import { copySourceGatherCollisionGeometry } from './collisionGuard';
import type { CollisionGuardInput, CollisionGuardOptions, CollisionGuardReport, CollisionSeamActivation } from './collisionGuard';
import { collisionGuardActivationBinding, collisionGuardWorkerBinding, type CollisionGuardWorkerRequest, type CollisionGuardWorkerResponse } from './collisionGuardWorkerProtocol';

export type CollisionGuardWorkerTransport = Pick<Worker, 'postMessage' | 'addEventListener' | 'removeEventListener' | 'terminate'>;
let sequence = 0;
interface Pending { resolve(report: CollisionGuardReport): void; reject(error: Error): void; expected: number;
  activation?: CollisionSeamActivation; activationBinding?: string; timer: ReturnType<typeof setTimeout> }

/** Source-only asynchronous proof execution. Transport failure never falls back to the UI thread. */
export class CollisionGuardWorker {
  readonly ready: Promise<void>;
  readonly #worker: CollisionGuardWorkerTransport;
  readonly #token = `source-guard-${++sequence}`;
  readonly #particleCount: number;
  readonly #faceCount: number;
  #binding = '';
  #initialized = false;
  #failure: Error | null = null;
  #disposed = false;
  #requestId = 0;
  #pending = new Map<number, Pending>();
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #startupTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #proofDeadline: number;

  constructor(input: CollisionGuardInput, options: CollisionGuardOptions = {}, factory?: () => CollisionGuardWorkerTransport,
    testDeadlines?: { startupMs?: number; proofMs?: number }) {
    if (testDeadlines && !factory) throw new Error('Test verification deadlines require an injected worker transport.');
    const startupDeadline = testDeadlines?.startupMs ?? 60_000;
    this.#proofDeadline = testDeadlines?.proofMs ?? 60_000;
    if (![startupDeadline, this.#proofDeadline].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error('Invalid collision verification worker deadline.');
    }
    this.#particleCount = input.particleCount;
    this.#faceCount = input.clothTriangles.length / (input.clothTriangleStride ?? 4);
    // Snapshot before any asynchronous work; later body edits cannot change the worker's binding.
    const snapshot: CollisionGuardInput = { ...input, ...(input.sourceGatherCollisionGeometry ? { sourceGatherCollisionGeometry: copySourceGatherCollisionGeometry(input.sourceGatherCollisionGeometry) } : {}), bodyPositions: Array.from(input.bodyPositions),
      bodyIndices: Array.from(input.bodyIndices), clothTriangles: Array.from(input.clothTriangles),
      seams: input.seams && Array.from(input.seams),
      seamPairsBySeam: input.seamPairsBySeam?.map(group => ({ ...group, pairs: Array.from(group.pairs),
        ...(group.stitchIndices ? { stitchIndices: Array.from(group.stitchIndices) } : {}),
        ...(group.stitchIndexKinds ? { stitchIndexKinds: group.stitchIndexKinds.slice() } : {}) })) };
    const settings = { ...options };
    if (!factory && typeof Worker === 'undefined') throw new Error('Source garment verification requires Web Workers.');
    this.#worker = factory ? factory() : new Worker(new URL('./collisionGuard.worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    // A passive renderer can dispose before its first step; retain the rejection for callers,
    // while preventing an unhandled startup/disposal rejection in the meantime.
    void this.ready.catch(() => undefined);
    this.#worker.addEventListener('message', this.#onMessage);
    this.#worker.addEventListener('error', this.#onError);
    this.#worker.addEventListener('messageerror', this.#onError);
    this.#startupTimer = this.#deadline(startupDeadline, 'Collision verification worker startup timed out. Reset and try again.');
    void collisionGuardWorkerBinding(snapshot, settings).then(binding => {
      if (this.#disposed || this.#failure) return;
      this.#binding = binding;
      this.#worker.postMessage({ kind: 'init', token: this.#token, binding, requestId: 0,
        input: snapshot, options: settings } satisfies CollisionGuardWorkerRequest);
    }).catch(error => this.#fail(error instanceof Error ? error : new Error('Collision verification worker initialization failed.')));
  }

  async inspectTrajectory(final: Float32Array, previous: Float32Array,
    trajectory: readonly Float32Array[] | null | undefined, expectedSubSteps: number,
    activation?: CollisionSeamActivation): Promise<CollisionGuardReport> {
    // Snapshot immediately, including during worker startup or the asynchronous digest.
    const active = activation && { ...activation, activeSeams: activation.activeSeams.slice() };
    const finalCopy = final.slice(), previousCopy = previous.slice(), path = trajectory?.map(sample => sample.slice()) ?? trajectory;
    await this.ready;
    if (this.#disposed || this.#failure) throw this.#failure ?? new Error('Collision verification worker was disposed.');
    // Transfer copies only. Published positions, GPU trace views and diagnostic buffers stay owned.
    const transfer: Transferable[] = [finalCopy.buffer, previousCopy.buffer, ...(path ?? []).map(sample => sample.buffer),
      ...(active ? [active.activeSeams.buffer] : [])];
    const activationBinding = active ? await collisionGuardActivationBinding(active) : undefined;
    if (this.#disposed || this.#failure) throw this.#failure ?? new Error('Collision verification worker was disposed.');
    const requestId = ++this.#requestId;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, expected: expectedSubSteps,
        activation: active && { ...active, activeSeams: active.activeSeams.slice() }, activationBinding,
        timer: this.#deadline(this.#proofDeadline, 'Collision verification worker proof timed out. Reset and try again.') });
      try {
        this.#worker.postMessage({ kind: 'trajectory', token: this.#token, binding: this.#binding, requestId,
          final: finalCopy, previous: previousCopy, trajectory: path, expectedSubSteps, activation: active,
          activationBinding, activationRevision: active?.revision } satisfies CollisionGuardWorkerRequest, transfer);
      } catch (error) { this.#fail(error instanceof Error ? error : new Error('Collision verification worker transport failed.')); }
    });
  }

  #onMessage = (event: Event): void => {
    if (this.#disposed || this.#failure) return;
    const response = (event as MessageEvent<CollisionGuardWorkerResponse>).data;
    if (!response || response.token !== this.#token || response.binding !== this.#binding
      || !Number.isInteger(response.requestId)) { this.#fail(new Error('Collision verification worker returned a stale or mismatched body/topology response.')); return; }
    if (response.kind === 'error') { this.#fail(new Error(response.message || 'Collision verification worker failed.')); return; }
    if (response.kind === 'ready' && response.requestId === 0 && !this.#initialized) {
      this.#initialized = true;
      if (this.#startupTimer !== null) clearTimeout(this.#startupTimer);
      this.#startupTimer = null; this.#resolveReady(); return;
    }
    const pending = this.#pending.get(response.requestId);
    if (!this.#initialized || response.kind !== 'report' || !pending
      || response.activationBinding !== pending.activationBinding || response.activationRevision !== pending.activation?.revision
      || !this.#validReport(response.report, pending.expected, pending.activation)) {
      this.#fail(new Error('Collision verification worker returned an invalid proof response.')); return;
    }
    clearTimeout(pending.timer); this.#pending.delete(response.requestId); pending.resolve(response.report);
  };

  #validReport(report: CollisionGuardReport, expected: number, activation?: CollisionSeamActivation): boolean {
    if (!report || typeof report.safe !== 'boolean' || typeof report.finite !== 'boolean'
      || typeof report.bodyClosed !== 'boolean') return false;
    const counts = [report.insideParticleCount, report.bodyCrossingTriangleCount, report.selfCrossingPairCount,
      report.sweptBodyCrossingParticleCount, report.rayDisagreementCount];
    if (!counts.every(count => Number.isInteger(count) && count >= 0)
      || !Array.isArray(report.limitations) || !report.limitations.every(value => typeof value === 'string')) return false;
    const ids = (values: number[], limit: number) => Array.isArray(values) && values.every(id => Number.isInteger(id) && id >= 0 && id < limit);
    if (!ids(report.insideParticles, this.#particleCount) || !ids(report.sweptBodyCrossingParticles, this.#particleCount)
      || !ids(report.bodyCrossingTriangles, this.#faceCount) || !Array.isArray(report.selfCrossingPairs)
      || !report.selfCrossingPairs.every(pair => Array.isArray(pair) && pair.length === 2 && ids(pair, this.#faceCount))) return false;
    if (report.insideParticles.length > report.insideParticleCount
      || report.bodyCrossingTriangles.length > report.bodyCrossingTriangleCount
      || report.selfCrossingPairs.length > report.selfCrossingPairCount
      || report.sweptBodyCrossingParticles.length > report.sweptBodyCrossingParticleCount) return false;
    const path = report.trajectory;
    if (!path || typeof path.valid !== 'boolean' || path.expectedSubSteps !== expected
      || !Number.isInteger(path.inspectedSubsteps) || path.inspectedSubsteps < 0 || path.inspectedSubsteps > expected
      || path.counts !== 'feature-occurrences-across-substeps') return false;
    if (path.valid && (path.inspectedSubsteps !== expected || !report.finite || path.invalidReason !== undefined)) return false;
    if (!path.valid && (report.finite || path.inspectedSubsteps !== 0 || !path.invalidReason)) return false;
    const shouldBeSafe = report.finite && report.bodyClosed && path.valid && counts.every(count => count === 0);
    if (report.safe !== shouldBeSafe) return false;
    const active = report.seamActivation;
    if (active) {
      if (!activation || active.revision !== activation.revision || active.sewnUpTo !== activation.sewnUpTo
        || !Array.isArray(active.activeSeams) || active.activeSeams.length !== activation.activeSeams.length
        || active.activeSeams.some((value, index) => value !== activation.activeSeams[index])) return false;
    } else if (activation && path.valid) return false;
    if (report.safe && (path.firstUnsafeSubstep !== undefined || path.invalidReason !== undefined)) return false;
    if (!report.safe && path.valid && (!Number.isInteger(path.firstUnsafeSubstep)
      || path.firstUnsafeSubstep! < 0 || path.firstUnsafeSubstep! > expected)) return false;
    return true;
  }

  #deadline(milliseconds: number, message: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.#fail(new Error(message)), milliseconds);
    // Browsers return a number; Node tests return a timer object. Do not retain test processes.
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  }

  #onError = (event: Event): void => {
    this.#fail(new Error((event as ErrorEvent).message || 'Collision verification worker could not execute its proof.'));
  };

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error; this.#rejectReady(error);
    if (this.#startupTimer !== null) clearTimeout(this.#startupTimer);
    this.#startupTimer = null;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.#worker.removeEventListener('message', this.#onMessage);
    this.#worker.removeEventListener('error', this.#onError);
    this.#worker.removeEventListener('messageerror', this.#onError);
    this.#worker.terminate();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#fail(new Error('Collision verification worker was disposed.'));
  }
}
