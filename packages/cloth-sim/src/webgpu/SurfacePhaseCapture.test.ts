import { describe, expect, it, vi } from 'vitest';
import { SurfacePhaseCapture, planSurfacePhaseChunks } from './SurfacePhaseCapture';
interface BufferStub { size: number; bytes: ArrayBuffer; destroy: ReturnType<typeof vi.fn>; mapAsync: ReturnType<typeof vi.fn>; getMappedRange(): ArrayBuffer; unmap: ReturnType<typeof vi.fn> }
function harness() {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_SRC: 2, MAP_READ: 4, COPY_DST: 8, UNIFORM: 16 });
  vi.stubGlobal('GPUMapMode', { READ: 1 });
  const buffers: BufferStub[] = [], createBuffer = vi.fn(({ size }: { size: number }) => {
    const b = { size, bytes: new ArrayBuffer(size), destroy: vi.fn(), mapAsync: vi.fn().mockResolvedValue(undefined),
      getMappedRange() { return this.bytes; }, unmap: vi.fn() };
    buffers.push(b); return b;
  });
  const device = { limits: { maxStorageBufferBindingSize: 96, maxBufferSize: 1024, minUniformBufferOffsetAlignment: 16 }, createBuffer,
    queue: { writeBuffer: (b: BufferStub, offset: number, data: ArrayBuffer) => new Uint8Array(b.bytes).set(new Uint8Array(data), offset) },
    createBindGroup: (descriptor: { entries: { resource: { buffer: BufferStub; offset?: number } }[] }) => descriptor.entries };
  let group: { resource: { buffer: BufferStub; offset?: number } }[] = [];
  const dispatch = vi.fn(() => {
    const src = new Uint32Array(group[0].resource.buffer.bytes), destination = new Uint32Array(group[1].resource.buffer.bytes),
      sample = new Uint32Array(group[2].resource.buffer.bytes, group[2].resource.offset, 1)[0];
    destination.set(src, sample * src.length);
  });
  const pass = { setPipeline: vi.fn(), setBindGroup: (_index: number, value: typeof group) => { group = value; }, dispatchWorkgroups: dispatch };
  const encoder = { copyBufferToBuffer: (a: BufferStub, offsetA: number, b: BufferStub, offsetB: number, size: number) =>
    new Uint8Array(b.bytes).set(new Uint8Array(a.bytes, offsetA, size), offsetB) };
  const sources = [createBuffer({ size: 16 }), createBuffer({ size: 48 })];
  const build = (indices = [0, 5, 7]) => new SurfacePhaseCapture(device as unknown as GPUDevice,
    { getBindGroupLayout: vi.fn() } as unknown as GPUComputePipeline,
    sources[0] as unknown as GPUBuffer, sources[1] as unknown as GPUBuffer, indices, 1, 4);
  return { device, sources, buffers, pass, encoder, dispatch, build };
}
describe('bounded raw surface phase capture chunks', () => {
  it('retains exact word bits and actual phase indices across independently bounded buffers', async () => {
    const h = harness();
    try {
      const capture = h.build();
      for (const [ordinal, phase] of [0, 5, 7].entries()) {
        new Uint32Array(h.sources[0].bytes).set([ordinal + 2, 0xffffffff, 0x80000000, 0]);
        new Uint32Array(h.sources[1].bytes).set([0x80000000, 0x7fc00001 + ordinal]);
        capture.capture(h.pass as unknown as GPUComputePassEncoder, phase);
      }
      capture.capture(h.pass as unknown as GPUComputePassEncoder, 6);
      expect(h.dispatch).toHaveBeenCalledTimes(6);
      capture.encodeReadback(h.encoder as unknown as GPUCommandEncoder);
      const observations = await capture.readback();
      expect([...observations.keys()]).toEqual([0, 5, 7]);
      for (const [ordinal, phase] of [0, 5, 7].entries()) {
        expect([...observations.get(phase)!.candidates]).toEqual([ordinal + 2, 0xffffffff, 0x80000000, 0]);
        const floatBits = new Uint32Array(observations.get(phase)!.corrections.buffer, observations.get(phase)!.corrections.byteOffset, 12);
        expect([...floatBits.slice(0, 2)]).toEqual([0x80000000, 0x7fc00001 + ordinal]);
      }
      expect(h.buffers.slice(2).every(buffer => buffer.size <= 96)).toBe(true);
      capture.destroy(); capture.destroy();
      expect(h.buffers.slice(2).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects impossible full rows and duplicate phase indices before allocating diagnostics', () => {
    const h = harness();
    try {
      expect(() => h.build([1, 1])).toThrow('topology');
      expect(h.buffers).toHaveLength(2);
      h.device.limits.maxStorageBufferBindingSize = 32;
      expect(() => h.build()).toThrow('topology');
      expect(h.buffers).toHaveLength(2);
    } finally { vi.unstubAllGlobals(); }
  });
  it('unmaps an earlier candidate readback when the correction map fails', async () => {
    const h = harness();
    try {
      const capture = h.build([0]);
      h.buffers[5].mapAsync.mockRejectedValue(new Error('lost device'));
      await expect(capture.readback()).rejects.toThrow('lost device');
      expect(h.buffers[3].unmap).toHaveBeenCalledOnce();
      capture.destroy();
    } finally { vi.unstubAllGlobals(); }
  });
  it('destroys both completed chunks and a partially allocated later chunk', () => {
    const h = harness();
    try {
      const original = h.device.createBuffer;
      h.device.createBuffer = vi.fn(descriptor => {
        if (h.buffers.length === 9) throw new Error('allocation failed');
        return original(descriptor);
      });
      expect(() => h.build()).toThrow('allocation failed');
      expect(h.buffers.slice(2)).toHaveLength(7);
      expect(h.buffers.slice(2).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects truncated source rows and oversized uniform records before allocation', () => {
    const h = harness();
    try {
      h.sources[0].size = 12;
      expect(() => h.build()).toThrow('topology');
      expect(h.buffers).toHaveLength(2);
      h.sources[0].size = 16;
      h.device.limits.maxBufferSize = 96;
      h.device.limits.minUniformBufferOffsetAlignment = 256;
      expect(() => h.build()).toThrow('uniform limits');
      expect(h.buffers).toHaveLength(2);
    } finally { vi.unstubAllGlobals(); }
  });
  it('destroys allocation prefixes if a later bind-group creation fails', () => {
    const h = harness();
    try {
      h.device.createBindGroup = () => { throw new Error('invalid layout'); };
      expect(() => h.build()).toThrow('invalid layout');
      expect(h.buffers.slice(2).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('portable large phase record plans', () => {
  it('chunks the complete pants range above128MiB without omitting its final phase index', () => {
    const phases = Array.from({ length: 32 }, (_, index) => 3 + index * 2);
    const chunks = planSurfacePhaseChunks(13000, 128, phases,
      { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024 });
    expect(chunks.length).toBe(2);
    expect(chunks.flatMap(chunk => chunk.records)).toEqual(phases);
    expect(chunks.at(-1)!.records.at(-1)).toBe(65);
    expect(chunks.reduce((sum, chunk) => sum + chunk.candidateBytes, 0)).toBe(13000 * 128 * 4 * 32);
    expect(chunks.every(chunk => chunk.candidateBytes <= 128 * 1024 * 1024 && chunk.correctionBytes <= 128 * 1024 * 1024)).toBe(true);
    const smaller = planSurfacePhaseChunks(13000, 128, phases,
      { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 64 * 1024 * 1024 });
    expect(smaller.length).toBe(4);
    expect(smaller.every(chunk => chunk.candidateBytes <= 64 * 1024 * 1024)).toBe(true);
  });
});
