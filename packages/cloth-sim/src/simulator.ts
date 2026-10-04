// Orchestrates the cloth simulation. prepare() does all GPU-free work (triangulate + arrange +
// assemble sim data + body mesh packing) so the avatar and arranged panels render even without
// WebGPU; the live XPBD drape (ClothSimulation) is created on demand once a GPU device is available.

import type { Pattern } from '@seamer/pattern-model';
import {
  indexPoints,
  pieceTransform
} from '@seamer/pattern-model/utils/patternGeometry';
import type { CylinderFrame } from './geometry/cylinders';
import { buildPieceCloth, buildSavedCloth, reuseSavedDrape, reuseSavedSurface, computeSeamEdgeIntervals } from './geometry/boundary';
import { arrangeParticles } from './geometry/arrangement';
import { buildSimData, type SimData, type ArrangedPiece } from './build';
import { ClothEngine, type BodyMesh, type ClothStepPerformance, type CollisionPhaseObservation } from './webgpu/engine';
import type { CollisionProfileReport } from './webgpu/CollisionTimestampProfiler';
import { SIM_CONFIG, type SimConfig } from './config';
import { kabschRigid, applyRigid } from './refit';
import { buildSourceStagingPlan, SourceStagingController, type SourceStagingSnapshot, type SourceAssemblyState } from './sourceStaging';
import { physicalSeamStitchIndices } from './webgpu/seamGate';
import { sourceAssemblyTopologyIdentity } from './sourceAssemblyTopology';
import { refineSourceGatherArrangement, type GatherBuildScope } from './sourceGatherRefinement';
import { prepareGarmentCodeAssembly, type AssemblySupportState, type AssemblySupportSnapshot } from './assembly';
import { activeGarmentCodeBody } from '@seamer/avatar';
import { ClothCollisionGuard, failedCollisionTrajectoryReport, type CollisionGuardInput, type CollisionGuardReport, type CollisionSeamActivation } from './collisionGuard';
import { CollisionGuardWorker } from './collisionGuardWorker';
import { applySourceContactPolicy, inferSourceContactPolicy, type SourceContactPolicy, type SourceContactConfigOptions } from './contactConfig';
export type { SourceContactConfigOptions } from './contactConfig';
export type { CollisionProfileReport, CollisionProfileRecord, CollisionProfileStage } from './webgpu/CollisionTimestampProfiler';

export interface ClothFramePerformance extends ClothStepPerformance {
  workerProofMs: number;
  totalFrameMs: number;
}

export interface PreparedCloth {
  simData: SimData;
  body: BodyMesh;
  /** Valid source-body garments fail closed when a step intersects the body or distant cloth. */
  collisionSafety?: boolean;
  /** Material target only; live solver settings are resolved when the GPU simulation starts. */
  contactPolicy?: SourceContactPolicy;
}

export interface SourceAssemblySnapshot {
  readonly topology: string;
  readonly controller: SourceStagingSnapshot | null;
  readonly requestedActivation: CollisionSeamActivation;
  readonly acceptedState: SourceAssemblyState | null;
  readonly lastAcceptedActivation: CollisionSeamActivation | null;
}
const cloneActivation = (value: CollisionSeamActivation): CollisionSeamActivation =>
  ({ ...value, activeSeams: value.activeSeams.slice() });
const cloneSourceState = (value: SourceAssemblyState): SourceAssemblyState =>
  ({ ...value, activeSeamMask: value.activeSeamMask.slice(), activeStitchMask: value.activeStitchMask.slice() });

export class CollisionSafetyError extends Error {
  readonly candidateSeamActivation: CollisionSeamActivation | null;
  readonly candidateSourceAssemblyState: SourceAssemblyState | null;
  readonly candidatePositions: Float32Array | null;
  readonly candidateTrajectory: readonly Float32Array[] | null;
  readonly candidatePhases: readonly CollisionPhaseObservation[] | null;
  readonly candidateGPUStageProfile: Readonly<CollisionProfileReport> | null;
  constructor(readonly report: CollisionGuardReport, candidatePositions?: Float32Array,
    candidateTrajectory?: readonly Float32Array[], candidatePhases?: readonly CollisionPhaseObservation[],
    candidateGPUStageProfile?: Readonly<CollisionProfileReport> | null,
    candidateSeamActivation?: CollisionSeamActivation | null, candidateSourceAssemblyState?: SourceAssemblyState | null) {
    super(report.trajectory?.valid === false
      ? `Simulation paused: the solver trajectory could not be verified (${report.trajectory.invalidReason ?? 'invalid trace'}).`
      : 'Simulation paused: the candidate garment intersects the body or another cloth surface.');
    this.name = 'CollisionSafetyError';
    this.candidateSeamActivation = candidateSeamActivation ? cloneActivation(candidateSeamActivation) : null;
    this.candidateSourceAssemblyState = candidateSourceAssemblyState ? cloneSourceState(candidateSourceAssemblyState) : null;
    this.candidatePositions = candidatePositions?.slice() ?? null;
    this.candidateTrajectory = candidateTrajectory?.map(sample => sample.slice()) ?? null;
    this.candidatePhases = candidatePhases?.length
      ? candidatePhases.map(phase => ({ ...phase, positions: phase.positions.slice(),
        ...(phase.selfSurfaceCandidates ? { selfSurfaceCandidates: phase.selfSurfaceCandidates.slice() } : {}),
        ...(phase.selfSurfaceCorrections ? { selfSurfaceCorrections: phase.selfSurfaceCorrections.slice() } : {}),
        ...(phase.externalSurfaceCandidates ? { externalSurfaceCandidates: phase.externalSurfaceCandidates.slice() } : {}),
        ...(phase.externalSurfaceCorrections ? { externalSurfaceCorrections: phase.externalSurfaceCorrections.slice() } : {}) })) : null;
    this.candidateGPUStageProfile = candidateGPUStageProfile
      ? { ...candidateGPUStageProfile, selectedZeroBasedSubsteps: candidateGPUStageProfile.selectedZeroBasedSubsteps.slice(),
        records: candidateGPUStageProfile.records.map(record => ({ ...record })) } : null;
  }
}

/**
 * Use the prepared assembly arrangement for a first live drape while leaving the prepared
 * saved-drape positions available to the static renderer. Saved positions are a display/reuse seed
 * sampled onto rebuilt topology; they need not satisfy that topology's XPBD rest lengths. The
 * arrangement is built from the same topology and is therefore the stable live-solver seed.
 * Valid GarmentCode bodies additionally use skin-clearance shoulder placement and temporary Y support.
 */
export function fromArrangement(prepared: PreparedCloth): PreparedCloth {
  const positions = prepared.simData.arrangedPositions.slice();
  const anchors = new Float32Array(positions.length);
  for (let index = 0; index < positions.length; index += 4) {
    anchors[index] = positions[index];
    anchors[index + 1] = positions[index + 1];
    anchors[index + 2] = positions[index + 2];
    // Saved XYZ anchors stay released; source sewing supports have their own measured release.
    anchors[index + 3] = 0;
  }
  return {
    body: prepared.body,
    collisionSafety: prepared.collisionSafety,
    contactPolicy: prepared.contactPolicy,
    simData: {
      ...prepared.simData,
      positions,
      anchors,
      sourceStaging: prepared.simData.arrangementSourceStaging ?? prepared.simData.sourceStaging,
      assemblySupport: prepared.simData.assemblySupport
        ? { ...prepared.simData.assemblySupport, activeOnStart: true }
        : undefined
    }
  };
}

/** Static checkpoint previews keep their saved positions. Starting an unfinished free source
 * checkpoint uses coherent fresh assembly instead of pulling body-trapped seams with Y supports.
 * A closed checkpoint or an explicit saved XYZ hold retains its existing live seed. */
export function selectInitialSimulationState(prepared: PreparedCloth): PreparedCloth {
  const data = prepared.simData, support = data.assemblySupport;
  if (!prepared.collisionSafety || !support || support.activeOnStart) return prepared;
  for (let i = 3; i < data.anchors.length; i += 4) if (data.anchors[i] !== 0) return prepared;
  for (const group of support.groups) {
    for (let i = 0; i < group.seamPairs.length; i += 2) {
      const a = group.seamPairs[i] * 4, b = group.seamPairs[i + 1] * 4;
      const gap = Math.hypot(data.positions[a] - data.positions[b], data.positions[a + 1] - data.positions[b + 1], data.positions[a + 2] - data.positions[b + 2]);
      if (!Number.isFinite(gap) || gap > group.releaseGapM) return fromArrangement(prepared);
    }
  }
  return prepared;
}

/** Pack the avatar mesh into the engine's vec4 layout (positions x,y,z,0; triangles i0,i1,i2,0).
 *  The body broad-phase itself (a triangle spatial hash) is built on the GPU, like the original. */
export function packBodyMesh(vertexPositions: Float32Array, indices: Uint32Array): BodyMesh {
  const numVerts = vertexPositions.length / 3;
  const numTris = indices.length / 3;
  const positions = new Float32Array(numVerts * 4);
  for (let i = 0; i < numVerts; i++) {
    positions[i * 4] = vertexPositions[i * 3];
    positions[i * 4 + 1] = vertexPositions[i * 3 + 1];
    positions[i * 4 + 2] = vertexPositions[i * 3 + 2];
  }
  const triangles = new Uint32Array(numTris * 4);
  for (let t = 0; t < numTris; t++) {
    triangles[t * 4] = indices[t * 3];
    triangles[t * 4 + 1] = indices[t * 3 + 1];
    triangles[t * 4 + 2] = indices[t * 3 + 2];
  }
  return { positions, triangles, numTriangles: numTris };
}

export interface PrepareInit {
  pattern: Pattern;
  avatarVertices: Float32Array; // posed, meters
  avatarIndices: Uint32Array;
  cylinders: Map<string, CylinderFrame>;
}


/** GPU-free: triangulate + arrange every dynamic piece, assemble sim data + body collision grid.
 *  Topology always comes from the live pattern (so explicit seams attach via edgeParticles) and a
 *  cached drape only seeds particle positions, like the source. `fromArrangement` forces the
 *  fresh first-drape pipeline: ignore the cached drape and seed from the prepared assembly
 *  arrangement, so the solver drapes live. `changedPieces` is kept for API compatibility (edits
 *  now flow through the same reuse path as unedited pieces). */
export function prepareCloth(
  init: PrepareInit,
  opts: { fromArrangement?: boolean; changedPieces?: Set<string>; sourceGatherScope?: GatherBuildScope } = {}
): PreparedCloth | null {
  const { pattern, cylinders } = init;
  const arranged: ArrangedPiece[] = [];
  const points = indexPoints(pattern);
  // Seam-matched sub-segmentation: both sides of every seam resample to equal interval counts so
  // the sim links particles 1:1 (the original's boundary slicing at seam-range boundaries).
  const edgeIntervals = computeSeamEdgeIntervals(pattern);
  for (const piece of pattern.pieces) {
    if (piece.type !== 'dynamic' || piece.settings3d.enable3d === false) continue;

    // Production pipeline: topology ALWAYS comes from the live pattern (buildPieceCloth, whose
    // per-PiecePath edgeParticles let explicit seams attach), and a cached drape only seeds particle
    // POSITIONS via the source's 3-way reuse below. Building topology from the saved blob instead
    // (buildSavedCloth) leaves edgeParticles empty — seams can't link such pieces, and a free-running
    // garment falls apart (it only held together via the anchor hold + proximity sewing).
    const pdOverride = pattern.settings3d.globalParticleDistanceOverride;
    const cloth = buildPieceCloth(pattern, piece, pdOverride && pdOverride > 0 ? pdOverride : undefined, edgeIntervals);
    if (!cloth || cloth.mesh.points.length < 3) {
      // Fallback for degenerate 2D path data: rebuild from the saved blob (no edgeParticles —
      // the proximity-sewing pass covers these).
      const savedCloth = opts.fromArrangement ? null : buildSavedCloth(piece);
      if (savedCloth) {
        const arranged3d = arrangeParticles(savedCloth.cloth.mesh.points, piece.settings3d.arrangement, cylinders.get(piece.settings3d.arrangement.cylinderName) ?? null, {
          flipNormals: piece.settings3d.flipNormals
        });
        arranged.push({ cloth: savedCloth.cloth, positions3d: savedCloth.positions3d, frozen: piece.settings3d.frozen, fromSaved: true, boundaryLocal: savedCloth.boundaryParticles, arranged3d });
      }
      continue;
    }
    const arranged3d = arrangeParticles(cloth.mesh.points, piece.settings3d.arrangement, cylinders.get(piece.settings3d.arrangement.cylinderName) ?? null, {
      flipNormals: piece.settings3d.flipNormals
    });

    // Current Seamer caches key by placed-plan coordinates. SeamScape v0.0.1 instead stored a
    // piece-local indexed 2D surface and restored onto newly-triangulated topology by barycentric
    // projection. Keep those paths separate: treating the legacy surface as nearest-neighbour data
    // is what caused torn/bridged panels in converted projects.
    const toPlan = pieceTransform(piece, points);
    const reusePoints = cloth.mesh.points.map(toPlan);
    let reuse: { positions3d: Float32Array } | null = null;
    if (!opts.fromArrangement && piece.settings3d.savedMeshSnapshot?.coordinateSpace === 'piece-local') {
      const radians = -((piece.rotation ?? 0) * Math.PI) / 180;
      const cos = Math.cos(radians), sin = Math.sin(radians);
      const originX = piece.position?.x ?? 0, originY = piece.position?.y ?? 0;
      const localPoints = reusePoints.map((point) => {
        const dx = point.x - originX, dy = point.y - originY;
        let x = dx * cos - dy * sin;
        let y = dx * sin + dy * cos;
        if (piece.mirrorX) x = -x;
        if (piece.mirrorY) y = -y;
        return { x, y };
      });
      const surface = reuseSavedSurface(localPoints, piece.settings3d.savedPositions, piece.settings3d.savedMeshSnapshot);
      if (surface && surface.safeCoverage >= 0.5) reuse = surface;
    } else if (!opts.fromArrangement) {
      reuse = reuseSavedDrape(reusePoints, piece.settings3d.savedPositions, cloth.particleDistanceMm)
        // Compatibility with drapes saved by earlier studio builds, which wrote drafting coordinates.
        ?? reuseSavedDrape(cloth.mesh.points, piece.settings3d.savedPositions, cloth.particleDistanceMm);
    }
    if (reuse) {
      arranged.push({
        cloth,
        positions3d: reuse.positions3d,
        arranged3d,
        frozen: piece.settings3d.frozen,
        fromSaved: true,
        boundaryLocal: cloth.mesh.boundary
      });
      continue;
    }

    // Never-draped (or the edit changed the shape too much to reuse / fromArrangement): seed from the
    // cylinder arrangement and simulate.
    arranged.push({ cloth, positions3d: arranged3d, frozen: piece.settings3d.frozen, fromSaved: false });
  }
  if (arranged.length === 0) return null;
  // Saved-drape cloths carry no edgeParticles (boundary.ts builds them with an empty map), so
  // explicit seam links can't attach to them — proximity sewing is what keeps those garments
  // connected. Enable it exactly in that case; fresh arrangements keep explicit-seams-only
  // (source parity).
  const proximitySeams = arranged.some((a) => a.cloth.edgeParticles.size === 0);
  const baselineData = buildSimData(pattern, arranged, { proximitySeams });
  const gather = opts.sourceGatherScope ? refineSourceGatherArrangement(pattern, arranged, baselineData, opts.sourceGatherScope) : null;
  const simData = gather ? buildSimData(pattern, gather.arranged, { proximitySeams }) : baselineData;
  if (gather) {
    simData.sourceGatherRefinement = gather.policy;
    simData.sourceGatherCollisionGeometry = { ...gather.geometry, sourceMaterialCoordinates: simData.positions2d.slice(), sourceCoordinateStride: 4 };
  }
  // fixTop (debug): pin each piece's topmost particles in place (invMass 0) while simulating
  if (pattern.settings3d.fixTop) {
    for (const sp of simData.pieces) {
      let maxY = -Infinity;
      for (let i = 0; i < sp.count; i++) maxY = Math.max(maxY, simData.positions[(sp.start + i) * 4 + 1]);
      for (let i = 0; i < sp.count; i++) {
        const g = sp.start + i;
        if (simData.positions[g * 4 + 1] >= maxY - 0.02) {
          simData.positions[g * 4 + 3] = 0;
          simData.arrangedPositions[g * 4 + 3] = 0;
        }
      }
    }
  }
  const body = packBodyMesh(init.avatarVertices, init.avatarIndices);
  const freshArrangement = !arranged.some(piece => piece.fromSaved);
  const arrangementSourceStaging = buildSourceStagingPlan(pattern, simData, {
    sourceBodyActive: !!pattern.garmentCodeSource && !!activeGarmentCodeBody(pattern.body),
    freshArrangement: true, cached: false,
    held: arranged.some(piece => piece.frozen) || pattern.settings3d.fixTop
      || simData.anchors.some((weight, index) => index % 4 === 3 && weight > 0)
  });
  if (arrangementSourceStaging) {
    simData.arrangementSourceStaging = arrangementSourceStaging;
    if (freshArrangement) simData.sourceStaging = arrangementSourceStaging;
  }
  prepareGarmentCodeAssembly(pattern, simData, body, freshArrangement);
  return { simData, body, collisionSafety: !!pattern.garmentCodeSource && !!activeGarmentCodeBody(pattern.body),
    contactPolicy: inferSourceContactPolicy(pattern) };
}

export class ClothSimulation {
  readonly simData: SimData;
  readonly simulationConfig: SimConfig;
  get sourceStretchSewingMode(): 'sequential' | 'interleaved' { return this.engine.sourceStretchSewingMode; }
  get sewingMotionPolicy() { return { ...this.engine.sewingMotionPolicy }; }
  readonly contactPolicy: SourceContactPolicy;
  private engine: ClothEngine;
  private latest: Float32Array;
  private guard: ClothCollisionGuard | null = null;
  private guardedBody: BodyMesh | null = null;
  private guardWorker: CollisionGuardWorker | null = null;
  private lastSafetyReport: CollisionGuardReport | null = null;
  private safetyFailure: CollisionSafetyError | null = null;
  private stateGeneration = 0;
  private disposed = false;
  private activeStep: Promise<Float32Array> | null = null;
  private pendingCollisionProofGeneration: number | null = null;
  private framePerformance: ClothFramePerformance | null = null;
  private sourceController: SourceStagingController | null = null;
  private requestedActivation: CollisionSeamActivation | null = null;
  private acceptedActivation: CollisionSeamActivation | null = null;
  private acceptedSourceState: SourceAssemblyState | null = null;
  private checkpointSourceComplete: boolean | null = null;
  private sourceDictionary: { stitchCount: number; seamPairsBySeam: { seamId: string; index: number; pairs: number[]; stitchIndices: number[]; stitchIndexKinds: ('identity-logical' | 'reciprocal-first-stamp')[] }[] } | null = null;
  private sourceTopology = '';
  private grabActive = false;
  private checkpointMutation = 0;

  constructor(device: GPUDevice, prepared: PreparedCloth, options: SourceContactConfigOptions = {}) {
    const initial = selectInitialSimulationState(prepared);
    // Numerical scheduling metadata belongs to this simulation. An explicit experiment must
    // not rewrite a shared preparation that another default/native simulation may reuse.
    const sourceMode = initial.collisionSafety && initial.simData.sourceStretchPolicy
      && options.sourceStretchSewingMode === 'interleaved' ? 'interleaved' : 'sequential';
    this.simData = initial.simData.sourceStretchPolicy ? { ...initial.simData,
      sourceStretchPolicy: { ...initial.simData.sourceStretchPolicy,
        sourcePieceIds: [...initial.simData.sourceStretchPolicy.sourcePieceIds],
        sewingSolver: sourceMode === 'interleaved' ? 'interleaved-stretch-sewing-v1' : 'sequential-stretch-sewing-v1' }
    } : initial.simData;
    const contacts = applySourceContactPolicy(SIM_CONFIG, initial.contactPolicy ?? {
      policy: 'unchanged', reason: 'not-active-source', materialIds: [], preservedExplicitPadding: []
    }, options);
    // The frame proof must use the same substep count as its baked GPU engine even if
    // global settings change while a renderer drains the previous live frame.
    this.simulationConfig = initial.collisionSafety
      ? { ...contacts.config, gravity: [...contacts.config.gravity] }
      : contacts.config;
    this.contactPolicy = contacts.contactPolicy;
    this.latest = initial.simData.positions.slice();
    if (initial.collisionSafety) {
      this.checkpointSourceComplete = false;
      // Old untyped test preparations have no stitch dictionary; real baked source data does.
      if (Number.isSafeInteger(this.simData.stitchCount) && this.simData.seamPairsBySeam && this.simData.seamOrder) {
        const indices = physicalSeamStitchIndices(this.simData.seams, this.simData.seamOrder, this.simData.seamPairsBySeam, this.simData.seamStitchRanges);
        this.sourceDictionary = { stitchCount: this.simData.stitchCount, seamPairsBySeam: this.simData.seamPairsBySeam.map((group, index) =>
          ({ seamId: group.seamId, index, pairs: Array.from(group.pairs), stitchIndices: Array.from(indices[index]), stitchIndexKinds: Array.from(indices[index], (_, pair) => group.pairs[pair*2] === group.pairs[pair*2+1] ? 'identity-logical' as const : 'reciprocal-first-stamp' as const) })) };
        this.sourceTopology = sourceAssemblyTopologyIdentity(this.simData, this.sourceDictionary);
        const explicit = sourceMode !== 'sequential' || options.explicitSeamIterations || options.explicitSubstepContactIterations
          || options.explicitFinalContactIterations || Object.values(options.explicitPadding ?? {}).some(Boolean)
          || this.contactPolicy.preservedExplicitPadding.length > 0 || this.contactPolicy.preservedExplicitSeamIterations
          || this.contactPolicy.preservedExplicitSubstepContactIterations || this.contactPolicy.preservedExplicitFinalContactIterations;
        if (this.simData.sourceStaging && !explicit) this.sourceController = new SourceStagingController(this.simData.sourceStaging);
        this.requestedActivation = { revision: 0, activeSeams: this.sourceController?.nextActiveSeamMask
          ?? new Uint32Array(this.sourceDictionary.seamPairsBySeam.length).fill(1), sewnUpTo: this.simData.stitchCount };
        this.acceptedSourceState = this.sourceStateFor({ ...this.requestedActivation, sewnUpTo: 0 }, false);
      }
    }
    if (initial.collisionSafety) {
      this.guardedBody = initial.body;
      this.guard = this.createGuard(initial.body);
      this.inspectCandidate(this.latest);
    }
    this.engine = new ClothEngine(device, this.simData, initial.body, this.simulationConfig,
      { strictSurfaceHistory: !!initial.collisionSafety, sourceStretchSewingMode: sourceMode, sourceStructuralStaging: !!this.sourceController });
    this.applyRequestedActivation();
    if (this.guard) {
      try {
        if (typeof this.engine.enableCollisionTrajectoryReadback !== 'function') {
          throw new Error('GPU collision trajectory recording is unavailable');
        }
        this.engine.enableCollisionTrajectoryReadback();
        if (!Array.isArray(this.engine.collisionTrajectoryPositions)) {
          throw new Error('GPU collision trajectory readback is unavailable');
        }
        // Source assembly already has validated anatomical placement. Native's infinitesimal
        // vertical-panel tilt must not silently change that verified first trajectory sample.
        this.engine.resetPositions(this.latest);
      } catch (error) {
        this.engine.dispose();
        throw new Error('Source garment safety requires GPU collision trajectory recording.', { cause: error });
      }
      try {
        this.guardWorker = new CollisionGuardWorker(this.guardInput(initial.body));
      } catch (error) {
        this.engine.dispose();
        throw new Error('Source garment safety requires a collision verification worker.', { cause: error });
      }
    }
  }

  /** Advance one frame; returns the global vec4 position buffer (x,y,z,invMass per particle). */
  step(): Promise<Float32Array> {
    if (this.activeStep) return this.activeStep;
    const pending = this.advanceFrame();
    this.activeStep = pending;
    void pending.finally(() => {
      if (this.activeStep === pending) this.activeStep = null;
    }).catch(() => { /* The original promise carries the frame failure to its caller. */ });
    return pending;
  }

  private async advanceFrame(): Promise<Float32Array> {
    if (this.disposed) return this.latest;
    if (this.safetyFailure) throw this.safetyFailure;
    this.engine.setSourceStructuralStagingEnabled?.(this.sourceController?.capture().mode === 'automatic');
    this.applyRequestedActivation();
    const generation = this.stateGeneration;
    const frameStarted = performance.now();
    let workerProofMs = 0;
    // Keep a single immutable activation context throughout dispatch and asynchronous proof.
    const activation = this.requestedActivation ? cloneActivation(this.requestedActivation) : null;
    const stageSnapshot = this.sourceController?.capture() ?? null;
    const acceptedBefore = { activation: this.lastCollisionSeamActivation, state: this.sourceAssemblyState,
      checkpoint: this.checkpointSourceComplete };
    const inputResume = this.requestedActivation ? { support: this.engine.captureAssemblySupport(),
      anchorCount: this.engine.activeXYZAnchorCount, grabbed: this.grabActive, mutation: this.checkpointMutation } : null;
    const snapshot = this.guard ? this.engine.captureState() : null;
    try {
      const out = await this.engine.step();
      if (this.disposed || generation !== this.stateGeneration) return this.latest;
      const trajectory = this.guard ? this.engine.collisionTrajectoryPositions : undefined;
      // These controller/hold values belong to the completed GPU candidate, before any
      // asynchronous proof permits UI settings to change the next attempt.
      const candidateResume = this.requestedActivation ? { support: this.engine.captureAssemblySupport(),
        anchorCount: this.engine.activeXYZAnchorCount, grabbed: this.grabActive, mutation: inputResume!.mutation, input: inputResume! } : null;
      if (this.guard) {
        const proofStarted = performance.now();
        try {
          if (!await this.proveCandidate(out, this.latest, trajectory, generation, activation)) return this.latest;
        } finally { workerProofMs = performance.now() - proofStarted; }
      }
      if (out.length === this.latest.length) {
        if (activation) {
          this.sourceController?.observeAccepted(out, activation.activeSeams, activation.sewnUpTo);
          this.acceptedActivation = cloneActivation(activation);
          this.acceptedSourceState = this.sourceController?.acceptedState ?? this.sourceStateFor(activation, true);
          this.checkpointSourceComplete = !!candidateResume && candidateResume.mutation === this.checkpointMutation
            && this.sourceCheckpointEligible(out, candidateResume);
          // Applying a planned gate changes only the NEXT attempt, never accepted-frame metadata.
          if (this.sourceController) this.requestedActivation = { revision: this.sourceController.maskRevision,
            activeSeams: this.sourceController.nextActiveSeamMask, sewnUpTo: activation.sewnUpTo };
          this.applyRequestedActivation();
        }
        this.latest = out;
      }
    } catch (error) {
      if (this.disposed || generation !== this.stateGeneration) return this.latest;
      // Preserve particle positions, previous positions and velocities. Rejection is a pause,
      // never an automatic restart or a zero-velocity frame declared settled.
      if (snapshot) this.engine.restoreState(snapshot);
      if (stageSnapshot) this.sourceController?.restore(stageSnapshot);
      if (activation) this.requestedActivation = cloneActivation(activation);
      this.acceptedActivation = acceptedBefore.activation;
      this.acceptedSourceState = acceptedBefore.state;
      this.checkpointSourceComplete = acceptedBefore.checkpoint && inputResume?.mutation === this.checkpointMutation
        ? true : this.guard ? false : null;
      if (this.guard && !(error instanceof CollisionSafetyError)) {
        // An unreadable/missing GPU trace cannot become an implicitly accepted source frame.
        this.lastSafetyReport = this.guard.inspectTrajectory(this.latest, this.latest, [], this.simulationConfig.subSteps, activation ?? undefined);
        this.safetyFailure = new CollisionSafetyError(this.lastSafetyReport, undefined, undefined, undefined, undefined, activation, activation ? this.sourceStateFor(activation, true) : null);
        throw this.safetyFailure;
      }
      throw error;
    } finally {
      snapshot?.destroy();
      const timing = this.engine.lastStepPerformance;
      if (!this.disposed && generation === this.stateGeneration && timing) {
        this.framePerformance = { ...timing, workerProofMs, totalFrameMs: performance.now() - frameStarted };
      }
    }
    return this.latest;
  }

  get safetyReport(): CollisionGuardReport | null {
    return this.lastSafetyReport;
  }

  private applyRequestedActivation(): void {
    if (this.requestedActivation) this.engine.setSeamActivation(this.requestedActivation);
  }

  private sourceStateFor(activation: CollisionSeamActivation, proved: boolean): SourceAssemblyState {
    const activeStitchMask = new Uint32Array(this.sourceDictionary?.stitchCount ?? 0);
    for (const range of this.simData.seamStitchRanges ?? []) {
      const index = this.sourceDictionary?.seamPairsBySeam.findIndex(group => group.seamId === range.seamId) ?? -1;
      if (index < 0 || !activation.activeSeams[index]) continue;
      for (let stitch = range.start; stitch < Math.min(range.end, activation.sewnUpTo); stitch++) activeStitchMask[stitch] = 1;
    }
    const allActive = proved && activation.activeSeams.every(value => value === 1)
      && activation.sewnUpTo === activeStitchMask.length;
    return { revision: activation.revision, phase: allActive ? 'all' : 'structural', stableAcceptedFrames: 0,
      activeSeamMask: activation.activeSeams.slice(), activeStitchMask,
      enabledStitchCount: activeStitchMask.reduce((sum, value) => sum + value, 0), totalStitchCount: activeStitchMask.length, allActive };
  }

  private sourceCheckpointEligible(positions: Float32Array,
    candidate: { support: AssemblySupportSnapshot | null; anchorCount: number; grabbed: boolean;
      input: { support: AssemblySupportSnapshot | null; anchorCount: number; grabbed: boolean } }): boolean {
    if (!this.acceptedSourceState?.allActive || candidate.grabbed || candidate.anchorCount > 0
      || candidate.input.grabbed || candidate.input.anchorCount > 0) return false;
    for (const group of this.sourceDictionary?.seamPairsBySeam ?? []) for (let i = 0; i < group.pairs.length; i += 2) {
      const a = group.pairs[i] * 4, b = group.pairs[i + 1] * 4;
      const gap = Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
      if (!Number.isFinite(gap) || gap > .003) return false;
    }
    const released = (support: AssemblySupportSnapshot | null) => !support
      || support.states.every(state => state.phase === 'released' && state.scale === 0)
        && support.targets.every((value, index) => index % 4 !== 1 || value === 0);
    return released(candidate.input.support) && released(candidate.support);
  }

  get sourceAssemblyState(): SourceAssemblyState | null {
    return this.acceptedSourceState ? cloneSourceState(this.acceptedSourceState) : null;
  }
  /** Resume eligibility from the last accepted geometry, support and effective hold state. */
  get sourceAssemblyComplete(): boolean | null { return this.checkpointSourceComplete; }
  get lastCollisionSeamActivation(): CollisionSeamActivation | null {
    return this.acceptedActivation ? cloneActivation(this.acceptedActivation) : null;
  }
  get collisionSeamDictionary() {
    return this.sourceDictionary && { stitchCount: this.sourceDictionary.stitchCount,
      seamPairsBySeam: this.sourceDictionary.seamPairsBySeam.map(group => ({ ...group, pairs: [...group.pairs], stitchIndices: [...group.stitchIndices], stitchIndexKinds: [...group.stitchIndexKinds] })) };
  }
  captureSourceAssembly(): SourceAssemblySnapshot | null {
    if (this.activeStep) throw new Error('Drain the active frame before capturing source assembly');
    return this.requestedActivation ? { topology: this.sourceTopology, controller: this.sourceController?.capture() ?? null,
      requestedActivation: cloneActivation(this.requestedActivation), acceptedState: this.sourceAssemblyState,
      lastAcceptedActivation: this.lastCollisionSeamActivation } : null;
  }
  restoreSourceAssembly(snapshot: SourceAssemblySnapshot | null): void {
    if (!snapshot) return;
    if (this.activeStep) throw new Error('Drain the active frame before restoring source assembly');
    if (!this.requestedActivation || snapshot.topology !== this.sourceTopology
      || snapshot.requestedActivation.activeSeams.length !== this.requestedActivation.activeSeams.length
      || snapshot.requestedActivation.activeSeams.some(value => value !== 0 && value !== 1)
      || !Number.isSafeInteger(snapshot.requestedActivation.revision) || snapshot.requestedActivation.revision < 0
      || !Number.isSafeInteger(snapshot.requestedActivation.sewnUpTo) || snapshot.requestedActivation.sewnUpTo < 0
      || snapshot.requestedActivation.sewnUpTo > this.stitchCount
      || !!snapshot.controller && !this.simData.sourceStaging) throw new Error('Source assembly snapshot topology changed');
    const restoredController = snapshot.controller && this.simData.sourceStaging ? new SourceStagingController(this.simData.sourceStaging) : null;
    if (snapshot.controller) restoredController!.restore(snapshot.controller);
    this.sourceController = restoredController;
    this.requestedActivation = cloneActivation(snapshot.requestedActivation);
    this.acceptedActivation = snapshot.lastAcceptedActivation ? cloneActivation(snapshot.lastAcceptedActivation) : null;
    this.acceptedSourceState = snapshot.acceptedState ? cloneSourceState(snapshot.acceptedState) : null;
    this.checkpointSourceComplete = false;
    this.engine.setSourceStructuralStagingEnabled(snapshot.controller?.mode === 'automatic');
    this.applyRequestedActivation();
  }

  /** Observational timings for the last current frame attempt, including rejected proofs. */
  get stepPerformance(): Readonly<ClothFramePerformance> | null {
    return this.framePerformance && { ...this.framePerformance };
  }

  /** A current source frame awaits its asynchronous geometry proof before publication. */
  get collisionSafetyPending(): boolean {
    return !this.disposed && this.pendingCollisionProofGeneration === this.stateGeneration;
  }

  get assemblySupportStates(): readonly AssemblySupportState[] {
    return this.engine.assemblySupportStates;
  }

  /** Actual corrected substep endpoints; the accepted frame start is supplied separately. */
  get collisionSubstepPositions(): readonly Float32Array[] {
    return this.engine.collisionSubstepPositions;
  }

  /** Exact GPU frame start plus every corrected endpoint; the guard binds both ends. */
  get collisionTrajectoryPositions(): readonly Float32Array[] {
    return this.engine.collisionTrajectoryPositions;
  }

  /** Optional diagnostic capture only; zeroBasedSubstep23 observes corrected trajectory step24. */
  enableCollisionPhaseReadback(zeroBasedSubstep: number, endZeroBasedSubstep = zeroBasedSubstep,
    includeSelfSurfaceDiagnostics = false, includeExternalSurfaceDiagnostics = false): void {
    this.engine.enableCollisionPhaseReadback(zeroBasedSubstep, endZeroBasedSubstep, includeSelfSurfaceDiagnostics, includeExternalSurfaceDiagnostics);
  }

  /** Diagnostic phases use a 1-based corrected substep index; mandatory frame proof is separate. */
  get collisionPhaseObservations(): readonly CollisionPhaseObservation[] {
    return this.engine.collisionPhaseObservations;
  }

  /** Optional selected GPU pass timing; it does not change the mandatory collision proof. */
  enableGPUStageProfiling(options: { selectedZeroBasedSubsteps?: readonly number[] } = {}): void {
    this.engine.enableGPUStageProfiling(options);
  }

  /** Retains the current rejected attempt profile; an explicit reset clears it in the engine. */
  get gpuStageProfile(): Readonly<CollisionProfileReport> | null {
    return this.engine.gpuStageProfile;
  }

  /** Transfer after a position reset when changing live settings on the same cloth topology. */
  captureAssemblySupport(): AssemblySupportSnapshot | null {
    return this.engine.captureAssemblySupport();
  }

  restoreAssemblySupport(snapshot: AssemblySupportSnapshot | null): void {
    if (this.activeStep) throw new Error('Drain the active frame before restoring assembly support');
    this.checkpointMutation++;
    if (this.guard) this.checkpointSourceComplete = false;
    this.engine.restoreAssemblySupport(snapshot);
  }

  /** Controlled assembly experiments can change gravity without losing velocities/history. */
  setGravityScale(scale: number): void {
    this.engine.setGravityScale(scale);
  }

  private guardInput(body: BodyMesh): CollisionGuardInput {
    return { bodyPositions: body.positions, bodyIndices: body.triangles,
      bodyPositionStride: 4, bodyTriangleStride: 4, clothTriangles: this.simData.triangles,
      particleCount: this.simData.particleCount, seams: this.simData.seams,
      ...(this.sourceDictionary ?? { seamPairsBySeam: this.simData.seamPairsBySeam }),
      ...(this.simData.sourceGatherRefinement || this.simData.sourceGatherCollisionGeometry ? {
        sourceGatherRefinementRevision: this.simData.sourceGatherRefinement?.revision,
        sourceGatherCollisionGeometry: this.simData.sourceGatherCollisionGeometry as CollisionGuardInput['sourceGatherCollisionGeometry'] } : {}) };
  }

  private createGuard(body: BodyMesh): ClothCollisionGuard {
    return new ClothCollisionGuard(this.guardInput(body));
  }

  private async proveCandidate(positions: Float32Array, previous: Float32Array,
    trajectory: readonly Float32Array[] | undefined, generation: number, activation: CollisionSeamActivation | null): Promise<boolean> {
    this.pendingCollisionProofGeneration = generation;
    const bodyClosed = this.lastSafetyReport?.bodyClosed ?? false;
    const worker = this.guardWorker;
    let report: CollisionGuardReport;
    try {
      if (!worker) throw new Error('Source collision verification worker is unavailable.');
      report = await worker.inspectTrajectory(positions, previous, trajectory, this.simulationConfig.subSteps, activation ?? undefined);
    } catch {
      if (generation === this.stateGeneration && this.guardWorker === worker) {
        worker?.dispose();
        this.guardWorker = null;
      }
      report = failedCollisionTrajectoryReport(this.simulationConfig.subSteps, bodyClosed);
    } finally {
      if (this.pendingCollisionProofGeneration === generation) this.pendingCollisionProofGeneration = null;
    }
    // A valid reset, pose update or disposal owns the current state even if an old proof fails.
    if (this.disposed || generation !== this.stateGeneration) return false;
    this.acceptSafetyReport(report, positions, trajectory, activation);
    return true;
  }

  private inspectCandidate(positions: Float32Array, previous?: Float32Array,
    trajectory?: readonly Float32Array[]): void {
    if (!this.guard) return;
    this.acceptSafetyReport(this.guard.inspect(positions, previous, this.requestedActivation ?? undefined), positions, trajectory, this.requestedActivation);
  }

  private acceptSafetyReport(report: CollisionGuardReport, positions: Float32Array,
    trajectory?: readonly Float32Array[], activation: CollisionSeamActivation | null = this.requestedActivation): void {
    this.lastSafetyReport = report;
    if (!report.safe) {
      this.safetyFailure = new CollisionSafetyError(report, positions, trajectory,
        this.engine?.collisionPhaseObservations, this.engine?.gpuStageProfile, activation,
        activation ? this.sourceStateFor(activation, true) : null);
      throw this.safetyFailure;
    }
  }

  private acceptReset(positions: Float32Array): void {
    this.inspectCandidate(positions);
    // A transport failure invalidates its isolate permanently; an explicit valid reset can
    // create a new body-bound verifier rather than retrying a failed worker automatically.
    if (this.guard && !this.guardWorker && this.guardedBody) {
      this.guardWorker = new CollisionGuardWorker(this.guardInput(this.guardedBody));
    }
    this.stateGeneration++;
    this.framePerformance = null;
    this.checkpointSourceComplete = this.guard ? false : null;
    this.acceptedActivation = null;
    this.acceptedSourceState = this.requestedActivation ? this.sourceStateFor({ ...this.requestedActivation, sewnUpTo: 0 }, false) : null;
    this.safetyFailure = null;
    this.engine.resetPositions(positions);
    this.latest = positions.slice();
  }

  get positions(): Float32Array {
    return this.latest;
  }

  /** 1 = hold the cached drape; 0 = release so it re-drapes (e.g. on a changed body). */
  setAnchorScale(scale: number) {
    this.engine.setAnchorScale(scale);
    this.checkpointMutation++;
    if (this.guard) this.checkpointSourceComplete = false;
  }

  /** Toggle self-collision at runtime (off during a body-change re-drape to avoid curling). */
  setSelfCollision(enabled: boolean) {
    this.engine.setSelfCollisionEnabled(enabled);
  }

  /** Total gated stitches — the top of the assembly timeline. */
  get stitchCount(): number {
    return this.simData.stitchCount;
  }

  /** Close stitches below `count`; the rest stay loose. Drives the assembly recording. */
  setSewnUpTo(count: number) {
    const prefix = Math.max(0, Math.min(this.stitchCount, Math.round(count)));
    if (!Number.isFinite(prefix)) throw new Error('Invalid sewing prefix');
    if (this.requestedActivation && prefix === this.requestedActivation.sewnUpTo) return;
    if (this.activeStep) throw new Error('Drain the active frame before changing sewing activation');
    if (this.requestedActivation) {
      this.sourceController?.cancelAutomatic();
      this.engine.setSourceStructuralStagingEnabled(false);
      this.requestedActivation = { revision: this.sourceController?.maskRevision ?? this.requestedActivation.revision + 1,
        activeSeams: new Uint32Array(this.requestedActivation.activeSeams.length).fill(1), sewnUpTo: prefix };
      this.checkpointSourceComplete = false;
      this.applyRequestedActivation();
    } else this.engine.setSewnUpTo(prefix);
  }

  cancelSourceAssembly(): void {
    if (!this.requestedActivation) return;
    if (this.activeStep) throw new Error('Drain the active frame before changing source assembly');
    this.sourceController?.cancelAutomatic();
    this.engine.setSourceStructuralStagingEnabled(false);
    this.requestedActivation = { ...this.requestedActivation, revision: this.sourceController?.maskRevision ?? this.requestedActivation.revision + 1,
      activeSeams: new Uint32Array(this.requestedActivation.activeSeams.length).fill(1) };
    this.checkpointSourceComplete = false;
    this.applyRequestedActivation();
  }

  /** Re-point the anchor targets at the latest settled positions and softly hold them. Used after a
   *  body-change re-drape so the garment gently holds the NEW clean drape (not a rigid freeze). */
  reanchorToSettled(scale = 0.25) {
    this.engine.setAnchors(this.latest);
    this.setAnchorScale(scale);
  }

  /** Rigidly re-fit the cached drape onto the NEW-body arrangement (per-piece Kabsch), matching the
   *  original's createCloth re-fit of saved positions. Each piece's settled drape is rotated+translated
   *  so it best overlays where that piece now sits on the changed body, preserving the drape's shape;
   *  the solver then settles the non-rigid residual. Re-seeds both positions and anchors to the fit. */
  refitToArrangement(scale = 0.25) {
    const sd = this.simData;
    const out = sd.positions.slice();
    for (const piece of sd.pieces) {
      const n = piece.count;
      if (n < 3) continue;
      const cached = new Float32Array(n * 3); // current drape (old body)
      const arranged = new Float32Array(n * 3); // arrangement on the new body
      for (let i = 0; i < n; i++) {
        const g = piece.start + i;
        cached[i * 3] = sd.positions[g * 4]; cached[i * 3 + 1] = sd.positions[g * 4 + 1]; cached[i * 3 + 2] = sd.positions[g * 4 + 2];
        arranged[i * 3] = sd.arrangedPositions[g * 4]; arranged[i * 3 + 1] = sd.arrangedPositions[g * 4 + 1]; arranged[i * 3 + 2] = sd.arrangedPositions[g * 4 + 2];
      }
      const tr = kabschRigid(cached, arranged, n);
      for (let i = 0; i < n; i++) {
        const g = piece.start + i;
        const [x, y, z] = applyRigid(tr, cached[i * 3], cached[i * 3 + 1], cached[i * 3 + 2]);
        out[g * 4] = x; out[g * 4 + 1] = y; out[g * 4 + 2] = z; // .w (invMass) preserved from slice()
      }
    }
    this.acceptReset(out);
    this.engine.setAnchors(out);
    this.setAnchorScale(scale);
  }

  /** Interactive grab: pull global particle `index` (and same-piece neighbours) toward world `pos`. */
  setGrab(grabbing: boolean, index: number, pos: [number, number, number]) {
    this.grabActive = grabbing;
    this.checkpointMutation++;
    if (this.guard) this.checkpointSourceComplete = false;
    this.engine.setGrab(grabbing, index, pos);
  }

  /** Re-seed to the cached/settled drape. */
  resetToSaved() {
    this.acceptReset(this.simData.positions);
    this.engine.resetAssemblySupport(this.simData.assemblySupport?.activeOnStart === true);
  }

  /** Re-seed to the flat-on-body arrangement (pre-drape). */
  resetToArranged() {
    const previousController = this.sourceController, previousActivation = this.requestedActivation;
    if (this.sourceController?.capture().mode === 'automatic' && this.simData.sourceStaging) {
      this.sourceController = new SourceStagingController(this.simData.sourceStaging);
      this.requestedActivation = { revision: this.sourceController.maskRevision,
        activeSeams: this.sourceController.nextActiveSeamMask, sewnUpTo: this.stitchCount };
    }
    try { this.acceptReset(this.simData.arrangedPositions); }
    catch (error) { this.sourceController = previousController; this.requestedActivation = previousActivation; throw error; }
    this.engine.resetAssemblySupport(true);
    // A stale in-flight frame may still be draining. Its generation is invalidated;
    // the new gate is uploaded before the next frame is encoded.
    if (!this.activeStep) {
      this.engine.setSourceStructuralStagingEnabled?.(this.sourceController?.capture().mode === 'automatic');
      this.applyRequestedActivation();
    }
  }

  /** Re-seed to an arbitrary global stride-4 position array (e.g. a user arrangement). */
  resetTo(positions: Float32Array) {
    this.acceptReset(positions);
  }

  /** Seed to `positions`, anchor to them, and softly hold (used after a coherent re-fit so the new
   *  positions become the held target without a physics re-settle). */
  seedAndHold(positions: Float32Array, scale = 0.25) {
    this.acceptReset(positions);
    this.engine.resetAssemblySupport(false);
    this.engine.setAnchors(positions);
    this.setAnchorScale(scale);
  }

  rebuildBodyGrid(avatarVertices: Float32Array, avatarIndices: Uint32Array) {
    this.stateGeneration++;
    this.framePerformance = null;
    if (this.guard) this.checkpointSourceComplete = false;
    const body = packBodyMesh(avatarVertices, avatarIndices);
    this.engine.updateBodyMesh(body);
    if (this.guard) {
      this.guardWorker?.dispose();
      this.guardWorker = null;
      this.guardedBody = body;
      this.guard = this.createGuard(body);
      this.inspectCandidate(this.latest);
      this.guardWorker = new CollisionGuardWorker(this.guardInput(body));
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stateGeneration++;
    this.framePerformance = null;
    this.guardWorker?.dispose();
    this.guardWorker = null;
    this.engine.dispose();
  }
}
