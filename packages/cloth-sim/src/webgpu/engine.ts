/// <reference types="@webgpu/types" />
import { SurfacePhaseCapture } from "./SurfacePhaseCapture";
// WebGPU XPBD cloth engine. One step() runs `subSteps` substeps in a single compute pass
// (WebGPU orders dispatches and makes storage writes visible to subsequent dispatches), then reads
// back particle positions. Finite cloth contacts refit a stackless BVH each substep; finite body
// contacts traverse a static BVH rebuilt with avatar geometry. Particle contacts retain hashes.

import { captureUint32WordsWGSL } from './diagnosticCopies';
import { buildSeamGateLayout, packSeamGate, physicalSeamStitchIndices, type SeamGateLayout } from './seamGate';
import type { CollisionSeamActivation } from '../collisionGuard';
import { CollisionTimestampProfiler, type CollisionProfileReport } from './CollisionTimestampProfiler';
import type { SimConfig } from '../config';
import { resolveSewingMotionPolicy, type SewingMotionPolicy } from '../config';
import type { SimData, ColorGroup } from '../build';
import { applyInitialVerticalTilt } from '../geometry/initialTilt';
import { AssemblySupportController, type AssemblySupportData, type AssemblySupportState, type AssemblySupportSnapshot } from '../assembly';
import { assemblySupportWGSL } from '../supportShader';
import { buildBodySurfaceBVH, initBodySurfaceBVHCollisionWGSL, type SurfaceBVH } from './bodySurfaceBroadphase';
import { buildBodyContactFeatureNormals } from './bodyContactFeatures';
import { gatherBodyPointContactsWGSL, solveBodyPointContactsWGSL, captureCollisionSubstepWGSL } from './bodyPointContacts';
import { surfaceTopologyExclusions, surfaceSeamLinks } from './surfaceTopology';
import { buildSurfaceRefitPlan, type SurfaceRefitLevel } from './surfaceRefitPlan';
import { initSelfSurfaceCollisionWGSL, refitSurfaceLeavesWGSL, refitSurfaceParentsWGSL, solveSelfSurfaceCollisionWGSL, gatherSelfSurfaceCorrectionsWGSL, surfaceSeamGapsWGSL } from './surfaceSelf';
import {
  WORKGROUP_SIZE,
  integrateWGSL,
  distanceConstraintWGSL,
  bendingConstraintWGSL,
  seamWGSL,
  solveExternalSurfaceCollisionWGSL,
  gatherExternalSurfaceCorrectionsWGSL,
  applyCorrectionsWGSL,
  resetCorrectionsWGSL,
  velocityWGSL,
  triangleCentersWGSL,
  clearU32WGSL,
  countHashWGSL,
  prefixSumWGSL,
  fillHashWGSL,
  initSelfCollisionWGSL,
  solveSelfCollisionWGSL,
  computeDampingStateWGSL,
  applyLocalDampingWGSL,
  nearDampingWGSL
} from './shaders';

/** Avatar (body) mesh packed for the GPU: vec4 positions (x,y,z,0) + vec4u triangles (i0,i1,i2,0). */
export interface BodyMesh {
  positions: Float32Array;
  triangles: Uint32Array;
  numTriangles: number;
}

interface ColorBuffers {
  edges: GPUBuffer;
  props: GPUBuffer;
  count: number;
  bindGroup: GPUBindGroup;
}

/** Wall-clock diagnostics; readback wait includes GPU execution and queue scheduling. */
export interface ClothStepPerformance {
  encodingMs: number;
  readbackWaitMs: number;
  trajectoryReadbackMs: number;
  positionReadbackMs: number;
  controllerMs: number;
  totalMs: number;
}

/** Diagnostic copies for selectedZeroBasedSubstep+1; they never drive solver state. */
export interface CollisionPhaseObservation {
  substep: number;
  zeroBasedSubstep?: number;
  stage: string;
  positions: Float32Array;
  selfSurfaceCandidates?: Uint32Array;
  selfSurfaceCorrections?: Float32Array;
  selfSurfaceCandidateBudget?: number;
  selfSurfaceTriangleCount?: number;
  externalSurfaceCandidates?: Uint32Array;
  externalSurfaceCorrections?: Float32Array;
  externalSurfaceCandidateBudget?: number;
  externalSurfaceTriangleCount?: number;
}

export class ClothEngine {
  private device: GPUDevice;
  private config: SimConfig;
  private particleCount: number;

  private positions!: GPUBuffer;
  private velocities!: GPUBuffer;
  private lastPositions!: GPUBuffer;
  private correction!: GPUBuffer;
  private anchors!: GPUBuffer;
  private simParams!: GPUBuffer;
  private anchorScale = 1;
  private gravityScale = 1;
  private assemblySupportData?: AssemblySupportData;
  private assemblyController?: AssemblySupportController;
  private supportTargets?: GPUBuffer;
  private supportParams?: GPUBuffer;
  private supportPipe?: GPUComputePipeline;
  private supportBG?: GPUBindGroup;
  private positions2d!: GPUBuffer;
  private dynamicConfig!: GPUBuffer;
  private seams!: GPUBuffer;
  private seamOrder!: GPUBuffer;
  private seamGate!: GPUBuffer;
  private seamGateLayout?: SeamGateLayout;
  private seamStitchIndices: readonly (readonly number[])[] = [];
  private currentSeamActivation: CollisionSeamActivation | null = null;
  private sewnUpToValue = 0;
  private gateSnapshots = new WeakMap<GPUBuffer, { prefix:number; activation:CollisionSeamActivation|null; structuralEnabled:boolean }>();
  /** Total gated stitches; the ungated state is `sewnUpTo === stitchCount`. */
  stitchCount = 0;
  private readback!: GPUBuffer;
  private collisionTrajectory?: GPUBuffer;
  private collisionTrajectoryReadback?: GPUBuffer;
  private collisionTrajectoryParams?: GPUBuffer;
  private collisionTrajectoryPipe?: GPUComputePipeline;
  private collisionTrajectoryGroups: GPUBindGroup[] = [];
  private latestCollisionSubsteps: readonly Float32Array[] = [];
  private latestCollisionTrajectory: readonly Float32Array[] = [];
  private collisionPhaseBuffer?: GPUBuffer;
  private collisionPhaseReadback?: GPUBuffer;
  private collisionPhaseParams?: GPUBuffer;
  private collisionPhasePipe?: GPUComputePipeline;
  private collisionPhaseGroups: GPUBindGroup[] = [];
  private collisionPhaseStages: string[] = [];
  private collisionPhaseRecords: { zeroBasedSubstep: number; stage: string }[] = [];
  private collisionPhaseCandidates?: GPUBuffer;
  private collisionPhaseCandidatesReadback?: GPUBuffer;
  private collisionPhaseCorrections?: GPUBuffer;
  private collisionPhaseCorrectionsReadback?: GPUBuffer;
  private collisionPhaseCandidatesPipe?: GPUComputePipeline;
  private collisionPhaseCandidatesGroups: GPUBindGroup[] = [];
  private collisionPhaseCorrectionsGroups: GPUBindGroup[] = [];
  private collisionPhaseSelfDiagnostics = false;
  private collisionPhaseSelfChunks?: SurfacePhaseCapture;
  private collisionPhaseBodyChunks?: SurfacePhaseCapture;
  private collisionPhaseSubstep = -1;
  private latestCollisionPhases: readonly CollisionPhaseObservation[] = [];

  get collisionPhaseObservations(): readonly CollisionPhaseObservation[] { return this.latestCollisionPhases; }

  /** Enable an observer once between frames; the selected step is zero-based. */
  enableCollisionPhaseReadback(zeroBasedSubstep: number, endZeroBasedSubstep = zeroBasedSubstep, includeSelfSurfaceDiagnostics = false, includeExternalSurfaceDiagnostics = false): void {
    if (!Number.isInteger(zeroBasedSubstep) || zeroBasedSubstep < 0 || zeroBasedSubstep >= this.config.subSteps
      || !Number.isInteger(endZeroBasedSubstep) || endZeroBasedSubstep < zeroBasedSubstep || endZeroBasedSubstep >= this.config.subSteps)
      throw new Error('Collision phase substep must be inside the configured frame');
    if (this.inFlight || this.disposalRequested || this.collisionPhaseBuffer)
      throw new Error('Enable collision phase observations once, between live frames');
    this.collisionPhaseRecords = [];
    for (let selected = zeroBasedSubstep; selected <= endZeroBasedSubstep; selected++) {
      const passes = selected === this.config.subSteps - 1
        ? Math.max(this.config.substepContactIterations ?? 1, this.config.finalContactIterations ?? 1)
        : this.config.substepContactIterations ?? 1;
      const stages = ['start', 'prediction', 'stretch', 'bending', 'particle-self', 'sewing', 'support'];
      for (let iteration = 0; iteration < passes; iteration++) {
        if (includeSelfSurfaceDiagnostics) stages.push(`contact-${iteration + 1}-self-gather`);
        stages.push(`contact-${iteration + 1}-self-surface`);
        if (includeExternalSurfaceDiagnostics) stages.push(`contact-${iteration + 1}-body-input`, `contact-${iteration + 1}-body-gather`);
        stages.push(`contact-${iteration + 1}-body-surface`, `contact-${iteration + 1}-body-point`);
      }
      stages.push('final');
      this.collisionPhaseRecords.push(...stages.map(stage => ({ zeroBasedSubstep: selected, stage })));
    }
    this.collisionPhaseStages = this.collisionPhaseRecords.map(record => record.stage);
    const size = this.collisionPhaseRecords.length * this.particleCount * 16;
    const candidateBytes = includeSelfSurfaceDiagnostics
      ? this.collisionPhaseRecords.length * this.triangleCount * (this.config.numInternalSurfaceCollisionConstraints ?? 32) * 4 : 0;
    const correctionBytes = includeSelfSurfaceDiagnostics ? this.collisionPhaseRecords.length * this.triangleCount * 48 : 0;
    if (includeSelfSurfaceDiagnostics && (!this.triangleCount || !this.selfSurfaceCandidates || !this.selfSurfaceCorrections))
      throw new Error('Self-surface phase diagnostics require a nonempty prepared cloth mesh');
    const cap = Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize);
    const chunkSelf = includeSelfSurfaceDiagnostics && Math.max(candidateBytes, correctionBytes) > cap;
    const selfRowBytes = this.triangleCount * (this.config.numInternalSurfaceCollisionConstraints ?? 32) * 4;
    const bodyRowBytes = this.triangleCount * (this.config.numExternalSurfaceCollisionConstraints ?? 128) * 4;
    if ((includeSelfSurfaceDiagnostics && Math.max(selfRowBytes, this.triangleCount * 48) > cap)
      || includeExternalSurfaceDiagnostics && (!this.externalCollision || this.config.handleExternalSurfaceCollisions === false || !this.triangleCount || !this.externalSurfaceCandidates
        || !this.externalSurfaceCorrections || Math.max(bodyRowBytes, this.triangleCount * 48) > cap)) {
      throw new Error('Surface phase diagnostics require complete rows within the actual buffer limit');
    }
    // Validate the complete optional range before creating any buffers. A rejected observer
    // request must leave the live engine eligible for a smaller request.
    if ([size, chunkSelf ? 0 : candidateBytes, chunkSelf ? 0 : correctionBytes].some(bytes => !Number.isSafeInteger(bytes)
      || bytes > this.device.limits.maxStorageBufferBindingSize || bytes > this.device.limits.maxBufferSize))
      throw new Error('Selected collision phase range exceeds the actual device buffer limit');
    try {
    this.collisionPhaseBuffer = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.collisionPhaseReadback = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const alignment = this.device.limits.minUniformBufferOffsetAlignment;
    const parameters = new Uint32Array(this.collisionPhaseStages.length * alignment / 4);
    for (let stage = 0; stage < this.collisionPhaseStages.length; stage++) parameters[stage * alignment / 4] = stage;
    this.collisionPhaseParams = this.buf(parameters, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.collisionPhasePipe = this.pipe(captureCollisionSubstepWGSL());
    this.collisionPhaseGroups = this.collisionPhaseStages.map((_, stage) => this.device.createBindGroup({
      layout: this.collisionPhasePipe!.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.positions } },
        { binding: 1, resource: { buffer: this.collisionPhaseBuffer! } },
        { binding: 2, resource: { buffer: this.collisionPhaseParams!, offset: stage * alignment, size: 16 } }
      ] }));
    if (includeSelfSurfaceDiagnostics && chunkSelf) {
      const pipe = this.pipe(captureUint32WordsWGSL());
      this.collisionPhaseSelfChunks = new SurfacePhaseCapture(this.device, pipe,
        this.selfSurfaceCandidates, this.selfSurfaceCorrections, this.collisionPhaseRecords.map((_, index) => index),
        this.triangleCount, this.config.numInternalSurfaceCollisionConstraints ?? 32);
    }
    if (includeExternalSurfaceDiagnostics) {
      const pipe = this.pipe(captureUint32WordsWGSL());
      const indices = this.collisionPhaseRecords.flatMap((record, index) => /-body-(?:gather|surface)$/.test(record.stage) ? [index] : []);
      this.collisionPhaseBodyChunks = new SurfacePhaseCapture(this.device, pipe,
        this.externalSurfaceCandidates, this.externalSurfaceCorrections, indices,
        this.triangleCount, this.config.numExternalSurfaceCollisionConstraints ?? 128);
    }
    if (includeSelfSurfaceDiagnostics && !chunkSelf) {
      this.collisionPhaseCandidates = this.device.createBuffer({ size: candidateBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this.collisionPhaseCandidatesReadback = this.device.createBuffer({ size: candidateBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      this.collisionPhaseCorrections = this.device.createBuffer({ size: correctionBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this.collisionPhaseCorrectionsReadback = this.device.createBuffer({ size: correctionBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      this.collisionPhaseCandidatesPipe = this.pipe(captureUint32WordsWGSL());
      this.collisionPhaseCandidatesGroups = this.collisionPhaseStages.map((_, stage) => this.device.createBindGroup({
        layout: this.collisionPhaseCandidatesPipe!.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.selfSurfaceCandidates } },
          { binding: 1, resource: { buffer: this.collisionPhaseCandidates! } },
          { binding: 2, resource: { buffer: this.collisionPhaseParams!, offset: stage * alignment, size: 16 } }
        ] }));
      this.collisionPhaseCorrectionsGroups = this.collisionPhaseStages.map((_, stage) => this.device.createBindGroup({
        layout: this.collisionPhasePipe!.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.selfSurfaceCorrections } },
          { binding: 1, resource: { buffer: this.collisionPhaseCorrections! } },
          { binding: 2, resource: { buffer: this.collisionPhaseParams!, offset: stage * alignment, size: 16 } }
        ] }));
      this.collisionPhaseSelfDiagnostics = true;
    }
    this.collisionPhaseSubstep = zeroBasedSubstep;
    } catch (error) {
      this.collisionPhaseSelfChunks?.destroy(); this.collisionPhaseSelfChunks = undefined;
      this.collisionPhaseBodyChunks?.destroy(); this.collisionPhaseBodyChunks = undefined;
      for (const buffer of [this.collisionPhaseBuffer, this.collisionPhaseReadback, this.collisionPhaseParams,
        this.collisionPhaseCandidates, this.collisionPhaseCandidatesReadback,
        this.collisionPhaseCorrections, this.collisionPhaseCorrectionsReadback]) buffer?.destroy();
      this.collisionPhaseBuffer = this.collisionPhaseReadback = this.collisionPhaseParams = undefined;
      this.collisionPhaseCandidates = this.collisionPhaseCandidatesReadback = undefined;
      this.collisionPhaseCorrections = this.collisionPhaseCorrectionsReadback = undefined;
      this.collisionPhaseGroups = this.collisionPhaseCandidatesGroups = this.collisionPhaseCorrectionsGroups = [];
      this.collisionPhaseRecords = []; this.collisionPhaseStages = [];
      this.collisionPhaseSelfDiagnostics = false; this.collisionPhaseSubstep = -1;
      throw error;
    }
  }
  private gpuProfiler?: CollisionTimestampProfiler;
  private latestGPUProfile: CollisionProfileReport | null = null;
  private profiledFrameIndex = 0;

  /** Timestamp diagnostics are opt-in and never alter solver constraints or acceptance. */
  enableGPUStageProfiling(options: { selectedZeroBasedSubsteps?: readonly number[] } = {}): void {
    if (this.inFlight || this.disposalRequested || this.gpuProfiler)
      throw new Error('Enable GPU profiling once, between live frames');
    this.gpuProfiler = new CollisionTimestampProfiler(this.device, { ...options, substeps: this.config.subSteps });
  }
  get gpuStageProfile(): Readonly<CollisionProfileReport> | null { return this.latestGPUProfile; }

  private stepTiming: ClothStepPerformance | null = null;
  private readbackControllerMs = 0;

  get lastStepPerformance(): Readonly<ClothStepPerformance> | null { return this.stepTiming; }

  get collisionTrajectoryPositions(): readonly Float32Array[] { return this.latestCollisionTrajectory; }

  get collisionSubstepPositions(): readonly Float32Array[] { return this.latestCollisionSubsteps; }

  /** Optional exact corrected trajectory for source safety validation; native simulations omit it. */
  enableCollisionTrajectoryReadback(): void {
    if (this.collisionTrajectory) return;
    if (this.inFlight || this.disposalRequested) throw new Error('Enable collision trajectory before starting a live frame');
    const size = this.particleCount * 16 * (this.config.subSteps + 1);
    this.collisionTrajectory = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.collisionTrajectoryReadback = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const params = new Uint32Array((this.config.subSteps + 1) * 64);
    for (let substep = 0; substep <= this.config.subSteps; substep++) params[substep * 64] = substep;
    this.collisionTrajectoryParams = this.buf(params, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.collisionTrajectoryPipe = this.pipe(captureCollisionSubstepWGSL());
    this.collisionTrajectoryGroups = Array.from({ length: this.config.subSteps + 1 }, (_, substep) => this.device.createBindGroup({
      layout: this.collisionTrajectoryPipe!.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.positions } },
        { binding: 1, resource: { buffer: this.collisionTrajectory! } },
        { binding: 2, resource: { buffer: this.collisionTrajectoryParams!, offset: substep * 256, size: 16 } }
      ]
    }));
  }

  // External (body) collision: GPU spatial hash over avatar triangles, rebuilt only when the body
  // mesh changes (externalDirty mirrors the original's externalPositionsDirty), plus a per-frame
  // near-triangle gather list frozen across the substep loop.
  private externalCollision: boolean;
  private bodyTriangleCount: number;
  private externalHashTableSize: number;
  private externalDirty = true;
  private bodyPositions!: GPUBuffer;
  private bodyTriangles!: GPUBuffer;
  private externalTriangleCenters!: GPUBuffer;
  private externalHashTable!: GPUBuffer;
  private externalHashPositions!: GPUBuffer;
  private externalNearTriangles!: GPUBuffer;
  private bodyPointContacts!: GPUBuffer;
  private bodyFeatureNormals!: GPUBuffer;
  private externalSurfaceCandidates!: GPUBuffer;
  private externalSurfaceCorrections!: GPUBuffer;
  private bodyTriangleRadius = 0;
  private currentBodyMesh!: BodyMesh;
  private bodySurfaceBVHData!: SurfaceBVH;
  private lastResetPositions!: Float32Array;

  // Self-collision (cloth-vs-cloth) + near-damping buffers
  private selfCollision: boolean;
  private triangleCount: number;
  private hashTableSize: number;
  private clothTriangles!: GPUBuffer;
  private triangleCenters!: GPUBuffer;
  private particleLayers!: GPUBuffer;
  private hashTable!: GPUBuffer;
  private hashPositions!: GPUBuffer;
  private nearTriangles!: GPUBuffer;
  private selfSurfaceCandidates!: GPUBuffer;
  private selfSurfaceBounds!: GPUBuffer;
  private selfSurfaceOrdered!: GPUBuffer;
  private selfSurfaceRanges!: GPUBuffer;
  private selfSurfaceNodeCount=0;
  private bodySurfaceBounds!: GPUBuffer;
  private bodySurfaceOrdered!: GPUBuffer;
  private selfSurfaceBoundsPipe!: GPUComputePipeline;
  private selfSurfaceBoundsBG!: GPUBindGroup;
  private selfSurfaceParentIds!: GPUBuffer;
  private selfSurfaceParentParams!: GPUBuffer;
  private selfSurfaceParentPipe!: GPUComputePipeline;
  private selfSurfaceRefitLevels: SurfaceRefitLevel[] = [];
  private selfSurfaceParentGroups: { bindGroup: GPUBindGroup; count: number }[] = [];
  private selfSurfaceCorrections!: GPUBuffer;
  private selfSurfaceTopology!: GPUBuffer;
  private surfaceSeamLinks!: GPUBuffer;
  private surfaceSeamGaps!: GPUBuffer;
  private surfaceSeamCount = 0;
  private selfSurfaceSeedResetBG!: GPUBindGroup;
  private initSelfSurfacePipe!: GPUComputePipeline;
  private solveSelfSurfacePipe!: GPUComputePipeline;
  private surfaceSeamGapsPipe!: GPUComputePipeline;
  private selfSurfaceGatherPipe!: GPUComputePipeline;
  private initSelfSurfaceBG!: GPUBindGroup;
  private solveSelfSurfaceBG!: GPUBindGroup;
  private surfaceSeamGapsBG!: GPUBindGroup;
  private selfSurfaceGatherBG!: GPUBindGroup;
  private neighborIndices!: GPUBuffer;
  private incidentTriangles!: GPUBuffer; // external-collision cloth-normal filter
  private maxIncident: number;

  // Local (whole-garment rigid-body) damping state: 3 vec4f — xcm(+totalMass), vcm, omega.
  private dampingState!: GPUBuffer;

  private integratePipe!: GPUComputePipeline;
  private distancePipe!: GPUComputePipeline;
  private bendPipe!: GPUComputePipeline;
  private seamPipe!: GPUComputePipeline;
  private applyPipe!: GPUComputePipeline;
  private resetPipe!: GPUComputePipeline;
  private velocityPipe!: GPUComputePipeline;
  private triCentersPipe!: GPUComputePipeline;
  private clearPipe!: GPUComputePipeline;
  private countPipe!: GPUComputePipeline;
  private prefixSumPipe!: GPUComputePipeline;
  private fillPipe!: GPUComputePipeline;
  private initSelfPipe!: GPUComputePipeline;
  private solveSelfPipe!: GPUComputePipeline;
  private extCountPipe!: GPUComputePipeline;
  private extPrefixSumPipe!: GPUComputePipeline;
  private extFillPipe!: GPUComputePipeline;
  private initExternalPipe!: GPUComputePipeline;
  private solveExternalPipe!: GPUComputePipeline;
  private initExternalSurfacePipe!: GPUComputePipeline;
  private solveExternalSurfacePipe!: GPUComputePipeline;
  private gatherExternalSurfacePipe!: GPUComputePipeline;
  private computeDampingPipe!: GPUComputePipeline;
  private applyLocalDampingPipe!: GPUComputePipeline;
  private nearDampingPipe!: GPUComputePipeline;

  private integrateBG!: GPUBindGroup;
  private seamBG!: GPUBindGroup;
  private applyBG!: GPUBindGroup;
  private resetBG!: GPUBindGroup;
  private velocityBG!: GPUBindGroup;
  private triCentersBG!: GPUBindGroup;
  private clearHashTableBG!: GPUBindGroup;
  private clearHashPositionsBG!: GPUBindGroup;
  private countBG!: GPUBindGroup;
  private prefixSumBG!: GPUBindGroup;
  private fillBG!: GPUBindGroup;
  private initSelfBG!: GPUBindGroup;
  private solveSelfBG!: GPUBindGroup;
  private extTriCentersBG!: GPUBindGroup;
  private extClearHashTableBG!: GPUBindGroup;
  private extClearHashPositionsBG!: GPUBindGroup;
  private extCountBG!: GPUBindGroup;
  private extPrefixSumBG!: GPUBindGroup;
  private extFillBG!: GPUBindGroup;
  private initExternalBG!: GPUBindGroup;
  private solveExternalBG!: GPUBindGroup;
  private initExternalSurfaceBG!: GPUBindGroup;
  private solveExternalSurfaceBG!: GPUBindGroup;
  private gatherExternalSurfaceBG!: GPUBindGroup;
  private computeDampingBG!: GPUBindGroup;
  private applyLocalDampingBG!: GPUBindGroup;
  private nearDampingBG!: GPUBindGroup;
  private stretchGroups: ColorBuffers[] = [];
  private bendGroups: ColorBuffers[] = [];

  private inFlight = false;
  private stateGeneration = 0;
  private disposalRequested = false;
  private resourcesDisposed = false;
  private supportSnapshots=new WeakMap<GPUBuffer,AssemblySupportSnapshot>();
  private selfCollisionRuntime = true; // runtime toggle (e.g. off during a body-change re-drape)
  private anchorW!: Float32Array; // original anchor weights (.w lane) to preserve on re-anchor

  private readonly strictSurfaceHistory: boolean;
  private readonly refinedSeamProof: boolean;
  private readonly interleaveSourceStretch: boolean;
  private sourceStructuralStaging = false;
  readonly sourceStretchSewingMode: 'sequential' | 'interleaved';
  readonly sewingMotionPolicy: Readonly<SewingMotionPolicy>;

  constructor(device: GPUDevice, sim: SimData, body: BodyMesh, config: SimConfig,
    options: { strictSurfaceHistory?: boolean; sourceStretchSewingMode?: 'sequential' | 'interleaved'; sourceStructuralStaging?:boolean } = {}) {
    if(!Number.isFinite(config.maxSurfaceCorrection ?? .005) || (config.maxSurfaceCorrection ?? .005)<=0)
      throw new Error('Surface recovery bound must be positive and finite');
    if(!Number.isInteger(config.finalContactIterations ?? 1) || (config.finalContactIterations ?? 1)<1 || (config.finalContactIterations ?? 1)>16)
      throw new Error('Final contact iterations must be an integer between one and sixteen');
    if(!Number.isInteger(config.substepContactIterations ?? 1) || (config.substepContactIterations ?? 1)<1 || (config.substepContactIterations ?? 1)>16)
      throw new Error('Substep contact iterations must be an integer between one and sixteen');
    this.device = device;
    this.config = config;
    this.strictSurfaceHistory = !!options.strictSurfaceHistory;
    this.refinedSeamProof = !!sim.sourceGatherCollisionGeometry;
    this.sewingMotionPolicy = resolveSewingMotionPolicy(config, this.strictSurfaceHistory);
    this.sourceStructuralStaging=!!options.sourceStructuralStaging && this.strictSurfaceHistory && !!sim.sourceStaging;
    if(this.strictSurfaceHistory) {
      this.seamGateLayout=buildSeamGateLayout(sim.stitchCount,sim.seamPairsBySeam.length);
      this.seamStitchIndices=physicalSeamStitchIndices(sim.seams,sim.seamOrder,sim.seamPairsBySeam,sim.seamStitchRanges);
      this.currentSeamActivation={revision:0,activeSeams:new Uint32Array(sim.seamPairsBySeam.length).fill(1),sewnUpTo:sim.stitchCount};
    }
    this.interleaveSourceStretch = this.strictSurfaceHistory
      && !!sim.sourceStretchPolicy && options.sourceStretchSewingMode === 'interleaved';
    this.sourceStretchSewingMode = this.interleaveSourceStretch ? 'interleaved' : 'sequential';
    this.particleCount = sim.particleCount;
    this.triangleCount = sim.triangleCount;
    this.maxIncident = sim.maxIncidentTrianglesPerParticle;
    this.selfCollision = config.handleSelfCollisions && sim.triangleCount > 0;
    this.externalCollision = config.handleExternalCollisions && body.numTriangles > 0;
    this.hashTableSize = config.internalHashTableMultiplier * Math.max(1, sim.triangleCount) + 1;
    this.bodyTriangleCount = body.numTriangles;
    this.bodyTriangleRadius = this.measureBodyTriangleRadius(body);
    this.externalHashTableSize = config.externalHashTableMultiplier * Math.max(1, body.numTriangles) + 1;
    this.anchorW = new Float32Array(this.particleCount);
    for (let i = 0; i < this.particleCount; i++) this.anchorW[i] = sim.anchors[i * 4 + 3];
    this.lastResetPositions=sim.positions.slice();
    this.createBuffers(sim, body);
    this.assemblySupportData = sim.assemblySupport;
    if (sim.assemblySupport) {
      this.assemblyController = new AssemblySupportController(sim.assemblySupport, config.timeStep,body,this.bodySurfaceBVHData);
      this.assemblyController.refreshTargets(sim.positions);
      this.supportTargets = this.buf(this.assemblyController.targets, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.supportParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const params = new ArrayBuffer(16);
      new Uint32Array(params)[0] = this.particleCount;
      new Float32Array(params).set([1.0, 0.005], 1);
      device.queue.writeBuffer(this.supportParams, 0, params);
    }
    if (this.currentSeamActivation) this.setSeamActivation(this.currentSeamActivation);
    this.createPipelines();
    this.createBindGroups();
  }

  private buf(data: ArrayBufferView, usage: number): GPUBuffer {
    const b = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage });
    this.device.queue.writeBuffer(b, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    return b;
  }

  /** Broad-phase padding only: the finite face solver still uses the configured cloth thickness. */
  private measureBodyTriangleRadius(body: BodyMesh): number {
    let maximum = 0;
    for (let triangle = 0; triangle < body.numTriangles; triangle++) {
      const indices = [0, 1, 2].map(slot => body.triangles[triangle * 4 + slot] * 4);
      const center = [0, 1, 2].map(axis => indices.reduce((sum, index) => sum + body.positions[index + axis], 0) / 3);
      for (const index of indices) {
        maximum = Math.max(maximum, Math.hypot(...center.map((value, axis) => value - body.positions[index + axis])));
      }
    }
    return maximum;
  }

  private createBuffers(sim: SimData, body: BodyMesh) {
    const d = this.device;
    const STORAGE = GPUBufferUsage.STORAGE;
    const COPY_DST = GPUBufferUsage.COPY_DST;
    const COPY_SRC = GPUBufferUsage.COPY_SRC;
    const initialPositions = sim.positions.slice();
    applyInitialVerticalTilt(initialPositions, sim.positions2d);
    this.positions = this.buf(initialPositions, STORAGE | COPY_DST | COPY_SRC);
    this.velocities = d.createBuffer({ size: this.particleCount * 16, usage: STORAGE | COPY_DST | COPY_SRC });
    d.queue.writeBuffer(this.velocities, 0, new Float32Array(this.particleCount * 4));
    this.lastPositions = d.createBuffer({ size: this.particleCount * 16, usage: STORAGE | COPY_DST | COPY_SRC });
    this.correction = d.createBuffer({ size: this.particleCount * 16, usage: STORAGE | COPY_DST });
    this.anchors = this.buf(sim.anchors, STORAGE | COPY_DST);
    this.simParams = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | COPY_DST });
    d.queue.writeBuffer(this.simParams, 0, new Float32Array([1, 1, 0, 0]));
    this.positions2d = this.buf(sim.positions2d, STORAGE | COPY_DST);
    this.dynamicConfig = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | COPY_DST });
    d.queue.writeBuffer(this.dynamicConfig, 0, new Float32Array(8));
    this.seams = this.buf(sim.seams, STORAGE | COPY_DST);
    this.seamOrder = this.buf(sim.seamOrder, STORAGE | COPY_DST);
    this.stitchCount = sim.stitchCount;
    this.seamGate = d.createBuffer({ size: this.seamGateLayout?.byteLength ?? 16, usage: GPUBufferUsage.UNIFORM | COPY_DST });
    // Everything sewn until an assembly recording says otherwise, so an ungated drape is unchanged.
    this.setSewnUpTo(sim.stitchCount);
    this.readback = d.createBuffer({ size: this.particleCount * 16, usage: GPUBufferUsage.MAP_READ | COPY_DST });

    this.bodyPositions = this.buf(body.positions, STORAGE | COPY_DST);
    this.bodyTriangles = this.buf(body.triangles, STORAGE | COPY_DST);
    this.createBodySurfaceBVH(body);
    this.createExternalHashBuffers();
    this.externalNearTriangles = d.createBuffer({
      size: Math.max(4, this.particleCount * this.config.numExternalCollisionConstraintsPerParticle * 4),
      usage: STORAGE
    });
    this.bodyPointContacts = d.createBuffer({ size: Math.max(64, this.particleCount * 64), usage: STORAGE });
    this.externalSurfaceCandidates = d.createBuffer({
      size: Math.max(4, this.triangleCount * (this.config.numExternalSurfaceCollisionConstraints ?? this.config.numExternalCollisionConstraintsPerParticle) * 4), usage: STORAGE
    });
    this.externalSurfaceCorrections = d.createBuffer({ size: Math.max(16, this.triangleCount * 3 * 16), usage: STORAGE });

    // Local-damping reduction output (3 vec4f), zero-initialized.
    this.dampingState = d.createBuffer({ size: 48, usage: STORAGE | COPY_DST });
    d.queue.writeBuffer(this.dampingState, 0, new Float32Array(12));

    // Self-collision + near-damping buffers.
    this.clothTriangles = this.buf(sim.triangles, STORAGE | COPY_DST);
    this.particleLayers = this.buf(sim.particleLayers, STORAGE | COPY_DST);
    this.neighborIndices = this.buf(sim.neighborIndices, STORAGE | COPY_DST);
    this.incidentTriangles = this.buf(sim.incidentTriangles, STORAGE | COPY_DST);
    this.triangleCenters = d.createBuffer({ size: Math.max(16, this.triangleCount * 16), usage: STORAGE });
    this.hashTable = d.createBuffer({ size: this.hashTableSize * 4, usage: STORAGE });
    this.hashPositions = d.createBuffer({ size: Math.max(4, this.triangleCount * 4), usage: STORAGE });
    this.nearTriangles = d.createBuffer({
      size: Math.max(4, this.particleCount * this.config.numInternalCollisionConstraintsPerParticle * 4),
      usage: STORAGE
    });
    const clothBVH=buildBodySurfaceBVH({positions:sim.positions,triangles:sim.triangles,numTriangles:this.triangleCount});
    this.selfSurfaceBounds = this.buf(clothBVH.nodes,STORAGE | COPY_DST);
    this.selfSurfaceOrdered = this.buf(clothBVH.triangleIds,STORAGE | COPY_DST);
    this.selfSurfaceRanges = this.buf(clothBVH.ranges,STORAGE | COPY_DST);
    this.selfSurfaceNodeCount=clothBVH.nodeCount;
    const refitPlan = buildSurfaceRefitPlan(clothBVH, this.device.limits.minUniformBufferOffsetAlignment);
    this.selfSurfaceParentIds = this.buf(refitPlan.parentNodeIds, STORAGE | COPY_DST);
    this.selfSurfaceParentParams = this.buf(refitPlan.uniforms, GPUBufferUsage.UNIFORM | COPY_DST);
    this.selfSurfaceRefitLevels = refitPlan.levels;
    this.selfSurfaceCandidates = d.createBuffer({ size: Math.max(4, this.triangleCount * (this.config.numInternalSurfaceCollisionConstraints ?? 32) * 4), usage: STORAGE });
    this.selfSurfaceCorrections = d.createBuffer({ size: Math.max(16, this.triangleCount * 48), usage: STORAGE });
    this.selfSurfaceTopology = this.buf(surfaceTopologyExclusions(sim.triangles, sim.seams, sim.seamOrder, sim.seamPairsBySeam,!!this.seamGateLayout, this.seamStitchIndices, sim.sourceGatherCollisionGeometry), STORAGE | COPY_DST);
    this.surfaceSeamLinks = this.buf(surfaceSeamLinks(sim.seamPairsBySeam, sim.sourceGatherCollisionGeometry), STORAGE | COPY_DST);
    this.surfaceSeamCount = sim.seamPairsBySeam.length;
    this.surfaceSeamGaps = d.createBuffer({ size: Math.max(4, this.surfaceSeamCount * 4), usage: STORAGE });

    for (const g of sim.stretchColors) this.stretchGroups.push(this.makeColorBuffers(g));
    for (const g of sim.bendColors) this.bendGroups.push(this.makeColorBuffers(g));
  }

  /** (Re)create the body-triangle hash buffers — sized by the CURRENT body triangle count. */
  private createExternalHashBuffers() {
    const d = this.device;
    const n = this.bodyTriangleCount;
    this.externalTriangleCenters = d.createBuffer({ size: Math.max(16, n * 16), usage: GPUBufferUsage.STORAGE });
    this.externalHashTable = d.createBuffer({ size: this.externalHashTableSize * 4, usage: GPUBufferUsage.STORAGE });
    this.externalHashPositions = d.createBuffer({ size: Math.max(4, n * 4), usage: GPUBufferUsage.STORAGE });
  }

  private makeColorBuffers(g: ColorGroup): ColorBuffers {
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const edges = this.buf(g.edges, usage);
    const props = this.buf(g.props, usage);
    return { edges, props, count: g.count, bindGroup: null as unknown as GPUBindGroup };
  }

  private pipe(code: string): GPUComputePipeline {
    return this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' }
    });
  }

  private createPipelines() {
    const cfg = this.config;
    this.integratePipe = this.pipe(integrateWGSL(cfg));
    if (this.supportTargets) this.supportPipe = this.pipe(assemblySupportWGSL());
    this.distancePipe = this.pipe(distanceConstraintWGSL(cfg));
    this.bendPipe = this.pipe(bendingConstraintWGSL(cfg));
    const sewing = this.sewingMotionPolicy;
    this.seamPipe = this.pipe(sewing.policy === 'legacy-per-iteration-v1'
      ? seamWGSL(cfg, sewing.perIterationMaximumSq, this.seamGateLayout)
      : seamWGSL(cfg, sewing.openPerIterationMaximumSq, this.seamGateLayout, {
        maximumSq: sewing.closedRestorationPerIterationMaximumSq,
        previousGapSq: sewing.closedGapCriterionMeters * sewing.closedGapCriterionMeters
      }));
    this.applyPipe = this.pipe(applyCorrectionsWGSL());
    this.resetPipe = this.pipe(resetCorrectionsWGSL());
    this.velocityPipe = this.pipe(velocityWGSL(cfg));
    if (cfg.localDamping > 0) {
      this.computeDampingPipe = this.pipe(computeDampingStateWGSL());
      this.applyLocalDampingPipe = this.pipe(applyLocalDampingWGSL(cfg));
    }
    if (cfg.nearDamping > 0) this.nearDampingPipe = this.pipe(nearDampingWGSL(cfg));
    if (this.selfCollision || this.externalCollision) {
      this.triCentersPipe = this.pipe(triangleCentersWGSL());
      this.clearPipe = this.pipe(clearU32WGSL());
    }
    if (this.selfCollision) {
      this.initSelfSurfacePipe = this.pipe(initSelfSurfaceCollisionWGSL(cfg));
      this.selfSurfaceBoundsPipe = this.pipe(refitSurfaceLeavesWGSL());
      this.selfSurfaceParentPipe = this.pipe(refitSurfaceParentsWGSL());
      this.solveSelfSurfacePipe = this.pipe(solveSelfSurfaceCollisionWGSL(cfg, !this.strictSurfaceHistory,this.seamGateLayout, this.refinedSeamProof));
      this.surfaceSeamGapsPipe = this.pipe(surfaceSeamGapsWGSL());
      this.selfSurfaceGatherPipe = this.pipe(gatherSelfSurfaceCorrectionsWGSL(cfg, this.maxIncident));
      this.countPipe = this.pipe(countHashWGSL(this.hashTableSize, cfg.clothSpacing));
      this.prefixSumPipe = this.pipe(prefixSumWGSL(this.hashTableSize));
      this.fillPipe = this.pipe(fillHashWGSL(this.hashTableSize, cfg.clothSpacing));
      this.initSelfPipe = this.pipe(initSelfCollisionWGSL(cfg, this.hashTableSize));
      this.solveSelfPipe = this.pipe(solveSelfCollisionWGSL(cfg));
    }
    if (this.externalCollision) this.createExternalPipelines();
  }

  /** Body-hash pipelines bake externalHashTableSize/spacing as constants — rebuilt on body change. */
  private createExternalPipelines() {
    const cfg = this.config;
    this.extCountPipe = this.pipe(countHashWGSL(this.externalHashTableSize, cfg.externalHashSpacing));
    this.extPrefixSumPipe = this.pipe(prefixSumWGSL(this.externalHashTableSize));
    this.extFillPipe = this.pipe(fillHashWGSL(this.externalHashTableSize, cfg.externalHashSpacing));
    this.initExternalPipe = this.pipe(gatherBodyPointContactsWGSL());
    this.solveExternalPipe = this.pipe(solveBodyPointContactsWGSL(cfg, this.maxIncident));
    if (cfg.handleExternalSurfaceCollisions !== false && this.triangleCount > 0) {
      this.initExternalSurfacePipe = this.pipe(initBodySurfaceBVHCollisionWGSL(cfg,0));
      this.solveExternalSurfacePipe = this.pipe(solveExternalSurfaceCollisionWGSL(cfg));
      this.gatherExternalSurfacePipe = this.pipe(gatherExternalSurfaceCorrectionsWGSL(this.maxIncident));
    }
  }

  private createBindGroups() {
    const d = this.device;
    const e = (buffer: GPUBuffer) => ({ buffer });
    if (this.supportPipe && this.supportTargets && this.supportParams) this.supportBG = d.createBindGroup({
      layout: this.supportPipe.getBindGroupLayout(0), entries: [this.positions, this.supportTargets, this.supportParams]
        .map((buffer, binding) => ({ binding, resource: e(buffer) }))
    });
    this.integrateBG = d.createBindGroup({
      layout: this.integratePipe.getBindGroupLayout(0),
      entries: [this.positions, this.velocities, this.lastPositions, this.correction, this.anchors, this.simParams, this.positions2d, this.dynamicConfig].map((b, i) => ({ binding: i, resource: e(b) }))
    });
    for (const g of this.stretchGroups) {
      g.bindGroup = d.createBindGroup({
        layout: this.distancePipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: e(this.positions) },
          { binding: 1, resource: e(g.edges) },
          { binding: 2, resource: e(g.props) }
        ]
      });
    }
    for (const g of this.bendGroups) {
      g.bindGroup = d.createBindGroup({
        layout: this.bendPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: e(this.positions) },
          { binding: 1, resource: e(g.edges) },
          { binding: 2, resource: e(g.props) }
        ]
      });
    }
    this.seamBG = d.createBindGroup({
      layout: this.seamPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: e(this.positions) },
        { binding: 1, resource: e(this.seams) },
        { binding: 2, resource: e(this.correction) },
        { binding: 3, resource: e(this.seamOrder) },
        { binding: 4, resource: e(this.seamGate) },
        ...(this.strictSurfaceHistory ? [{ binding: 5, resource: e(this.lastPositions) }] : [])
      ]
    });
    if (this.externalCollision) this.createExternalBindGroups();
    if (this.config.localDamping > 0) {
      this.computeDampingBG = d.createBindGroup({
        layout: this.computeDampingPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: e(this.positions) },
          { binding: 1, resource: e(this.velocities) },
          { binding: 2, resource: e(this.dampingState) }
        ]
      });
      this.applyLocalDampingBG = d.createBindGroup({
        layout: this.applyLocalDampingPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: e(this.positions) },
          { binding: 1, resource: e(this.velocities) },
          { binding: 2, resource: e(this.dampingState) }
        ]
      });
    }
    this.applyBG = d.createBindGroup({
      layout: this.applyPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: e(this.positions) },
        { binding: 1, resource: e(this.correction) }
      ]
    });
    this.resetBG = d.createBindGroup({
      layout: this.resetPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: e(this.correction) }]
    });
    this.velocityBG = d.createBindGroup({
      layout: this.velocityPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: e(this.positions) },
        { binding: 1, resource: e(this.velocities) },
        { binding: 2, resource: e(this.lastPositions) }
      ]
    });
    if (this.config.nearDamping > 0) {
      this.nearDampingBG = d.createBindGroup({
        layout: this.nearDampingPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: e(this.positions) },
          { binding: 1, resource: e(this.velocities) },
          { binding: 2, resource: e(this.neighborIndices) }
        ]
      });
    }
    if (this.selfCollision) {
      const group = (pipeline: GPUComputePipeline, buffers: GPUBuffer[]) => d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: e(buffer) }))
      });
      this.selfSurfaceSeedResetBG = group(this.clearPipe, [this.selfSurfaceCandidates]);
      this.initSelfSurfaceBG = group(this.initSelfSurfacePipe, [this.positions, this.clothTriangles, this.selfSurfaceCandidates,
        this.selfSurfaceBounds, this.selfSurfaceOrdered, this.lastPositions]);
      this.selfSurfaceBoundsBG = group(this.selfSurfaceBoundsPipe, [this.selfSurfaceBounds,this.selfSurfaceOrdered, this.clothTriangles, this.positions, this.lastPositions,this.selfSurfaceRanges]);
      this.selfSurfaceParentGroups = this.selfSurfaceRefitLevels.map(level => ({ count: level.count,
        bindGroup: d.createBindGroup({ layout: this.selfSurfaceParentPipe.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.selfSurfaceBounds } },
          { binding: 1, resource: { buffer: this.selfSurfaceParentIds } },
          { binding: 2, resource: { buffer: this.selfSurfaceParentParams, offset: level.uniformOffset, size: 16 } }
        ] }) }));
      this.solveSelfSurfaceBG = group(this.solveSelfSurfacePipe, [this.positions, this.clothTriangles, this.selfSurfaceCandidates,
        this.lastPositions, this.selfSurfaceCorrections, this.selfSurfaceTopology, this.surfaceSeamLinks, this.surfaceSeamGaps, this.seamGate]);
      this.surfaceSeamGapsBG = group(this.surfaceSeamGapsPipe, [this.positions, this.surfaceSeamLinks, this.surfaceSeamGaps]);
      this.selfSurfaceGatherBG = group(this.selfSurfaceGatherPipe, [this.clothTriangles, this.incidentTriangles, this.selfSurfaceCorrections, this.correction, this.positions]);
      this.triCentersBG = d.createBindGroup({
        layout: this.triCentersPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: e(this.clothTriangles) },
          { binding: 1, resource: e(this.positions) },
          { binding: 2, resource: e(this.triangleCenters) }
        ]
      });
      this.clearHashTableBG = d.createBindGroup({
        layout: this.clearPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: e(this.hashTable) }]
      });
      this.clearHashPositionsBG = d.createBindGroup({
        layout: this.clearPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: e(this.hashPositions) }]
      });
      this.countBG = d.createBindGroup({
        layout: this.countPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: e(this.triangleCenters) },
          { binding: 1, resource: e(this.hashTable) }
        ]
      });
      this.prefixSumBG = d.createBindGroup({
        layout: this.prefixSumPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: e(this.hashTable) }]
      });
      this.fillBG = d.createBindGroup({
        layout: this.fillPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: e(this.triangleCenters) },
          { binding: 1, resource: e(this.hashTable) },
          { binding: 2, resource: e(this.hashPositions) }
        ]
      });
      this.initSelfBG = d.createBindGroup({
        layout: this.initSelfPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: e(this.positions) },
          { binding: 1, resource: e(this.nearTriangles) },
          { binding: 2, resource: e(this.hashTable) },
          { binding: 3, resource: e(this.hashPositions) },
          { binding: 4, resource: e(this.clothTriangles) },
          { binding: 5, resource: e(this.positions2d) },
          { binding: 6, resource: e(this.triangleCenters) },
          { binding: 7, resource: e(this.seams) }
        ]
      });
      this.solveSelfBG = d.createBindGroup({
        layout: this.solveSelfPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: e(this.positions) },
          { binding: 1, resource: e(this.correction) },
          { binding: 2, resource: e(this.nearTriangles) },
          { binding: 3, resource: e(this.clothTriangles) },
          { binding: 4, resource: e(this.lastPositions) },
          { binding: 5, resource: e(this.particleLayers) }
        ]
      });
    }
  }

  /** Bind groups touching the body buffers — recreated whenever the body mesh changes. */
  private createExternalBindGroups() {
    const d = this.device;
    const e = (buffer: GPUBuffer) => ({ buffer });
    this.extTriCentersBG = d.createBindGroup({
      layout: this.triCentersPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: e(this.bodyTriangles) },
        { binding: 1, resource: e(this.bodyPositions) },
        { binding: 2, resource: e(this.externalTriangleCenters) }
      ]
    });
    this.extClearHashTableBG = d.createBindGroup({
      layout: this.clearPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: e(this.externalHashTable) }]
    });
    this.extClearHashPositionsBG = d.createBindGroup({
      layout: this.clearPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: e(this.externalHashPositions) }]
    });
    this.extCountBG = d.createBindGroup({
      layout: this.extCountPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: e(this.externalTriangleCenters) },
        { binding: 1, resource: e(this.externalHashTable) }
      ]
    });
    this.extPrefixSumBG = d.createBindGroup({
      layout: this.extPrefixSumPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: e(this.externalHashTable) }]
    });
    this.extFillBG = d.createBindGroup({
      layout: this.extFillPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: e(this.externalTriangleCenters) },
        { binding: 1, resource: e(this.externalHashTable) },
        { binding: 2, resource: e(this.externalHashPositions) }
      ]
    });
    this.initExternalBG = d.createBindGroup({
      layout: this.initExternalPipe.getBindGroupLayout(0),
      entries: [this.positions, this.bodyPointContacts, this.bodySurfaceBounds,
        this.bodySurfaceOrdered, this.bodyTriangles, this.bodyPositions,
        this.lastPositions, this.bodyFeatureNormals].map((buffer, binding) => ({ binding, resource: e(buffer) }))
    });
    this.solveExternalBG = d.createBindGroup({
      layout: this.solveExternalPipe.getBindGroupLayout(0),
      entries: [this.positions, this.correction, this.bodyPointContacts,
        this.lastPositions, this.clothTriangles, this.incidentTriangles]
        .map((buffer, binding) => ({ binding, resource: e(buffer) }))
    });
    if (this.config.handleExternalSurfaceCollisions !== false && this.triangleCount > 0) {
      this.initExternalSurfaceBG = d.createBindGroup({
        layout: this.initExternalSurfacePipe.getBindGroupLayout(0), entries: [
          { binding: 0, resource: e(this.positions) }, { binding: 1, resource: e(this.clothTriangles) },
          { binding: 2, resource: e(this.externalSurfaceCandidates) }, { binding: 3, resource: e(this.bodySurfaceBounds) },
          { binding: 4, resource: e(this.bodySurfaceOrdered) }, { binding: 5, resource: e(this.lastPositions) }
          , { binding: 6, resource: e(this.bodyTriangles) }, { binding: 7, resource: e(this.bodyPositions) }
        ]
      });
      this.solveExternalSurfaceBG = d.createBindGroup({
        layout: this.solveExternalSurfacePipe.getBindGroupLayout(0), entries: [
          { binding: 0, resource: e(this.positions) }, { binding: 1, resource: e(this.clothTriangles) },
          { binding: 2, resource: e(this.externalSurfaceCandidates) }, { binding: 3, resource: e(this.bodyTriangles) },
          { binding: 4, resource: e(this.bodyPositions) }, { binding: 5, resource: e(this.externalSurfaceCorrections) },
          { binding: 6, resource: e(this.lastPositions) }
        ]
      });
      this.gatherExternalSurfaceBG = d.createBindGroup({
        layout: this.gatherExternalSurfacePipe.getBindGroupLayout(0), entries: [
          { binding: 0, resource: e(this.clothTriangles) }, { binding: 1, resource: e(this.incidentTriangles) },
          { binding: 2, resource: e(this.externalSurfaceCorrections) }, { binding: 3, resource: e(this.correction) }
        ]
      });
    }
  }

  /** Rebuild the body buffers + spatial hash (body shape/pose changed). The hash itself is
   *  recomputed on the GPU at the start of the next step (externalDirty), mirroring the
   *  original's externalPositionsDirty flag. */
  private createBodySurfaceBVH(body: BodyMesh) {
    this.bodySurfaceBounds?.destroy();this.bodySurfaceOrdered?.destroy();
    this.bodyFeatureNormals?.destroy();
    const bvh=buildBodySurfaceBVH(body);
    this.currentBodyMesh=body;this.bodySurfaceBVHData=bvh;
    this.assemblyController?.setBody(body,bvh);
    const usage=GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.bodySurfaceBounds=this.buf(bvh.nodes,usage);
    this.bodySurfaceOrdered=this.buf(bvh.triangleIds,usage);
    this.bodyFeatureNormals=this.buf(buildBodyContactFeatureNormals(body),usage);
  }

  updateBodyMesh(body: BodyMesh) {
    this.stateGeneration++;
    this.latestCollisionPhases = [];
    this.latestCollisionSubsteps = [];
    this.latestCollisionTrajectory = [];
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.bodyPositions.destroy();
    this.bodyTriangles.destroy();
    this.bodyPositions = this.buf(body.positions, usage);
    this.bodyTriangles = this.buf(body.triangles, usage);
    this.createBodySurfaceBVH(body);
    // Previous closest points are valid upper bounds only for the same static body.
    this.device.queue.writeBuffer(this.bodyPointContacts, 0, new Float32Array(this.particleCount * 16));
    if (this.externalCollision) {
      const radiusChanged = this.measureBodyTriangleRadius(body) !== this.bodyTriangleRadius;
      this.bodyTriangleRadius = this.measureBodyTriangleRadius(body);
      const sizeChanged = body.numTriangles !== this.bodyTriangleCount;
      this.bodyTriangleCount = body.numTriangles;
      if (sizeChanged) {
        // Hash table size / buffer sizes are baked into the hash shaders and buffers.
        this.externalHashTableSize = this.config.externalHashTableMultiplier * Math.max(1, body.numTriangles) + 1;
        this.externalTriangleCenters.destroy();
        this.externalHashTable.destroy();
        this.externalHashPositions.destroy();
        this.createExternalHashBuffers();
        this.createExternalPipelines();
      } else if (radiusChanged) {
        this.createExternalPipelines();
      }
      this.createExternalBindGroups();
      this.externalDirty = true;
    } else {
      this.bodyTriangleCount = body.numTriangles;
    }
  }

  /** 1 = hold particles to their anchored (cached) drape; 0 = free, let it re-drape. */
  setAnchorScale(scale: number) {
    this.anchorScale = scale;
    this.device.queue.writeBuffer(this.simParams, 0, new Float32Array([scale, this.gravityScale, 0, 0]));
  }

  setGravityScale(scale: number) {
    if (!Number.isFinite(scale) || scale < 0) throw new Error('Gravity scale must be finite and nonnegative');
    this.gravityScale = scale;
    this.device.queue.writeBuffer(this.simParams, 0, new Float32Array([this.anchorScale, scale, 0, 0]));
  }

  get assemblySupportStates(): readonly AssemblySupportState[] { return this.assemblyController?.states ?? []; }
  get activeXYZAnchorCount(): number { return this.anchorScale > 0 ? this.anchorW.reduce((count,weight)=>count+Number(weight>0),0) : 0; }
  get requestedSewnUpTo(): number { return this.sewnUpToValue; }
  get seamActivation(): CollisionSeamActivation | null {
    return this.currentSeamActivation && {...this.currentSeamActivation,activeSeams:this.currentSeamActivation.activeSeams.slice()};
  }

  setSeamActivation(activation: CollisionSeamActivation): void {
    if(this.inFlight) throw new Error('Cannot mutate source sewing activation during a GPU frame');
    if(!this.seamGateLayout || !Number.isSafeInteger(activation.revision) || activation.revision<0) throw new Error('Source sewing activation is unavailable');
    const packed=packSeamGate(this.seamGateLayout,activation.sewnUpTo,activation.activeSeams,this.seamStitchIndices);
    this.currentSeamActivation={...activation,activeSeams:activation.activeSeams.slice()};
    this.sewnUpToValue=activation.sewnUpTo;
    this.device.queue.writeBuffer(this.seamGate,0,packed.buffer as ArrayBuffer,packed.byteOffset,packed.byteLength);
    if(this.assemblySupportData?.activationSeamCount!==undefined) this.assemblyController?.setSeamActivation(activation.activeSeams,activation.sewnUpTo,this.sourceStructuralStaging);
  }

  setSourceStructuralStagingEnabled(enabled:boolean):void {
    if(this.inFlight) throw new Error('Cannot change source assembly during a GPU frame');
    this.sourceStructuralStaging=enabled;
    if(this.currentSeamActivation) this.setSeamActivation(this.currentSeamActivation);
  }

  /** Preserve assembly progress when recreating an engine for live solver settings. */
  captureAssemblySupport(): AssemblySupportSnapshot | null {
    return this.assemblyController?.captureState() ?? null;
  }

  restoreAssemblySupport(snapshot: AssemblySupportSnapshot | null): void {
    if (!snapshot) return;
    if (!this.assemblyController || !this.supportTargets) throw new Error('Assembly support snapshot topology changed');
    this.assemblyController.restoreState(snapshot);
    const targets = this.assemblyController.targets;
    this.device.queue.writeBuffer(this.supportTargets, 0, targets.buffer as ArrayBuffer, targets.byteOffset, targets.byteLength);
  }

  resetAssemblySupport(active: boolean) {
    this.stateGeneration++;
    if (!this.assemblySupportData || !this.supportTargets) return;
    this.assemblyController = new AssemblySupportController({ ...this.assemblySupportData, activeOnStart: active }, this.config.timeStep,this.currentBodyMesh,this.bodySurfaceBVHData);
    this.assemblyController.refreshTargets(this.lastResetPositions);
    if (this.currentSeamActivation && this.assemblySupportData.activationSeamCount !== undefined)
      this.assemblyController.setSeamActivation(this.currentSeamActivation.activeSeams, this.currentSeamActivation.sewnUpTo, this.sourceStructuralStaging);
    const targets = this.assemblyController.targets;
    this.device.queue.writeBuffer(this.supportTargets, 0, targets.buffer as ArrayBuffer, targets.byteOffset, targets.byteLength);
  }

  /** GPU-only particle-history snapshot for fail-closed rollback, without inventing zero velocity. */
  captureState(): GPUBuffer {
    const bytes = this.particleCount * 16;
    const state = this.device.createBuffer({ size: bytes * 3, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.gateSnapshots.set(state,{prefix:this.sewnUpToValue,activation:this.seamActivation,structuralEnabled:this.sourceStructuralStaging});
    if(this.assemblyController) this.supportSnapshots.set(state,this.assemblyController.captureState());
    const encoder = this.device.createCommandEncoder();
    for (const [index, buffer] of [this.positions, this.lastPositions, this.velocities].entries()) {
      encoder.copyBufferToBuffer(buffer, 0, state, index * bytes, bytes);
    }
    this.device.queue.submit([encoder.finish()]);
    return state;
  }

  restoreState(state: GPUBuffer) {
    this.latestCollisionSubsteps = [];
    this.latestCollisionTrajectory = [];
    const bytes = this.particleCount * 16;
    if (state.size !== bytes * 3) throw new Error('Particle snapshot topology changed');
    const encoder = this.device.createCommandEncoder();
    for (const [index, buffer] of [this.positions, this.lastPositions, this.velocities].entries()) {
      encoder.copyBufferToBuffer(state, index * bytes, buffer, 0, bytes);
    }
    this.device.queue.submit([encoder.finish()]);
    const support=this.supportSnapshots.get(state);
    if(support && this.assemblyController && this.supportTargets) {
      this.assemblyController.restoreState(support);
      const targets=this.assemblyController.targets;
      this.device.queue.writeBuffer(this.supportTargets,0,targets.buffer as ArrayBuffer,targets.byteOffset,targets.byteLength);
    }
    this.supportSnapshots.delete(state);
    const gate=this.gateSnapshots.get(state);
    if (gate) this.sourceStructuralStaging = gate.structuralEnabled;
    if(gate?.activation) this.setSeamActivation(gate.activation);
    else if(gate) this.setSewnUpTo(gate.prefix);
    this.gateSnapshots.delete(state);
  }

  /** Runtime toggle for self-collision (e.g. off during a body-change re-drape to avoid curling). */
  setSelfCollisionEnabled(enabled: boolean) {
    this.selfCollisionRuntime = enabled;
  }

  /** Re-point the anchor targets at the given (freshly-settled) positions, preserving anchor weights.
   *  Used after a body-change re-drape so the garment then holds the NEW clean drape, not the old one. */
  setAnchors(positions: Float32Array) {
    const n = this.particleCount;
    const a = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      a[i * 4] = positions[i * 4];
      a[i * 4 + 1] = positions[i * 4 + 1];
      a[i * 4 + 2] = positions[i * 4 + 2];
      a[i * 4 + 3] = this.anchorW[i];
    }
    this.device.queue.writeBuffer(this.anchors, 0, a.buffer as ArrayBuffer, a.byteOffset, a.byteLength);
  }

  /** Interactive grab: pull particle `index` (and same-piece neighbours) toward world `pos`. */
  setGrab(grabbing: boolean, index: number, pos: [number, number, number], dragInfluenceRadius = 0.15) {
    this.device.queue.writeBuffer(
      this.dynamicConfig,
      0,
      new Float32Array([grabbing ? 1 : 0, index, dragInfluenceRadius, 0, pos[0], pos[1], pos[2], 0])
    );
  }

  /**
   * Close every stitch below `count` and leave the rest loose. `count >= stitchCount` is the
   * fully-sewn garment; 0 leaves every seam open with the panels hanging free.
   */
  setSewnUpTo(count: number) {
    const clamped = Math.max(0, Math.min(this.stitchCount, Math.round(count)));
    if(this.currentSeamActivation) this.setSeamActivation({...this.currentSeamActivation,sewnUpTo:clamped});
    else { this.sewnUpToValue=clamped; this.device.queue.writeBuffer(this.seamGate, 0, new Int32Array([clamped, 0, 0, 0])); }
  }

  /** Re-seed particle positions (vec4: x,y,z,invMass) and zero velocities — for Arrange/Reset. */
  resetPositions(positions: Float32Array) {
    this.latestGPUProfile = null;
    this.latestCollisionSubsteps = [];
    this.latestCollisionTrajectory = [];
    this.stateGeneration++;
    this.latestCollisionPhases = [];
    this.lastResetPositions=positions.slice();
    this.device.queue.writeBuffer(this.positions, 0, positions.buffer as ArrayBuffer, positions.byteOffset, positions.byteLength);
    this.device.queue.writeBuffer(this.velocities, 0, new Float32Array(this.particleCount * 4));
    this.device.queue.writeBuffer(this.lastPositions, 0, positions.buffer as ArrayBuffer, positions.byteOffset, positions.byteLength);
  }

  private wg(n: number): number {
    return Math.ceil(n / WORKGROUP_SIZE);
  }

  /** Run one frame (subSteps substeps) and return the latest particle positions (vec4 array). */
  async step(): Promise<Float32Array> {
    if (this.inFlight || this.disposalRequested) return new Float32Array(0);
    this.inFlight = true;
    this.latestCollisionPhases = [];
    const generation = this.stateGeneration;
    try {
      return await this.stepInner(generation);
    } finally {
      // Always clear in-flight, even if the GPU readback rejects (device lost / buffer destroyed mid
      // teardown). Otherwise every later step() short-circuits to empty and the sim loop busy-spins.
      this.inFlight = false;
      if (this.disposalRequested) this.destroyResources();
    }
  }

  private async stepInner(generation: number): Promise<Float32Array> {
    const startedAt = performance.now();
    const d = this.device;
    const encoder = d.createCommandEncoder();
    let pass = encoder.beginComputePass();
    this.gpuProfiler?.beginFrame(generation, this.profiledFrameIndex++);
    let timestampedPass = false;
    const profileStage = (stage: string, zeroBasedSubstep: number, contactIteration?: number) => {
      if (!this.gpuProfiler) return;
      const timestampWrites = this.gpuProfiler.timestampWrites({ stage, zeroBasedSubstep, contactIteration });
      if (timestampWrites || timestampedPass) {
        pass.end(); pass = encoder.beginComputePass({ timestampWrites });
        timestampedPass = !!timestampWrites;
      }
    };
    const pCount = this.wg(this.particleCount);
    const apply = () => {
      pass.setPipeline(this.applyPipe);
      pass.setBindGroup(0, this.applyBG);
      pass.dispatchWorkgroups(pCount);
      pass.setPipeline(this.resetPipe);
      pass.setBindGroup(0, this.resetBG);
      pass.dispatchWorkgroups(pCount);
    };

    // Rebuild the cloth-triangle spatial hash + gather each particle's near triangles from the
    // CURRENT positions. The original gathers this once per frame and reuses it across all substeps;
    // that is only stable near equilibrium. Because we re-settle/pull a cached drape (larger motion),
    // a once-per-frame set goes stale mid-frame and curls free edges, so we re-gather every
    // `selfCollisionGatherInterval` substeps (1 = every substep).
    const rebuildClothHash = () => {
      const tCount = this.wg(this.triangleCount);
      pass.setPipeline(this.triCentersPipe);
      pass.setBindGroup(0, this.triCentersBG);
      pass.dispatchWorkgroups(tCount);
      pass.setPipeline(this.clearPipe);
      pass.setBindGroup(0, this.clearHashTableBG);
      pass.dispatchWorkgroups(this.wg(this.hashTableSize));
      pass.setBindGroup(0, this.clearHashPositionsBG);
      pass.dispatchWorkgroups(tCount);
      pass.setPipeline(this.countPipe);
      pass.setBindGroup(0, this.countBG);
      pass.dispatchWorkgroups(tCount);
      pass.setPipeline(this.prefixSumPipe);
      pass.setBindGroup(0, this.prefixSumBG);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(this.fillPipe);
      pass.setBindGroup(0, this.fillBG);
      pass.dispatchWorkgroups(tCount);
      };
    const gatherSelf = () => {
      rebuildClothHash();
      pass.setPipeline(this.initSelfPipe);
      pass.setBindGroup(0, this.initSelfBG);
      pass.dispatchWorkgroups(pCount);
    };
    const gatherInterval = Math.max(1, this.config.selfCollisionGatherInterval ?? this.config.subSteps);
    const selfOn = this.selfCollision && this.selfCollisionRuntime;
    const solveStretch = () => {
      pass.setPipeline(this.distancePipe);
      for (const group of this.stretchGroups) {
        if (group.count === 0) continue;
        pass.setBindGroup(0, group.bindGroup);
        pass.dispatchWorkgroups(this.wg(group.count));
      }
    };

    // The body hash is static until the avatar changes. Particle candidates, however, must follow
    // the cloth while seams pull an initial arrangement through many centimetres within a frame.
    if (this.externalCollision) {
      if (this.externalDirty) {
        const bCount = this.wg(this.bodyTriangleCount);
        pass.setPipeline(this.triCentersPipe);
        pass.setBindGroup(0, this.extTriCentersBG);
        pass.dispatchWorkgroups(bCount);
        pass.setPipeline(this.clearPipe);
        pass.setBindGroup(0, this.extClearHashTableBG);
        pass.dispatchWorkgroups(this.wg(this.externalHashTableSize));
        pass.setBindGroup(0, this.extClearHashPositionsBG);
        pass.dispatchWorkgroups(bCount);
        pass.setPipeline(this.extCountPipe);
        pass.setBindGroup(0, this.extCountBG);
        pass.dispatchWorkgroups(bCount);
        pass.setPipeline(this.extPrefixSumPipe);
        pass.setBindGroup(0, this.extPrefixSumBG);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(this.extFillPipe);
        pass.setBindGroup(0, this.extFillBG);
        pass.dispatchWorkgroups(bCount);
        this.externalDirty = false;
      }
    }

    if (this.collisionTrajectoryPipe) {
      pass.setPipeline(this.collisionTrajectoryPipe);
      pass.setBindGroup(0, this.collisionTrajectoryGroups[0]);
      pass.dispatchWorkgroups(pCount);
    }
    for (let s = 0; s < this.config.subSteps; s++) {
      const observePhase = (stage: string) => {
        if (this.collisionPhaseSubstep < 0 || !this.collisionPhasePipe) return;
        const at = this.collisionPhaseRecords.findIndex(record => record.zeroBasedSubstep === s && record.stage === stage);
        if (at < 0) return;
        pass.setPipeline(this.collisionPhasePipe); pass.setBindGroup(0, this.collisionPhaseGroups[at]);
        pass.dispatchWorkgroups(Math.ceil(this.particleCount / 64));
        this.collisionPhaseSelfChunks?.capture(pass, at);
        this.collisionPhaseBodyChunks?.capture(pass, at);
        if (this.collisionPhaseSelfDiagnostics && this.collisionPhaseCandidatesPipe) {
          pass.setPipeline(this.collisionPhaseCandidatesPipe); pass.setBindGroup(0, this.collisionPhaseCandidatesGroups[at]);
          pass.dispatchWorkgroups(Math.ceil(this.triangleCount * (this.config.numInternalSurfaceCollisionConstraints ?? 32) / 64));
          pass.setPipeline(this.collisionPhasePipe); pass.setBindGroup(0, this.collisionPhaseCorrectionsGroups[at]);
          pass.dispatchWorkgroups(Math.ceil(this.triangleCount * 3 / 64));
        }
      };
      profileStage('particle-hash-gather', s);
      observePhase('start');
      // Re-gather near triangles against the latest positions at the chosen cadence.
      if (selfOn && s % gatherInterval === 0) gatherSelf();

      profileStage('prediction', s);
      pass.setPipeline(this.integratePipe);
      pass.setBindGroup(0, this.integrateBG);
      pass.dispatchWorkgroups(pCount);
      observePhase('prediction');

      profileStage('stretch', s);
      solveStretch();
      observePhase('stretch');
      // "Use bending" toggle: skip the bending-constraint passes entirely when disabled.
      profileStage('bending', s);
      if (this.config.useBending !== false) {
        pass.setPipeline(this.bendPipe);
        for (const g of this.bendGroups) {
          if (g.count === 0) continue;
          pass.setBindGroup(0, g.bindGroup);
          pass.dispatchWorkgroups(this.wg(g.count));
        }
      }

      observePhase('bending');

      // Cloth self-collision (edge + face) — stops panels folding through each other.
      profileStage('particle-self', s);
      if (selfOn) {
        pass.setPipeline(this.solveSelfPipe);
        pass.setBindGroup(0, this.solveSelfBG);
        pass.dispatchWorkgroups(pCount);
        apply();
      }

      observePhase('particle-self');

      // Seam constraints: run several Jacobi iterations so weakly-linked joins (the short
      // waistband-centre seam) close fast enough to hold panels together under an interactive drag.
      profileStage('sewing', s);
      const seamIters = Math.max(1, this.config.seamIterations ?? 1);
      for (let si = 0; si < seamIters; si++) {
        // Source stitches and their authored panel edges share one constraint solve. Restore
        // fabric lengths between sewing iterations instead of allowing all joins to pull
        // against only one preceding stretch pass. Native dispatch order stays unchanged.
        if (this.interleaveSourceStretch && si > 0) solveStretch();
        pass.setPipeline(this.seamPipe);
        pass.setBindGroup(0, this.seamBG);
        pass.dispatchWorkgroups(pCount);
        apply();
      }

      observePhase('sewing');

      profileStage('support', s);
      if (this.supportPipe && this.supportBG) {
        pass.setPipeline(this.supportPipe); pass.setBindGroup(0, this.supportBG);
        pass.dispatchWorkgroups(Math.ceil(this.particleCount / 64));
      }

      observePhase('support');

      const substepContacts=this.config.substepContactIterations ?? 1;
      const contactIterations=s===this.config.subSteps-1 ? Math.max(substepContacts,this.config.finalContactIterations ?? 1) : substepContacts;
      if(selfOn && this.config.handleSelfSurfaceCollisions!==false) {
        // Pair history is scoped to this actual prediction substep, never a preceding frame or
        // rollback. Dispatch ordering completes this clear before any gather/atomic seed reads.
        pass.setPipeline(this.clearPipe);pass.setBindGroup(0,this.selfSurfaceSeedResetBG);
        pass.dispatchWorkgroups(this.wg(this.triangleCount*(this.config.numInternalSurfaceCollisionConstraints??32)));
      }
      // Finish collision constraints without reapplying stretch, sewing, gravity or support.
      // Calculate velocity only after these corrections, preserving particle history.
      for(let contactIteration=0;contactIteration<contactIterations;contactIteration++) {
      // Finite cloth-face contacts also inspect seam particles and coarse interiors. Only true
      // local, fully closed sewing neighborhoods may overlap; remote joined panels still collide.
      if (selfOn && this.config.handleSelfSurfaceCollisions !== false) {
        {
          profileStage('self-refit', s, contactIteration);
          pass.setPipeline(this.selfSurfaceBoundsPipe); pass.setBindGroup(0, this.selfSurfaceBoundsBG);
          pass.dispatchWorkgroups(this.wg(this.selfSurfaceNodeCount));
          // Leaves finish first. Separate depth dispatches make every parent read completed
          // children, preserving the exact current/previous finite AABBs without float atomics.
          pass.setPipeline(this.selfSurfaceParentPipe);
          for (const level of this.selfSurfaceParentGroups) {
            pass.setBindGroup(0, level.bindGroup); pass.dispatchWorkgroups(this.wg(level.count));
          }
          profileStage('self-gather', s, contactIteration);
          pass.setPipeline(this.initSelfSurfacePipe); pass.setBindGroup(0, this.initSelfSurfaceBG);
          pass.dispatchWorkgroups(this.wg(this.triangleCount));
        }
        observePhase(`contact-${contactIteration + 1}-self-gather`);
        profileStage('self-seam-proof', s, contactIteration);
        if (this.surfaceSeamCount) {
          pass.setPipeline(this.surfaceSeamGapsPipe); pass.setBindGroup(0, this.surfaceSeamGapsBG);
          pass.dispatchWorkgroups(this.surfaceSeamCount);
        }
        profileStage('self-solve', s, contactIteration);
        pass.setPipeline(this.solveSelfSurfacePipe); pass.setBindGroup(0, this.solveSelfSurfaceBG);
        pass.dispatchWorkgroups(this.wg(this.triangleCount));
        profileStage('self-collect-apply', s, contactIteration);
        pass.setPipeline(this.selfSurfaceGatherPipe); pass.setBindGroup(0, this.selfSurfaceGatherBG);
        pass.dispatchWorkgroups(pCount); apply();
      }

      observePhase(`contact-${contactIteration + 1}-self-surface`);

      // Gather after the stretch/seam moves, before resolving body contacts.
      observePhase(`contact-${contactIteration + 1}-body-input`);
      if (this.externalCollision) {
        if (this.config.handleExternalSurfaceCollisions !== false && this.triangleCount > 0) {
          // Query actual current/previous finite bounds after all constraint moves, every substep.
          profileStage('body-face-gather', s, contactIteration);
          pass.setPipeline(this.initExternalSurfacePipe);
          pass.setBindGroup(0, this.initExternalSurfaceBG);
          pass.dispatchWorkgroups(this.wg(this.triangleCount));
          observePhase(`contact-${contactIteration + 1}-body-gather`);
          profileStage('body-face-solve', s, contactIteration);
          pass.setPipeline(this.solveExternalSurfacePipe);
          pass.setBindGroup(0, this.solveExternalSurfaceBG);
          pass.dispatchWorkgroups(this.wg(this.triangleCount));
          profileStage('body-face-collect-apply', s, contactIteration);
          pass.setPipeline(this.gatherExternalSurfacePipe);
          pass.setBindGroup(0, this.gatherExternalSurfaceBG);
          pass.dispatchWorkgroups(pCount);
          apply();
        }
        observePhase(`contact-${contactIteration + 1}-body-surface`);
        // Face corrections can move a shared vertex through skin. Re-query the actual finite
        // nearest feature AFTER their application on every finishing iteration.
        profileStage('body-point-gather', s, contactIteration);
        pass.setPipeline(this.initExternalPipe);
        pass.setBindGroup(0, this.initExternalBG);
        pass.dispatchWorkgroups(pCount);
        profileStage('body-point-solve-apply', s, contactIteration);
        pass.setPipeline(this.solveExternalPipe);
        pass.setBindGroup(0, this.solveExternalBG);
        pass.dispatchWorkgroups(pCount);
        apply();
      }
      if (!this.externalCollision) observePhase(`contact-${contactIteration + 1}-body-surface`);
      observePhase(`contact-${contactIteration + 1}-body-point`);

      }

      profileStage('velocity-damping-trace', s);
      pass.setPipeline(this.velocityPipe);
      pass.setBindGroup(0, this.velocityBG);
      pass.dispatchWorkgroups(pCount);

      // Local damping: damp velocities toward the whole-garment rigid-body motion (single-workgroup
      // reduction + per-particle apply). Original position: after calculateVelocities, before
      // nearDamping; skipped entirely at the default localDamping = 0.
      if (this.config.localDamping > 0) {
        pass.setPipeline(this.computeDampingPipe);
        pass.setBindGroup(0, this.computeDampingBG);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(this.applyLocalDampingPipe);
        pass.setBindGroup(0, this.applyLocalDampingBG);
        pass.dispatchWorkgroups(pCount);
      }

      // Near-damping: pull each particle's velocity toward its 8-neighbour rigid-body motion so a
      // pull propagates coherently instead of tearing the cloth apart.
      if (this.config.nearDamping > 0) {
        pass.setPipeline(this.nearDampingPipe);
        pass.setBindGroup(0, this.nearDampingBG);
        pass.dispatchWorkgroups(pCount);
      }
      observePhase('final');
      if (this.collisionTrajectoryPipe) {
        pass.setPipeline(this.collisionTrajectoryPipe);
        pass.setBindGroup(0, this.collisionTrajectoryGroups[s + 1]);
        pass.dispatchWorkgroups(pCount);
      }
    }
    pass.end();
    this.gpuProfiler?.encodeResolve(encoder);
    if (this.collisionTrajectory && this.collisionTrajectoryReadback) {
      encoder.copyBufferToBuffer(this.collisionTrajectory, 0, this.collisionTrajectoryReadback, 0, this.particleCount * 16 * (this.config.subSteps + 1));
    }
    if (this.collisionPhaseSubstep >= 0 && this.collisionPhaseBuffer && this.collisionPhaseReadback) {
      encoder.copyBufferToBuffer(this.collisionPhaseBuffer, 0, this.collisionPhaseReadback, 0,
        this.particleCount * 16 * this.collisionPhaseStages.length);
    }
    if (this.collisionPhaseSubstep >= 0) {
      this.collisionPhaseSelfChunks?.encodeReadback(encoder);
      this.collisionPhaseBodyChunks?.encodeReadback(encoder);
    }
    if (this.collisionPhaseSelfDiagnostics && this.collisionPhaseCandidates && this.collisionPhaseCandidatesReadback
      && this.collisionPhaseCorrections && this.collisionPhaseCorrectionsReadback) {
      encoder.copyBufferToBuffer(this.collisionPhaseCandidates, 0, this.collisionPhaseCandidatesReadback, 0,
        this.collisionPhaseRecords.length * this.triangleCount * (this.config.numInternalSurfaceCollisionConstraints ?? 32) * 4);
      encoder.copyBufferToBuffer(this.collisionPhaseCorrections, 0, this.collisionPhaseCorrectionsReadback, 0,
        this.collisionPhaseRecords.length * this.triangleCount * 48);
    }

    encoder.copyBufferToBuffer(this.positions, 0, this.readback, 0, this.particleCount * 16);
    d.queue.submit([encoder.finish()]);
    const submittedAt = performance.now();
    // Start the independent diagnostic read even if a later position/trace map fails. Its helper
    // always unmaps and returns to idle; physical readback failures keep their original semantics.
    const profileRead = this.gpuProfiler?.readFrame(generation,
      () => !this.disposalRequested && generation === this.stateGeneration)
      .then(report => { this.latestGPUProfile = report; })
      .catch(() => { this.latestGPUProfile = null; });
    await this.readback.mapAsync(GPUMapMode.READ);
    const mappedAt = performance.now();
    await this.finishTrajectoryReadback(generation);
    await this.finishPhaseReadback(generation);
    await profileRead;
    const tracedAt = performance.now();
    const out = this.finishReadback(generation);
    const finishedAt = performance.now();
    if (!this.disposalRequested && generation === this.stateGeneration) {
      this.stepTiming = { encodingMs: submittedAt - startedAt, readbackWaitMs: mappedAt - submittedAt,
        trajectoryReadbackMs: tracedAt - mappedAt,
        positionReadbackMs: Math.max(0, finishedAt - tracedAt - this.readbackControllerMs),
        controllerMs: this.readbackControllerMs, totalMs: finishedAt - startedAt };
    }
    return out;
  }

  private async finishTrajectoryReadback(generation: number): Promise<void> {
    if (!this.collisionTrajectoryReadback) return;
    try {
      await this.collisionTrajectoryReadback.mapAsync(GPUMapMode.READ);
      let copy: Float32Array;
      try { copy = new Float32Array(this.collisionTrajectoryReadback.getMappedRange().slice(0)); }
      finally { this.collisionTrajectoryReadback.unmap(); }
      if (!this.disposalRequested && generation === this.stateGeneration) {
        this.latestCollisionTrajectory = Array.from({ length: this.config.subSteps + 1 }, (_, index) => copy.subarray(index * this.particleCount * 4, (index + 1) * this.particleCount * 4));
        this.latestCollisionSubsteps = this.latestCollisionTrajectory.slice(1);
      }
    } catch (error) {
      // The primary readback was mapped first. A failed optional second map must not leave it
      // mapped, which would invalidate every later copy/reset after this failure.
      this.readback.unmap();
      this.latestCollisionSubsteps = [];
      this.latestCollisionTrajectory = [];
      throw error;
    }
  }

  private async finishPhaseReadback(generation: number): Promise<void> {
    if (this.collisionPhaseSubstep < 0 || !this.collisionPhaseReadback) return;
    try {
      await this.collisionPhaseReadback.mapAsync(GPUMapMode.READ);
      let copy: Float32Array;
      try { copy = new Float32Array(this.collisionPhaseReadback.getMappedRange().slice(0)); }
      finally { this.collisionPhaseReadback.unmap(); }
      let candidates: Uint32Array | undefined, corrections: Float32Array | undefined;
      if (this.collisionPhaseSelfDiagnostics && this.collisionPhaseCandidatesReadback && this.collisionPhaseCorrectionsReadback) {
        await this.collisionPhaseCandidatesReadback.mapAsync(GPUMapMode.READ);
        try { candidates = new Uint32Array(this.collisionPhaseCandidatesReadback.getMappedRange().slice(0)); }
        finally { this.collisionPhaseCandidatesReadback.unmap(); }
        await this.collisionPhaseCorrectionsReadback.mapAsync(GPUMapMode.READ);
        try { corrections = new Float32Array(this.collisionPhaseCorrectionsReadback.getMappedRange().slice(0)); }
        finally { this.collisionPhaseCorrectionsReadback.unmap(); }
      }
      const selfChunks = await this.collisionPhaseSelfChunks?.readback();
      const bodyChunks = await this.collisionPhaseBodyChunks?.readback();
      const candidateWords = this.triangleCount * (this.config.numInternalSurfaceCollisionConstraints ?? 32);
      const correctionFloats = this.triangleCount * 12;
      if (!this.disposalRequested && generation === this.stateGeneration) {
        this.latestCollisionPhases = this.collisionPhaseRecords.map(({ stage, zeroBasedSubstep }, index) => ({
          substep: zeroBasedSubstep + 1, zeroBasedSubstep, stage,
          positions: copy.subarray(index * this.particleCount * 4, (index + 1) * this.particleCount * 4),
          ...(selfChunks?.get(index) ? {
            selfSurfaceCandidates: selfChunks.get(index)!.candidates,
            selfSurfaceCorrections: selfChunks.get(index)!.corrections,
            selfSurfaceCandidateBudget: this.config.numInternalSurfaceCollisionConstraints ?? 32,
            selfSurfaceTriangleCount: this.triangleCount
          } : {}),
          ...(bodyChunks?.get(index) ? {
            externalSurfaceCandidates: bodyChunks.get(index)!.candidates,
            externalSurfaceCorrections: bodyChunks.get(index)!.corrections,
            externalSurfaceCandidateBudget: this.config.numExternalSurfaceCollisionConstraints ?? 128,
            externalSurfaceTriangleCount: this.triangleCount
          } : {}),
          ...(candidates && corrections ? {
            selfSurfaceCandidates: candidates.subarray(index * candidateWords, (index + 1) * candidateWords),
            selfSurfaceCorrections: corrections.subarray(index * correctionFloats, (index + 1) * correctionFloats),
            selfSurfaceCandidateBudget: this.config.numInternalSurfaceCollisionConstraints ?? 32,
            selfSurfaceTriangleCount: this.triangleCount
          } : {})
        }));
        this.collisionPhaseSubstep = -1;
      }
    } catch (error) {
      this.readback.unmap(); this.latestCollisionPhases = [];
      throw error;
    }
  }

  private finishReadback(generation: number): Float32Array {
    const out = new Float32Array(this.readback.getMappedRange().slice(0));
    this.readback.unmap();
    const controllerStartedAt = performance.now();
    if (!this.disposalRequested && generation === this.stateGeneration && this.assemblyController?.advance(out) && this.supportTargets) {
      const targets = this.assemblyController.targets;
      this.device.queue.writeBuffer(this.supportTargets, 0, targets.buffer as ArrayBuffer, targets.byteOffset, targets.byteLength);
    }
    this.readbackControllerMs = performance.now() - controllerStartedAt;
    return out;
  }

  dispose() {
    if (this.disposalRequested) return;
    this.disposalRequested = true;
    this.stateGeneration++;
    this.latestCollisionPhases = [];
    if (!this.inFlight) this.destroyResources();
  }

  private destroyResources() {
    if (this.resourcesDisposed) return;
    this.resourcesDisposed = true;
    this.collisionPhaseSelfChunks?.destroy();
    this.collisionPhaseBodyChunks?.destroy();
    void this.gpuProfiler?.dispose();
    for (const buffer of [this.supportTargets, this.supportParams, this.collisionTrajectory, this.collisionTrajectoryReadback, this.collisionTrajectoryParams,
      this.collisionPhaseBuffer, this.collisionPhaseReadback, this.collisionPhaseParams,
      this.collisionPhaseCandidates, this.collisionPhaseCandidatesReadback,
      this.collisionPhaseCorrections, this.collisionPhaseCorrectionsReadback]) buffer?.destroy();
    for (const b of [this.positions, this.velocities, this.lastPositions, this.correction, this.anchors, this.simParams, this.positions2d, this.dynamicConfig, this.seams, this.seamOrder, this.seamGate,
      this.readback, this.bodyPositions, this.bodyTriangles, this.bodyPointContacts, this.bodyFeatureNormals,
      this.bodySurfaceBounds,this.bodySurfaceOrdered,this.selfSurfaceBounds,this.selfSurfaceOrdered,this.selfSurfaceRanges,this.selfSurfaceParentIds,this.selfSurfaceParentParams, this.selfSurfaceCandidates, this.selfSurfaceCorrections, this.selfSurfaceTopology, this.surfaceSeamLinks, this.surfaceSeamGaps,
      this.externalTriangleCenters, this.externalHashTable, this.externalHashPositions, this.externalNearTriangles,
      this.externalSurfaceCandidates, this.externalSurfaceCorrections, this.dampingState,
      this.clothTriangles, this.triangleCenters, this.particleLayers, this.hashTable, this.hashPositions, this.nearTriangles, this.neighborIndices, this.incidentTriangles]) {
      try { b?.destroy(); } catch { /* ignore */ }
    }
    for (const g of [...this.stretchGroups, ...this.bendGroups]) { g.edges.destroy(); g.props.destroy(); }
  }
}
