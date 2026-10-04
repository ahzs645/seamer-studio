import { describe, expect, it, vi } from 'vitest';
import { AssemblySupportController, type AssemblySupportData } from '../assembly';
import { ClothEngine } from './engine';

interface EngineHarnessFields {
  stateGeneration: number;
  inFlight: boolean;
  disposalRequested: boolean;
  resourcesDisposed: boolean;
  assemblyController: AssemblySupportController;
  stepInner: (generation: number) => Promise<Float32Array>;
  finishReadback: (generation: number) => Float32Array;
  finishTrajectoryReadback: (generation: number) => Promise<void>;
  finishPhaseReadback: (generation: number) => Promise<void>;
  collisionPhaseSubstep: number;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** Exercise the real lifecycle/readback methods without compiling or running GPU kernels. */
function harness() {
  const data: AssemblySupportData = { revision: 3, activeOnStart: true,
    targets: new Float32Array([1.5, 1, 0, 0, 1.5, 1, 0, 0]),
    groups: [{ id: 'shoulder', kind: 'shoulder', particles: [0, 1], seamPairs: [0, 1], releaseGapM: .006 }] };
  const out = new Float32Array([0, 1.5, 0, 1, 0, 1.5, .002, 1]);
  const events: string[] = [], writeBuffer = vi.fn();
  const buffer = (name: string) => ({ destroy: vi.fn(() => events.push('destroy:' + name)) });
  const readback = { ...buffer('readback'), getMappedRange: () => out.buffer,
    unmap: vi.fn(() => events.push('unmap')) };
  const engine = Object.create(ClothEngine.prototype) as ClothEngine;
  const fields = engine as unknown as EngineHarnessFields;
  Object.assign(fields, { stateGeneration: 0, inFlight: false, disposalRequested: false, resourcesDisposed: false,
    config: { timeStep: .1 }, assemblySupportData: data, assemblyController: new AssemblySupportController(data, .1),
    supportTargets: buffer('supports'), readback, positions: buffer('positions'), velocities: buffer('velocities'),
    lastPositions: buffer('lastPositions'), device: { queue: { writeBuffer } }, stretchGroups: [], bendGroups: [] });
  const pending = deferred();
  fields.stepInner = generation => pending.promise.then(() => fields.finishReadback(generation));
  return { engine, fields, pending, readback, writeBuffer, events, out };
}

describe('engine reset and disposal during pending readback', () => {
  it('does not advance or overwrite freshly reset supports from an obsolete readback', async () => {
    const h = harness();
    const step = h.engine.step();
    h.engine.resetPositions(new Float32Array([0, 1.5, -.3, 1, 0, 1.5, .3, 1]));
    h.engine.resetAssemblySupport(true);
    const reset = h.fields.assemblyController.captureState();
    const uploadsAfterReset = h.writeBuffer.mock.calls.length;
    h.pending.resolve();
    await expect(step).resolves.toEqual(h.out);
    expect(h.fields.assemblyController.captureState()).toEqual(reset);
    expect(h.writeBuffer).toHaveBeenCalledTimes(uploadsAfterReset);
    expect(h.readback.unmap).toHaveBeenCalledOnce();
  });
  it('unmaps the pending readback before destroying buffers, and disposal is idempotent', async () => {
    const h = harness(), before = h.fields.assemblyController.captureState();
    const step = h.engine.step();
    h.engine.dispose(); h.engine.dispose();
    expect(h.events).toEqual([]);
    h.pending.resolve();
    await expect(step).resolves.toEqual(h.out);
    expect(h.events[0]).toBe('unmap');
    expect(h.readback.destroy).toHaveBeenCalledOnce();
    expect(h.fields.assemblyController.captureState()).toEqual(before);
    expect(h.writeBuffer).not.toHaveBeenCalled();
    expect(h.fields.resourcesDisposed).toBe(true);
    const eventCount = h.events.length;
    await expect(h.engine.step()).resolves.toHaveLength(0);
    h.engine.dispose();
    expect(h.events).toHaveLength(eventCount);
  });
  it('still destroys deferred buffers when a pending readback rejects', async () => {
    const h = harness();
    const step = h.engine.step(); h.engine.dispose();
    expect(h.events).toEqual([]);
    h.pending.reject(new Error('readback failed'));
    await expect(step).rejects.toThrow('readback failed');
    expect(h.readback.destroy).toHaveBeenCalledOnce();
    expect(h.fields.inFlight).toBe(false);
  });
});

describe('source stretch and sewing dispatch balance', () => {
  it.each([true, false])('interleaves authored stretch only for source mode=%s without extra integration or support time', async source => {
    const h = harness(), dispatches: string[] = [];
    let pipeline = '', group = '';
    const pass = { setPipeline: (value: string) => { pipeline = value; },
      setBindGroup: (_index: number, value: string) => { group = value; },
      dispatchWorkgroups: () => dispatches.push(pipeline === 'stretch' ? pipeline + ':' + group : pipeline), end: vi.fn() };
    const encoder = { beginComputePass: () => pass, copyBufferToBuffer: vi.fn(), finish: vi.fn() };
    Object.assign(h.fields, { config: { timeStep: .1, subSteps: 2, seamIterations: 8,
      useBending: false, localDamping: 0, nearDamping: 0, substepContactIterations: 4, finalContactIterations: 4 },
      particleCount: 2, triangleCount: 0, interleaveSourceStretch: source,
      selfCollision: false, externalCollision: false, collisionPhaseSubstep: -1,
      stretchGroups: [{ count: 1, bindGroup: 'first' }, { count: 0, bindGroup: 'empty' }, { count: 1, bindGroup: 'second' }],
      integratePipe: 'prediction', distancePipe: 'stretch', seamPipe: 'sewing',
      applyPipe: 'apply', resetPipe: 'reset-correction', velocityPipe: 'velocity',
      device: { createCommandEncoder: () => encoder, queue: { submit: vi.fn(), writeBuffer: h.writeBuffer } } });
    Object.assign(h.readback, { mapAsync: vi.fn().mockResolvedValue(undefined) });
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    try {
      await (ClothEngine.prototype as unknown as EngineHarnessFields).stepInner.call(h.engine, 0);
      const expectedSubstep = ['prediction', 'stretch:first', 'stretch:second'];
      for (let iteration = 0; iteration < 8; iteration++) {
        if (source && iteration > 0) expectedSubstep.push('stretch:first', 'stretch:second');
        expectedSubstep.push('sewing', 'apply', 'reset-correction');
      }
      expectedSubstep.push('velocity');
      expect(dispatches).toEqual([...expectedSubstep, ...expectedSubstep]);
      expect(dispatches.filter(stage => stage === 'prediction')).toHaveLength(2);
      expect(dispatches.filter(stage => stage === 'sewing')).toHaveLength(16);
      expect(h.fields.assemblyController.captureState().elapsedSeconds).toBe(.1);
      expect(h.readback.unmap).toHaveBeenCalledOnce();
      expect(encoder.copyBufferToBuffer).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});


describe('optional collision trajectory readback', () => {
  it('publishes exact copied substeps and suppresses obsolete generation traces', async () => {
    const h = harness();
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    const source = new Float32Array([0,1,0,1,0,1,0,1,0,1,0,1,0,1,.1,1,0,1,0,1,0,1,.2,1]);
    const trace = { mapAsync: vi.fn().mockResolvedValue(undefined), getMappedRange: () => source.buffer, unmap: vi.fn() };
    Object.assign(h.fields, { collisionTrajectoryReadback: trace, config: { timeStep: .1, subSteps: 2 }, particleCount: 2, latestCollisionSubsteps: [] });
    await h.fields.finishTrajectoryReadback(0);
    expect(h.engine.collisionSubstepPositions).toHaveLength(2);
    expect(Array.from(h.engine.collisionSubstepPositions[1])).toEqual(Array.from(source.slice(16)));
    expect(h.engine.collisionTrajectoryPositions).toHaveLength(3);
    source[23] = 99;
    expect(h.engine.collisionSubstepPositions[1][7]).toBe(1);
    h.engine.resetPositions(new Float32Array(8));
    expect(h.engine.collisionSubstepPositions).toEqual([]);
    await h.fields.finishTrajectoryReadback(0);
    expect(h.engine.collisionSubstepPositions).toEqual([]);
    expect(trace.unmap).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('unmaps the primary buffer when the second map fails, without publishing a partial trace', async () => {
    const h = harness();
    const original = new Float32Array([0, 1.5, 0, 1]);
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    const trace = { mapAsync: vi.fn().mockRejectedValue(new Error('trajectory device loss')), unmap: vi.fn() };
    Object.assign(h.fields, { collisionTrajectoryReadback: trace, latestCollisionSubsteps: [original] });
    await expect(h.fields.finishTrajectoryReadback(0)).rejects.toThrow('trajectory device loss');
    expect(h.readback.unmap).toHaveBeenCalledOnce();
    expect(trace.unmap).not.toHaveBeenCalled();
    expect(h.engine.collisionSubstepPositions).toEqual([]);
    expect(h.fields.assemblyController.states[0].stableFrames).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe('diagnostic collision phase observations', () => {
  it('copies exact stage positions once and rejects stale generation publication', async () => {
    const h = harness();
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    const source = new Float32Array([0, 1, 0, 1, 0, 1, .01, 1]);
    const phases = { mapAsync: vi.fn().mockResolvedValue(undefined), getMappedRange: () => source.buffer, unmap: vi.fn() };
    Object.assign(h.fields, { collisionPhaseReadback: phases, collisionPhaseSubstep: 22,
      collisionPhaseStages: ['start', 'final'], collisionPhaseRecords: [{ zeroBasedSubstep: 22, stage: 'start' }, { zeroBasedSubstep: 22, stage: 'final' }], particleCount: 1, latestCollisionPhases: [] });
    await h.fields.finishPhaseReadback(0);
    expect(h.engine.collisionPhaseObservations.map(observation => [observation.substep, observation.zeroBasedSubstep, observation.stage]))
      .toEqual([[23, 22, 'start'], [23, 22, 'final']]);
    source[6] = 99;
    expect(h.engine.collisionPhaseObservations[1].positions[2]).toBeCloseTo(.01);
    expect(h.fields.collisionPhaseSubstep).toBe(-1);
    await h.fields.finishPhaseReadback(0);
    expect(phases.mapAsync).toHaveBeenCalledOnce();
    h.engine.resetPositions(new Float32Array(4));
    h.fields.collisionPhaseSubstep = 22;
    await h.fields.finishPhaseReadback(0);
    expect(h.engine.collisionPhaseObservations).toEqual([]);
    expect(phases.unmap).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('keeps each inclusive range record bound to its actual corrected step', async () => {
    const h = harness();
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    const source = new Float32Array([0, 1, 0, 1, 0, 1, .01, 1, 0, 1, .02, 1, 0, 1, .03, 1]);
    const phases = { mapAsync: vi.fn().mockResolvedValue(undefined), getMappedRange: () => source.buffer, unmap: vi.fn() };
    Object.assign(h.fields, { collisionPhaseReadback: phases, collisionPhaseSubstep: 11, particleCount: 1,
      collisionPhaseRecords: [{ zeroBasedSubstep: 11, stage: 'start' }, { zeroBasedSubstep: 11, stage: 'final' },
        { zeroBasedSubstep: 12, stage: 'start' }, { zeroBasedSubstep: 12, stage: 'final' }] });
    await h.fields.finishPhaseReadback(0);
    expect(h.engine.collisionPhaseObservations.map(record => [record.substep, record.zeroBasedSubstep, record.stage]))
      .toEqual([[12, 11, 'start'], [12, 11, 'final'], [13, 12, 'start'], [13, 12, 'final']]);
    expect(h.engine.collisionPhaseObservations[2].positions[2]).toBeCloseTo(.02);
    expect(h.engine.collisionPhaseObservations[3].positions[2]).toBeCloseTo(.03);
    expect(phases.unmap).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('unmaps the primary buffer after a failed third diagnostic map', async () => {
    const h = harness();
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    const phases = { mapAsync: vi.fn().mockRejectedValue(new Error('phase device loss')) };
    Object.assign(h.fields, { collisionPhaseReadback: phases, collisionPhaseSubstep: 0, latestCollisionPhases: [] });
    await expect(h.fields.finishPhaseReadback(0)).rejects.toThrow('phase device loss');
    expect(h.readback.unmap).toHaveBeenCalledOnce();
    expect(h.engine.collisionPhaseObservations).toEqual([]);
    vi.unstubAllGlobals();
  });
  function auxiliaryHarness() {
    const h = harness();
    const source = new Float32Array([0, 1, 0, 1, 0, 1, .01, 1]);
    const words = new Uint32Array([0x90000003, 0xffffffff, 0x30000002, 0x7fc00001]);
    const floatBits = new Uint32Array(24);
    floatBits[0] = 0x80000000; floatBits[12] = 0x7fc00001; floatBits[15] = 0x3f800000;
    const mapped = (data: Float32Array | Uint32Array) => ({ mapAsync: vi.fn().mockResolvedValue(undefined),
      getMappedRange: () => data.buffer, unmap: vi.fn() });
    const phases = mapped(source), candidates = mapped(words), corrections = mapped(floatBits);
    Object.assign(h.fields, { collisionPhaseReadback: phases, collisionPhaseSubstep: 23, particleCount: 1,
      collisionPhaseRecords: [{ zeroBasedSubstep: 23, stage: 'contact-1-self-gather' },
        { zeroBasedSubstep: 23, stage: 'contact-1-self-surface' }], triangleCount: 1,
      config: { timeStep: .1, numInternalSurfaceCollisionConstraints: 2 }, collisionPhaseSelfDiagnostics: true,
      collisionPhaseCandidatesReadback: candidates, collisionPhaseCorrectionsReadback: corrections });
    return { ...h, source, words, floatBits, phases, candidates, corrections };
  }

  it('copies per-stage candidate and correction bits before releasing every mapped buffer', async () => {
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    try {
      const h = auxiliaryHarness(); await h.fields.finishPhaseReadback(0);
      const observations = h.engine.collisionPhaseObservations;
      expect(observations.map(o => [o.selfSurfaceTriangleCount, o.selfSurfaceCandidateBudget])).toEqual([[1, 2], [1, 2]]);
      expect(Array.from(observations[0].selfSurfaceCandidates!)).toEqual([0x90000003, 0xffffffff]);
      expect(Array.from(observations[1].selfSurfaceCandidates!)).toEqual([0x30000002, 0x7fc00001]);
      const first = observations[0].selfSurfaceCorrections!, second = observations[1].selfSurfaceCorrections!;
      expect(new Uint32Array(first.buffer, first.byteOffset, first.length)[0]).toBe(0x80000000);
      expect(new Uint32Array(second.buffer, second.byteOffset, second.length)[0]).toBe(0x7fc00001);
      h.words.fill(0); h.floatBits.fill(0);
      expect(observations[0].selfSurfaceCandidates![0]).toBe(0x90000003);
      expect(new Uint32Array(second.buffer, second.byteOffset, second.length)[0]).toBe(0x7fc00001);
      for (const buffer of [h.phases, h.candidates, h.corrections]) expect(buffer.unmap).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not publish partial diagnostics after a correction-buffer map failure', async () => {
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    try {
      const h = auxiliaryHarness(); h.corrections.mapAsync.mockRejectedValueOnce(new Error('correction map failed'));
      await expect(h.fields.finishPhaseReadback(0)).rejects.toThrow('correction map failed');
      expect(h.phases.unmap).toHaveBeenCalledOnce(); expect(h.candidates.unmap).toHaveBeenCalledOnce();
      expect(h.corrections.unmap).not.toHaveBeenCalled(); expect(h.readback.unmap).toHaveBeenCalledOnce();
      expect(h.engine.collisionPhaseObservations).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('unmaps delayed auxiliary diagnostics and suppresses publication after reset or disposal', async () => {
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    try {
      for (const action of ['reset', 'dispose']) {
        const h = auxiliaryHarness(), pending = deferred();
        h.corrections.mapAsync.mockImplementationOnce(() => pending.promise);
        const read = h.fields.finishPhaseReadback(0);
        await vi.waitFor(() => expect(h.corrections.mapAsync).toHaveBeenCalledOnce());
        if (action === 'reset') h.engine.resetPositions(new Float32Array(4));
        else { h.fields.inFlight = true; h.engine.dispose(); }
        pending.resolve(); await read;
        expect(h.engine.collisionPhaseObservations).toEqual([]);
        for (const buffer of [h.phases, h.candidates, h.corrections]) expect(buffer.unmap).toHaveBeenCalledOnce();
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it('publishes chunked body evidence only at its actual selected stages and drops stale generations', async () => {
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    try {
      for (const stale of [false, true]) {
        const h = harness(), pending = deferred();
        const positions = new Float32Array(12);
        const words = new Uint32Array([0xffffffff, 4]);
        const bits = new Uint32Array(12); bits[0] = 0x80000000; bits[1] = 0x7fc00001;
        const readback = vi.fn(async () => { await pending.promise; return new Map([[1, { candidates: words,
          corrections: new Float32Array(bits.buffer) }]]); });
        Object.assign(h.fields, { collisionPhaseReadback: { mapAsync: vi.fn().mockResolvedValue(undefined),
          getMappedRange: () => positions.buffer, unmap: vi.fn() }, collisionPhaseSubstep: 13, particleCount: 1,
          triangleCount: 1, config: { numExternalSurfaceCollisionConstraints: 2 }, collisionPhaseBodyChunks: { readback },
          collisionPhaseRecords: [{ zeroBasedSubstep: 13, stage: 'contact-1-body-input' },
            { zeroBasedSubstep: 13, stage: 'contact-1-body-gather' }, { zeroBasedSubstep: 13, stage: 'final' }] });
        const read = h.fields.finishPhaseReadback(0);
        await vi.waitFor(() => expect(readback).toHaveBeenCalledOnce());
        if (stale) h.engine.resetPositions(new Float32Array(4));
        pending.resolve(); await read;
        if (stale) expect(h.engine.collisionPhaseObservations).toEqual([]);
        else {
          const observations = h.engine.collisionPhaseObservations;
          expect(observations[0]).not.toHaveProperty('externalSurfaceCandidates');
          expect(observations[2]).not.toHaveProperty('externalSurfaceCandidates');
          expect(observations[1].externalSurfaceCandidates).toBe(words);
          expect(observations[1].externalSurfaceCandidateBudget).toBe(2);
          expect(observations[1].externalSurfaceTriangleCount).toBe(1);
          expect([...new Uint32Array(observations[1].externalSurfaceCorrections!.buffer).slice(0, 2)])
            .toEqual([0x80000000, 0x7fc00001]);
        }
      }
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects oversized optional ranges before allocating buffers and permits a smaller retry', () => {
    vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_SRC: 2, MAP_READ: 4, COPY_DST: 8 });
    const h = harness(), createBuffer = vi.fn();
    Object.assign(h.fields, { particleCount: 256, triangleCount: 2, selfSurfaceCandidates: {}, selfSurfaceCorrections: {},
      config: { subSteps: 40, substepContactIterations: 4, numInternalSurfaceCollisionConstraints: 32 },
      device: { limits: { maxStorageBufferBindingSize: 100000, maxBufferSize: 100000 }, createBuffer } });
    // Position snapshots remain bounded too: two selected steps need 48 * 256 * 16 bytes.
    expect(() => h.engine.enableCollisionPhaseReadback(23, 24, true)).toThrow('actual device buffer limit');
    expect(createBuffer).not.toHaveBeenCalled();
    // The one-step request gets past range validation to the deliberately incomplete fake device.
    expect(() => h.engine.enableCollisionPhaseReadback(23, 23, true)).not.toThrow('actual device buffer limit');
    expect(createBuffer).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

});

// These tests exercise real uniform packing and rollback methods, rather than a mirror
// of the source stage controller. GPU queue writes are observed without dispatching physics.
describe('source gate uploads and particle snapshot rollback', () => {
  it('keeps the attempted packed activation and support mode intact across rejected particle history', async () => {
    const h = harness();
    const { buildSeamGateLayout } = await import('./seamGate');
    const fields = h.fields as unknown as Record<string, unknown>;
    const createCommandEncoder = () => ({ copyBufferToBuffer: vi.fn(), finish: vi.fn() });
    Object.assign(fields, { particleCount: 2, stitchCount: 8, seamGateLayout: buildSeamGateLayout(8, 2),
      seamStitchIndices: [[7], [2]], gateSnapshots: new WeakMap(), supportSnapshots: new WeakMap(),
      currentSeamActivation: null, seamGate: {}, sewnUpToValue: 0, sourceStructuralStaging: false,
      device: { createBuffer: (descriptor: { size: number }) => ({ size: descriptor.size, destroy: vi.fn() }),
        createCommandEncoder, queue: { writeBuffer: h.writeBuffer, submit: vi.fn() } } });
    vi.stubGlobal('GPUBufferUsage', { COPY_SRC: 1, COPY_DST: 2 });
    try {
      const used = { revision: 2, activeSeams: new Uint32Array([1, 0]), sewnUpTo: 8 };
      h.engine.setSeamActivation(used);
      used.activeSeams[0] = 0;
      expect(h.engine.seamActivation!.activeSeams).toEqual(new Uint32Array([1, 0]));
      const snapshot = h.engine.captureState();
      h.engine.setSeamActivation({ revision: 3, activeSeams: new Uint32Array([1, 1]), sewnUpTo: 3 });
      h.engine.setSourceStructuralStagingEnabled(true);
      h.engine.restoreState(snapshot);
      expect(h.engine.seamActivation).toEqual({ revision: 2, activeSeams: new Uint32Array([1, 0]), sewnUpTo: 8 });
      expect(fields.sourceStructuralStaging).toBe(false);
      expect(h.engine.requestedSewnUpTo).toBe(8);
      const upload = h.writeBuffer.mock.calls.at(-1)!;
      const words = new Uint32Array(upload[2], upload[3], upload[4] / 4);
      expect(words[0]).toBe(8);
      expect(words[4]).toBe(1 << 7);
      expect(words[8]).toBe(1);
      h.fields.inFlight = true;
      expect(() => h.engine.setSewnUpTo(0)).toThrow('during a GPU frame');
      expect(() => h.engine.setSourceStructuralStagingEnabled(false)).toThrow('during a GPU frame');
    } finally { vi.unstubAllGlobals(); }
  });
});
