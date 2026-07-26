// Main-thread client for the nesting Web Worker: builds the per-instance nest items from the
// pattern, posts them to the worker, streams progress, and supports cancellation (terminate).

import type { Pattern } from '@seamer/pattern-model';
import { buildNestItems, type MarkerLayout, type NestOptions } from './markerLayout';
import type { CoreItem, CoreLayout, CoreOptions, CoreProgress, NestStrategy, NestGravity } from './nestCore';

export type { CoreProgress as NestProgress } from './nestCore';

export interface NestJob {
  promise: Promise<MarkerLayout>;
  cancel: () => void;
}

export interface WorkerNestOptions extends NestOptions {
  /** 'nfp' (default): no-fit-polygon vertex-contact placement; 'corners': bbox shelf candidates. */
  strategy?: NestStrategy;
  /** which fabric edge pieces snug toward (the original's gravityDirection). Default 'bottom'. */
  gravity?: NestGravity;
  /** Douglas-Peucker tolerance (mm) for cut-polygon simplification (the original's curveTolerance). */
  curveToleranceMm?: number;
}

/** Nest off the main thread. Resolves with the layout; rejects with Error('cancelled') on cancel. */
export function nestInWorker(
  pattern: Pattern,
  opts: WorkerNestOptions = {},
  onProgress?: (p: CoreProgress) => void
): NestJob {
  return nestItemsInWorker(buildNestItems(pattern), opts, onProgress);
}

/** Lower-level variant taking pre-built nest items (used by /test-nfp and tests). */
export function nestItemsInWorker(
  items: CoreItem[],
  opts: WorkerNestOptions = {},
  onProgress?: (p: CoreProgress) => void
): NestJob {
  const options: CoreOptions = {
    fabricWidthMm: opts.fabricWidthMm ?? 1400,
    gapMm: opts.gapMm ?? 10,
    rotations: opts.allowedRotations?.length ? opts.allowedRotations : [0, 180],
    generations: opts.generations ?? 12,
    population: Math.max(4, opts.population ?? 16),
    strategy: opts.strategy ?? 'nfp',
    maxLengthMm: opts.maxLengthMm && opts.maxLengthMm > 0 ? opts.maxLengthMm : null,
    gravity: opts.gravity ?? 'bottom',
    simplifyTolMm: opts.curveToleranceMm && opts.curveToleranceMm > 0 ? opts.curveToleranceMm : 1
  };

  const worker = new Worker(new URL('../workers/nesting.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<MarkerLayout>((resolve, reject) => {
    rejectFn = reject;
    worker.onmessage = (e: MessageEvent<{ type: string } & Record<string, unknown>>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg as unknown as CoreProgress);
      } else if (msg.type === 'done') {
        settled = true;
        worker.terminate();
        resolve(msg.layout as CoreLayout as MarkerLayout);
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
