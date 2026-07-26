// Main-thread client for the nesting Web Worker: builds the per-instance nest items from the
// pattern, posts them to the worker, streams progress, and supports cancellation (terminate).

import type { Pattern } from '@seamer/pattern-model';
import { buildNestItems, type MarkerLayout, type NestItem, type NestOptions } from './markerLayout';

export interface NestProgress {
  generation: number;
  generations: number;
  bestLengthMm: number;
  efficiency: number;
}

export interface NestJob {
  promise: Promise<MarkerLayout>;
  cancel: () => void;
}

export interface WorkerNestOptions extends NestOptions {
  /** max marker length per fabric sheet (mm); overflow spills into more bins. 0 = unlimited. */
  maxLengthMm?: number;
}

/** Nest off the main thread. Resolves with the layout; rejects with Error('cancelled') on cancel. */
export function nestInWorker(
  pattern: Pattern,
  opts: WorkerNestOptions = {},
  onProgress?: (p: NestProgress) => void
): NestJob {
  return nestItemsInWorker(buildNestItems(pattern), opts, onProgress);
}

/** Lower-level variant taking pre-built nest items (used by /test-nfp and tests). */
export function nestItemsInWorker(
  items: NestItem[],
  opts: WorkerNestOptions = {},
  onProgress?: (p: NestProgress) => void
): NestJob {
  const options = {
    fabricWidthMm: opts.fabricWidthMm ?? 1400,
    gapMm: opts.gapMm ?? 10,
    rotations: opts.allowedRotations?.length ? opts.allowedRotations : [0, 180],
    ...(opts.maxLengthMm && opts.maxLengthMm > 0 ? { maxLengthMm: opts.maxLengthMm } : {})
  };

  const worker = new Worker(new URL('../workers/nesting.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<MarkerLayout>((resolve, reject) => {
    rejectFn = reject;
    worker.onmessage = (e: MessageEvent<{ type: string } & Record<string, unknown>>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg as unknown as NestProgress);
      } else if (msg.type === 'done') {
        settled = true;
        worker.terminate();
        resolve(msg.layout as MarkerLayout);
      } else if (msg.type === 'error') {
        settled = true;
        worker.terminate();
        reject(new Error(String(msg.message ?? 'Nesting failed')));
      }
    };
    worker.onerror = (e) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error(e.message || 'Nesting worker failed'));
    };
    worker.postMessage({ items, options });
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectFn(new Error('cancelled'));
    }
  };
}
