// Nesting Web Worker: runs Atelier's true-shape nester off the main thread.

import {
  nestItemsWithAtelier,
  type MarkerLayout,
  type NestItem
} from '../utils/markerLayout';
import type { NestProgress } from '../utils/nestingClient';

export interface NestWorkerRequest {
  items: NestItem[];
  options: {
    fabricWidthMm: number;
    gapMm: number;
    rotations: number[];
    maxLengthMm?: number;
  };
}

self.onmessage = (e: MessageEvent<NestWorkerRequest>) => {
  const { items, options } = e.data;
  try {
    const layout: MarkerLayout = nestItemsWithAtelier(items, options);
    const progress: NestProgress = {
      generation: 1,
      generations: 1,
      bestLengthMm: layout.usedLengthMm,
      efficiency: layout.efficiency ?? 0
    };
    self.postMessage({ type: 'progress', ...progress });
    self.postMessage({ type: 'done', layout });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
