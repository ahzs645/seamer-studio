import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIM_CONFIG, packBodyMesh, CollisionSafetyError, ClothCollisionGuard, type ClothSimulation, type PreparedCloth, type SimData, type AssemblySupportSnapshot, type SourceAssemblySnapshot } from '@seamer/cloth-sim';
import * as THREE from 'three';
import { AvatarController } from '@seamer/avatar';
import { AssemblyPlayback } from '$lib/timeline/assemblyRecording';
import { PatternRenderer } from './scene3d';
import { readFileSync } from 'node:fs';
import { convertGarmentCodePattern } from '$lib/utils/importGarmentCode';

vi.mock('./seamerLighting', () => ({ SeamerLighting: vi.fn() }));
vi.mock('./pieceTexture', () => ({ createPieceTexture: vi.fn(), pieceNeedsBake: vi.fn() }));

const originalConfig = structuredClone(SIM_CONFIG);
afterEach(() => { Object.assign(SIM_CONFIG, structuredClone(originalConfig)); vi.restoreAllMocks(); });

function simulation() {
  return {
    positions: new Float32Array([0.1, 1.2, 0.3, 1]),
    captureAssemblySupport: vi.fn((): AssemblySupportSnapshot | null => null), restoreAssemblySupport: vi.fn(),
    captureSourceAssembly: vi.fn((): SourceAssemblySnapshot | null => null), restoreSourceAssembly: vi.fn(),
    setSelfCollision: vi.fn(), setAnchorScale: vi.fn(), resetTo: vi.fn(), dispose: vi.fn(),
    setGrab: vi.fn(), seedAndHold: vi.fn()
  };
}

// Exercise the renderer's orchestration without constructing a DOM viewport or GPU engine.
// Engine creation is represented by ensureSim; the real public methods must request it when
// a collision option changes and transfer the live positions and run state to the new engine.
function rendererRig() {
  const renderer = Object.create(PatternRenderer.prototype) as PatternRenderer;
  const oldSim = simulation();
  const newSim = simulation();
  const runner = { stop: vi.fn(), dispose: vi.fn() };
  const state = {
    sim: oldSim as ReturnType<typeof simulation> | null,
    simRunner: runner,
    simulating: false, userSimulating: false, bodyDirty: false, baseCylinders: null,
    adaptFramesLeft: 0, anchorsEnabled: false, liveAnchorScale: 0,
    grabbing: false, grabIndex: 0, sourceBodyInitializationRevision: 0, sourcePreparationRequestRevision: 0, simulationResetRevision: 0,
    applyClothPositions: vi.fn(), onStatus: vi.fn(), runSimLoop: vi.fn(),
    ensureSim: vi.fn(async () => {
      Object.assign(renderer, { sim: newSim });
      return newSim;
    })
  };
  Object.assign(renderer, state);
  return { renderer, oldSim, newSim, runner, state };
}

describe('renderer simulation failure handling', () => {
  function rejectedRecordingRig() {
    const rig = rendererRig();
    const prepared = sourcePreviewData();
    Object.assign(prepared.simData, { assemblySteps: [] });
    const guard = new ClothCollisionGuard({ bodyPositions: prepared.body.positions,
      bodyIndices: prepared.body.triangles, bodyPositionStride: 4, bodyTriangleStride: 4,
      clothTriangles: prepared.simData.triangles, particleCount: 3,
      seams: prepared.simData.seams, stitchCount: 0, seamPairsBySeam: [] });
    const report = guard.inspect(crossingPreview, undefined, { revision: 0, activeSeams: new Uint32Array(), sewnUpTo: 0 });
    expect(report.safe).toBe(false);
    expect(report.bodyCrossingTriangleCount).toBeGreaterThan(0);
    const trajectory = Array.from({ length: 41 }, (_, index) => index === 0 ? clearPreview.slice() : crossingPreview.slice());
    const error = new CollisionSafetyError(report, crossingPreview.slice(), trajectory);
    const recordSim = Object.assign(rig.newSim, { positions: clearPreview.slice(), stitchCount: 0,
      simulationConfig: structuredClone(SIM_CONFIG),
      resetToArranged: vi.fn(() => { rig.newSim.positions = clearPreview.slice(); }),
      cancelSourceAssembly: vi.fn(), setSewnUpTo: vi.fn(), step: vi.fn(async (): Promise<Float32Array> => { throw error; }) });
    Object.assign(rig.renderer, { prepared, pattern: { id: 'source', pieces: [] },
      sourceSceneGeneration: 7, disposed: false, invalidate: vi.fn(),
      simulationFailure: null, drapeFailureDiagnostics: null, recordedAssemblyGeneration: -1 });
    return { ...rig, newSim: recordSim, prepared, error, trajectory };
  }

  it('keeps a rejected manual recording persistently invalid with exact evidence and a working Reset', async () => {
    const { renderer, newSim, state, error, trajectory } = rejectedRecordingRig();
    const onDrapeSettled = vi.fn();
    Object.assign(renderer, { onDrapeSettled });
    await expect(renderer.recordAssemblyTimeline({ from: 'arranged', leadFrames: 1, maxFrames: 8 })).rejects.toBe(error);
    expect(state.onStatus).toHaveBeenLastCalledWith('invalid', error.message);
    expect((renderer as unknown as { simulationFailure: string }).simulationFailure).toBe(error.message);
    const captured = renderer.getDrapeFailureDiagnostics()!;
    expect(captured.report.safe).toBe(false);
    expect(captured.candidateTrajectory).toEqual(trajectory);
    expect(captured.candidateTrajectory).toHaveLength(41);
    expect(captured.previousPositions).toEqual(clearPreview);
    expect(newSim.positions).toEqual(clearPreview);
    expect(state.applyClothPositions).not.toHaveBeenCalled();
    expect(onDrapeSettled).not.toHaveBeenCalled();
    expect((renderer as unknown as { recordedAssemblyGeneration: number }).recordedAssemblyGeneration).toBe(-1);
    expect(newSim.setSewnUpTo.mock.calls).toEqual([[0], [0]]);
    renderer.resetSimulation();
    expect(renderer.getDrapeFailureDiagnostics()).toBeNull();
    expect((renderer as unknown as { simulationFailure: string | null }).simulationFailure).toBeNull();
    expect(state.applyClothPositions).toHaveBeenCalledWith(clearPreview);
    expect(state.onStatus).toHaveBeenLastCalledWith('ready');
  });

  it.each(['reset', 'body', 'preparation', 'rebuild', 'dispose', 'pattern', 'simulation'] as const)(
    'a stale manual-record rejection after %s cannot invalidate its replacement', async reason => {
      const { renderer, newSim, error } = rejectedRecordingRig();
      let reject!: (error: Error) => void, started!: () => void;
      const startedStep = new Promise<void>(resolve => { started = resolve; });
      const pending = new Promise<Float32Array>((_resolve, rejectStep) => { reject = rejectStep; });
      newSim.step = vi.fn(() => { started(); return pending; });
      const fail = vi.spyOn(renderer as unknown as { failSimulation(error: unknown): void }, 'failSimulation');
      const recording = renderer.recordAssemblyTimeline({ from: 'arranged', leadFrames: 1, maxFrames: 8 });
      await startedStep;
      if (reason === 'reset') Object.assign(renderer, { simulationResetRevision: 1 });
      if (reason === 'body') Object.assign(renderer, { sourceBodyInitializationRevision: 1 });
      if (reason === 'preparation') Object.assign(renderer, { sourcePreparationRequestRevision: 1 });
      if (reason === 'rebuild') Object.assign(renderer, { sourceSceneGeneration: 8, prepared: {} });
      if (reason === 'dispose') Object.assign(renderer, { disposed: true });
      if (reason === 'pattern') Object.assign(renderer, { pattern: { id: 'replacement', pieces: [] } });
      if (reason === 'simulation') Object.assign(renderer, { sim: {} });
      reject(error);
      await expect(recording).rejects.toBe(error);
      expect(fail).not.toHaveBeenCalled();
      expect(renderer.getDrapeFailureDiagnostics()).toBeNull();
      expect((renderer as unknown as { simulationFailure: string | null }).simulationFailure).toBeNull();
    });

  it('a manual recording device error stays actionable and is not returned as playable frames', async () => {
    const { renderer, newSim, state } = rejectedRecordingRig();
    const error = new Error('The GPU device could not continue. Reset the garment.');
    newSim.step = vi.fn(async () => { throw error; });
    await expect(renderer.recordAssemblyTimeline({ from: 'arranged', leadFrames: 1, maxFrames: 8 })).rejects.toBe(error);
    expect(state.onStatus).toHaveBeenLastCalledWith('error', error.message);
    expect((renderer as unknown as { simulationFailure: string | null }).simulationFailure).toBe(error.message);
    expect(renderer.getDrapeFailureDiagnostics()).toBeNull();
  });

  it('rebuilds refined topology to the original sewing mesh before a manual recording and preserves effective intent', async () => {
    const { renderer, newSim } = rendererRig();
    const pattern = { id: 'approved', pieces: [] };
    const refined = { simData: { sourceGatherRefinement: { revision: 'source-free-gather-boundary-v1' } } };
    const original = { simData: { particleCount: 1, assemblySteps: [{ id: 'manual', label: 'Manual', start: 0, end: 12, settleFrames: 0 }] } };
    const rebuildCloth = vi.fn(async (_pattern, _changed, arranged) => {
      expect(arranged).toBe(true);
      expect((renderer as unknown as { sourceGatherManualRecording: boolean }).sourceGatherManualRecording).toBe(true);
      Object.assign(renderer, { prepared: original, sourceGatherManualPrepared: original });
    });
    Object.assign(newSim, { stitchCount: 12, resetToArranged: vi.fn(), cancelSourceAssembly: vi.fn(),
      setSewnUpTo: vi.fn(), step: async () => newSim.positions });
    Object.assign(renderer, { prepared: refined, pattern, sourcePreparationRequestRevision: 2,
      sourceSceneGeneration: 1, invalidate: vi.fn(), rebuildCloth });
    const recording = await renderer.recordAssemblyTimeline({ from: 'arranged', leadFrames: 0, maxFrames: 8 });
    expect(rebuildCloth).toHaveBeenCalledOnce();
    expect(recording!.stitches).toEqual([2, 4, 6, 8, 10, 12]);
    expect(renderer.getSourceGatherIntent()).toBe('manual');
    Object.assign(renderer, { prepared: refined });
    expect(renderer.getSourceGatherIntent()).toBeUndefined();
  });

  it.each(['dispose', 'reset', 'pattern', 'avatar', 'request'] as const)('cancels a stale cold pose finalization after %s without rolling back or pausing its replacement', async reason => {
    const renderer = Object.create(PatternRenderer.prototype) as PatternRenderer;
    const oldAvatar = { poseName: () => 'previous', setPose: vi.fn() }, nextAvatar = { poseName: () => 'replacement', setPose: vi.fn() };
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, failed) => { reject = failed; });
    const rebuildCloth = vi.fn(() => pending), failSimulation = vi.fn();
    Object.assign(renderer, { avatar: oldAvatar, pattern: { id: 'old' }, prepared: { id: 'prepared' }, sim: null,
      disposed: false, sourceBodyInitializationRevision: 0, sourcePreparationRequestRevision: 0,
      simulationResetRevision: 0, rebuildCloth, failSimulation });
    const changing = renderer.setPose('candidate');
    if (reason === 'dispose') Object.assign(renderer, { disposed: true });
    if (reason === 'reset') Object.assign(renderer, { simulationResetRevision: 1 });
    if (reason === 'pattern') Object.assign(renderer, { pattern: { id: 'new' } });
    if (reason === 'avatar') Object.assign(renderer, { avatar: nextAvatar });
    if (reason === 'request') Object.assign(renderer, { sourcePreparationRequestRevision: 1 });
    reject(new Error('The candidate finalization became stale.'));
    await expect(changing).resolves.toBeUndefined();
    expect(rebuildCloth).toHaveBeenCalledOnce();
    expect(oldAvatar.setPose.mock.calls).toEqual([['candidate']]);
    expect(nextAvatar.setPose).not.toHaveBeenCalled();
    expect(failSimulation).not.toHaveBeenCalled();
  });

  it.each(['current', 'dispose', 'reset', 'pattern', 'avatar'] as const)('checks the actual source pair before cold hashing and safely drains a %s transaction', async reason => {
    const { renderer, prepared, mesh, geometry } = previewRenderer();
    const originalBody = Float32Array.from(prepared.body.positions.filter((_, index) => index % 4 !== 3));
    const indices = Uint32Array.from(prepared.body.triangles.filter((_, index) => index % 4 !== 3));
    let pose = 'A', release!: () => void;
    const avatar = { vertexPositions: originalBody.slice(), indices, poseName: () => pose,
      setPose: vi.fn((name: string) => { pose = name;
        avatar.vertexPositions = Float32Array.from(originalBody, (value, index) => index % 3 === 0 && name === 'T' ? value - 2 : value); }) };
    const pending = new Promise<void>(resolve => { release = resolve; });
    const internals = renderer as unknown as { renderedSourcePositions(): Float32Array };
    const inspected = vi.spyOn(internals, 'renderedSourcePositions');
    const rebuildCloth = vi.fn(() => {
      expect(inspected).toHaveBeenCalledOnce();
      expect(avatar.vertexPositions[0]).toBe(originalBody[0] - 2);
      return pending;
    });
    const failSimulation = vi.fn();
    Object.assign(renderer, { avatar, rebuildCloth, failSimulation });
    mesh.position.y = 0.125;
    const before = Float32Array.from(geometry.getAttribute('position').array);
    const changing = renderer.setPose('T');
    expect(rebuildCloth).toHaveBeenCalledOnce();
    expect(inspected.mock.results[0].value[1]).toBe(clearPreview[1] + 0.125);
    expect(geometry.getAttribute('position').array).toEqual(before);
    expect(failSimulation).not.toHaveBeenCalled();
    if (reason === 'dispose') Object.assign(renderer, { disposed: true });
    if (reason === 'reset') Object.assign(renderer, { simulationResetRevision: 1 });
    if (reason === 'pattern') Object.assign(renderer, { pattern: { id: 'replacement' } });
    const replacement = { setPose: vi.fn() };
    if (reason === 'avatar') Object.assign(renderer, { avatar: replacement });
    release(); await changing;
    expect(replacement.setPose).not.toHaveBeenCalled();
    expect(avatar.poseName()).toBe('T');
    expect(failSimulation).not.toHaveBeenCalled();
  });

  it('rejects a direct visible source mesh edit before a cold pose hash or rebuild can await', async () => {
    const { renderer, prepared, mesh } = previewRenderer();
    const body = Float32Array.from(prepared.body.positions.filter((_, index) => index % 4 !== 3));
    const indices = Uint32Array.from(prepared.body.triangles.filter((_, index) => index % 4 !== 3));
    let pose = 'A';
    const avatar = { vertexPositions: body, indices, poseName: () => pose,
      setPose: vi.fn((name: string) => { pose = name; }) };
    const rebuildCloth = vi.fn(() => new Promise<void>(() => undefined)), failSimulation = vi.fn();
    Object.assign(renderer, { avatar, rebuildCloth, failSimulation });
    mesh.position.x = -2; // Displayed cloth intersects; the stale prepared XYZ remains clear.
    await renderer.setPose('T');
    expect(avatar.setPose.mock.calls).toEqual([['T'], ['A']]);
    expect(rebuildCloth).not.toHaveBeenCalled();
    expect(failSimulation.mock.calls[0][0]).toBeInstanceOf(CollisionSafetyError);
    expect(prepared.simData.positions).toEqual(clearPreview);
  });
  it('retains the proven publication gate when its solver is absent and clears it before a fresh arrangement reset', () => {
    const { renderer, prepared } = previewRenderer();
    const context = { dictionary: { stitchCount: 0, seamPairsBySeam: [] },
      activation: { revision: 7, activeSeams: new Uint32Array(), sewnUpTo: 0 } };
    Object.assign(renderer, { sourcePublishedCollisionContext: { prepared, context } });
    const internals = renderer as unknown as { sourceCollisionContext(p: PreparedCloth, accepted: boolean): typeof context };
    expect(internals.sourceCollisionContext(prepared, true).activation.revision).toBe(7);
    expect(internals.sourceCollisionContext({ ...prepared }, true).activation.revision).toBe(0);
    renderer.resetSimulation();
    expect(internals.sourceCollisionContext(prepared, true).activation.revision).toBe(0);
  });

  it('captures actual baked source-rest metadata without exposing live mutable arrays', () => {
    const { renderer } = rendererRig();
    const policy = { policy: 'source-authored-seam-stretch-v1' as const,
      sewingSolver: 'interleaved-stretch-sewing-v1' as const, sourcePieceIds: ['original-source-panel'],
      retainedSeamStretchEdges: 9, legacySoftenedSeamStretchEdges: 0 };
    Object.assign(renderer, { sim: null, prepared: { simData: { sourceStretchPolicy: policy } } });
    const captured = renderer.getSourceStretchPolicy();
    expect(captured).toEqual(policy);
    captured!.sourcePieceIds[0] = 'mutated';
    captured!.retainedSeamStretchEdges = 900;
    expect(renderer.getSourceStretchPolicy()).toEqual(policy);
    const livePolicy = { ...policy, sourcePieceIds: ['actual-live-source-panel'], retainedSeamStretchEdges: 12 };
    Object.assign(renderer, { sim: { simData: { sourceStretchPolicy: livePolicy } } });
    expect(renderer.getSourceStretchPolicy()).toEqual(livePolicy);
    Object.assign(renderer, { sim: null, prepared: { simData: {} } });
    expect(renderer.getSourceStretchPolicy()).toBeNull();
  });
  it('captures source resume eligibility from actual live accepted state, never prepared metadata', () => {
    const { renderer } = rendererRig();
    Object.assign(renderer, { sim: null, prepared: { simData: { sourceAssemblyComplete: true } } });
    expect(renderer.getSourceAssemblyComplete()).toBeNull();
    Object.assign(renderer, { sim: { sourceAssemblyComplete: false } });
    expect(renderer.getSourceAssemblyComplete()).toBe(false);
    Object.assign(renderer, { sim: { sourceAssemblyComplete: true } });
    expect(renderer.getSourceAssemblyComplete()).toBe(true);
    Object.assign(renderer, { sim: { sourceAssemblyComplete: null } });
    expect(renderer.getSourceAssemblyComplete()).toBeNull();
  });

  it('records an intentionally manual sewing sequence after a fresh reset reinitializes automatic staging', async () => {
    const { renderer, newSim } = rendererRig();
    let automatic = false, prefix = 12;
    const observedPrefixes: number[] = [];
    Object.assign(newSim, { stitchCount: 12,
      resetToArranged: () => { automatic = true; },
      cancelSourceAssembly: () => { automatic = false; },
      setSewnUpTo: (value: number) => { prefix = value; },
      step: async () => {
        if (automatic) throw new Error('Recording unexpectedly used automatic stages');
        observedPrefixes.push(prefix); return newSim.positions;
      } });
    Object.assign(renderer, { invalidate: vi.fn(), sourceSceneGeneration: 3,
      prepared: { simData: { particleCount: 1,
        assemblySteps: [{ id: 'manual', label: 'Manual sewing', start: 0, end: 12, settleFrames: 0 }] } } });
    const recording = await renderer.recordAssemblyTimeline({ from: 'arranged', leadFrames: 0, maxFrames: 8 });
    expect(recording!.frames).toHaveLength(6);
    expect(recording!.stitches).toEqual([2, 4, 6, 8, 10, 12]);
    expect(observedPrefixes).toEqual(recording!.stitches);
    expect(automatic).toBe(false);
    expect(prefix).toBe(12);
  });

  it.each([true, false])('starts source solver without repainting unchanged pending geometry (source: %s)', source => {
    const { renderer } = rendererRig();
    const acquireRenderLease = vi.fn(() => vi.fn());
    const start = vi.fn();
    Object.assign(renderer, { prepared: { collisionSafety: source }, viewport: { acquireRenderLease }, simRunner: { start } });
    const prototype = PatternRenderer.prototype as unknown as { runSimLoop(): void };
    prototype.runSimLoop.call(renderer);
    prototype.runSimLoop.call(renderer);
    expect(start).toHaveBeenCalledTimes(2);
    expect(acquireRenderLease).toHaveBeenCalledTimes(source ? 0 : 1);
    if (!source) expect(acquireRenderLease).toHaveBeenCalledWith('cloth-solver');
  });

  it('releases an old native drawing lease when starting a source solver', () => {
    const { renderer } = rendererRig();
    const release = vi.fn(), acquireRenderLease = vi.fn(), start = vi.fn();
    Object.assign(renderer, { prepared: { collisionSafety: true }, releaseSimulationLease: release,
      viewport: { acquireRenderLease }, simRunner: { start } });
    const prototype = PatternRenderer.prototype as unknown as { runSimLoop(): void };
    prototype.runSimLoop.call(renderer);
    prototype.runSimLoop.call(renderer);
    expect(release).toHaveBeenCalledOnce();
    expect(acquireRenderLease).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('retains immutable exact rejected trajectory evidence and clears it on a valid reset', () => {
    const { renderer, oldSim, state } = rendererRig();
    const prepared = sourcePreviewData();
    const candidate = crossingPreview.slice();
    const trajectory = [clearPreview.slice(), candidate.slice()];
    const report = { safe: false, finite: true, bodyClosed: true, insideParticleCount: 0,
      bodyCrossingTriangleCount: 1, selfCrossingPairCount: 0, sweptBodyCrossingParticleCount: 0,
      insideParticles: [], bodyCrossingTriangles: [0], selfCrossingPairs: [],
      sweptBodyCrossingParticles: [], rayDisagreementCount: 0, limitations: [] };
    const error = new CollisionSafetyError(report, candidate, trajectory);
    Object.assign(oldSim, { positions: clearPreview.slice(), simulationConfig: structuredClone(SIM_CONFIG),
      resetToArranged: vi.fn() });
    Object.assign(renderer, { pattern: null, prepared, invalidate: vi.fn(), sourceSceneGeneration: 7 });
    (renderer as unknown as { failSimulation(error: unknown): void }).failSimulation(error);
    const evidence = renderer.getDrapeFailureDiagnostics()!;
    expect(evidence).not.toBeNull();
    expect(evidence.candidateTrajectory).toEqual(trajectory);
    expect(evidence.previousPositions).toEqual(clearPreview);
    expect(evidence.bodyPositions).toEqual(prepared.body.positions);
    expect(evidence.bodyPositionStride).toBe(4);
    expect(evidence.sceneGeneration).toBe(7);
    evidence.candidateTrajectory![1][0] = 100;
    candidate[0] = 200;
    prepared.body.positions[0] = 300;
    expect(renderer.getDrapeFailureDiagnostics()!.candidateTrajectory![1][0]).toBe(crossingPreview[0]);
    expect(renderer.getDrapeFailureDiagnostics()!.bodyPositions[0]).not.toBe(300);
    expect(state.onStatus).toHaveBeenLastCalledWith('invalid', error.message);
    renderer.resetSimulation();
    expect(renderer.getDrapeFailureDiagnostics()).toBeNull();
  });

  it('still pauses safely if DEV evidence cannot be cloned', () => {
    const { renderer, state } = rendererRig();
    const pattern = new Proxy({}, { ownKeys: () => { throw new Error('Unavailable pattern data'); } });
    Object.assign(renderer, { prepared: sourcePreviewData(), pattern, invalidate: vi.fn() });
    const error = new CollisionSafetyError({ safe: false } as never, crossingPreview);
    expect(() => (renderer as unknown as { failSimulation(error: unknown): void }).failSimulation(error)).not.toThrow();
    expect(state.onStatus).toHaveBeenLastCalledWith('invalid', error.message);
    expect(renderer.getDrapeFailureDiagnostics()).toBeNull();
  });

  it('captures reactive pattern proxies using the same JSON data representation as persistence', () => {
    const { renderer, oldSim } = rendererRig();
    const data = { name: 'Reactive source garment', pieces: [{ name: 'torso' }] };
    const pattern = new Proxy(data, {});
    expect(() => structuredClone(pattern)).toThrow();
    Object.assign(oldSim, { simulationConfig: structuredClone(SIM_CONFIG) });
    Object.assign(renderer, { prepared: sourcePreviewData(), pattern, invalidate: vi.fn() });
    (renderer as unknown as { failSimulation(error: unknown): void }).failSimulation(
      new CollisionSafetyError({ safe: false } as never, crossingPreview));
    expect(renderer.getDrapeFailureDiagnostics()!.pattern).toEqual(data);
    data.name = 'Later changed';
    expect(renderer.getDrapeFailureDiagnostics()!.pattern!.name).toBe('Reactive source garment');
  });

  it('drains the current GPU frame before changing the body pose', async () => {
    const { renderer, oldSim, state } = rendererRig();
    let finish!: (positions: Float32Array) => void;
    const activeSimulationStep = new Promise<Float32Array>(resolve => { finish = resolve; });
    const avatar = { poseName: () => 'A', setPose: vi.fn(),
      vertexPositions: new Float32Array([0, 0, 0]), indices: new Uint32Array() };
    const rebuildBodyGrid = vi.fn();
    Object.assign(oldSim, { rebuildBodyGrid });
    Object.assign(renderer, { activeSimulationStep, avatar, pattern: {},
      simulating: true, userSimulating: true, invalidate: vi.fn() });
    const changed = renderer.setPose('T');
    expect(avatar.setPose).not.toHaveBeenCalled();
    expect(rebuildBodyGrid).not.toHaveBeenCalled();
    finish(oldSim.positions);
    await changed;
    expect(avatar.setPose).toHaveBeenCalledWith('T');
    expect(rebuildBodyGrid).toHaveBeenCalledOnce();
    expect(state.runSimLoop).toHaveBeenCalledOnce();
  });
  it.each([true, false])('preserves checked source geometry when baking (source: %s)', source => {
    const { renderer, oldSim } = rendererRig();
    const before = oldSim.positions.slice();
    const weldSeamCounterparts = vi.fn((positions: Float32Array) => { positions[0] = -10; });
    const onDrapeSettled = vi.fn();
    Object.assign(renderer, { pattern: {}, prepared: { collisionSafety: source },
      userSimulating: true, weldSeamCounterparts, computeStretchError: vi.fn(() => 0),
      extractSavedPositions: vi.fn(() => oldSim.positions.slice()),
      onDrapeSettled, invalidate: vi.fn() });
    renderer.stopSimulation();
    if (source) {
      expect(weldSeamCounterparts).not.toHaveBeenCalled();
      expect(oldSim.positions).toEqual(before);
      expect(onDrapeSettled).toHaveBeenCalledWith(before);
    } else expect(weldSeamCounterparts).toHaveBeenCalledOnce();
  });
  it('refreshes the prepared body collider when changing pose before simulation starts', () => {
    const { renderer } = rendererRig();
    const avatar = { poseName: () => 'A', setPose: vi.fn() };
    const pattern = {};
    const rebuildCloth = vi.fn();
    Object.assign(renderer, { avatar, pattern, sim: null, rebuildCloth, invalidate: vi.fn() });
    renderer.setPose('T');
    expect(avatar.setPose).toHaveBeenCalledWith('T');
    expect(rebuildCloth).toHaveBeenCalledWith(pattern);
  });
  it('restores the previous avatar pose when an instant pose change crosses the cloth', () => {
    const { renderer, oldSim, runner, state } = rendererRig();
    const error = new Error('Body collision');
    error.name = 'CollisionSafetyError';
    const rebuildBodyGrid = vi.fn().mockImplementationOnce(() => { throw error; });
    const avatar = { poseName: () => 'A', setPose: vi.fn(),
      vertexPositions: new Float32Array([0, 0, 0]), indices: new Uint32Array() };
    Object.assign(oldSim, { rebuildBodyGrid });
    Object.assign(renderer, { avatar, pattern: {}, invalidate: vi.fn(), simulating: true });
    renderer.setPose('T');
    expect(avatar.setPose.mock.calls).toEqual([['T'], ['A']]);
    expect(rebuildBodyGrid).toHaveBeenCalledTimes(2);
    expect(oldSim.resetTo).toHaveBeenCalledWith(oldSim.positions);
    expect(runner.stop).toHaveBeenCalledOnce();
    expect(state.onStatus).toHaveBeenLastCalledWith('invalid', expect.stringContaining('pose intersects'));
  });
  it('pauses rejected geometry and does not bake it as a new drape', () => {
    const { renderer, oldSim, runner, state } = rendererRig();
    const releaseLease = vi.fn(), onDrapeSettled = vi.fn();
    Object.assign(renderer, { pattern: {}, simulating: true, userSimulating: true,
      releaseSimulationLease: releaseLease, onDrapeSettled, invalidate: vi.fn() });
    const error = new Error('Simulation paused: fabric crossed the body. Reset the arrangement.');
    error.name = 'CollisionSafetyError';
    const positions = oldSim.positions.slice();
    (renderer as unknown as { failSimulation(error: unknown): void }).failSimulation(error);
    expect(runner.stop).toHaveBeenCalledOnce();
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(state.onStatus).toHaveBeenLastCalledWith('invalid', error.message);
    expect(oldSim.positions).toEqual(positions);
    renderer.stopSimulation();
    expect(onDrapeSettled).not.toHaveBeenCalled();
  });
});

const clearPreview = new Float32Array([2, -.3, -.3, 1, 2, .3, -.3, 1, 2, 0, .3, 1]);
// The cube cuts the triangle interior although every cloth vertex is outside it.
const crossingPreview = new Float32Array([-4, -3, 0, 1, 4, -3, 0, 1, 0, 5, 0, 1]);
function sourcePreviewData(source = true): PreparedCloth {
  const body = packBodyMesh(new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
    -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1
  ]), new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7
  ]));
  return { body, collisionSafety: source, simData: {
    particleCount: 3, triangles: new Uint32Array([0, 1, 2, 0]),
    positions: clearPreview.slice(), arrangedPositions: clearPreview.slice(),
    anchors: new Float32Array(12), seams: new Int32Array(12).fill(-1),
    seamOrder: new Int32Array(12).fill(-1), seamPairsBySeam: [], seamStitchRanges: [], stitchCount: 0
  } as unknown as SimData };
}
type PreviewInternals = {
  checkSourcePreview(prepared: PreparedCloth): { prepared: PreparedCloth; report: { safe: boolean } | null };
  applyClothPositions(positions: Float32Array): void;
  applyPattern(pattern: ReturnType<typeof convertGarmentCodePattern>): Promise<boolean>;
  sourceSceneGeneration: number;
  sourcePreviewReport: { safe: boolean; insideParticleCount: number; bodyCrossingTriangleCount: number };
  lastClothPositions: Float32Array;
};
function previewRenderer(source = true) {
  const renderer = Object.create(PatternRenderer.prototype) as PatternRenderer;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  geometry.setIndex([0, 1, 2]);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const prepared = sourcePreviewData(source);
  const onStatus = vi.fn();
  Object.assign(renderer, {
    prepared, sim: null, simRunner: null, pattern: {}, avatar: null,
    clothMeshes: [{ pieceId: 'panel', start: 0, count: 3, geometry, mesh, baseVisible: true }],
    pieceLabels: [], overlays: { updatePositions: vi.fn() },
    invalidate: vi.fn(), updateDebugFocusPoint: vi.fn(), onStatus,
    sourceSceneGeneration: 1, recordedAssemblyGeneration: 1, sourceContactOptions: {},
    sourcePreparationRequestRevision: 0, sourceBodyInitializationRevision: 0, simulationResetRevision: 0
  });
  const internals = renderer as unknown as PreviewInternals;
  internals.applyClothPositions(clearPreview);
  return { renderer, internals, prepared, mesh, geometry, onStatus };
}

describe('source accepted frame publication', () => {
  function publicationRig(source = true) {
    const rig = previewRenderer(source);
    const pattern = convertGarmentCodePattern(JSON.parse(readFileSync(
      new URL('../../../static/examples/garmentcode/hoody_mean_specification.json', import.meta.url), 'utf8'
    )));
    pattern.pieces = [{ ...pattern.pieces[0], id: 'panel' }];
    Object.assign(rig.prepared.simData, { positions2d: new Float32Array(12),
      pieces: [{ pieceId: 'panel', start: 0, count: 3 }], seamPairsBySeam: [] });
    let resolve!: (positions: Float32Array) => void;
    let reject!: (error: Error) => void;
    const deferred = new Promise<Float32Array>((done, failed) => { resolve = done; reject = failed; });
    const activation = { revision: 1, sewnUpTo: 1, activeSeams: new Uint32Array([1]) };
    const sim = { positions: clearPreview.slice(), step: vi.fn(() => deferred),
      safetyReport: { safe: true, trajectory: { valid: true, inspectedSubsteps: 40 },
        seamActivation: { ...activation, activeSeams: [1] } }, lastCollisionSeamActivation: activation,
      simulationConfig: { subSteps: 40 }, resetToArranged: vi.fn() };
    Object.assign(sim, { simData: rig.prepared.simData });
    Object.assign(rig.renderer, { sim, pattern, sourceSimPrepared: rig.prepared, simFrameCount: 0, simulating: true,
      simulationResetRevision: 0, failSimulation: vi.fn() });
    const controls = rig.renderer as unknown as {
      stepSimulation(simulation: ClothSimulation): Promise<void>;
      publishRunnerFrame(simulation: ClothSimulation, positions: Float32Array): void;
      simFrameCount: number;
    };
    const accepted = clearPreview.slice();
    for (let particle = 0; particle < 3; particle++) accepted[particle * 4] += .025;
    return { ...rig, sim, controls, accepted, resolve, reject };
  }

  it.each([true, false])('publishes one genuine accepted source frame while paused=%s, with export matching real mesh coordinates', async paused => {
    const { renderer, geometry, sim, controls, accepted, resolve } = publicationRig();
    const pending = controls.stepSimulation(sim as unknown as ClothSimulation);
    if (paused) renderer.pauseSimulation();
    sim.positions = accepted; resolve(accepted); await pending;
    const rendered = Array.from(geometry.getAttribute('position').array);
    expect(rendered).toEqual(Array.from(accepted).filter((_, index) => index % 4 < 3));
    const captured = renderer.extractSavedPositions().panel;
    expect(captured.filter((_, index) => index % 5 >= 2)).toEqual(rendered);
    expect(renderer.getDrapeDebugState().renderedPositionErrorM).toBe(0);
    expect(controls.simFrameCount).toBe(1);
    controls.publishRunnerFrame(sim as unknown as ClothSimulation, accepted);
    expect(controls.simFrameCount, 'source runner callbacks cannot publish twice').toBe(1);
  });

  it.each(['reset', 'body generation', 'replaced preparation', 'replaced simulation', 'disposed'])(
    'does not publish a completed old source frame after %s', async change => {
      const { renderer, geometry, sim, controls, accepted, resolve, prepared } = publicationRig();
      const pending = controls.stepSimulation(sim as unknown as ClothSimulation);
      if (change === 'reset') renderer.resetSimulation();
      if (change === 'body generation') Object.assign(renderer, { sourceSceneGeneration: 2 });
      if (change === 'replaced preparation') Object.assign(renderer, { prepared: { ...prepared } });
      if (change === 'replaced simulation') Object.assign(renderer, { sim: { ...sim } });
      if (change === 'disposed') Object.assign(renderer, { disposed: true });
      sim.positions = accepted; resolve(accepted); await pending;
      expect(Array.from(geometry.getAttribute('position').array)).toEqual(Array.from(clearPreview).filter((_, index) => index % 4 < 3));
      expect(controls.simFrameCount).toBe(0);
    }
  );

  it.each(['unsafe', 'missing trajectory', 'incomplete trajectory', 'wrong activation'])(
    'cannot publish source positions with %s proof', async condition => {
      const { geometry, sim, controls, accepted, resolve } = publicationRig();
      const pending = controls.stepSimulation(sim as unknown as ClothSimulation);
      if (condition === 'unsafe') sim.safetyReport.safe = false;
      if (condition === 'missing trajectory') sim.safetyReport.trajectory.valid = false;
      if (condition === 'incomplete trajectory') sim.safetyReport.trajectory.inspectedSubsteps = 39;
      if (condition === 'wrong activation') sim.safetyReport.seamActivation.revision = 2;
      sim.positions = accepted; resolve(accepted); await pending;
      expect(Array.from(geometry.getAttribute('position').array)).toEqual(Array.from(clearPreview).filter((_, index) => index % 4 < 3));
      expect(controls.simFrameCount).toBe(0);
    }
  );

  it('leaves native publication on its existing runner callback', async () => {
    const { geometry, sim, controls, accepted, resolve } = publicationRig(false);
    const pending = controls.stepSimulation(sim as unknown as ClothSimulation);
    sim.positions = accepted; resolve(accepted); await pending;
    expect(controls.simFrameCount).toBe(0);
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(Array.from(clearPreview).filter((_, index) => index % 4 < 3));
    controls.publishRunnerFrame(sim as unknown as ClothSimulation, accepted);
    expect(controls.simFrameCount).toBe(1);
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(Array.from(accepted).filter((_, index) => index % 4 < 3));
  });

  it('retains the displayed frame when an actual pending step rejects', async () => {
    const { renderer, geometry, sim, controls, reject } = publicationRig();
    const pending = controls.stepSimulation(sim as unknown as ClothSimulation);
    renderer.pauseSimulation();
    const error = new Error('Candidate rejected by source proof');
    reject(error);
    await expect(pending).rejects.toBe(error);
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(Array.from(clearPreview).filter((_, index) => index % 4 < 3));
    expect(controls.simFrameCount).toBe(0);
    expect((renderer as unknown as { failSimulation: ReturnType<typeof vi.fn> }).failSimulation).toHaveBeenCalledWith(error);
  });
});

describe('source preview, playback and export use finite geometry safety', () => {
  it('discards a finite compatible free cache whose triangle interior crosses skin, retaining a safe arrangement', () => {
    const { internals } = previewRenderer();
    const prepared = sourcePreviewData();
    prepared.simData.positions = crossingPreview.slice();
    const checked = internals.checkSourcePreview(prepared);
    expect(checked.report?.safe).toBe(true);
    expect(checked.prepared.simData.positions).toEqual(clearPreview);
    expect(prepared.simData.positions).toEqual(crossingPreview);
    expect(checked.prepared.simData.anchors.every((value, index) => index % 4 !== 3 || value === 0)).toBe(true);
  });

  it('rejects an unsafe deliberate hold or unsafe fallback arrangement before cold publication', () => {
    const { internals, geometry } = previewRenderer();
    const before = Float32Array.from(geometry.getAttribute('position').array);
    const held = sourcePreviewData(); held.simData.positions = crossingPreview.slice(); held.simData.anchors[3] = 1;
    expect(() => internals.checkSourcePreview(held)).toThrow(CollisionSafetyError);
    const free = sourcePreviewData();
    free.simData.positions = crossingPreview.slice(); free.simData.arrangedPositions = crossingPreview.slice();
    expect(() => internals.checkSourcePreview(free)).toThrow(CollisionSafetyError);
    expect(() => internals.applyClothPositions(crossingPreview)).toThrow(CollisionSafetyError);
    expect(internals.sourcePreviewReport).toMatchObject({ insideParticleCount: 0, bodyCrossingTriangleCount: 1 });
    expect(geometry.getAttribute('position').array).toEqual(before);
  });

  it('rejects an unsafe explicitly frozen cache with zero inverse mass and released XYZ anchors', () => {
    const { internals, geometry } = previewRenderer();
    const before = Float32Array.from(geometry.getAttribute('position').array);
    const frozen = sourcePreviewData();
    frozen.simData.positions = crossingPreview.map((value, index) => index % 4 === 3 ? 0 : value);
    frozen.simData.arrangedPositions = clearPreview.map((value, index) => index % 4 === 3 ? 0 : value);
    expect(frozen.simData.anchors.every(value => value === 0)).toBe(true);
    let rejected: CollisionSafetyError | undefined;
    try { internals.checkSourcePreview(frozen); } catch (error) { rejected = error as CollisionSafetyError; }
    expect(rejected).toBeInstanceOf(CollisionSafetyError);
    expect(rejected?.report).toMatchObject({ insideParticleCount: 0, bodyCrossingTriangleCount: 1 });
    expect(rejected?.candidatePositions).toEqual(frozen.simData.positions);
    expect(rejected?.message).toContain('unfreeze');
    expect(frozen.simData.positions).toEqual(crossingPreview.map((value, index) => index % 4 === 3 ? 0 : value));
    expect(geometry.getAttribute('position').array).toEqual(before);
  });

  it('rejects a penetrating interpolated playback midpoint between independently clear endpoints', () => {
    const { renderer, internals, geometry, onStatus } = previewRenderer();
    const opposite = clearPreview.slice();
    for (let index = 0; index < opposite.length; index += 4) opposite[index] = -2;
    const xyz = (values: Float32Array) => Float32Array.from(values.filter((_, index) => index % 4 !== 3));
    const player = new AssemblyPlayback({ frames: [xyz(clearPreview), xyz(opposite)], stitches: [0, 1],
      particleCount: 3, stitchCount: 1, steps: [] });
    // Both endpoints pass the same finite body classifier used by rendering.
    expect(internals.checkSourcePreview({ ...sourcePreviewData(), simData: {
      ...sourcePreviewData().simData, positions: opposite
    } }).report?.safe).toBe(true);
    renderer.showAssemblyFrame(player.sample(0)!.positions);
    const before = Float32Array.from(geometry.getAttribute('position').array);
    renderer.showAssemblyFrame(player.sample(.5)!.positions);
    expect(geometry.getAttribute('position').array).toEqual(before);
    expect(internals.lastClothPositions).toEqual(clearPreview.map((value, index) => index % 4 === 3 ? 0 : value));
    expect(internals.sourcePreviewReport).toMatchObject({ safe: false, insideParticleCount: 3 });
    expect(onStatus).toHaveBeenLastCalledWith('invalid', expect.stringContaining('last safe frame'));
  });

  it('blocks an old recording after a body/topology generation change, even with clear geometry', () => {
    const { renderer, internals, geometry, onStatus } = previewRenderer();
    const before = Float32Array.from(geometry.getAttribute('position').array);
    internals.sourceSceneGeneration++;
    const oldFrame = clearPreview.slice(); oldFrame[0] = 3;
    renderer.showAssemblyFrame(oldFrame);
    expect(geometry.getAttribute('position').array).toEqual(before);
    expect(onStatus).toHaveBeenLastCalledWith('error', expect.stringContaining('different body or garment'));
  });

  it('rejects a wrong particle count and unsafe cold reset without replacing the accepted mesh', () => {
    const { renderer, internals, prepared, geometry } = previewRenderer();
    const before = Float32Array.from(geometry.getAttribute('position').array);
    renderer.showAssemblyFrame(clearPreview.slice(0, 8));
    expect(geometry.getAttribute('position').array).toEqual(before);
    prepared.simData.arrangedPositions = crossingPreview.slice();
    renderer.resetSimulation();
    expect(geometry.getAttribute('position').array).toEqual(before);
    expect(internals.lastClothPositions).toEqual(clearPreview);
    expect(internals.sourcePreviewReport.bodyCrossingTriangleCount).toBe(1);
  });

  it('validates the actual export mesh after direct geometry edits rather than trusting the saved solver buffer', () => {
    const { renderer, geometry } = previewRenderer();
    expect(renderer.exportScene().children).toHaveLength(1);
    const attribute = geometry.getAttribute('position');
    for (let index = 0; index < 3; index++) attribute.setXYZ(index,
      crossingPreview[index * 4], crossingPreview[index * 4 + 1], crossingPreview[index * 4 + 2]);
    expect(() => renderer.exportScene()).toThrow(CollisionSafetyError);
  });

  it('includes visible mesh transforms when checking exported source surfaces', () => {
    const { renderer, mesh } = previewRenderer();
    mesh.position.x = -2;
    expect(() => renderer.exportScene()).toThrow(CollisionSafetyError);
  });

  it('restores the actual source body and accepted cloth when a cold pose makes held triangles penetrate', async () => {
    const { renderer, internals, prepared, geometry } = previewRenderer();
    const bodyVertices = Float32Array.from(prepared.body.positions.filter((_, index) => index % 4 !== 3));
    const indices = Uint32Array.from(prepared.body.triangles.filter((_, index) => index % 4 !== 3));
    let currentPose = 'A';
    const avatar = { vertexPositions: bodyVertices.slice(), indices,
      poseName: () => currentPose,
      setPose: vi.fn((name: string) => {
        currentPose = name;
        avatar.vertexPositions = Float32Array.from(bodyVertices, (value, index) => index % 3 === 0 && name === 'T' ? value + 2 : value);
      }) };
    const held = sourcePreviewData(); held.simData.anchors[3] = 1;
    const rebuildCloth = vi.fn(() => internals.checkSourcePreview({ ...held,
      body: packBodyMesh(avatar.vertexPositions, avatar.indices) }));
    Object.assign(renderer, { avatar, rebuildCloth });
    const before = Float32Array.from(geometry.getAttribute('position').array);
    await renderer.setPose('T');
    expect(avatar.setPose.mock.calls).toEqual([['T'], ['A']]);
    expect(avatar.vertexPositions).toEqual(bodyVertices);
    expect(geometry.getAttribute('position').array).toEqual(before);
    expect(rebuildCloth).not.toHaveBeenCalled();
  });

  it('preserves native cache, interpolation, reset and export behavior', () => {
    const { renderer, internals, prepared, geometry } = previewRenderer(false);
    prepared.simData.positions = crossingPreview.slice();
    expect(internals.checkSourcePreview(prepared).prepared).toBe(prepared);
    internals.sourceSceneGeneration++;
    renderer.showAssemblyFrame(crossingPreview);
    expect(geometry.getAttribute('position').getX(0)).toBe(-4);
    prepared.simData.arrangedPositions = crossingPreview.slice();
    expect(() => renderer.resetSimulation()).not.toThrow();
    expect(renderer.exportScene().children).toHaveLength(1);
  });

  it('keeps the visible accepted body, material and pose through an awaited failed source rebuild', async () => {
    const { renderer, prepared, mesh, geometry } = previewRenderer();
    const pattern = convertGarmentCodePattern(JSON.parse(readFileSync(
      new URL('../../../static/examples/garmentcode/hoody_mean_specification.json', import.meta.url), 'utf8'
    )));
    const oldBody = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 'red' }));
    const newBody = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 'blue' }));
    const scene = new THREE.Scene(); scene.add(oldBody, mesh);
    const previousAvatar = { mesh: oldBody, poseName: () => 'T', setBody: vi.fn(), dispose: vi.fn() };
    const candidate = { mesh: newBody, copyPoseSelectionFrom: vi.fn(), dispose: vi.fn() };
    let finish!: (avatar: AvatarController) => void;
    vi.spyOn(AvatarController, 'create').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    Object.assign(renderer, { scene, avatar: previousAvatar, pattern, patternId: pattern.id,
      lastBodyKey: 'old-body', baseBodyKey: 'old-body', bodyDirty: false,
      stopSimulation: vi.fn(), clearBodyMeasurement: vi.fn(), setDebugFocusPoint: vi.fn(),
      setAvatarVisible: vi.fn(), applyCameraSettings: vi.fn(), setLightingMode: vi.fn(),
      rebuildCloth: vi.fn(() => { throw new Error('Invalid polygon constraints'); }) });
    const before = Float32Array.from(geometry.getAttribute('position').array);
    const rebuilding = (renderer as unknown as PreviewInternals).applyPattern(pattern);
    await Promise.resolve();
    expect(scene.children).toContain(oldBody);
    expect(scene.children).not.toContain(newBody);
    expect(previousAvatar.setBody).not.toHaveBeenCalled();
    finish(candidate as unknown as AvatarController);
    await expect(rebuilding).resolves.toBe(false);
    expect(renderer as unknown as { avatar: unknown; prepared: PreparedCloth }).toMatchObject({ avatar: previousAvatar, prepared });
    expect(scene.children).toContain(oldBody);
    expect(scene.children).not.toContain(newBody);
    expect(oldBody.material.color.getHexString()).toBe('ff0000');
    expect(previousAvatar.poseName()).toBe('T');
    expect(candidate.copyPoseSelectionFrom).toHaveBeenCalledWith(previousAvatar);
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(previousAvatar.dispose).not.toHaveBeenCalled();
    expect(geometry.getAttribute('position').array).toEqual(before);
  });
});

describe('renderer self-collision policy', () => {
  it('waits for the current frame before capturing positions and rebuilding', async () => {
    const { renderer, oldSim, newSim } = rendererRig();
    let finish!: (positions: Float32Array) => void;
    const activeSimulationStep = new Promise<Float32Array>(resolve => { finish = resolve; });
    Object.assign(renderer, { activeSimulationStep });
    const changed = renderer.setSimConfig({ subSteps: SIM_CONFIG.subSteps + 1 });
    expect(oldSim.dispose).not.toHaveBeenCalled();
    expect(oldSim.captureAssemblySupport).not.toHaveBeenCalled();
    expect(oldSim.captureSourceAssembly).not.toHaveBeenCalled();
    oldSim.positions = new Float32Array([.2, 1.3, .4, 1]);
    finish(oldSim.positions);
    await changed;
    expect(oldSim.captureAssemblySupport).toHaveBeenCalledOnce();
    expect(newSim.resetTo).toHaveBeenCalledWith(oldSim.positions);
    expect(oldSim.dispose).toHaveBeenCalledOnce();
  });
  const thinSourcePolicy = { policy: 'source-material-thickness-v1' as const,
    reason: 'material-aware' as const, materialIds: ['fabric'],
    maximumMaterialThicknessMm: .5, automaticPaddingMeters: .001,
    preservedExplicitPadding: [] };

  it('reports effective source settings before and after engine creation', () => {
    const { renderer, oldSim } = rendererRig();
    Object.assign(renderer, { sim: null, prepared: { contactPolicy: thinSourcePolicy } });
    expect(renderer.getSimConfig().simulationThickness).toBe(.001);
    expect(renderer.getSimConfig().finalContactIterations).toBe(4);
    expect(renderer.getSimConfig().substepContactIterations).toBe(4);
    Object.assign(renderer, { sim: Object.assign(oldSim, {
      simulationConfig: { ...SIM_CONFIG, simulationThickness: .002, edgeThickness: .003 }
    }) });
    expect(renderer.getSimConfig().simulationThickness).toBe(.002);
    expect(renderer.getSimConfig().edgeThickness).toBe(.003);
  });

  it('preserves an intentional global-default padding selected for a source garment', async () => {
    const { renderer, oldSim, newSim, state } = rendererRig();
    Object.assign(renderer, { prepared: { contactPolicy: thinSourcePolicy } });
    Object.assign(oldSim, { simulationConfig: { ...SIM_CONFIG, simulationThickness: .001 } });
    await renderer.setSimConfig({ simulationThickness: .005 });
    expect(oldSim.dispose).toHaveBeenCalledOnce();
    expect(state.ensureSim).toHaveBeenCalledOnce();
    expect(newSim.resetTo).toHaveBeenCalledWith(oldSim.positions);
    Object.assign(renderer, { sim: null });
    expect(renderer.getSimConfig().simulationThickness).toBe(.005);
    expect(renderer.getSimConfig().edgeThickness).toBe(.001);
  });

  it('keeps an unchanged source-padding selection explicit without rebuilding', async () => {
    const { renderer, oldSim, state } = rendererRig();
    Object.assign(renderer, { prepared: { contactPolicy: thinSourcePolicy } });
    Object.assign(oldSim, { simulationConfig: { ...SIM_CONFIG, simulationThickness: .001 } });
    await renderer.setSimConfig({ simulationThickness: .001 });
    expect(state.ensureSim).not.toHaveBeenCalled();
    Object.assign(renderer, { sim: null, prepared: {
      contactPolicy: { ...thinSourcePolicy, automaticPaddingMeters: .002 }
    } });
    expect(renderer.getSimConfig().simulationThickness).toBe(.001);
  });
  it('preserves released assembly supports when rebuilding for live solver changes', async () => {
    const { renderer, oldSim, newSim } = rendererRig();
    const assemblyState = { topology: 'unchanged-shoulder-mesh', elapsedSeconds: 1.5, targets: new Float32Array([0, 0, 0, 0]),
      states: [{ id: 'shoulder-right', kind: 'shoulder' as const, phase: 'released' as const,
        scale: 0, maxSeamGapM: .001, stableFrames: 4, releaseSeconds: .5 }] };
    oldSim.captureAssemblySupport.mockReturnValue(assemblyState);
    await renderer.setSimConfig({ subSteps: SIM_CONFIG.subSteps + 1 });
    expect(oldSim.captureAssemblySupport).toHaveBeenCalledOnce();
    expect(newSim.restoreAssemblySupport).toHaveBeenCalledWith(assemblyState);
    expect(newSim.resetTo.mock.invocationCallOrder[0]).toBeLessThan(
      newSim.restoreAssemblySupport.mock.invocationCallOrder[0]
    );
  });
  it.each(['structural', 'transition pending', 'manual paused'])(
    'keeps source gate and support state when changing shader settings during %s', async scenario => {
      const { renderer, oldSim, newSim, state } = rendererRig();
      const manual = scenario === 'manual paused';
      const acceptedMask = new Uint32Array(manual ? [1, 1] : [1, 0]);
      const requestedMask = new Uint32Array(scenario === 'structural' ? [1, 0] : [1, 1]);
      const stage: SourceAssemblySnapshot = { topology: 'unchanged-source-seams',
        requestedActivation: { revision: 3, activeSeams: requestedMask, sewnUpTo: manual ? 4 : 12 },
        lastAcceptedActivation: { revision: 2, activeSeams: acceptedMask, sewnUpTo: manual ? 4 : 12 },
        controller: { topology: 'same-semantic-source-plan', mode: manual ? 'manual' : 'automatic',
          phase: scenario === 'structural' ? 'structural' : 'all', stableAcceptedFrames: 1, maskRevision: 3,
          activeMask: requestedMask, lastAcceptedMask: acceptedMask, lastAcceptedMaskRevision: 2,
          lastAcceptedSewnUpTo: manual ? 4 : 12, hasAcceptedFrame: true },
        acceptedState: { revision: 2, phase: 'structural', stableAcceptedFrames: 1,
          allActive: false, enabledStitchCount: manual ? 4 : 7, totalStitchCount: 12, activeSeamMask: acceptedMask,
          activeStitchMask: new Uint32Array(12).map((_, index) => Number(index < (manual ? 4 : 7))) } };
      const support = { topology: 'unchanged-support', elapsedSeconds: .7, targets: new Float32Array([1.2, .5, 0, 0]), states: [] };
      let activeStage = structuredClone(stage), cacheEligible = true;
      oldSim.captureSourceAssembly.mockImplementation(() => structuredClone(activeStage));
      oldSim.captureAssemblySupport.mockReturnValue(support);
      Object.assign(renderer, { simulating: !manual, userSimulating: !manual });
      newSim.restoreSourceAssembly.mockImplementation(snapshot => { activeStage = structuredClone(snapshot); cacheEligible = false; });
      // Expose actual new live getter rather than the seed state's capture provenance.
      Object.defineProperty(newSim, 'sourceAssemblyComplete', { get: () => cacheEligible, configurable: true });
      await renderer.setSimConfig({ seamIterations: SIM_CONFIG.seamIterations + 1 });
      expect(activeStage.requestedActivation.sewnUpTo).toBe(manual ? 4 : 12);
      expect(Array.from(activeStage.controller!.activeMask)).toEqual(Array.from(requestedMask));
      expect(Array.from(activeStage.controller!.lastAcceptedMask)).toEqual(Array.from(acceptedMask));
      expect(activeStage.controller!.mode).toBe(manual ? 'manual' : 'automatic');
      expect(renderer.getSourceAssemblyComplete()).toBe(false);
      expect(newSim.resetTo).toHaveBeenCalledWith(oldSim.positions);
      expect(newSim.restoreAssemblySupport).toHaveBeenCalledWith(support);
      expect(newSim.restoreSourceAssembly.mock.invocationCallOrder[0]).toBeLessThan(newSim.restoreAssemblySupport.mock.invocationCallOrder[0]);
      expect(state.runSimLoop).toHaveBeenCalledTimes(manual ? 0 : 1);
    }
  );

  it('does not transplant an old staged garment into a concurrently rebuilt topology', async () => {
    const { renderer, oldSim, newSim, state } = rendererRig();
    const before = { simData: { particleCount: 1 } }, changed = { simData: { particleCount: 2 } };
    Object.assign(renderer, { prepared: before, simulating: true, userSimulating: true });
    oldSim.captureSourceAssembly.mockReturnValue({ topology: 'old-source-garment', controller: null, acceptedState: null,
      requestedActivation: { revision: 0, activeSeams: new Uint32Array([1]), sewnUpTo: 0 }, lastAcceptedActivation: null });
    oldSim.positions = new Float32Array([.8, 1.5, .7, 1]);
    state.ensureSim.mockImplementation(async () => {
      Object.assign(renderer, { prepared: changed, sim: newSim });
      return newSim;
    });
    await renderer.setSimConfig({ seamIterations: SIM_CONFIG.seamIterations + 1 });
    expect(newSim.resetTo).not.toHaveBeenCalled();
    expect(newSim.restoreSourceAssembly).not.toHaveBeenCalled();
    expect(newSim.positions).toEqual(new Float32Array([.1, 1.2, .3, 1]));
    expect(state.runSimLoop).not.toHaveBeenCalled();
  });

  it.each(['maxSurfaceCorrection', 'finalContactIterations', 'substepContactIterations'] as const)(
    'rebuilds the solver when %s changes without discarding live geometry', async (field) => {
      const { renderer, oldSim, newSim, state } = rendererRig();
      await renderer.setSimConfig({ [field]: field === 'maxSurfaceCorrection' ? .004 : 3 });
      expect(oldSim.dispose).toHaveBeenCalledOnce();
      expect(state.ensureSim).toHaveBeenCalledOnce();
      expect(newSim.resetTo).toHaveBeenCalledWith(oldSim.positions);
    }
  );
  it('preserves a deliberately selected single source contact pass when rebuilding', async () => {
    const { renderer, oldSim, newSim } = rendererRig();
    Object.assign(renderer, { prepared: { contactPolicy: thinSourcePolicy } });
    Object.assign(oldSim, { simulationConfig: { ...SIM_CONFIG, substepContactIterations: 2 } });
    await renderer.setSimConfig({ substepContactIterations: 1 });
    expect(oldSim.dispose).toHaveBeenCalledOnce();
    expect(newSim.resetTo).toHaveBeenCalledWith(oldSim.positions);
    Object.assign(renderer, { sim: null });
    expect(renderer.getSimConfig().substepContactIterations).toBe(1);
  });
  it('disables both body contact solvers without disabling source safety or coupling independent API flags', async () => {
    const { renderer, oldSim, newSim, state } = rendererRig();
    const prepared = { collisionSafety: true, contactPolicy: thinSourcePolicy };
    Object.assign(renderer, { prepared });
    await renderer.setSimConfig({ handleExternalCollisions: false, handleExternalSurfaceCollisions: false });
    expect(oldSim.dispose).toHaveBeenCalledOnce();
    expect(state.ensureSim).toHaveBeenCalledOnce();
    expect(newSim.resetTo).toHaveBeenCalledWith(oldSim.positions);
    expect(renderer.getSimConfig()).toMatchObject({ handleExternalCollisions: false, handleExternalSurfaceCollisions: false });
    expect(prepared.collisionSafety).toBe(true);
    // The aggregate UI switch expresses both flags; the advanced API can still select each independently.
    Object.assign(renderer, { sim: null });
    await renderer.setSimConfig({ handleExternalSurfaceCollisions: true });
    expect(renderer.getSimConfig()).toMatchObject({ handleExternalCollisions: false, handleExternalSurfaceCollisions: true });
    expect(prepared.collisionSafety).toBe(true);
  });
  it.each([true, false])('rebuilds the engine when self-collision becomes %s and transfers positions', async (enabled) => {
    SIM_CONFIG.handleSelfCollisions = !enabled;
    const { renderer, oldSim, newSim, runner, state } = rendererRig();
    Object.assign(renderer, { simulating: true, userSimulating: true });
    await renderer.setSimConfig({ handleSelfCollisions: enabled });
    expect(oldSim.dispose).toHaveBeenCalledOnce();
    expect(runner.stop).toHaveBeenCalledOnce();
    expect(runner.dispose).toHaveBeenCalledOnce();
    expect(state.ensureSim).toHaveBeenCalledOnce();
    expect(newSim.resetTo).toHaveBeenCalledWith(oldSim.positions);
    expect(newSim.setSelfCollision).toHaveBeenLastCalledWith(enabled);
    expect(state.runSimLoop).toHaveBeenCalledOnce();
    expect(state.onStatus).toHaveBeenCalledWith('simulating');
  });

  it('does not recreate an engine for an unchanged option', async () => {
    const { renderer, oldSim, state } = rendererRig();
    await renderer.setSimConfig({ handleSelfCollisions: SIM_CONFIG.handleSelfCollisions });
    expect(oldSim.dispose).not.toHaveBeenCalled();
    expect(state.ensureSim).not.toHaveBeenCalled();
  });

  it.each([true, false])('starting or resuming honors self-collision %s', async (enabled) => {
    SIM_CONFIG.handleSelfCollisions = enabled;
    const { renderer, newSim, state } = rendererRig();
    await renderer.simulate();
    expect(newSim.setSelfCollision).toHaveBeenLastCalledWith(enabled);
    expect(state.runSimLoop).toHaveBeenCalledOnce();
  });

  it('preserves deliberately disabled collision during body adaptation', async () => {
    SIM_CONFIG.handleSelfCollisions = true;
    const { renderer, newSim } = rendererRig();
    Object.assign(renderer, { bodyDirty: true });
    await renderer.simulate();
    expect(newSim.setSelfCollision).toHaveBeenLastCalledWith(false);
  });

  it.each([false, true])('adapts source checkpoints without adding hold weights (cylinders: %s)', async (withCylinders) => {
    const pattern = convertGarmentCodePattern(JSON.parse(readFileSync(
      new URL('../../../static/examples/garmentcode/hoody_mean_specification.json', import.meta.url), 'utf8'
    )));
    SIM_CONFIG.handleSelfCollisions = true;
    const { renderer, newSim, state } = rendererRig();
    Object.assign(renderer, {
      pattern, bodyDirty: true, anchorsEnabled: true,
      baseCylinders: withCylinders ? new Map() : null,
      cylinders: new Map(), lastBodyKey: 'updated-source-body'
    });
    await renderer.simulate();
    expect(newSim.seedAndHold).not.toHaveBeenCalled();
    expect(newSim.setSelfCollision).toHaveBeenLastCalledWith(true);
    expect(renderer as unknown as { bodyDirty: boolean; adaptFramesLeft: number }).toMatchObject({
      bodyDirty: false, adaptFramesLeft: 0
    });
    expect(state.runSimLoop).toHaveBeenCalledOnce();
  });

  it.each([true, false])('live grabbing honors self-collision %s', async (enabled) => {
    SIM_CONFIG.handleSelfCollisions = enabled;
    const { renderer, newSim } = rendererRig();
    Object.assign(renderer, { grabbing: true, userSimulating: true });
    const target = renderer as unknown as { beginGrab(point: { x: number; y: number; z: number }): Promise<void> };
    await target.beginGrab({ x: 0, y: 1, z: 0 });
    expect(newSim.setSelfCollision).toHaveBeenLastCalledWith(enabled);
  });

  it('keeps collision temporarily disabled for idle repositioning', async () => {
    SIM_CONFIG.handleSelfCollisions = true;
    const { renderer, newSim } = rendererRig();
    Object.assign(renderer, { grabbing: true, userSimulating: false });
    const target = renderer as unknown as { beginGrab(point: { x: number; y: number; z: number }): Promise<void> };
    await target.beginGrab({ x: 0, y: 1, z: 0 });
    expect(newSim.setSelfCollision).toHaveBeenLastCalledWith(false);
  });

  it('keeps source cloth collision enabled while repositioning an idle garment', async () => {
    SIM_CONFIG.handleSelfCollisions = true;
    const { renderer, newSim } = rendererRig();
    Object.assign(renderer, { grabbing: true, userSimulating: false, prepared: { collisionSafety: true } });
    const target = renderer as unknown as { beginGrab(point: { x: number; y: number; z: number }): Promise<void> };
    await target.beginGrab({ x: 0, y: 1, z: 0 });
    expect(newSim.setSelfCollision).toHaveBeenLastCalledWith(true);
  });

  it.each([true, false])('moving a saved drape honors self-collision %s', async (enabled) => {
    SIM_CONFIG.handleSelfCollisions = enabled;
    const { renderer, newSim, state } = rendererRig();
    Object.assign(renderer, {
      mode: 'arrange', prepared: {}, arrangeFromDrape: true,
      arrangedSeed: () => newSim.positions, exitArrangeMode: vi.fn()
    });
    await renderer.simulateFromArrangement();
    expect(newSim.setSelfCollision).toHaveBeenLastCalledWith(enabled);
    expect(state.runSimLoop).toHaveBeenCalledOnce();
  });

  it('retains deliberately disabled collision during flat arrangement repositioning', async () => {
    SIM_CONFIG.handleSelfCollisions = true;
    const { renderer, newSim } = rendererRig();
    Object.assign(renderer, {
      mode: 'arrange', prepared: {}, arrangeFromDrape: false,
      arrangedSeed: () => newSim.positions, exitArrangeMode: vi.fn()
    });
    await renderer.simulateFromArrangement();
    expect(newSim.setSelfCollision).toHaveBeenLastCalledWith(false);
  });

  it('keeps source arrangement collision enabled and runs assembly after repositioning', async () => {
    SIM_CONFIG.handleSelfCollisions = true;
    const { renderer, newSim, state } = rendererRig();
    Object.assign(renderer, {
      mode: 'arrange', prepared: { collisionSafety: true }, arrangeFromDrape: false,
      arrangedSeed: () => newSim.positions, exitArrangeMode: vi.fn()
    });
    await renderer.simulateFromArrangement();
    expect(newSim.setSelfCollision).toHaveBeenLastCalledWith(true);
    expect(renderer as unknown as { userSimulating: boolean }).toMatchObject({ userSimulating: true });
    expect(state.runSimLoop).toHaveBeenCalledOnce();
  });

});
