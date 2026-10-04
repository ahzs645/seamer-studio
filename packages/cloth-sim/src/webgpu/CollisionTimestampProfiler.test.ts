import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollisionTimestampProfiler } from './CollisionTimestampProfiler';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
interface FakeResource { destroys: number; destroy(): void }
interface FakeBuffer extends FakeResource {
  descriptor: GPUBufferDescriptor;
  unmaps: number;
  values: BigUint64Array<ArrayBuffer>;
  mapAsync(): Promise<void>;
  getMappedRange(offset: number, size: number): ArrayBuffer;
  unmap(): void;
}
/** Exercise actual query allocation, command encoding and asynchronous readback ownership.
 * Numerical timestamps are supplied independently; no solver or browser is instantiated.
 */
function harness() {
  const buffers: FakeBuffer[] = [], resources: FakeResource[] = [];
  let map: () => Promise<void> = () => Promise.resolve();
  let queued: () => Promise<void> = () => Promise.resolve();
  const device = {
    features: new Set(['timestamp-query']),
    queue: { onSubmittedWorkDone: () => queued() },
    createQuerySet: (descriptor: GPUQuerySetDescriptor) => {
      const object = { descriptor, destroys: 0, destroy() { this.destroys++; } };
      resources.push(object); return object;
    },
    createBuffer: (descriptor: GPUBufferDescriptor) => {
      const object: FakeBuffer = {
        descriptor, destroys: 0, unmaps: 0, values: new BigUint64Array(1024),
        mapAsync: () => map(),
        getMappedRange(offset, size) { return this.values.buffer.slice(offset, offset + size); },
        unmap() { this.unmaps++; }, destroy() { this.destroys++; }
      };
      buffers.push(object); resources.push(object); return object;
    }
  };
  const encoder = {
    resolveQuerySet: vi.fn<GPUCommandEncoder['resolveQuerySet']>(),
    copyBufferToBuffer: vi.fn<GPUCommandEncoder['copyBufferToBuffer']>()
  };
  return {
    device, encoder, buffers, resources,
    setMap(callback: () => Promise<void>) { map = callback; },
    setQueue(callback: () => Promise<void>) { queued = callback; }
  };
}
function begin(h: ReturnType<typeof harness>, options?: ConstructorParameters<typeof CollisionTimestampProfiler>[1]) {
  const profiler = new CollisionTimestampProfiler(h.device as unknown as GPUDevice, options);
  profiler.beginFrame(7, 12); return profiler;
}

beforeEach(() => {
  vi.stubGlobal('GPUBufferUsage', { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 });
  vi.stubGlobal('GPUMapMode', { READ: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe('diagnostic collision timestamp lifecycle', () => {
  it('requires the requested feature and validates selected substeps and query capacity', () => {
    const h = harness(); h.device.features.clear();
    expect(() => new CollisionTimestampProfiler(h.device as unknown as GPUDevice)).toThrow('timestamp-query');
    h.device.features.add('timestamp-query');
    expect(() => new CollisionTimestampProfiler(h.device as unknown as GPUDevice, { selectedZeroBasedSubsteps: [40] })).toThrow('substeps');
    expect(() => new CollisionTimestampProfiler(h.device as unknown as GPUDevice, { capacity: 2049 })).toThrow('capacity');
    expect(h.resources).toHaveLength(0);
  });

  it('reserves selected spans sequentially for all four contacts and converts actual nanoseconds', async () => {
    const h = harness(), profiler = begin(h, { selectedZeroBasedSubsteps: [15] });
    expect(profiler.timestampWrites({ stage: 'body-nearest', zeroBasedSubstep: 14 })).toBeUndefined();
    for (let contactIteration = 0; contactIteration < 4; contactIteration++) {
      const descriptor = profiler.timestampWrites({ stage: 'body-nearest', zeroBasedSubstep: 15, contactIteration });
      expect(descriptor?.beginningOfPassWriteIndex).toBe(contactIteration * 2);
      expect(descriptor?.endOfPassWriteIndex).toBe(contactIteration * 2 + 1);
      h.buffers[1].values[contactIteration * 2] = BigInt(contactIteration * 10_000_000);
      h.buffers[1].values[contactIteration * 2 + 1] = BigInt(contactIteration * 10_000_000 + 3_000_000);
    }
    profiler.encodeResolve(h.encoder as unknown as GPUCommandEncoder);
    expect(h.encoder.resolveQuerySet).toHaveBeenCalledExactlyOnceWith(profiler.timestampQuerySet, 0, 8, h.buffers[0], 0);
    expect(h.encoder.copyBufferToBuffer).toHaveBeenCalledExactlyOnceWith(h.buffers[0], 0, h.buffers[1], 0, 64);
    const report = await profiler.readFrame(7);
    expect(report?.valid).toBe(true);
    expect(report?.measuredStageMilliseconds).toBe(12);
    expect(report?.scope).toBe('selected-compute-pass-spans');
    expect(report?.records.map(record => record.substep)).toEqual([16, 16, 16, 16]);
    expect(report?.records.map(record => record.contactIteration)).toEqual([0, 1, 2, 3]);
    expect(h.buffers[1].unmaps).toBe(1);
    await profiler.dispose();
  });

  it('rejects overlapping frames, excess span capacity and mismatched read identity', async () => {
    const h = harness(), profiler = begin(h, { capacity: 1, selectedZeroBasedSubsteps: [15] });
    expect(() => profiler.beginFrame(8, 13)).toThrow('in flight');
    profiler.timestampWrites({ stage: 'self-gather', zeroBasedSubstep: 15 });
    expect(() => profiler.timestampWrites({ stage: 'body-gather', zeroBasedSubstep: 15 })).toThrow('capacity');
    profiler.encodeResolve(h.encoder as unknown as GPUCommandEncoder);
    await expect(profiler.readFrame(8)).rejects.toThrow('mismatch');
    await profiler.readFrame(7); await profiler.dispose();
  });

  it('discards a stale owner generation while unmapping the real readback', async () => {
    const h = harness(), profiler = begin(h, { selectedZeroBasedSubsteps: [15] });
    profiler.timestampWrites({ stage: 'body-nearest', zeroBasedSubstep: 15 });
    profiler.encodeResolve(h.encoder as unknown as GPUCommandEncoder);
    expect(await profiler.readFrame(7, () => false)).toBeNull();
    expect(h.buffers[1].unmaps).toBe(1);
    await profiler.dispose();
  });

  it('clears ownership on map rejection without fabricating a GPU duration', async () => {
    const h = harness(), profiler = begin(h, { selectedZeroBasedSubsteps: [15] });
    profiler.timestampWrites({ stage: 'self-gather', zeroBasedSubstep: 15 });
    profiler.encodeResolve(h.encoder as unknown as GPUCommandEncoder);
    h.setMap(() => Promise.reject(new Error('device lost during profile map')));
    await expect(profiler.readFrame(7)).rejects.toThrow('device lost');
    expect(h.buffers[1].unmaps).toBe(0);
    profiler.beginFrame(8, 13); profiler.cancelUnsubmittedFrame();
    await profiler.dispose();
  });

  it('reports an invalid ordering with a null total instead of a partial duration', async () => {
    const h = harness(), profiler = begin(h, { selectedZeroBasedSubsteps: [15] });
    profiler.timestampWrites({ stage: 'self-gather', zeroBasedSubstep: 15 });
    profiler.encodeResolve(h.encoder as unknown as GPUCommandEncoder);
    h.buffers[1].values[0] = 100n; h.buffers[1].values[1] = 90n;
    const report = await profiler.readFrame(7);
    expect(report?.valid).toBe(false);
    expect(report?.records[0].milliseconds).toBeNull();
    expect(report?.measuredStageMilliseconds).toBeNull();
    await profiler.dispose();
  });

  it('waits for active mapping and queued GPU work before destroying each resource once', async () => {
    const h = harness(), profiler = begin(h, { selectedZeroBasedSubsteps: [15] });
    const map = deferred(), queue = deferred();
    h.setMap(() => map.promise); h.setQueue(() => queue.promise);
    profiler.timestampWrites({ stage: 'body-nearest', zeroBasedSubstep: 15 });
    profiler.encodeResolve(h.encoder as unknown as GPUCommandEncoder);
    const read = profiler.readFrame(7), dispose = profiler.dispose();
    expect(h.resources.every(resource => resource.destroys === 0)).toBe(true);
    map.resolve(); expect(await read).toBeNull();
    await Promise.resolve();
    expect(h.buffers[1].unmaps).toBe(1);
    expect(h.resources.every(resource => resource.destroys === 0)).toBe(true);
    queue.resolve(); await dispose;
    expect(h.resources.every(resource => resource.destroys === 1)).toBe(true);
    await profiler.dispose();
    expect(h.resources.every(resource => resource.destroys === 1)).toBe(true);
  });
});
