import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollisionGuardWorker, type CollisionGuardWorkerTransport } from './collisionGuardWorker';
import { ClothCollisionGuard, failedCollisionTrajectoryReport, type CollisionGuardInput, type CollisionSeamActivation } from './collisionGuard';
import { createCollisionGuardWorkerHandler } from './collisionGuardWorkerRuntime';
import { collisionGuardActivationBinding, collisionGuardWorkerBinding, type CollisionGuardWorkerRequest, type CollisionGuardWorkerResponse } from './collisionGuardWorkerProtocol';

const bodyPositions = new Float32Array([
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
  -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1
]);
const bodyIndices = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7
]);
const input = (): CollisionGuardInput => ({ bodyPositions: bodyPositions.slice(), bodyIndices: bodyIndices.slice(),
  clothTriangles: new Uint32Array([0, 1, 2, 0]), particleCount: 3 });
const positions = (x: number, z = 0) => new Float32Array([x, -.3, z - .3, 1, x, .3, z - .3, 1, x, 0, z + .3, 1]);
const curved = () => [positions(-2), positions(-2, 2.5), positions(2, 2.5), positions(2)];

/** Executes the real isolate handler, including SHA binding and finite geometry proof. */
class LocalWorker extends EventTarget implements CollisionGuardWorkerTransport {
  requests: CollisionGuardWorkerRequest[] = [];
  responses: CollisionGuardWorkerResponse[] = [];
  hold = false;
  terminated = false;
  private resolveFirstRequest!: () => void;
  readonly firstRequest = new Promise<void>(resolve => { this.resolveFirstRequest = resolve; });
  transform: ((response: CollisionGuardWorkerResponse) => CollisionGuardWorkerResponse) | null = null;
  readonly handler = createCollisionGuardWorkerHandler(response => {
    this.responses.push(response);
    this.emit(this.transform ? this.transform(response) : response);
  });
  postMessage(message: CollisionGuardWorkerRequest, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
    const transfer = Array.isArray(transferOrOptions) ? transferOrOptions : transferOrOptions?.transfer;
    const copy = structuredClone(message, { transfer });
    this.requests.push(copy);
    this.resolveFirstRequest();
    if (!this.hold) queueMicrotask(() => { void this.handler(copy); });
  }
  emit(response: CollisionGuardWorkerResponse): void {
    this.dispatchEvent(new MessageEvent('message', { data: structuredClone(response) }));
  }
  terminate(): void { this.terminated = true; }
}
const clients: CollisionGuardWorker[] = [];
function client(worker = new LocalWorker(), settings?: { startupMs?: number; proofMs?: number }) {
  const instance = new CollisionGuardWorker(input(), {}, () => worker, settings);
  clients.push(instance);
  return { instance, worker };
}
afterEach(() => { for (const instance of clients.splice(0)) instance.dispose(); vi.useRealTimers(); });

describe('source collision verification worker', () => {
  it('proves every real curved boundary without detaching published or diagnostic arrays', async () => {
    const { instance, worker } = client(), path = curved(), copies = path.map(p => p.slice());
    expect(new ClothCollisionGuard(input()).inspect(path[3], path[0]).safe).toBe(false);
    const report = await instance.inspectTrajectory(path[3], path[0], path, 3);
    expect(report).toMatchObject({ safe: true, trajectory: { valid: true, inspectedSubsteps: 3 } });
    path.forEach((p, i) => { expect(p.byteLength).toBe(48); expect(p).toEqual(copies[i]); });
    const request = worker.requests[1];
    expect(request.kind).toBe('trajectory');
    if (request.kind === 'trajectory') {
      expect(request.final).not.toBe(path[3]);
      expect(request.previous).not.toBe(path[0]);
      expect(request.trajectory).toEqual(path);
    }
  });

  it('retains actual intermediate penetration and successive tunnel findings', async () => {
    const { instance } = client(), path = [positions(-2), positions(0), positions(2)];
    const report = await instance.inspectTrajectory(path[2], path[0], path, 2);
    expect(report.safe).toBe(false);
    expect(report.insideParticleCount).toBe(3);
    expect(report.trajectory).toMatchObject({ valid: true, firstUnsafeSubstep: 1, inspectedSubsteps: 2 });
    expect(report.sweptBodyCrossingParticleCount).toBeGreaterThan(0);
  });

  it('rejects an intermediate finite face crossing while all cloth vertices stay outside', async () => {
    const { instance } = client();
    const clear = new Float32Array([-4, -3, 2, 1, 4, -3, 2, 1, 0, 5, 2, 1]);
    const crossing = new Float32Array([-4, -3, 0, 1, 4, -3, 0, 1, 0, 5, 0, 1]);
    const report = await instance.inspectTrajectory(clear, clear, [clear, crossing, clear], 2);
    expect(report).toMatchObject({ safe: false, insideParticleCount: 0, bodyCrossingTriangleCount: 1,
      trajectory: { valid: true, firstUnsafeSubstep: 1 } });
  });

  it.each(['missing', 'short', 'nan', 'start', 'end', 'mass'] as const)('returns a fail-closed %s trace proof', async kind => {
    const { instance } = client(), path = curved(), final = path[3].slice(), previous = path[0].slice();
    let trace: Float32Array[] | undefined = path;
    if (kind === 'missing') trace = undefined;
    if (kind === 'short') trace = path.slice(0, 3);
    if (kind === 'nan') path[1][0] = NaN;
    if (kind === 'start') previous[0] -= .1;
    if (kind === 'end') final[0] += .1;
    if (kind === 'mass') path[1][3] = 0;
    const report = await instance.inspectTrajectory(final, previous, trace, 3);
    expect(report).toMatchObject({ safe: false, finite: false, trajectory: { valid: false, inspectedSubsteps: 0 } });
    expect(report.trajectory?.invalidReason).toBeTruthy();
  });

  it('snapshots source body topology before asynchronous initialization', async () => {
    const worker = new LocalWorker(), data = input();
    const instance = new CollisionGuardWorker(data, {}, () => worker); clients.push(instance);
    (data.bodyPositions as Float32Array)[0] = 50; (data.clothTriangles as Uint32Array)[0] = 900;
    await instance.ready;
    const request = worker.requests[0];
    expect(request.kind).toBe('init');
    if (request.kind === 'init') {
      expect(request.input.bodyPositions[0]).toBe(-1);
      expect(request.input.clothTriangles[0]).toBe(0);
    }
    const path = curved(); expect((await instance.inspectTrajectory(path[3], path[0], path, 3)).safe).toBe(true);
  });

  it('independently rejects a mutated worker body whose digest no longer matches', async () => {
    const worker = new LocalWorker(); worker.hold = true;
    const { instance } = client(worker);
    const rejected = expect(instance.ready).rejects.toThrow('body/topology binding mismatch');
    await vi.waitFor(() => expect(worker.requests.length).toBe(1));
    const request = worker.requests[0];
    if (request.kind !== 'init') throw new Error('Expected worker initialization');
    (request.input.bodyPositions as number[])[0] = -3;
    await worker.handler(request); await rejected;
    expect(worker.terminated).toBe(true);
  });

  it.each(['token', 'binding', 'request'] as const)('rejects a mismatched %s response permanently', async field => {
    const { instance, worker } = client(); await instance.ready;
    worker.transform = response => ({ ...response,
      ...(field === 'token' ? { token: 'other-source' } : field === 'binding' ? { binding: 'other-body' } : { requestId: 999 }) });
    const path = curved();
    await expect(instance.inspectTrajectory(path[3], path[0], path, 3)).rejects.toThrow(/mismatched|invalid proof/);
    expect(worker.terminated).toBe(true);
    await expect(instance.inspectTrajectory(path[3], path[0], path, 3)).rejects.toThrow();
  });

  it.each(['issues', 'firstUnsafe', 'invalidReason'] as const)('rejects inconsistent safe proof with %s', async field => {
    const { instance, worker } = client(); await instance.ready;
    worker.transform = response => {
      if (response.kind !== 'report') return response;
      const report = structuredClone(response.report);
      if (field === 'issues') report.bodyCrossingTriangles.push(0);
      if (field === 'firstUnsafe') report.trajectory!.firstUnsafeSubstep = 1;
      if (field === 'invalidReason') report.trajectory!.invalidReason = 'mass-mismatch';
      return { ...response, report };
    };
    const path = curved();
    await expect(instance.inspectTrajectory(path[3], path[0], path, 3)).rejects.toThrow('invalid proof');
    expect(worker.terminated).toBe(true);
  });

  it('disposes all pending proofs and ignores late valid reports', async () => {
    const { instance, worker } = client(); await instance.ready; worker.hold = true;
    const path = curved(), proof = instance.inspectTrajectory(path[3], path[0], path, 3);
    const rejection = expect(proof).rejects.toThrow('disposed'); await Promise.resolve();
    instance.dispose(); await rejection;
    await worker.handler(worker.requests[1]);
    expect(worker.terminated).toBe(true);
    await expect(instance.inspectTrajectory(path[3], path[0], path, 3)).rejects.toThrow('disposed');
  });

  it('fails closed on a worker transport error without running proof on the caller thread', async () => {
    const { instance, worker } = client(); await instance.ready; worker.hold = true;
    const path = curved(), proof = instance.inspectTrajectory(path[3], path[0], path, 3);
    const rejected = expect(proof).rejects.toThrow('could not execute'); await Promise.resolve();
    worker.dispatchEvent(new Event('messageerror')); await rejected;
    expect(worker.responses.filter(response => response.kind === 'report')).toHaveLength(0);
    expect(worker.terminated).toBe(true);
  });

  it('requires an actual browser worker unless a test transport is explicitly injected', () => {
    vi.stubGlobal('Worker', undefined);
    try { expect(() => new CollisionGuardWorker(input())).toThrow('requires Web Workers'); }
    finally { vi.unstubAllGlobals(); }
  });

  it('bounds silent startup, terminates the isolate and ignores late readiness', async () => {
    vi.useFakeTimers(); const worker = new LocalWorker(); worker.hold = true;
    const { instance } = client(worker, { startupMs: 10, proofMs: 10 });
    const rejection = expect(instance.ready).rejects.toThrow('startup timed out');
    // Let native SHA finish while the fake clock stays at zero: the silent worker really
    // received init, and its eventual authentic ready message is exercised after timeout.
    await worker.firstRequest;
    expect(worker.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10); await rejection;
    expect(worker.terminated).toBe(true); expect(vi.getTimerCount()).toBe(0);
    await worker.handler(worker.requests[0]);
    await expect(instance.ready).rejects.toThrow('startup timed out');
  });

  it('bounds silent proof, rejects concurrent requests and ignores late successful proof', async () => {
    const { instance, worker } = client(new LocalWorker(), { proofMs: 10 }); await instance.ready;
    vi.useFakeTimers(); worker.hold = true;
    const path = curved();
    const first = instance.inspectTrajectory(path[3], path[0], path, 3);
    const second = instance.inspectTrajectory(path[3], path[0], path, 3);
    const rejection1 = expect(first).rejects.toThrow('proof timed out');
    const rejection2 = expect(second).rejects.toThrow('proof timed out');
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(10); await Promise.all([rejection1, rejection2]);
    expect(worker.terminated).toBe(true); expect(vi.getTimerCount()).toBe(0);
    await worker.handler(worker.requests[1]);
    await expect(instance.inspectTrajectory(path[3], path[0], path, 3)).rejects.toThrow('proof timed out');
  });

  it('clears successful proof deadlines instead of failing a healthy idle renderer', async () => {
    const { instance } = client(new LocalWorker(), { proofMs: 10 }); await instance.ready;
    vi.useFakeTimers(); const path = curved();
    expect((await instance.inspectTrajectory(path[3], path[0], path, 3)).safe).toBe(true);
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(100);
    expect((await instance.inspectTrajectory(path[3], path[0], path, 3)).safe).toBe(true);
  });

  it('builds an explicit failed transport report for wrapper rollback', () => {
    expect(failedCollisionTrajectoryReport(40, true)).toMatchObject({ safe: false, finite: false, bodyClosed: true,
      trajectory: { valid: false, expectedSubSteps: 40, inspectedSubsteps: 0, invalidReason: 'worker-failure' } });
  });
});

const joined = () => new Float32Array([2, 0, 0, 1, 2, .1, 0, 1, 2.1, 0, 0, 1,
  2, 0, .001, 1, 2, .1, -.001, 1, 2.1, .05, .02, 1]);
function stagedInput(): CollisionGuardInput {
  return { bodyPositions, bodyIndices, particleCount: 6, clothTriangles: new Uint32Array([0, 1, 2, 0, 3, 4, 5, 0]),
    stitchCount: 4, seamPairsBySeam: [{ seamId: 'source-joining-seam', index: 0, pairs: [0, 3, 1, 4], stitchIndices: [3, 1] }] };
}
function stagedClient(worker = new LocalWorker(), data = stagedInput()) {
  const instance = new CollisionGuardWorker(data, {}, () => worker); clients.push(instance); return { instance, worker };
}
const activation = (mask = 1, revision = 7, prefix = 4): CollisionSeamActivation => ({
  revision, activeSeams: new Uint32Array([mask]), sewnUpTo: prefix
});

describe('worker request-specific source sewing activation', () => {
  it('checks all41 real locally closed contacts under the exact active semantic mask', async () => {
    const { instance } = stagedClient(), point = joined(), path = Array.from({ length: 41 }, () => point.slice());
    const rejected = await instance.inspectTrajectory(point, point, path, 40, activation(0));
    expect(rejected).toMatchObject({ safe: false, finite: true, selfCrossingPairCount: 41,
      seamActivation: { revision: 7, activeSeams: [0], sewnUpTo: 4 },
      trajectory: { valid: true, firstUnsafeSubstep: 0, inspectedSubsteps: 40 } });
    const active = await instance.inspectTrajectory(point, point, path, 40, activation());
    expect(active).toMatchObject({ safe: true, seamActivation: { revision: 7, activeSeams: [1], sewnUpTo: 4 } });
  });
  it('keeps manual prefix gating tied to actual first-stamp link indices rather than pair ordinals', async () => {
    const { instance } = stagedClient(), point = joined();
    const report = await instance.inspectTrajectory(point, point, [point, point], 1, activation(1, 7, 2));
    expect(report).toMatchObject({ safe: false, finite: true, selfCrossingPairCount: 2 });
  });
  it('snapshots mask, revision, prefix and exact geometry BEFORE delayed startup', async () => {
    const worker = new LocalWorker(); worker.hold = true;
    const { instance } = stagedClient(worker), point = joined(), original = point.slice(), context = activation(0);
    const proof = instance.inspectTrajectory(point, point, [point, point], 1, context);
    context.activeSeams.fill(1); context.revision = 8; context.sewnUpTo = 0; point[0] = 900;
    await worker.firstRequest;
    await worker.handler(worker.requests[0]);
    await vi.waitFor(() => expect(worker.requests.length).toBe(2));
    const request = worker.requests[1];
    if (request.kind !== 'trajectory') throw Error('Expected trajectory proof');
    expect(request.activation).toEqual(activation(0)); expect(request.final).toEqual(original);
    expect(context.activeSeams.byteLength).toBe(4);
    await worker.handler(request);
    expect(await proof).toMatchObject({ safe: false, selfCrossingPairCount: 2,
      seamActivation: { revision: 7, activeSeams: [0], sewnUpTo: 4 } });
  });
  it.each(['activationBinding', 'activationRevision', 'mask', 'prefix', 'omitted-metadata'] as const)('rejects a forged %s reply rather than publishing a proof for another stage', async field => {
    const { instance, worker } = stagedClient(); await instance.ready;
    worker.transform = response => {
      if (response.kind !== 'report') return response;
      const value = structuredClone(response);
      if (field === 'activationBinding') value.activationBinding = 'other-mask';
      else if (field === 'activationRevision') value.activationRevision = 8;
      else if (field === 'omitted-metadata') delete value.report.seamActivation;
      else if (field === 'mask') value.report.seamActivation!.activeSeams[0] = 0;
      else value.report.seamActivation!.sewnUpTo = 0;
      return value;
    };
    const point = joined();
    await expect(instance.inspectTrajectory(point, point, [point, point], 1, activation())).rejects.toThrow('invalid proof');
    expect(worker.terminated).toBe(true);
  });
  it('independently rejects an activation changed in transit after the caller computed its SHA', async () => {
    const { instance, worker } = stagedClient(); await instance.ready; worker.hold = true;
    const point = joined(), proof = instance.inspectTrajectory(point, point, [point, point], 1, activation());
    const rejected = expect(proof).rejects.toThrow('activation binding mismatch');
    await vi.waitFor(() => expect(worker.requests.length).toBe(2));
    const request = worker.requests[1];
    if (request.kind !== 'trajectory') throw Error('Expected trajectory proof');
    request.activation!.activeSeams[0] = 0;
    await worker.handler(request); await rejected; expect(worker.terminated).toBe(true);
  });
  it('binds reordered concurrent replies to their own immutable mask instead of the current planned stage', async () => {
    const { instance, worker } = stagedClient(); await instance.ready; worker.hold = true;
    const point = joined(), inactive = instance.inspectTrajectory(point, point, [point, point], 1, activation(0, 7));
    const next = instance.inspectTrajectory(point, point, [point, point], 1, activation(1, 8));
    await vi.waitFor(() => expect(worker.requests.length).toBe(3));
    await worker.handler(worker.requests[2]); await worker.handler(worker.requests[1]);
    expect(await inactive).toMatchObject({ safe: false, seamActivation: { revision: 7, activeSeams: [0] } });
    expect(await next).toMatchObject({ safe: true, seamActivation: { revision: 8, activeSeams: [1] } });
  });
  it('fails closed for a missing or malformed mask without weakening source geometry classification', async () => {
    const { instance } = stagedClient(), point = joined();
    expect(await instance.inspectTrajectory(point, point, [point, point], 1)).toMatchObject({ safe: false, finite: false,
      trajectory: { valid: false, invalidReason: 'activation-missing' } });
    expect(await instance.inspectTrajectory(point, point, [point, point], 1, activation(2))).toMatchObject({ safe: false, finite: false,
      trajectory: { valid: false, invalidReason: 'invalid-seam-activation' } });
  });
  it('hashes immutable source IDs, pair-stitch indices and stitch count, not only pair coordinates', async () => {
    const original = stagedInput(), base = await collisionGuardWorkerBinding(original, {});
    for (const change of ['id', 'index', 'indices', 'count']) {
      const changed = structuredClone(original);
      if (change === 'id') changed.seamPairsBySeam![0].seamId = 'different-source-join';
      if (change === 'index') changed.seamPairsBySeam![0].index = 1;
      if (change === 'indices') changed.seamPairsBySeam![0].stitchIndices = [0, 1];
      if (change === 'count') changed.stitchCount = 5;
      expect(await collisionGuardWorkerBinding(changed, {})).not.toBe(base);
    }
    const mask = activation(), binding = await collisionGuardActivationBinding(mask);
    expect(await collisionGuardActivationBinding(activation(0))).not.toBe(binding);
    expect(await collisionGuardActivationBinding(activation(1, 8))).not.toBe(binding);
    expect(await collisionGuardActivationBinding(activation(1, 7, 2))).not.toBe(binding);
  });
  it('binds identity/reciprocal provenance labels in immutable topology SHA', async () => {
    const input = stagedInput(), withoutLabels = await collisionGuardWorkerBinding(input, {});
    input.seamPairsBySeam![0].stitchIndexKinds = ['reciprocal-first-stamp', 'reciprocal-first-stamp'];
    const honest = await collisionGuardWorkerBinding(input, {});
    expect(honest).not.toBe(withoutLabels);
    input.seamPairsBySeam![0].stitchIndexKinds = ['identity-logical', 'reciprocal-first-stamp'];
    expect(await collisionGuardWorkerBinding(input, {})).not.toBe(honest);
  });
  it('snapshots provenance before asynchronous initialization instead of relabeling the bound dictionary', async () => {
    const input = stagedInput(), kinds: ('identity-logical' | 'reciprocal-first-stamp')[] = ['reciprocal-first-stamp', 'reciprocal-first-stamp'];
    input.seamPairsBySeam![0].stitchIndexKinds = kinds;
    const worker = new LocalWorker(); worker.hold = true;
    const { instance } = stagedClient(worker, input);
    kinds[0] = 'identity-logical';
    await worker.firstRequest;
    const init = worker.requests[0];
    if (init.kind !== 'init') throw new Error('Expected guard initialization');
    expect(init.input.seamPairsBySeam![0].stitchIndexKinds).toEqual(['reciprocal-first-stamp', 'reciprocal-first-stamp']);
    await worker.handler(init); await instance.ready;
    worker.hold = false;
    const point = joined();
    expect((await instance.inspectTrajectory(point, point, [point, point], 1, activation())).safe).toBe(true);
  });
});
