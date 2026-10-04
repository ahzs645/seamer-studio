/** Optional raw surface-buffer copies. Never dispatches or updates a physics kernel. */
export interface SurfacePhaseSample {
  candidates: Uint32Array;
  corrections: Float32Array;
}
interface Chunk {
  records: readonly number[];
  candidates: GPUBuffer;
  candidateReadback: GPUBuffer;
  corrections: GPUBuffer;
  correctionReadback: GPUBuffer;
  params: GPUBuffer;
  candidateGroups: readonly GPUBindGroup[];
  correctionGroups: readonly GPUBindGroup[];
}
export function planSurfacePhaseChunks(triangleCount: number, budget: number, phaseIndices: readonly number[],
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number }) {
  const candidateBytes = triangleCount * budget * 4, correctionBytes = triangleCount * 48;
  const cap = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
  if (!Number.isSafeInteger(triangleCount) || triangleCount <= 0 || !Number.isSafeInteger(budget) || budget <= 0
    || !Number.isSafeInteger(candidateBytes) || !Number.isSafeInteger(correctionBytes)
    || candidateBytes > cap || correctionBytes > cap || !Number.isSafeInteger(cap) || cap <= 0 || !phaseIndices.length
    || new Set(phaseIndices).size !== phaseIndices.length || phaseIndices.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Invalid bounded surface phase capture topology');
  }
  const capacity = Math.floor(cap / Math.max(candidateBytes, correctionBytes));
  const chunks: { records: readonly number[]; candidateBytes: number; correctionBytes: number }[] = [];
  for (let first = 0; first < phaseIndices.length; first += capacity) {
    const records = phaseIndices.slice(first, first + capacity);
    chunks.push({ records, candidateBytes: records.length * candidateBytes, correctionBytes: records.length * correctionBytes });
  }
  return chunks;
}
export class SurfacePhaseCapture {
  private readonly chunks: Chunk[] = [];
  private readonly allocated: GPUBuffer[] = [];
  private readonly locations = new Map<number, { chunk: Chunk; local: number }>();
  private readonly candidateWords: number;
  private readonly correctionWords: number;
  constructor(device: GPUDevice, private readonly pipe: GPUComputePipeline,
    sourceCandidates: GPUBuffer, sourceCorrections: GPUBuffer, phaseIndices: readonly number[],
    readonly triangleCount: number, readonly budget: number) {
    this.candidateWords = triangleCount * budget;
    this.correctionWords = triangleCount * 12;
    const plan = planSurfacePhaseChunks(triangleCount, budget, phaseIndices, device.limits);
    if (sourceCandidates.size !== this.candidateWords * 4 || sourceCorrections.size !== this.correctionWords * 4)
      throw new Error('Invalid bounded surface phase capture topology');
    const alignment = device.limits.minUniformBufferOffsetAlignment;
    if (!Number.isSafeInteger(alignment) || alignment < 16 || alignment % 4 !== 0
      || plan.some(chunk => chunk.records.length * alignment > device.limits.maxBufferSize))
      throw new Error('Invalid bounded surface phase capture uniform limits');
    const create = (descriptor: GPUBufferDescriptor) => {
      const buffer = device.createBuffer(descriptor); this.allocated.push(buffer); return buffer;
    };
    try {
      for (const planned of plan) {
        const records = planned.records;
        const candidates = create({ size: planned.candidateBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const candidateReadback = create({ size: planned.candidateBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const corrections = create({ size: planned.correctionBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const correctionReadback = create({ size: planned.correctionBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const parameters = new Uint32Array(records.length * alignment / 4);
        for (let local = 0; local < records.length; local++) parameters[local * alignment / 4] = local;
        const params = create({ size: parameters.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(params, 0, parameters.buffer);
        const groups = (source: GPUBuffer, destination: GPUBuffer) => records.map((_, local) => device.createBindGroup({
          layout: pipe.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: destination } },
            { binding: 2, resource: { buffer: params, offset: local * alignment, size: 16 } }
          ] }));
        const chunk: Chunk = { records, candidates, candidateReadback, corrections, correctionReadback, params,
          candidateGroups: groups(sourceCandidates, candidates), correctionGroups: groups(sourceCorrections, corrections) };
        this.chunks.push(chunk);
        records.forEach((phase, local) => this.locations.set(phase, { chunk, local }));
      }
    } catch (error) { this.destroy(); throw error; }
  }
  capture(pass: GPUComputePassEncoder, phase: number): void {
    const location = this.locations.get(phase);
    if (!location) return;
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, location.chunk.candidateGroups[location.local]);
    pass.dispatchWorkgroups(Math.ceil(this.candidateWords / 64));
    pass.setBindGroup(0, location.chunk.correctionGroups[location.local]);
    pass.dispatchWorkgroups(Math.ceil(this.correctionWords / 64));
  }
  encodeReadback(encoder: GPUCommandEncoder): void {
    for (const chunk of this.chunks) {
      encoder.copyBufferToBuffer(chunk.candidates, 0, chunk.candidateReadback, 0, chunk.candidates.size);
      encoder.copyBufferToBuffer(chunk.corrections, 0, chunk.correctionReadback, 0, chunk.corrections.size);
    }
  }
  async readback(): Promise<Map<number, SurfacePhaseSample>> {
    const samples = new Map<number, SurfacePhaseSample>();
    for (const chunk of this.chunks) {
      await chunk.candidateReadback.mapAsync(GPUMapMode.READ);
      let candidates: Uint32Array;
      try { candidates = new Uint32Array(chunk.candidateReadback.getMappedRange().slice(0)); }
      finally { chunk.candidateReadback.unmap(); }
      await chunk.correctionReadback.mapAsync(GPUMapMode.READ);
      let corrections: Float32Array;
      try { corrections = new Float32Array(chunk.correctionReadback.getMappedRange().slice(0)); }
      finally { chunk.correctionReadback.unmap(); }
      chunk.records.forEach((phase, local) => samples.set(phase, {
        candidates: candidates.subarray(local * this.candidateWords, (local + 1) * this.candidateWords),
        corrections: corrections.subarray(local * this.correctionWords, (local + 1) * this.correctionWords)
      }));
    }
    return samples;
  }
  destroy(): void {
    for (const buffer of this.allocated) buffer.destroy();
    this.allocated.length = 0;
    this.chunks.length = 0;
    this.locations.clear();
  }
}
