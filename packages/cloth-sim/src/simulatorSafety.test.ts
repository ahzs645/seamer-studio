import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimData } from './build';
import type { CollisionSeamActivation } from './collisionGuard';
import type { AssemblySupportSnapshot } from './assembly';
import type { SourceStagingPlan } from './sourceStaging';
import type { ClothStepPerformance, CollisionPhaseObservation } from './webgpu/engine';
import type { CollisionProfileReport } from './webgpu/CollisionTimestampProfiler';
import { SIM_CONFIG, resolveSewingMotionPolicy } from './config';
import { ClothCollisionGuard, type CollisionGuardInput, type CollisionGuardReport } from './collisionGuard';

const fake = vi.hoisted(() => ({ output: new Float32Array(), resets: [] as Float32Array[], steps: 0, restores: 0,
  snapshotsDestroyed: 0, pending: null as Promise<Float32Array> | null, disposals: 0,
  trace: null as Float32Array[] | null, traceEnabled: 0, traceEnableError: null as Error | null,
  fullTrace: null as Float32Array[] | null, engineStart: new Float32Array(), lastTraceStart: new Float32Array(), engineGeneration: 0,
  trajectoryUnavailable: false,
  activation: null as CollisionSeamActivation | null, structuralEnabled: false,
  support: null as AssemblySupportSnapshot | null, anchorCount: 0,
  engineSubsteps: 40,
  strictSurfaceHistory: false,
  sourceStretchSewingMode: 'sequential' as 'sequential' | 'interleaved',
  timing: null as ClothStepPerformance | null,
  phases: [] as CollisionPhaseObservation[], phaseSelected: null as number | null,
  phaseEnd: null as number | null,
  phaseSelfSurface: false, phaseBodySurface: false,
  gpuProfile: null as CollisionProfileReport | null,
  profileSelected: null as readonly number[] | null,
  proofPending: null as Promise<CollisionGuardReport> | null, proofError: null as Error | null,
  workerStartupError: null as Error | null,
  workers: [] as { disposed: boolean; proofs: number; input: CollisionGuardInput }[] }));
vi.mock('./collisionGuardWorker', async () => {
  const { ClothCollisionGuard } = await import('./collisionGuard');
  return { CollisionGuardWorker: class {
    readonly ready = Promise.resolve();
    private readonly guard: InstanceType<typeof ClothCollisionGuard>;
    private readonly record: (typeof fake.workers)[number];
    constructor(input: CollisionGuardInput) {
      if (fake.workerStartupError) throw fake.workerStartupError;
      this.guard = new ClothCollisionGuard(input);
      this.record = { disposed: false, proofs: 0, input }; fake.workers.push(this.record);
    }
    async inspectTrajectory(final: Float32Array, previous: Float32Array,
      trajectory: readonly Float32Array[], expected: number, activation?: CollisionSeamActivation) {
      this.record.proofs++;
      if (fake.proofPending) return await fake.proofPending;
      if (fake.proofError) throw fake.proofError;
      return this.guard.inspectTrajectory(final, previous, trajectory, expected, activation);
    }
    dispose() { this.record.disposed = true; }
  } };
});
vi.mock('./webgpu/engine', () => ({ ClothEngine: class {
  constructor(_device: GPUDevice, data: SimData, _body: unknown, config = SIM_CONFIG,
    options?: { strictSurfaceHistory?: boolean; sourceStretchSewingMode?: 'sequential' | 'interleaved'; sourceStructuralStaging?: boolean }) {
    fake.engineStart = data.positions.slice(); fake.engineSubsteps = config.subSteps;
    fake.strictSurfaceHistory = options?.strictSurfaceHistory ?? false;
    this.sewingMotionPolicy = resolveSewingMotionPolicy(config, fake.strictSurfaceHistory);
    fake.sourceStretchSewingMode = options?.sourceStretchSewingMode ?? 'sequential';
    fake.structuralEnabled = options?.sourceStructuralStaging ?? false;
  }
  readonly sewingMotionPolicy: ReturnType<typeof resolveSewingMotionPolicy>;
  get sourceStretchSewingMode() { return fake.sourceStretchSewingMode; }
  async step() {
    fake.steps++;
    const start = fake.engineStart.slice(), generation = fake.engineGeneration;
    const output = fake.pending ? await fake.pending : fake.output.slice();
    if (generation === fake.engineGeneration) { fake.lastTraceStart = start; fake.engineStart = output.slice(); }
    return output;
  }
  enableCollisionTrajectoryReadback() {
    fake.traceEnabled++;
    if (fake.traceEnableError) throw fake.traceEnableError;
  }
  get collisionSubstepPositions() { return fake.trace ?? Array.from({ length: fake.engineSubsteps }, () => fake.output.slice()); }
  get collisionTrajectoryPositions() { return fake.trajectoryUnavailable ? undefined : fake.fullTrace ?? [fake.lastTraceStart, ...this.collisionSubstepPositions]; }
  get lastStepPerformance() { return fake.timing; }
  enableCollisionPhaseReadback(selected: number, end = selected, includeSelfSurface = false, includeBodySurface = false) {
    fake.phaseSelected = selected; fake.phaseEnd = end; fake.phaseSelfSurface = includeSelfSurface; fake.phaseBodySurface = includeBodySurface;
  }
  get collisionPhaseObservations() { return fake.phases; }
  enableGPUStageProfiling(options: { selectedZeroBasedSubsteps?: readonly number[] } = {}) { fake.profileSelected = options.selectedZeroBasedSubsteps ?? []; }
  get gpuStageProfile() { return fake.gpuProfile; }
  resetPositions(positions: Float32Array) { fake.resets.push(positions.slice()); fake.engineStart = positions.slice(); fake.engineGeneration++; fake.gpuProfile = null; fake.phases = []; }
  setSeamActivation(value: CollisionSeamActivation) { fake.activation = { ...value, activeSeams: value.activeSeams.slice() }; }
  setSourceStructuralStagingEnabled(value: boolean) { fake.structuralEnabled = value; }
  get activeXYZAnchorCount() { return fake.anchorCount; }
  captureAssemblySupport() { return fake.support && { ...fake.support, states: fake.support.states.map(state => ({ ...state })), targets: fake.support.targets.slice() }; }
  restoreAssemblySupport(value: AssemblySupportSnapshot | null) { fake.support = value; }
  setSewnUpTo() {}
  setGrab() {}
  captureState() { return { activation: fake.activation && { ...fake.activation, activeSeams: fake.activation.activeSeams.slice() }, destroy() { fake.snapshotsDestroyed++; } }; }
  restoreState(value: { activation: CollisionSeamActivation | null }) { fake.restores++; fake.activation = value.activation; }
  resetAssemblySupport() {}
  updateBodyMesh() {}
  setAnchors() {}
  setAnchorScale() {}
  dispose() { fake.disposals++; }
} }));
import { ClothSimulation, CollisionSafetyError, packBodyMesh, selectInitialSimulationState, type PreparedCloth } from './simulator';

const clear = new Float32Array([2, -1, -1, 1, 2, 1, -1, 1, 2, 0, 1, 1]);
const intersecting = new Float32Array([-4, -3, 0, 1, 4, -3, 0, 1, 0, 5, 0, 1]);
function prepared(safety = true): PreparedCloth {
  const body = packBodyMesh(new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
    -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]), new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]));
  return { body, collisionSafety: safety, simData: { positions: clear.slice(), arrangedPositions: clear.slice(),
    particleCount: 3, triangles: new Uint32Array([0, 1, 2, 0]), seams: new Int32Array(12).fill(-1) } as SimData };
}
beforeEach(() => { fake.output = clear.slice(); fake.resets = []; fake.steps = 0; fake.restores = 0;
  fake.snapshotsDestroyed = 0; fake.pending = null; fake.disposals = 0; fake.trace = null;
  fake.traceEnabled = 0; fake.traceEnableError = null; fake.proofPending = null; fake.proofError = null;
  fake.workerStartupError = null; fake.workers = []; fake.fullTrace = null;
  fake.activation = null; fake.structuralEnabled = false; fake.support = null; fake.anchorCount = 0;
  fake.engineStart = clear.slice(); fake.lastTraceStart = clear.slice(); fake.engineGeneration = 0; fake.trajectoryUnavailable = false; fake.timing = null;
  fake.phases = []; fake.phaseSelected = null; fake.phaseEnd = null; fake.phaseSelfSurface = false; fake.phaseBodySurface = false; fake.gpuProfile = null; fake.profileSelected = null; fake.strictSurfaceHistory = false; });

function deferredStep() {
  let resolve!: (value: Float32Array) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Float32Array>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('source simulation fails closed', () => {
  it('keeps scheduling opt-in and owns metadata independently of a reused preparation', () => {
    const input = prepared();
    input.simData.sourceStretchPolicy = { policy: 'source-authored-seam-stretch-v1',
      sewingSolver: 'sequential-stretch-sewing-v1', sourcePieceIds: ['source-panel'],
      retainedSeamStretchEdges: 2, legacySoftenedSeamStretchEdges: 0 };
    const experiment = new ClothSimulation({} as GPUDevice, input, { sourceStretchSewingMode: 'interleaved' });
    expect(experiment.sourceStretchSewingMode).toBe('interleaved');
    expect(experiment.simData.sourceStretchPolicy!.sewingSolver).toBe('interleaved-stretch-sewing-v1');
    expect(input.simData.sourceStretchPolicy.sewingSolver).toBe('sequential-stretch-sewing-v1');
    experiment.simData.sourceStretchPolicy!.sourcePieceIds[0] = 'changed-copy';
    expect(input.simData.sourceStretchPolicy.sourcePieceIds).toEqual(['source-panel']);
    const production = new ClothSimulation({} as GPUDevice, input);
    expect(production.sourceStretchSewingMode).toBe('sequential');
    expect(production.simData.sourceStretchPolicy!.sewingSolver).toBe('sequential-stretch-sewing-v1');
    const native = new ClothSimulation({} as GPUDevice, { ...input, collisionSafety: false },
      { sourceStretchSewingMode: 'interleaved' });
    expect(native.sourceStretchSewingMode).toBe('sequential');
    expect(native.simData.sourceStretchPolicy!.sewingSolver).toBe('sequential-stretch-sewing-v1');
  });
  it('selects strict source surface history independently of assembly supports or saved drapes', () => {
    const cachedSourceWithoutSupports = prepared();
    expect(cachedSourceWithoutSupports.simData.assemblySupport).toBeUndefined();
    new ClothSimulation({} as GPUDevice, cachedSourceWithoutSupports);
    expect(fake.strictSurfaceHistory).toBe(true);
    new ClothSimulation({} as GPUDevice, prepared(false));
    expect(fake.strictSurfaceHistory).toBe(false);
  });
  it('binds the sewing budget to explicit source provenance across cache/reset and config overrides', () => {
    const original = SIM_CONFIG.seamIterations;
    try {
      SIM_CONFIG.seamIterations = 8;
      const source = new ClothSimulation({} as GPUDevice, prepared(), { explicitSeamIterations: true });
      const evidence = source.sewingMotionPolicy;
      expect(evidence.policy).toBe('source-open-budget-closed-restoration-v2'); expect(evidence.actualIterations).toBe(8);
      evidence.actualIterations = 99;
      expect(source.sewingMotionPolicy.actualIterations).toBe(8);
      source.resetToArranged();
      expect(source.sewingMotionPolicy.policy).toBe('source-open-budget-closed-restoration-v2');
      expect(source.sourceAssemblyComplete).toBe(false);
      const native = new ClothSimulation({} as GPUDevice, prepared(false), { explicitSeamIterations: true });
      expect(native.sewingMotionPolicy.policy).toBe('legacy-per-iteration-v1');
      const nativePolicy = native.sewingMotionPolicy, sourcePolicy = source.sewingMotionPolicy;
      if (nativePolicy.policy !== 'legacy-per-iteration-v1' || sourcePolicy.policy !== 'source-open-budget-closed-restoration-v2') throw new Error('Wrong policy scope');
      expect(nativePolicy.perIterationMaximumSq).toBe(sourcePolicy.openPerIterationMaximumSq * 64);
      expect(sourcePolicy.closedRestorationPerIterationMaximumSq).toBe(nativePolicy.perIterationMaximumSq);
      expect(sourcePolicy.universalSharedSubstepBudget).toBe(false);
      SIM_CONFIG.seamIterations = 1;
      const explicitOne = new ClothSimulation({} as GPUDevice, prepared(), { explicitSeamIterations: true });
      expect(explicitOne.sewingMotionPolicy.actualIterations).toBe(1);
      const onePolicy = explicitOne.sewingMotionPolicy;
      if (onePolicy.policy !== 'source-open-budget-closed-restoration-v2') throw new Error('Expected source policy');
      expect(onePolicy.openPerIterationMaximumSq).toBe(nativePolicy.perIterationMaximumSq);
      expect(onePolicy.closedRestorationPerIterationMaximumSq).toBe(nativePolicy.perIterationMaximumSq);
    } finally { SIM_CONFIG.seamIterations = original; }
  });
  it('shares the complete pending frame between concurrent public step callers', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    const pending = deferredStep(); fake.pending = pending.promise;
    const first = simulation.step(), second = simulation.step();
    expect(second).toBe(first);
    expect(fake.steps).toBe(1);
    pending.resolve(clear);
    await expect(first).resolves.toEqual(clear);
    fake.pending = null;
    await expect(simulation.step()).resolves.toEqual(clear);
    expect(fake.steps).toBe(2);
  });
  it('requires source GPU trajectory recording at startup while native keeps it disabled', () => {
    new ClothSimulation({} as GPUDevice, prepared(false));
    expect(fake.traceEnabled).toBe(0);
    fake.traceEnableError = new Error('trace buffer unavailable');
    expect(() => new ClothSimulation({} as GPUDevice, prepared())).toThrow('requires GPU collision trajectory recording');
    expect(fake.traceEnabled).toBe(1);
    expect(fake.disposals).toBe(1);
  });
  it('ignores an old unsafe readback after an explicit valid reset without rolling the reset back', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    const pending = deferredStep(); fake.pending = pending.promise;
    const step = simulation.step();
    const reset = clear.slice(); reset[0] = 3; reset[4] = 3; reset[8] = 3;
    simulation.resetTo(reset);
    pending.resolve(intersecting);
    await expect(step).resolves.toEqual(reset);
    expect(simulation.positions).toEqual(reset);
    expect(simulation.safetyReport?.safe).toBe(true);
    expect(fake.restores).toBe(0);
    expect(fake.snapshotsDestroyed).toBe(1);
    fake.pending = null; fake.output = reset;
    await expect(simulation.step()).resolves.toEqual(reset);
  });
  it('ignores an obsolete step error after reset while keeping the new simulation usable', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    const pending = deferredStep(); fake.pending = pending.promise;
    const step = simulation.step(); simulation.resetToArranged();
    pending.reject(new Error('obsolete readback failed'));
    await expect(step).resolves.toEqual(clear);
    expect(fake.restores).toBe(0);
    fake.pending = null;
    await expect(simulation.step()).resolves.toEqual(clear);
  });
  it('discards pending results after disposal and never starts another GPU step', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    const pending = deferredStep(); fake.pending = pending.promise;
    const step = simulation.step(); simulation.dispose(); simulation.dispose();
    pending.resolve(intersecting);
    await expect(step).resolves.toEqual(clear);
    expect(simulation.safetyReport?.safe).toBe(true);
    expect(fake.restores).toBe(0);
    expect(fake.disposals).toBe(1);
    await expect(simulation.step()).resolves.toEqual(clear);
    expect(fake.steps).toBe(1);
  });
  it('never publishes an intersecting candidate and remains paused until an explicit valid reset', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    fake.output = intersecting;
    let rejected: CollisionSafetyError | undefined;
    try { await simulation.step(); } catch (error) { rejected = error as CollisionSafetyError; }
    expect(rejected).toBeInstanceOf(CollisionSafetyError);
    expect(rejected?.candidatePositions).toEqual(intersecting);
    expect(rejected?.candidatePositions).not.toBe(fake.output);
    expect(rejected?.candidateTrajectory).toHaveLength(SIM_CONFIG.subSteps + 1);
    expect(rejected?.candidateTrajectory?.[0]).toEqual(clear);
    expect(rejected?.candidateTrajectory?.at(-1)).toEqual(intersecting);
    expect(rejected?.candidateTrajectory?.at(-1)).not.toBe(fake.output);
    expect(simulation.positions).toEqual(clear);
    expect(fake.resets).toEqual([clear]);
    expect(fake.restores).toBe(1);
    expect(fake.snapshotsDestroyed).toBe(1);
    expect(simulation.safetyReport!.bodyCrossingTriangleCount).toBeGreaterThan(0);
    fake.output = clear;
    await expect(simulation.step()).rejects.toBeInstanceOf(CollisionSafetyError);
    expect(fake.steps).toBe(1);
    simulation.resetToArranged();
    await expect(simulation.step()).resolves.toEqual(clear);
    expect(simulation.safetyReport?.safe).toBe(true);
  });
  it('rejects an unsafe cached seed before creating a live source simulation', () => {
    const input = prepared(); input.simData.positions = intersecting;
    expect(() => new ClothSimulation({} as GPUDevice, input)).toThrow(CollisionSafetyError);
  });
  it('rejects malformed readback rather than returning unchanged positions as a settled frame', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    fake.output = new Float32Array();
    await expect(simulation.step()).rejects.toBeInstanceOf(CollisionSafetyError);
    expect(simulation.positions).toEqual(clear);
    expect(simulation.safetyReport?.finite).toBe(false);
  });
  it('pauses a current source readback failure until an explicit valid reset', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    const pending = deferredStep(); fake.pending = pending.promise;
    const step = simulation.step(); pending.reject(new Error('Trace map failed'));
    await expect(step).rejects.toBeInstanceOf(CollisionSafetyError);
    expect(simulation.safetyReport?.trajectory?.valid).toBe(false);
    expect(simulation.positions).toEqual(clear);
    expect(fake.restores).toBe(1);
    fake.pending = null;
    await expect(simulation.step()).rejects.toBeInstanceOf(CollisionSafetyError);
    expect(fake.steps).toBe(1);
    simulation.resetTo(clear);
    await expect(simulation.step()).resolves.toEqual(clear);
  });
  it('rejects arbitrary unsafe reset/hold positions without replacing the visible garment', () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    expect(() => simulation.seedAndHold(intersecting)).toThrow(CollisionSafetyError);
    expect(simulation.positions).toEqual(clear);
    expect(fake.resets).toHaveLength(1);
  });
  it('keeps native projects on their existing simulation behavior', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared(false));
    fake.output = intersecting;
    await expect(simulation.step()).resolves.toEqual(intersecting);
    expect(simulation.safetyReport).toBeNull();
    expect(fake.resets).toHaveLength(0);
    expect(fake.workers).toHaveLength(0);
  });
});

describe('starting saved source checkpoints', () => {
  function cached(): PreparedCloth {
    const input = prepared();
    input.simData.anchors = new Float32Array(12);
    input.simData.arrangedPositions = new Float32Array([3, 1.5, -.2, 1, 3, 1.5, .2, 1, 3, 1.8, 0, 1]);
    input.simData.assemblySupport = { revision: 2, activeOnStart: false,
      targets: new Float32Array([1.5, 1, 0, 0, 1.5, 1, 0, 0, 0, 0, 0, 0]),
      groups: [{ id: 'shoulder', kind: 'shoulder', particles: [0, 1], seamPairs: [0, 1], releaseGapM: .006 }] };
    return input;
  }
  it('restarts an unfinished free checkpoint coherently only when live simulation starts', () => {
    const input = cached(), original = input.simData.positions.slice();
    const selected = selectInitialSimulationState(input);
    expect(selected).not.toBe(input);
    expect(selected.simData.positions).toEqual(input.simData.arrangedPositions);
    expect(selected.simData.assemblySupport?.activeOnStart).toBe(true);
    expect(input.simData.positions).toEqual(original);
    expect(input.simData.assemblySupport?.activeOnStart).toBe(false);
    const simulation = new ClothSimulation({} as GPUDevice, input);
    expect(simulation.positions).toEqual(input.simData.arrangedPositions);
    expect(simulation.safetyReport?.safe).toBe(true);
  });
  it('reuses a fully closed free source checkpoint without reactivating sewing support', () => {
    const input = cached();
    input.simData.positions = new Float32Array([2, 1.5, 0, 1, 2, 1.5, .002, 1, 2, 1.8, .2, 1]);
    expect(selectInitialSimulationState(input)).toBe(input);
    expect(new ClothSimulation({} as GPUDevice, input).positions).toEqual(input.simData.positions);
    expect(input.simData.assemblySupport?.activeOnStart).toBe(false);
  });
  it('preserves an explicit held source checkpoint even when its seams remain open', () => {
    const input = cached(); input.simData.anchors[3] = 1;
    expect(selectInitialSimulationState(input)).toBe(input);
    expect(input.simData.assemblySupport?.activeOnStart).toBe(false);
  });
  it('preserves native checkpoint behavior', () => {
    const input = cached(); input.collisionSafety = false;
    expect(selectInitialSimulationState(input)).toBe(input);
  });
});

describe('live source material contact policy', () => {
  it('binds a pending source trace to captured engine settings while global settings are edited', async () => {
    const substeps = SIM_CONFIG.subSteps, gravity = SIM_CONFIG.gravity[1];
    const input = prepared(); // No material override: resolver normally returns global config identity.
    const simulation = new ClothSimulation({} as GPUDevice, input);
    const pending = deferredStep(); fake.pending = pending.promise;
    const step = simulation.step();
    try {
      SIM_CONFIG.subSteps = substeps + 1;
      SIM_CONFIG.gravity[1] = gravity - 1;
      expect(simulation.simulationConfig.subSteps).toBe(substeps);
      expect(simulation.simulationConfig.gravity[1]).toBe(gravity);
      pending.resolve(clear);
      await expect(step).resolves.toEqual(clear);
      expect(simulation.safetyReport?.trajectory?.expectedSubSteps).toBe(substeps);
    } finally { SIM_CONFIG.subSteps = substeps; SIM_CONFIG.gravity[1] = gravity; }
  });
  it('preserves intentionally selected original padding while unmarked source defaults resolve automatically', () => {
    const input = prepared();
    input.contactPolicy = { policy: 'source-material-thickness-v1', reason: 'material-aware', materialIds: ['fabric'],
      maximumMaterialThicknessMm: .5, automaticPaddingMeters: .001, preservedExplicitPadding: [] };
    const automatic = new ClothSimulation({} as GPUDevice, input);
    expect(automatic.simulationConfig.simulationThickness).toBe(.001);
    expect(automatic.simulationConfig.edgeThickness).toBe(.001);
    expect(automatic.simulationConfig.finalContactIterations).toBe(4);
    const explicit = new ClothSimulation({} as GPUDevice, input, {
      explicitPadding: { simulationThickness: true, edgeThickness: true }
    });
    expect(explicit.simulationConfig.simulationThickness).toBe(.005);
    expect(explicit.simulationConfig.edgeThickness).toBe(.005);
    expect(explicit.simulationConfig.finalContactIterations).toBe(1);
    expect(explicit.contactPolicy.preservedExplicitPadding).toEqual(['simulationThickness', 'edgeThickness']);
    expect(explicit.contactPolicy.automaticFinalContactIterations).toBe(1);
  });
  it('preserves an intentional single finishing pass with automatic source clearance', () => {
    const input = prepared();
    input.contactPolicy = { policy: 'source-material-thickness-v1', reason: 'material-aware', materialIds: ['fabric'],
      maximumMaterialThicknessMm: .5, automaticPaddingMeters: .001, preservedExplicitPadding: [] };
    const explicit = new ClothSimulation({} as GPUDevice, input, { explicitFinalContactIterations: true });
    expect(explicit.simulationConfig.simulationThickness).toBe(.001);
    expect(explicit.simulationConfig.finalContactIterations).toBe(1);
    expect(explicit.contactPolicy.automaticFinalContactIterations).toBe(4);
    expect(explicit.contactPolicy.preservedExplicitFinalContactIterations).toBe(true);
  });
  it('applies the prepared material target to current live flags and exposes actual engine provenance', () => {
    const input = prepared();
    input.contactPolicy = { policy: 'source-material-thickness-v1', reason: 'material-aware', materialIds: ['fabric'],
      maximumMaterialThicknessMm: .5, automaticPaddingMeters: .001, preservedExplicitPadding: [] };
    const previous = SIM_CONFIG.useBending;
    try {
      SIM_CONFIG.useBending = false;
      const simulation = new ClothSimulation({} as GPUDevice, input);
      expect(simulation.simulationConfig.simulationThickness).toBe(.001);
      expect(simulation.simulationConfig.edgeThickness).toBe(.001);
      expect(simulation.simulationConfig.useBending).toBe(false);
      expect(simulation.contactPolicy.maximumMaterialThicknessMm).toBe(.5);
      expect(SIM_CONFIG.simulationThickness).toBe(.005);
    } finally { SIM_CONFIG.useBending = previous; }
  });
  it('preserves a deliberate live padding override', () => {
    const input = prepared();
    input.contactPolicy = { policy: 'source-material-thickness-v1', reason: 'material-aware', materialIds: ['fabric'],
      maximumMaterialThicknessMm: .5, automaticPaddingMeters: .001, preservedExplicitPadding: [] };
    const previous = SIM_CONFIG.simulationThickness;
    try {
      SIM_CONFIG.simulationThickness = .004;
      const simulation = new ClothSimulation({} as GPUDevice, input);
      expect(simulation.simulationConfig.simulationThickness).toBe(.004);
      expect(simulation.contactPolicy.preservedExplicitPadding).toContain('simulationThickness');
    } finally { SIM_CONFIG.simulationThickness = previous; }
  });
});

function deferredProof() {
  let resolve!: (value: CollisionGuardReport) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CollisionGuardReport>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('asynchronous exact source collision proof', () => {
  it('forwards the inclusive phase range and preserves each actual corrected sample index', () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    simulation.enableCollisionPhaseReadback(11, 17);
    expect(fake.phaseSelected).toBe(11); expect(fake.phaseEnd).toBe(17);
    fake.phases = [{ substep: 12, stage: 'start', positions: clear.slice() },
      { substep: 18, stage: 'final', positions: clear.slice() }];
    expect(simulation.collisionPhaseObservations.map(phase => phase.substep)).toEqual([12, 18]);
    simulation.enableCollisionPhaseReadback(23);
    expect(fake.phaseSelected).toBe(23); expect(fake.phaseEnd).toBe(23);
    expect(fake.phaseSelfSurface).toBe(false);
    simulation.enableCollisionPhaseReadback(11, 17, true);
    expect(fake.phaseSelected).toBe(11); expect(fake.phaseEnd).toBe(17); expect(fake.phaseSelfSurface).toBe(true);
  });
  it('keeps rejected GPU timing diagnostics through rollback and copies nested profile data', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    expect(fake.profileSelected).toBeNull();
    simulation.enableGPUStageProfiling({ selectedZeroBasedSubsteps: [11, 17] });
    expect(fake.profileSelected).toEqual([11, 17]);
    const profile: CollisionProfileReport = { generation: 1, frameIndex: 5, selectedZeroBasedSubsteps: [11, 17],
      records: [{ stage: 'body-surface-apply', zeroBasedSubstep: 11, substep: 12,
        contactIteration: 0, valid: true, milliseconds: 2 }], valid: true,
      measuredStageMilliseconds: 2, scope: 'selected-compute-pass-spans' };
    fake.gpuProfile = profile; fake.output = intersecting;
    let failure: CollisionSafetyError | null = null;
    try { await simulation.step(); } catch (error) { failure = error as CollisionSafetyError; }
    expect(fake.restores).toBe(1); expect(simulation.gpuStageProfile).toBe(profile);
    expect(failure?.candidateGPUStageProfile).toEqual(profile);
    expect(failure?.candidateGPUStageProfile).not.toBe(profile);
    expect(failure?.candidateGPUStageProfile?.selectedZeroBasedSubsteps).not.toBe(profile.selectedZeroBasedSubsteps);
    expect(failure?.candidateGPUStageProfile?.records[0]).not.toBe(profile.records[0]);
    profile.selectedZeroBasedSubsteps[0] = 0; profile.records[0].milliseconds = 99;
    expect(failure?.candidateGPUStageProfile?.selectedZeroBasedSubsteps).toEqual([11, 17]);
    expect(failure?.candidateGPUStageProfile?.records[0].milliseconds).toBe(2);
    simulation.resetToArranged(); expect(simulation.gpuStageProfile).toBeNull();
  });
  it('leaves optional GPU profiling disabled for ordinary native and source simulation', () => {
    new ClothSimulation({} as GPUDevice, prepared(false));
    expect(fake.profileSelected).toBeNull();
    expect(new ClothSimulation({} as GPUDevice, prepared()).gpuStageProfile).toBeNull();
    expect(fake.profileSelected).toBeNull();
  });
  it('keeps optional rejected phase diagnostics copied and distinct from the mandatory trajectory', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    expect(fake.phaseSelected).toBeNull();
    simulation.enableCollisionPhaseReadback(23);
    expect(fake.phaseSelected).toBe(23);
    const phasePositions = clear.slice(); phasePositions[0] = .25;
    fake.phases = [{ substep: 24, stage: 'after-stretch', positions: phasePositions }];
    expect(simulation.collisionPhaseObservations).toBe(fake.phases);
    fake.output = intersecting;
    let failure: CollisionSafetyError | null = null;
    try { await simulation.step(); } catch (error) { failure = error as CollisionSafetyError; }
    expect(failure?.candidatePhases).toEqual(fake.phases);
    expect(failure?.candidatePhases?.[0]).not.toBe(fake.phases[0]);
    expect(failure?.candidatePhases?.[0].positions).not.toBe(phasePositions);
    expect(failure?.candidateTrajectory).toHaveLength(SIM_CONFIG.subSteps + 1);
    expect(failure?.candidateTrajectory?.at(-1)).toEqual(intersecting);
    phasePositions[0] = 100;
    expect(failure?.candidatePhases?.[0].positions[0]).toBe(.25);
    expect(failure?.candidatePhases?.[0].substep).toBe(24);
  });
  it('records engine/proof diagnostics for rejected attempts and clears them on reset', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    fake.timing = { encodingMs: 1, readbackWaitMs: 2, trajectoryReadbackMs: 3,
      positionReadbackMs: 4, controllerMs: 5, totalMs: 15 };
    fake.output = intersecting;
    await expect(simulation.step()).rejects.toBeInstanceOf(CollisionSafetyError);
    const timing = simulation.stepPerformance!;
    expect(timing).toMatchObject(fake.timing);
    expect(timing.workerProofMs).toBeGreaterThanOrEqual(0);
    expect(timing.totalFrameMs).toBeGreaterThanOrEqual(timing.workerProofMs);
    (timing as { encodingMs: number }).encodingMs = -1;
    expect(simulation.stepPerformance?.encodingMs).toBe(1);
    simulation.resetToArranged();
    expect(simulation.stepPerformance).toBeNull();
  });
  it('deep-copies rejected typed self-surface diagnostics independently of reset and later GPU reuse', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    simulation.enableCollisionPhaseReadback(22, 23, true);
    const candidates = new Uint32Array(32).fill(0xffffffff); candidates[1] = 0xfffffffe;
    const corrections = new Float32Array(12); corrections.set([.125, -.25, -0, 2]);
    const phase: CollisionPhaseObservation = { substep: 24, zeroBasedSubstep: 23, stage: 'contact-0-self-surface',
      positions: clear.slice(), selfSurfaceCandidates: candidates, selfSurfaceCorrections: corrections,
      selfSurfaceCandidateBudget: 32, selfSurfaceTriangleCount: 1 };
    fake.phases = [phase]; fake.output = intersecting;
    let failure: CollisionSafetyError | null = null;
    try { await simulation.step(); } catch (error) { failure = error as CollisionSafetyError; }
    const saved = failure?.candidatePhases?.[0];
    expect(saved?.selfSurfaceCandidates).toBeInstanceOf(Uint32Array);
    expect(saved?.selfSurfaceCorrections).toBeInstanceOf(Float32Array);
    expect(saved?.selfSurfaceCandidates).not.toBe(candidates);
    expect(saved?.selfSurfaceCorrections).not.toBe(corrections);
    expect(saved?.selfSurfaceCandidateBudget).toBe(32); expect(saved?.selfSurfaceTriangleCount).toBe(1);
    expect(saved?.selfSurfaceCandidates?.[1]).toBe(0xfffffffe);
    expect(Object.is(saved?.selfSurfaceCorrections?.[2], -0)).toBe(true);
    candidates.fill(0); corrections.fill(99); phase.positions.fill(99);
    expect(saved?.selfSurfaceCandidates?.[0]).toBe(0xffffffff);
    expect(saved?.selfSurfaceCorrections?.[0]).toBe(.125);
    expect(saved?.positions).toEqual(clear);
    expect(failure?.candidateTrajectory).toHaveLength(41);
    expect(fake.restores).toBe(1); expect(simulation.positions).toEqual(clear);
    simulation.resetToArranged(); expect(simulation.collisionPhaseObservations).toEqual([]);
    expect(saved?.selfSurfaceCandidates).toHaveLength(32); expect(saved?.selfSurfaceCorrections).toHaveLength(12);
  });
  it('forwards body-only diagnostics and preserves their raw bits across rejection/reset', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    simulation.enableCollisionPhaseReadback(12, 14, false, true);
    expect([fake.phaseSelected, fake.phaseEnd, fake.phaseSelfSurface, fake.phaseBodySurface]).toEqual([12, 14, false, true]);
    const candidates = new Uint32Array([0xffffffff, 5, 0, 1]);
    const correctionBits = new Uint32Array(12); correctionBits[0] = 0x80000000; correctionBits[1] = 0x7fc00001;
    fake.phases = [{ substep: 14, stage: 'contact-1-body-surface', positions: clear.slice(),
      externalSurfaceCandidates: candidates, externalSurfaceCorrections: new Float32Array(correctionBits.buffer),
      externalSurfaceCandidateBudget: 4, externalSurfaceTriangleCount: 1 }];
    fake.output = intersecting;
    let failure: CollisionSafetyError | null = null;
    try { await simulation.step(); } catch (error) { failure = error as CollisionSafetyError; }
    const saved = failure?.candidatePhases?.[0];
    candidates.fill(0); correctionBits.fill(0); simulation.resetToArranged();
    expect([...saved!.externalSurfaceCandidates!]).toEqual([0xffffffff, 5, 0, 1]);
    expect([...new Uint32Array(saved!.externalSurfaceCorrections!.buffer).slice(0, 2)]).toEqual([0x80000000, 0x7fc00001]);
    expect(saved?.externalSurfaceCandidateBudget).toBe(4); expect(saved?.externalSurfaceTriangleCount).toBe(1);
    expect(saved).not.toHaveProperty('selfSurfaceCandidates');
    expect(failure?.candidateTrajectory).toHaveLength(41);
    expect(simulation.collisionPhaseObservations).toEqual([]);
  });
  it('keeps ordinary phase observations free of optional self-surface arrays', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    simulation.enableCollisionPhaseReadback(23);
    fake.phases = [{ substep: 24, stage: 'final', positions: clear.slice() }]; fake.output = intersecting;
    let failure: CollisionSafetyError | null = null;
    try { await simulation.step(); } catch (error) { failure = error as CollisionSafetyError; }
    expect(fake.phaseSelfSurface).toBe(false); expect(fake.phaseBodySurface).toBe(false);
    expect(failure?.candidatePhases?.[0]).not.toHaveProperty('selfSurfaceCandidates');
    expect(failure?.candidatePhases?.[0]).not.toHaveProperty('selfSurfaceCorrections');
  });
  it('does not attach obsolete typed phase diagnostics or halt a reset during pending verification', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    simulation.enableCollisionPhaseReadback(23, 23, true);
    fake.phases = [{ substep: 24, stage: 'contact-1-self-surface', positions: clear.slice(),
      selfSurfaceCandidates: new Uint32Array(32).fill(0xffffffff), selfSurfaceCorrections: new Float32Array(12),
      selfSurfaceCandidateBudget: 32, selfSurfaceTriangleCount: 1 }];
    const proof = deferredProof(); fake.proofPending = proof.promise;
    const pending = simulation.step();
    await vi.waitFor(() => expect(fake.workers[0].proofs).toBe(1));
    simulation.resetToArranged();
    expect(simulation.collisionPhaseObservations).toEqual([]);
    proof.reject(new Error('Obsolete diagnostic frame failed'));
    await expect(pending).resolves.toEqual(clear);
    expect(fake.restores).toBe(0); expect(simulation.safetyReport?.safe).toBe(true);
    expect(simulation.collisionSafetyPending).toBe(false);
    fake.proofPending = null;
    await expect(simulation.step()).resolves.toEqual(clear);
    expect(simulation.collisionPhaseObservations).toEqual([]);
  });
  it('requires the complete trajectory getter at startup and rejects a missing later readback', async () => {
    fake.trajectoryUnavailable = true;
    expect(() => new ClothSimulation({} as GPUDevice, prepared())).toThrow('requires GPU collision trajectory recording');
    expect(fake.disposals).toBe(1);
    fake.trajectoryUnavailable = false;
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    fake.trajectoryUnavailable = true;
    await expect(simulation.step()).rejects.toBeInstanceOf(CollisionSafetyError);
    expect(simulation.positions).toEqual(clear);
    expect(simulation.safetyReport?.trajectory?.valid).toBe(false);
    expect(fake.restores).toBe(1);
  });
  it('fails startup actionably if the source worker cannot be created, cleaning up the engine', () => {
    fake.workerStartupError = new Error('Workers unavailable');
    expect(() => new ClothSimulation({} as GPUDevice, prepared())).toThrow('requires a collision verification worker');
    expect(fake.disposals).toBe(1);
  });
  it.each(['missing', 'malformed', 'nonfinite', 'start-binding', 'end-binding', 'mass-binding'])('rejects %s trace despite a clear final frame', async reason => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    fake.trace = Array.from({ length: SIM_CONFIG.subSteps }, () => clear.slice());
    if (reason === 'missing') fake.trace = [];
    if (reason === 'malformed') fake.trace[8] = new Float32Array(4);
    if (reason === 'nonfinite') fake.trace[8][0] = NaN;
    if (reason === 'end-binding') fake.trace.at(-1)![0] = 3;
    if (reason === 'mass-binding') fake.trace[8][3] = 0;
    if (reason === 'start-binding') {
      fake.fullTrace = [clear.slice(), ...fake.trace];
      fake.fullTrace[0][0] = 3;
    }
    await expect(simulation.step()).rejects.toBeInstanceOf(CollisionSafetyError);
    expect(simulation.positions).toEqual(clear);
    expect(simulation.safetyReport?.safe).toBe(false);
    expect(fake.restores).toBe(1);
    fake.trace = null; fake.proofError = null;
    await expect(simulation.step()).rejects.toBeInstanceOf(CollisionSafetyError);
    expect(fake.steps).toBe(1);
  });
  it('rejects a real intermediate tunnel even when both published endpoints are clear', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    fake.trace = Array.from({ length: SIM_CONFIG.subSteps }, () => clear.slice());
    for (let particle = 0; particle < 3; particle++) fake.trace[19][particle * 4] = -2;
    await expect(simulation.step()).rejects.toBeInstanceOf(CollisionSafetyError);
    expect(simulation.positions).toEqual(clear);
    expect(simulation.safetyReport?.trajectory?.valid).toBe(true);
    expect(simulation.safetyReport!.sweptBodyCrossingParticleCount).toBeGreaterThan(0);
    expect(fake.restores).toBe(1);
  });
  it('accepts the real clear bent path while a coarse frame chord would cross the body', async () => {
    const input = prepared();
    input.simData.positions = new Float32Array([2, -.2, -.2, 1, 2, .2, -.2, 1, 2, 0, .2, 1]);
    input.simData.arrangedPositions = input.simData.positions.slice();
    const start = input.simData.positions, final = start.slice();
    for (let particle = 0; particle < 3; particle++) final[particle * 4] = -2;
    fake.output = final;
    fake.trace = Array.from({ length: SIM_CONFIG.subSteps }, (_, index) => {
      const frame = start.slice(), step = index + 1;
      const x = step <= 10 ? 2 : step <= 30 ? 2 - (step - 10) / 5 : -2;
      const lift = step <= 10 ? step * .4 : step <= 30 ? 4 : (40 - step) * .4;
      for (let particle = 0; particle < 3; particle++) { frame[particle * 4] = x; frame[particle * 4 + 2] += lift; }
      return frame;
    });
    const simulation = new ClothSimulation({} as GPUDevice, input);
    await expect(simulation.step()).resolves.toEqual(final);
    expect(simulation.safetyReport?.trajectory).toMatchObject({ valid: true, inspectedSubsteps: SIM_CONFIG.subSteps });
    expect(fake.restores).toBe(0);
  });
  it('pauses persistently and restores the complete GPU snapshot if the worker transport fails', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, prepared());
    fake.proofError = new Error('Worker crashed');
    await expect(simulation.step()).rejects.toThrow('trajectory could not be verified');
    expect(simulation.safetyReport?.trajectory?.invalidReason).toBe('worker-failure');
    expect(simulation.positions).toEqual(clear);
    expect(fake.restores).toBe(1);
    expect(fake.snapshotsDestroyed).toBe(1);
    expect(fake.workers[0].disposed).toBe(true);
    fake.proofError = null;
    await expect(simulation.step()).rejects.toBeInstanceOf(CollisionSafetyError);
    expect(fake.steps).toBe(1);
    simulation.resetTo(clear);
    expect(fake.workers).toHaveLength(2);
    await expect(simulation.step()).resolves.toEqual(clear);
  });
  it('never publishes a valid obsolete proof over a newer explicit reset', async () => {
    const input = prepared(), simulation = new ClothSimulation({} as GPUDevice, input);
    fake.timing = { encodingMs: 0, readbackWaitMs: 0, trajectoryReadbackMs: 0,
      positionReadbackMs: 0, controllerMs: 0, totalMs: 0 };
    const oldCandidate = clear.slice(), reset = clear.slice();
    for (let particle = 0; particle < 3; particle++) {
      oldCandidate[particle * 4] = 3; reset[particle * 4] = 4;
    }
    fake.output = oldCandidate;
    const proof = deferredProof(); fake.proofPending = proof.promise;
    const pending = simulation.step();
    await vi.waitFor(() => expect(fake.workers[0].proofs).toBe(1));
    simulation.resetTo(reset);
    const guard = new ClothCollisionGuard({ bodyPositions: input.body.positions, bodyIndices: input.body.triangles,
      bodyPositionStride: 4, bodyTriangleStride: 4, clothTriangles: input.simData.triangles, particleCount: 3 });
    const trace = [clear, ...Array.from({ length: SIM_CONFIG.subSteps }, () => oldCandidate)];
    proof.resolve(guard.inspectTrajectory(oldCandidate, clear, trace, SIM_CONFIG.subSteps));
    await expect(pending).resolves.toEqual(reset);
    expect(simulation.positions).toEqual(reset);
    expect(fake.restores).toBe(0);
    expect(simulation.collisionSafetyPending).toBe(false);
    expect(simulation.stepPerformance).toBeNull();
    fake.proofPending = null; fake.output = reset;
    await expect(simulation.step()).resolves.toEqual(reset);
  });
  it.each(['reset', 'dispose', 'body-update'])('ignores an obsolete proof failure after %s', async action => {
    const input = prepared(), simulation = new ClothSimulation({} as GPUDevice, input);
    const proof = deferredProof(); fake.proofPending = proof.promise;
    const pending = simulation.step();
    await vi.waitFor(() => expect(fake.workers[0].proofs).toBe(1));
    expect(simulation.collisionSafetyPending).toBe(true);
    expect(simulation.step()).toBe(pending);
    if (action === 'reset') simulation.resetTo(clear);
    if (action === 'dispose') simulation.dispose();
    if (action === 'body-update') {
      const vertices = new Float32Array(input.body.positions.length / 4 * 3);
      for (let i = 0; i < vertices.length / 3; i++) {
        vertices[i * 3] = input.body.positions[i * 4] + .25;
        vertices[i * 3 + 1] = input.body.positions[i * 4 + 1];
        vertices[i * 3 + 2] = input.body.positions[i * 4 + 2];
      }
      const triangles = new Uint32Array(input.body.numTriangles * 3);
      for (let i = 0; i < input.body.numTriangles; i++) triangles.set(input.body.triangles.subarray(i * 4, i * 4 + 3), i * 3);
      simulation.rebuildBodyGrid(vertices, triangles);
      expect(fake.workers).toHaveLength(2);
      expect(fake.workers[0].disposed).toBe(true);
      expect(fake.workers[1].input.bodyPositions[0]).toBe(-.75);
    }
    expect(simulation.collisionSafetyPending).toBe(false);
    proof.reject(new Error('Obsolete proof failed'));
    await expect(pending).resolves.toEqual(clear);
    expect(fake.restores).toBe(0);
    expect(fake.snapshotsDestroyed).toBe(1);
    expect(simulation.safetyReport?.safe).toBe(true);
    fake.proofPending = null;
    await expect(simulation.step()).resolves.toEqual(clear);
  });
});


function stagedPreparation(): PreparedCloth {
  const input = prepared();
  const positions = new Float32Array([...clear, ...clear.slice(0, 8)]);
  const seams = new Int32Array(20).fill(-1), orders = new Int32Array(20).fill(-1);
  seams[0] = 3; seams[12] = 0; orders[0] = orders[12] = 0;
  seams[4] = 4; seams[16] = 1; orders[4] = orders[16] = 1;
  const ranges = [{ seamId: 'structure', start: 0, end: 1 }, { seamId: 'attachment', start: 1, end: 2 }];
  const plan: SourceStagingPlan = { revision: 1, topology: 'stage-test-physical-topology', seamIds: ['structure', 'attachment'],
    structuralSeamIndices: [0], attachmentSeamIndices: [1], shoulderPrerequisites: [], pairs: [[0, 3], [1, 4]],
    stitchIndices: [[0], [1]], stitchCount: 2, seamStitchRanges: ranges, provenance: {} as SourceStagingPlan['provenance'] };
  input.simData = { ...input.simData, particleCount: 5, positions, arrangedPositions: positions.slice(), anchors: new Float32Array(20),
    seams, seamOrder: orders, stitchCount: 2, seamStitchRanges: ranges, sourceStaging: plan,
    seamPairsBySeam: [{ seamId: 'structure', index: 9, pairs: [0, 3] }, { seamId: 'attachment', index: 12, pairs: [1, 4] }] };
  fake.output = positions.slice();
  return input;
}
async function acceptStructuralFrames(simulation: ClothSimulation) {
  await simulation.step(); await simulation.step(); await simulation.step();
}
describe('actual source stage proof and lifecycle', () => {
  it('binds three structural proofs and records the used mask while planning full activation for the next frame', async () => {
    const input = stagedPreparation(), simulation = new ClothSimulation({} as GPUDevice, input);
    simulation.setSewnUpTo(2); // Initial fully requested count must not cancel semantic staging.
    expect(fake.structuralEnabled).toBe(true);
    expect(fake.activation!.activeSeams).toEqual(new Uint32Array([1, 0]));
    expect(simulation.collisionSeamDictionary!.seamPairsBySeam.map(group => group.index)).toEqual([0, 1]);
    await acceptStructuralFrames(simulation);
    expect(simulation.sourceAssemblyState!.allActive).toBe(false);
    expect(simulation.sourceAssemblyComplete).toBe(false);
    expect(simulation.lastCollisionSeamActivation!.activeSeams).toEqual(new Uint32Array([1, 0]));
    expect(simulation.lastCollisionSeamActivation!.revision).toBe(0);
    expect(fake.activation!.activeSeams).toEqual(new Uint32Array([1, 1]));
    await simulation.step();
    expect(simulation.sourceAssemblyState!.allActive).toBe(true);
    expect(simulation.sourceAssemblyComplete).toBe(true);
    expect(simulation.lastCollisionSeamActivation!.revision).toBe(1);
    const state = simulation.sourceAssemblyState!; state.activeSeamMask[0] = 0;
    expect(simulation.sourceAssemblyState!.activeSeamMask[0]).toBe(1);
  });
  it('does not publish planned activation while a full-mask attempt awaits proof and restores it on failure', async () => {
    const input = stagedPreparation(), simulation = new ClothSimulation({} as GPUDevice, input);
    await acceptStructuralFrames(simulation);
    let reject!: (reason: Error) => void;
    fake.proofPending = new Promise((_yes, no) => { reject = no; });
    const step = simulation.step(); await vi.waitFor(() => expect(simulation.collisionSafetyPending).toBe(true));
    expect(simulation.sourceAssemblyState!.allActive).toBe(false);
    expect(() => simulation.setSewnUpTo(0)).toThrow('Drain');
    expect(() => simulation.restoreSourceAssembly(simulation.captureSourceAssembly())).toThrow('Drain');
    reject(new Error('proof transport failed'));
    let failure: CollisionSafetyError | undefined;
    await step.catch(error => { failure = error; });
    expect(failure!.candidateSeamActivation!.activeSeams).toEqual(new Uint32Array([1, 1]));
    expect(failure!.candidateSourceAssemblyState!.allActive).toBe(true);
    expect(simulation.sourceAssemblyState!.allActive).toBe(false);
    expect(simulation.captureSourceAssembly()!.requestedActivation.activeSeams).toEqual(new Uint32Array([1, 1]));
    expect(fake.restores).toBe(1);
    expect(input.simData.sourceStaging!.structuralSeamIndices).toEqual([0]);
  });
  it('transfers requested and accepted gates across settings overrides without certifying the new engine', async () => {
    const input = stagedPreparation(), simulation = new ClothSimulation({} as GPUDevice, input);
    await acceptStructuralFrames(simulation);
    const snapshot = simulation.captureSourceAssembly()!;
    const next = new ClothSimulation({} as GPUDevice, input, { explicitSeamIterations: true });
    expect(fake.structuralEnabled).toBe(false);
    next.resetTo(simulation.positions);
    next.restoreSourceAssembly(snapshot);
    expect(fake.structuralEnabled).toBe(true);
    expect(next.sourceAssemblyState!.allActive).toBe(false);
    expect(fake.activation!.activeSeams).toEqual(new Uint32Array([1, 1]));
    expect(next.sourceAssemblyComplete).toBe(false);
    snapshot.requestedActivation.activeSeams[0] = 0;
    expect(next.captureSourceAssembly()!.requestedActivation.activeSeams[0]).toBe(1);
    await next.step(); expect(next.sourceAssemblyComplete).toBe(true);
    expect(() => next.restoreSourceAssembly({ ...next.captureSourceAssembly()!, topology: 'other' })).toThrow('topology');
  });
  it('resets automatic closure counters but preserves deliberate manual prefix behavior', async () => {
    const input = stagedPreparation(), simulation = new ClothSimulation({} as GPUDevice, input);
    await acceptStructuralFrames(simulation); await simulation.step();
    simulation.resetToArranged();
    expect(fake.activation!.activeSeams).toEqual(new Uint32Array([1, 0]));
    expect(simulation.captureSourceAssembly()!.controller!.stableAcceptedFrames).toBe(0);
    expect(simulation.sourceAssemblyComplete).toBe(false);
    simulation.setSewnUpTo(1);
    expect(fake.structuralEnabled).toBe(false);
    expect(fake.activation!.activeSeams).toEqual(new Uint32Array([1, 1]));
    simulation.resetToArranged();
    expect(simulation.captureSourceAssembly()!.requestedActivation.sewnUpTo).toBe(1);
    await simulation.step(); expect(simulation.sourceAssemblyState!.allActive).toBe(false);
  });
  it('requires actual lane1 support weights, closed seams and released supports for a source checkpoint', async () => {
    const input = stagedPreparation(), simulation = new ClothSimulation({} as GPUDevice, input);
    await acceptStructuralFrames(simulation);
    fake.support = { topology: 'support', elapsedSeconds: 1, states: [], targets: new Float32Array([1, .1, 0, 0]) };
    await simulation.step(); expect(simulation.sourceAssemblyComplete).toBe(false);
    fake.support.targets[1] = 0;
    fake.output[4 * 4 + 1] += .004;
    await simulation.step(); expect(simulation.sourceAssemblyComplete).toBe(false);
    fake.output = input.simData.positions.slice();
    fake.support = { ...fake.support, states: [{ id: 'waist', kind: 'waist', phase: 'assembling', scale: 0, maxSeamGapM: 0, stableFrames: 0, releaseSeconds: 0 }] };
    await simulation.step(); expect(simulation.sourceAssemblyComplete).toBe(false);
    fake.support = { ...fake.support, states: [] };
    await simulation.step(); expect(simulation.sourceAssemblyComplete).toBe(true);
  });
  it('uses the completed GPU support snapshot and cannot certify hold changes made during proof', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, stagedPreparation());
    await acceptStructuralFrames(simulation);
    fake.support = { topology: 'support', elapsedSeconds: 1, states: [], targets: new Float32Array([1, .1, 0, 0]) };
    let resolve!: (report: CollisionGuardReport) => void;
    fake.proofPending = new Promise(yes => { resolve = yes; });
    const pending = simulation.step(); await vi.waitFor(() => expect(simulation.collisionSafetyPending).toBe(true));
    fake.support.targets[1] = 0;
    const activation = fake.activation!;
    const report = new ClothCollisionGuard(fake.workers[0].input).inspectTrajectory(fake.output, simulation.positions,
      [simulation.positions, ...Array.from({length:40}, () => fake.output.slice())], 40, activation);
    resolve(report); await pending;
    expect(simulation.sourceAssemblyComplete).toBe(false);
    fake.proofPending = null; await simulation.step(); expect(simulation.sourceAssemblyComplete).toBe(true);
    fake.proofPending = new Promise(yes => { resolve = yes; });
    const held = simulation.step(); await vi.waitFor(() => expect(simulation.collisionSafetyPending).toBe(true));
    simulation.setAnchorScale(0); // Even a release is a next-attempt change, not candidate evidence.
    resolve(new ClothCollisionGuard(fake.workers[0].input).inspectTrajectory(fake.output, simulation.positions,
      [simulation.positions, ...Array.from({length:40}, () => fake.output.slice())], 40, fake.activation!));
    await held; expect(simulation.sourceAssemblyComplete).toBe(false);
  });
  it('does not advance a staged controller from a stale proof after arranging again', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, stagedPreparation());
    await simulation.step();
    let resolve!: (report: CollisionGuardReport) => void;
    fake.proofPending = new Promise(yes => { resolve = yes; });
    const pending = simulation.step(); await vi.waitFor(() => expect(simulation.collisionSafetyPending).toBe(true));
    const oldActivation = fake.activation!, oldPositions = simulation.positions.slice();
    simulation.resetToArranged();
    resolve(new ClothCollisionGuard(fake.workers[0].input).inspectTrajectory(fake.output, oldPositions,
      [oldPositions, ...Array.from({length:40}, () => fake.output.slice())], 40, oldActivation));
    await pending;
    expect(simulation.captureSourceAssembly()!.controller!.stableAcceptedFrames).toBe(0);
    expect(simulation.sourceAssemblyComplete).toBe(false);
  });
});

describe('source checkpoint support and holds actually used during GPU integration', () => {
  it('does not certify a frame whose GPU input support was still fading even if output schedules release', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, stagedPreparation());
    await acceptStructuralFrames(simulation);
    fake.support = { topology: 'support', elapsedSeconds: 1, states: [], targets: new Float32Array([1, .1, 0, 0]) };
    const gpu = deferredStep(); fake.pending = gpu.promise;
    const frame = simulation.step();
    fake.support.targets[1] = 0;
    gpu.resolve(fake.output); await frame;
    expect(simulation.sourceAssemblyComplete).toBe(false);
    fake.pending = null; await simulation.step(); expect(simulation.sourceAssemblyComplete).toBe(true);
  });
  it('captures the hold mutation token at frame input and refuses a changed hold during GPU readback', async () => {
    const simulation = new ClothSimulation({} as GPUDevice, stagedPreparation());
    await acceptStructuralFrames(simulation);
    const gpu = deferredStep(); fake.pending = gpu.promise;
    const frame = simulation.step(); simulation.setAnchorScale(0);
    gpu.resolve(fake.output); await frame;
    expect(simulation.sourceAssemblyComplete).toBe(false);
    fake.pending = null; await simulation.step(); expect(simulation.sourceAssemblyComplete).toBe(true);
    expect(new ClothSimulation({} as GPUDevice, prepared(false)).sourceAssemblyComplete).toBeNull();
  });
});

describe('source identity seams retain their logical timeline without inventing GPU links', () => {
  it('records the identity-only exception in guard and public dictionary metadata', async () => {
    const input = stagedPreparation();
    input.simData.sourceStaging = undefined;
    input.simData.stitchCount = 3;
    input.simData.seamPairsBySeam.push({ seamId: 'identity', index: 99, pairs: [3, 3] });
    input.simData.seamStitchRanges.push({ seamId: 'identity', start: 2, end: 3 });
    const simulation = new ClothSimulation({} as GPUDevice, input);
    const groups = simulation.collisionSeamDictionary!.seamPairsBySeam;
    expect(groups[0].stitchIndexKinds).toEqual(['reciprocal-first-stamp']);
    expect(groups[2].stitchIndices).toEqual([2]);
    expect(groups[2].stitchIndexKinds).toEqual(['identity-logical']);
    expect(input.simData.seams[12]).toBe(0); // The real distinct link remains untouched.
    expect(Array.from(input.simData.seams.slice(12, 16))).not.toContain(3);
    await simulation.step();
    expect(simulation.sourceAssemblyState!.allActive).toBe(true);
    expect(simulation.sourceAssemblyComplete).toBe(true);
  });
});
