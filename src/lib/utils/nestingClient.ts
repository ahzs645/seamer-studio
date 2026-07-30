// Main-thread nesting client. Atelier's solve host owns request ordering, result caching, progress
// filtering, and AbortSignal forwarding; its worker adapter owns worker lifecycle and hard cancel.

import type { Pattern } from '@seamer/pattern-model';
import {
  createSolveHost,
  createWorkerSteadySolverPlugin,
  SolveHostDisposed,
  SolveSuperseded,
  type SolveHost
} from '@atelier/sim';
import { buildNestItems, type MarkerLayout, type NestItem, type NestOptions } from './markerLayout';
import {
  type NestGravity,
  type NestProgress,
  type NestSolveQuery,
  type NestStrategy
} from './nestingProtocol';

export type { NestProgress } from './nestingProtocol';

export interface NestJob {
  promise: Promise<MarkerLayout>;
  cancel: () => void;
}

export interface WorkerNestOptions extends NestOptions {
  /** 'nfp' (default): polygon vertex-contact placement; 'corners': bounding-box candidates. */
  strategy?: NestStrategy;
  /** Which fabric edge pieces snug toward. Default 'bottom'. */
  gravity?: NestGravity;
  /** Douglas-Peucker tolerance (mm) for search-polygon simplification. */
  curveToleranceMm?: number;
}

type NestHost = SolveHost<NestSolveQuery, MarkerLayout, NestProgress>;

const nestingPlugin = createWorkerSteadySolverPlugin<void, NestSolveQuery, MarkerLayout, NestProgress>({
  id: 'seamer.ga-nesting.worker',
  createWorker: () =>
    new Worker(new URL('../workers/nesting.worker.ts', import.meta.url), { type: 'module' }),
  cancelMode: 'terminate',
  mapError: (message) => new Error(message)
});

let hostPromise: Promise<NestHost> | null = null;

function nestingHost(): Promise<NestHost> {
  hostPromise ??= createSolveHost(nestingPlugin, {
    input: undefined,
    cacheKey: (query) => JSON.stringify(query),
    maxCacheEntries: 8
  });
  return hostPromise;
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    error instanceof SolveSuperseded ||
    error instanceof SolveHostDisposed ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

/** Nest off the main thread. Resolves with the layout; rejects with Error('cancelled') on cancel. */
export function nestInWorker(
  pattern: Pattern,
  opts: WorkerNestOptions = {},
  onProgress?: (progress: NestProgress) => void
): NestJob {
  return nestItemsInWorker(buildNestItems(pattern), opts, onProgress);
}

/** Lower-level variant taking pre-built nest items (used by /test-nfp and tests). */
export function nestItemsInWorker(
  items: NestItem[],
  opts: WorkerNestOptions = {},
  onProgress?: (progress: NestProgress) => void
): NestJob {
  const query: NestSolveQuery = {
    items,
    options: {
      fabricWidthMm: opts.fabricWidthMm ?? 1400,
      gapMm: opts.gapMm ?? 10,
      rotations: opts.allowedRotations?.length ? opts.allowedRotations : [0, 180],
      generations: Math.max(0, opts.generations ?? 12),
      population: Math.max(4, opts.population ?? 16),
      strategy: opts.strategy ?? 'nfp',
      ...(opts.seed === undefined ? {} : { seed: opts.seed }),
      curveToleranceMm:
        opts.curveToleranceMm !== undefined && opts.curveToleranceMm > 0
          ? opts.curveToleranceMm
          : 1,
      ...(opts.maxLengthMm !== undefined && opts.maxLengthMm > 0
        ? { maxLengthMm: opts.maxLengthMm }
        : {}),
      gravity: opts.gravity ?? 'bottom'
    }
  };
  const controller = new AbortController();
  let settled = false;
  const promise = nestingHost()
    .then((host) => host.solve(query, { signal: controller.signal, onProgress }))
    .catch((error: unknown) => {
      if (isCancellation(error, controller.signal)) throw new Error('cancelled');
      throw error;
    });
  void promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  return {
    promise,
    cancel: () => {
      if (settled || controller.signal.aborted) return;
      controller.abort(new Error('cancelled'));
    }
  };
}
