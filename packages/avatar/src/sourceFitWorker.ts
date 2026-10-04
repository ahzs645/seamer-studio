import { snapshotAvatarBody } from './bodySnapshot';
import { computeSourceFit, type SourceFitInput } from './sourceFitWorkerRuntime';
let sourceFitRequest = 0;
export type SourceFitMode = 'worker' | 'synchronous';
export interface SourceFitWorkerLike {
  postMessage(value: unknown, transfers?: Transferable[]): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}
export type SourceFitWorkerFactory = () => SourceFitWorkerLike;
export const sourceFitWorkerFactory: SourceFitWorkerFactory = () => new Worker(new URL('./sourceFit.worker.ts', import.meta.url), { type: 'module' });
/** Snapshot before any asynchronous work; transfer copies never detach caller geometry. */
export function fitSourceInWorker(input: SourceFitInput, options: {
  mode?: SourceFitMode; signal?: AbortSignal; factory?: SourceFitWorkerFactory;
} = {}): Promise<Float32Array> {
  const snapshot = structuredClone({ ...input, body: snapshotAvatarBody(input.body) });
  const requestId = ++sourceFitRequest;
  const expectedLength = snapshot.vertices.length;
  if (options.signal?.aborted) return Promise.reject(new Error('Source body fitting was cancelled.'));
  if (options.mode === 'synchronous') return Promise.resolve(computeSourceFit(snapshot));
  return new Promise((resolve, reject) => {
    let worker: SourceFitWorkerLike;
    try { worker = (options.factory ?? sourceFitWorkerFactory)(); }
    catch (error) { reject(new Error(`Source body worker could not start: ${String(error)}`)); return; }
    let done = false;
    const close = (error?: Error, vertices?: Float32Array) => {
      if (done) return; done = true; clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      worker.onmessage = null; worker.onerror = null; worker.terminate();
      if (error) reject(error); else resolve(vertices!);
    };
    const abort = () => close(new Error('Source body fitting was cancelled.'));
    const timeout = setTimeout(() => close(new Error('Source body fitting exceeded its deadline.')), 60000);
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => close(new Error(`Source body worker failed: ${event.message}`));
    worker.onmessage = event => {
      const data = event.data as { id?: number; vertices?: unknown; error?: unknown } | null;
      if (!data || data.id !== requestId) { close(new Error('Source body worker returned an invalid request binding.')); return; }
      if (typeof data.error === 'string') { close(new Error(data.error)); return; }
      if (!(data.vertices instanceof Float32Array) || data.vertices.length !== expectedLength
        || !data.vertices.every(Number.isFinite)) { close(new Error('Source body worker returned invalid geometry.')); return; }
      close(undefined, data.vertices.slice());
    };
    if (options.signal?.aborted) { abort(); return; }
    try { worker.postMessage({ id: requestId, input: snapshot }, [snapshot.vertices.buffer, snapshot.indices.buffer, snapshot.skinIndices.buffer, snapshot.skinWeights.buffer]); }
    catch (error) { close(new Error(`Source body worker request failed: ${String(error)}`)); }
  });
}
