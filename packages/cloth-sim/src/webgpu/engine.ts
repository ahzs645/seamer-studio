/// <reference types="@webgpu/types" />
// WebGPU XPBD cloth engine. One step() runs `subSteps` substeps in a single compute pass
// (WebGPU orders dispatches and makes storage writes visible to subsequent dispatches), then reads
// back particle positions. Body collision uses a GPU spatial hash over avatar triangles (rebuilt
// only when the body mesh changes) + a once-per-frame near-triangle gather, like the original.

import type { SimConfig } from '../config';
import { seamMaxDisplacementSq } from '../config';
import type { SimData, ColorGroup } from '../build';
import {
  WORKGROUP_SIZE,
  integrateWGSL,
  distanceConstraintWGSL,
  bendingConstraintWGSL,
  seamWGSL,
  initExternalCollisionWGSL,
  solveExternalCollisionWGSL,
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
  private positions2d!: GPUBuffer;
  private dynamicConfig!: GPUBuffer;
  private seams!: GPUBuffer;
  private readback!: GPUBuffer;

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
  private computeDampingBG!: GPUBindGroup;
  private applyLocalDampingBG!: GPUBindGroup;
  private nearDampingBG!: GPUBindGroup;
  private stretchGroups: ColorBuffers[] = [];
  private bendGroups: ColorBuffers[] = [];

  private inFlight = false;
  private selfCollisionRuntime = true; // runtime toggle (e.g. off during a body-change re-drape)
  private anchorW!: Float32Array; // original anchor weights (.w lane) to preserve on re-anchor

  constructor(device: GPUDevice, sim: SimData, body: BodyMesh, config: SimConfig) {
    this.device = device;
    this.config = config;
    this.particleCount = sim.particleCount;
    this.triangleCount = sim.triangleCount;
    this.maxIncident = sim.maxIncidentTrianglesPerParticle;
    this.selfCollision = config.handleSelfCollisions && sim.triangleCount > 0;
    this.externalCollision = config.handleExternalCollisions && body.numTriangles > 0;
    this.hashTableSize = config.internalHashTableMultiplier * Math.max(1, sim.triangleCount) + 1;
    this.bodyTriangleCount = body.numTriangles;
    this.externalHashTableSize = config.externalHashTableMultiplier * Math.max(1, body.numTriangles) + 1;
    this.anchorW = new Float32Array(this.particleCount);
    for (let i = 0; i < this.particleCount; i++) this.anchorW[i] = sim.anchors[i * 4 + 3];
    this.createBuffers(sim, body);
    this.createPipelines();
    this.createBindGroups();
  }

  private buf(data: ArrayBufferView, usage: number): GPUBuffer {
    const b = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage });
    this.device.queue.writeBuffer(b, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    return b;
  }

  private createBuffers(sim: SimData, body: BodyMesh) {
    const d = this.device;
    const STORAGE = GPUBufferUsage.STORAGE;
    const COPY_DST = GPUBufferUsage.COPY_DST;
    const COPY_SRC = GPUBufferUsage.COPY_SRC;
    this.positions = this.buf(sim.positions, STORAGE | COPY_DST | COPY_SRC);
    this.velocities = d.createBuffer({ size: this.particleCount * 16, usage: STORAGE | COPY_DST });
    d.queue.writeBuffer(this.velocities, 0, new Float32Array(this.particleCount * 4));
    this.lastPositions = d.createBuffer({ size: this.particleCount * 16, usage: STORAGE | COPY_DST });
    this.correction = d.createBuffer({ size: this.particleCount * 16, usage: STORAGE | COPY_DST });
    this.anchors = this.buf(sim.anchors, STORAGE | COPY_DST);
    this.simParams = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | COPY_DST });
    d.queue.writeBuffer(this.simParams, 0, new Float32Array([1, 0, 0, 0]));
    this.positions2d = this.buf(sim.positions2d, STORAGE | COPY_DST);
    this.dynamicConfig = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | COPY_DST });
    d.queue.writeBuffer(this.dynamicConfig, 0, new Float32Array(8));
    this.seams = this.buf(sim.seams, STORAGE | COPY_DST);
    this.readback = d.createBuffer({ size: this.particleCount * 16, usage: GPUBufferUsage.MAP_READ | COPY_DST });

    this.bodyPositions = this.buf(body.positions, STORAGE | COPY_DST);
    this.bodyTriangles = this.buf(body.triangles, STORAGE | COPY_DST);
    this.createExternalHashBuffers();
    this.externalNearTriangles = d.createBuffer({
      size: Math.max(4, this.particleCount * this.config.numExternalCollisionConstraintsPerParticle * 4),
      usage: STORAGE
    });

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
    this.distancePipe = this.pipe(distanceConstraintWGSL(cfg));
    this.bendPipe = this.pipe(bendingConstraintWGSL(cfg));
    this.seamPipe = this.pipe(seamWGSL(cfg, seamMaxDisplacementSq(cfg)));
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
    this.initExternalPipe = this.pipe(initExternalCollisionWGSL(cfg, this.externalHashTableSize));
    this.solveExternalPipe = this.pipe(solveExternalCollisionWGSL(cfg, this.maxIncident));
  }

  private createBindGroups() {
    const d = this.device;
    const e = (buffer: GPUBuffer) => ({ buffer });
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
        { binding: 2, resource: e(this.correction) }
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
      entries: [
        { binding: 0, resource: e(this.positions) },
        { binding: 1, resource: e(this.externalNearTriangles) },
        { binding: 2, resource: e(this.externalHashTable) },
        { binding: 3, resource: e(this.externalHashPositions) },
        { binding: 4, resource: e(this.externalTriangleCenters) }
      ]
    });
    this.solveExternalBG = d.createBindGroup({
      layout: this.solveExternalPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: e(this.positions) },
        { binding: 1, resource: e(this.correction) },
        { binding: 2, resource: e(this.externalNearTriangles) },
        { binding: 3, resource: e(this.bodyTriangles) },
        { binding: 4, resource: e(this.bodyPositions) },
        { binding: 5, resource: e(this.lastPositions) },
        { binding: 6, resource: e(this.clothTriangles) },
        { binding: 7, resource: e(this.incidentTriangles) }
      ]
    });
  }

  /** Rebuild the body buffers + spatial hash (body shape/pose changed). The hash itself is
   *  recomputed on the GPU at the start of the next step (externalDirty), mirroring the
   *  original's externalPositionsDirty flag. */
  updateBodyMesh(body: BodyMesh) {
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.bodyPositions.destroy();
    this.bodyTriangles.destroy();
    this.bodyPositions = this.buf(body.positions, usage);
    this.bodyTriangles = this.buf(body.triangles, usage);
    if (this.externalCollision) {
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
      }
      this.createExternalBindGroups();
      this.externalDirty = true;
    } else {
      this.bodyTriangleCount = body.numTriangles;
    }
  }

  /** 1 = hold particles to their anchored (cached) drape; 0 = free, let it re-drape. */
  setAnchorScale(scale: number) {
    this.device.queue.writeBuffer(this.simParams, 0, new Float32Array([scale, 0, 0, 0]));
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

  /** Re-seed particle positions (vec4: x,y,z,invMass) and zero velocities — for Arrange/Reset. */
  resetPositions(positions: Float32Array) {
    this.device.queue.writeBuffer(this.positions, 0, positions.buffer as ArrayBuffer, positions.byteOffset, positions.byteLength);
    this.device.queue.writeBuffer(this.velocities, 0, new Float32Array(this.particleCount * 4));
    this.device.queue.writeBuffer(this.lastPositions, 0, positions.buffer as ArrayBuffer, positions.byteOffset, positions.byteLength);
  }

  private wg(n: number): number {
    return Math.ceil(n / WORKGROUP_SIZE);
  }

  /** Run one frame (subSteps substeps) and return the latest particle positions (vec4 array). */
  async step(): Promise<Float32Array> {
    if (this.inFlight) return new Float32Array(0);
    this.inFlight = true;
    try {
      return await this.stepInner();
    } finally {
      // Always clear in-flight, even if the GPU readback rejects (device lost / buffer destroyed mid
      // teardown). Otherwise every later step() short-circuits to empty and the sim loop busy-spins.
      this.inFlight = false;
    }
  }

  private async stepInner(): Promise<Float32Array> {
    const d = this.device;
    const encoder = d.createCommandEncoder();
    const pass = encoder.beginComputePass();
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
    const gatherSelf = () => {
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
      pass.setPipeline(this.initSelfPipe);
      pass.setBindGroup(0, this.initSelfBG);
      pass.dispatchWorkgroups(pCount);
    };
    const gatherInterval = Math.max(1, this.config.selfCollisionGatherInterval ?? this.config.subSteps);
    const selfOn = this.selfCollision && this.selfCollisionRuntime;

    // External (body) collision broad-phase, ONCE PER FRAME (original position: before the substep
    // loop, alongside the self-collision gather). The body-triangle spatial hash is rebuilt only
    // when the body mesh changed (externalDirty); the near-triangle gather runs every frame and the
    // resulting list is frozen across all substeps.
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
      pass.setPipeline(this.initExternalPipe);
      pass.setBindGroup(0, this.initExternalBG);
      pass.dispatchWorkgroups(pCount);
    }

    for (let s = 0; s < this.config.subSteps; s++) {
      // Re-gather near triangles against the latest positions at the chosen cadence.
      if (selfOn && s % gatherInterval === 0) gatherSelf();

      pass.setPipeline(this.integratePipe);
      pass.setBindGroup(0, this.integrateBG);
      pass.dispatchWorkgroups(pCount);

      pass.setPipeline(this.distancePipe);
      for (const g of this.stretchGroups) {
        if (g.count === 0) continue;
        pass.setBindGroup(0, g.bindGroup);
        pass.dispatchWorkgroups(this.wg(g.count));
      }
      // "Use bending" toggle: skip the bending-constraint passes entirely when disabled.
      if (this.config.useBending !== false) {
        pass.setPipeline(this.bendPipe);
        for (const g of this.bendGroups) {
          if (g.count === 0) continue;
          pass.setBindGroup(0, g.bindGroup);
          pass.dispatchWorkgroups(this.wg(g.count));
        }
      }

      // Cloth self-collision (edge + face) — stops panels folding through each other.
      if (selfOn) {
        pass.setPipeline(this.solveSelfPipe);
        pass.setBindGroup(0, this.solveSelfBG);
        pass.dispatchWorkgroups(pCount);
        apply();
      }

      // Seam constraints: run several Gauss-Seidel iterations so weakly-linked joins (the short
      // waistband-centre seam) close fast enough to hold panels together under an interactive drag.
      const seamIters = Math.max(1, this.config.seamIterations ?? 1);
      for (let si = 0; si < seamIters; si++) {
        pass.setPipeline(this.seamPipe);
        pass.setBindGroup(0, this.seamBG);
        pass.dispatchWorkgroups(pCount);
        apply();
      }

      // Cloth-vs-body collision: solve per-substep against the frozen per-frame gather list.
      if (this.externalCollision) {
        pass.setPipeline(this.solveExternalPipe);
        pass.setBindGroup(0, this.solveExternalBG);
        pass.dispatchWorkgroups(pCount);
        apply();
      }

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
    }
    pass.end();
    encoder.copyBufferToBuffer(this.positions, 0, this.readback, 0, this.particleCount * 16);
    d.queue.submit([encoder.finish()]);

    await this.readback.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(this.readback.getMappedRange().slice(0));
    this.readback.unmap();
    return out;
  }

  dispose() {
    for (const b of [this.positions, this.velocities, this.lastPositions, this.correction, this.anchors, this.simParams, this.positions2d, this.dynamicConfig, this.seams,
      this.readback, this.bodyPositions, this.bodyTriangles,
      this.externalTriangleCenters, this.externalHashTable, this.externalHashPositions, this.externalNearTriangles, this.dampingState,
      this.clothTriangles, this.triangleCenters, this.particleLayers, this.hashTable, this.hashPositions, this.nearTriangles, this.neighborIndices, this.incidentTriangles]) {
      try { b?.destroy(); } catch { /* ignore */ }
    }
    for (const g of [...this.stretchGroups, ...this.bendGroups]) { g.edges.destroy(); g.props.destroy(); }
  }
}
