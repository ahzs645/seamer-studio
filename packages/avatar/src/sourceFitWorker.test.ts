import { describe, it, expect } from 'vitest';
import { fitSourceInWorker, type SourceFitWorkerLike } from './sourceFitWorker';
import type { SourceFitInput } from './sourceFitWorkerRuntime';
function input(): SourceFitInput { return { vertices: new Float32Array([1, 2, 3]), indices: new Uint32Array([0, 0, 0]),
  skinIndices: new Uint16Array([0, 0, 0, 0]), skinWeights: new Float32Array([1, 0, 0, 0]),
  model: { nested: { value: 1 } }, body: { nested: { value: 1 } } } as unknown as SourceFitInput; }
function fake() {
  let request: { id: number; input: SourceFitInput } | null = null, terminated = 0;
  const worker: SourceFitWorkerLike = { onmessage: null, onerror: null,
    postMessage(value, transfers) { request = structuredClone(value, { transfer: transfers }) as { id: number; input: SourceFitInput }; },
    terminate() { terminated++; } };
  return { worker, get request() { return request!; }, get terminated() { return terminated; }, factory: () => worker };
}
describe('source fitting isolate boundary', () => {
  it('snapshots transferred values and preserves caller buffers', async () => {
    const source = input(), f = fake(), promise = fitSourceInWorker(source, { factory: f.factory });
    source.vertices[0] = 99;
    expect(f.request.input.vertices[0]).toBe(1); expect(source.vertices.byteLength).toBe(12);
    f.worker.onmessage!({ data: { id: f.request.id, vertices: new Float32Array([4, 5, 6]) } } as MessageEvent);
    expect(await promise).toEqual(new Float32Array([4, 5, 6])); expect(f.terminated).toBe(1);
  });
  for (const [name, data] of [
    ['binding', { id: 2, vertices: new Float32Array(3) }], ['type', { id: 1, vertices: [1, 2, 3] }],
    ['length', { id: 1, vertices: new Float32Array(2) }], ['finite', { id: 1, vertices: new Float32Array([0, Infinity, 0]) }]
  ] as const) it(`rejects malformed ${name} results`, async () => {
    const f = fake(), promise = fitSourceInWorker(input(), { factory: f.factory });
    f.worker.onmessage!({ data: { ...data, id: name === 'binding' ? f.request.id + 1 : f.request.id } } as MessageEvent); await expect(promise).rejects.toThrow('invalid'); expect(f.terminated).toBe(1);
  });
  it('cancellation terminates without detaching geometry', async () => {
    const source = input(), f = fake(), controller = new AbortController();
    const promise = fitSourceInWorker(source, { factory: f.factory, signal: controller.signal }); controller.abort();
    await expect(promise).rejects.toThrow('cancelled'); expect(source.vertices[0]).toBe(1); expect(f.terminated).toBe(1);
  });
  it('transport failure rejects rather than using synchronous fallback', async () => {
    const f = fake(), promise = fitSourceInWorker(input(), { factory: f.factory });
    f.worker.onerror!({ message: 'transport failed' } as ErrorEvent);
    await expect(promise).rejects.toThrow('transport failed'); expect(f.terminated).toBe(1);
  });
});
