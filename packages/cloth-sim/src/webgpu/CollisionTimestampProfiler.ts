export interface CollisionProfileStage {
  stage: string;
  zeroBasedSubstep: number;
  /** Zero-based contact pass; omitted for non-contact stages. */
  contactIteration?: number;
}
export interface CollisionProfileRecord extends CollisionProfileStage {
  substep: number;
  valid: boolean;
  milliseconds: number | null;
}
export interface CollisionProfileReport {
  generation: number;
  frameIndex: number;
  selectedZeroBasedSubsteps: number[];
  records: CollisionProfileRecord[];
  valid: boolean;
  measuredStageMilliseconds: number | null;
  /** These selected pass spans are not the complete frame duration. */
  scope: 'selected-compute-pass-spans';
}

/** Isolated diagnostic helper: no solver dispatches, queue submissions or storage bindings.
 * Owner must end the current compute pass before encodeResolve(). All indexed pass descriptors
 * must be used exactly once. The caller owns every pass/pipeline/bind group and physical setting.
 */
export class CollisionTimestampProfiler {
  readonly timestampQuerySet: GPUQuerySet;
  readonly #device: GPUDevice;
  readonly #resolved: GPUBuffer;
  readonly #readback: GPUBuffer;
  readonly #selected: ReadonlySet<number>;
  readonly #capacity: number;
  readonly #substeps: number;
  #records: CollisionProfileStage[] = [];
  #generation = -1;
  #frameIndex = -1;
  #state: 'idle' | 'encoding' | 'encoded' | 'mapping' = 'idle';
  #disposed = false;
  #destroyed = false;
  #readPromise: Promise<CollisionProfileReport | null> | null = null;

  constructor(device: GPUDevice, options: { selectedZeroBasedSubsteps?: readonly number[]; capacity?: number; substeps?: number } = {}) {
    if (!device.features.has('timestamp-query')) throw new Error('GPU profiling requires an explicitly requested timestamp-query device feature.');
    const substeps = options.substeps ?? 40;
    const selected = options.selectedZeroBasedSubsteps ?? [0, 20, 39];
    const capacity = options.capacity ?? 256;
    if (!Number.isInteger(substeps) || substeps < 1 || !selected.length
      || selected.some(value => !Number.isInteger(value) || value < 0 || value >= substeps)) throw new Error('Invalid selected GPU profile substeps.');
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2048) throw new Error('Invalid GPU profile stage capacity.');
    this.#device = device; this.#selected = new Set(selected); this.#capacity = capacity; this.#substeps = substeps;
    this.timestampQuerySet = device.createQuerySet({ type: 'timestamp', count: capacity * 2 });
    this.#resolved = device.createBuffer({ size: capacity * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.#readback = device.createBuffer({ size: capacity * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }

  beginFrame(generation: number, frameIndex: number): void {
    if (this.#disposed || this.#state !== 'idle') throw new Error('GPU profile frame is disposed or already in flight.');
    if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(frameIndex) || frameIndex < 0) throw new Error('Invalid GPU profile frame identity.');
    this.#records = []; this.#generation = generation; this.#frameIndex = frameIndex; this.#state = 'encoding';
  }

  /** Use as encoder.beginComputePass({ timestampWrites: profiler.timestampWrites(stage) }).
   * Reserve only at actual pass boundaries. Do not reserve a descriptor that will go unused.
   */
  timestampWrites(record: CollisionProfileStage): GPUComputePassTimestampWrites | undefined {
    if (this.#disposed || this.#state !== 'encoding') throw new Error('GPU profile is not encoding a live frame.');
    if (!Number.isInteger(record.zeroBasedSubstep) || record.zeroBasedSubstep < 0 || record.zeroBasedSubstep >= this.#substeps) throw new Error('Invalid GPU profile stage substep.');
    if (!this.#selected.has(record.zeroBasedSubstep)) return undefined;
    if (!record.stage || (record.contactIteration !== undefined && (!Number.isInteger(record.contactIteration) || record.contactIteration < 0))) throw new Error('Invalid GPU profile stage.');
    if (this.#records.length >= this.#capacity) throw new Error('GPU profile stage capacity exceeded.');
    const index = this.#records.length * 2;
    this.#records.push({ ...record });
    return { querySet: this.timestampQuerySet, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 };
  }

  /** Call after all compute passes end and before the ORIGINAL normal frame submission. */
  encodeResolve(encoder: GPUCommandEncoder): void {
    if (this.#disposed || this.#state !== 'encoding') throw new Error('GPU profile cannot resolve this frame.');
    if (this.#records.length) {
      encoder.resolveQuerySet(this.timestampQuerySet, 0, this.#records.length * 2, this.#resolved, 0);
      encoder.copyBufferToBuffer(this.#resolved, 0, this.#readback, 0, this.#records.length * 16);
    }
    this.#state = 'encoded';
  }

  /** Await after submitting the ORIGINAL command buffer. Return null on a stale owner generation.
   * Owner should catch profile failures separately: diagnostics must not publish fabricated times
   * or change physical acceptance. Map cleanup runs even if copy/validation/owner predicate fails.
   */
  readFrame(generation: number, isCurrent: () => boolean = () => true): Promise<CollisionProfileReport | null> {
    if (this.#disposed || this.#state !== 'encoded' || generation !== this.#generation) return Promise.reject(new Error('GPU profile read identity/state mismatch.'));
    this.#state = 'mapping';
    const pending = this.#readFrame(generation, isCurrent);
    this.#readPromise = pending;
    void pending.finally(() => { if (this.#readPromise === pending) this.#readPromise = null; }).catch(() => {});
    return pending;
  }

  async #readFrame(generation: number, isCurrent: () => boolean): Promise<CollisionProfileReport | null> {
    let mapped = false;
    try {
      let values = new BigUint64Array(0);
      if (this.#records.length) {
        await this.#readback.mapAsync(GPUMapMode.READ); mapped = true;
        values = new BigUint64Array(this.#readback.getMappedRange(0, this.#records.length * 16).slice(0));
      }
      if (this.#disposed || generation !== this.#generation || !isCurrent()) return null;
      const records = this.#records.map((record, index): CollisionProfileRecord => {
        const begin = values[index * 2], end = values[index * 2 + 1];
        return { ...record, substep: record.zeroBasedSubstep + 1, valid: end >= begin,
          milliseconds: end >= begin ? Number(end - begin) / 1e6 : null };
      });
      const valid = records.length > 0 && records.every(record => record.valid);
      return { generation, frameIndex: this.#frameIndex, selectedZeroBasedSubsteps: [...this.#selected], records, valid,
        measuredStageMilliseconds: valid ? records.reduce((total, record) => total + record.milliseconds!, 0) : null,
        scope: 'selected-compute-pass-spans' };
    } finally {
      if (mapped) this.#readback.unmap();
      this.#state = 'idle';
    }
  }

  /** Encoding aborted before submission; do not use for an already submitted frame. */
  cancelUnsubmittedFrame(): void {
    if (this.#state === 'mapping') throw new Error('Cannot cancel a mapping GPU profile frame.');
    this.#records = []; this.#state = 'idle';
  }

  /** Owner must stop new solver encoding first. Await mapping and the existing queue before
   * destroying resources; caller may invoke during disposal without publishing stale records.
   */
  async dispose(): Promise<void> {
    if (this.#destroyed) return;
    this.#disposed = true;
    await this.#readPromise?.catch(() => null);
    try { await this.#device.queue.onSubmittedWorkDone(); } catch { /* device loss still needs cleanup */ }
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#readback.destroy(); this.#resolved.destroy(); this.timestampQuerySet.destroy();
  }
}
