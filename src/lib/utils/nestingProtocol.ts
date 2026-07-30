import {
  nestSearch,
  type NestSearchGravity,
  type NestSearchOptions,
  type NestSearchProgress,
  type NestSearchResult,
  type NestSearchStrategy
} from '@atelier/geometry';
import type { MarkerLayout, NestItem } from './markerLayout';

export type { NestSearchGravity as NestGravity, NestSearchStrategy as NestStrategy };

export interface NestProgress {
  generation: number;
  generations: number;
  bestLengthMm: number;
  efficiency: number;
}

export interface NestSolveOptions {
  fabricWidthMm: number;
  gapMm: number;
  rotations: number[];
  generations: number;
  population: number;
  strategy: NestSearchStrategy;
  seed?: number;
  curveToleranceMm: number;
  maxLengthMm?: number;
  gravity: NestSearchGravity;
}

export interface NestSolveQuery {
  items: NestItem[];
  options: NestSolveOptions;
}

export function toNestSearchOptions(options: NestSolveOptions): NestSearchOptions {
  return {
    binWidth: options.fabricWidthMm,
    spacing: options.gapMm,
    rotations: options.rotations,
    generations: options.generations,
    population: options.population,
    strategy: options.strategy,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    curveTolerance: options.curveToleranceMm,
    ...(options.maxLengthMm === undefined ? {} : { maxLength: options.maxLengthMm }),
    gravity: options.gravity
  };
}

export function toMarkerLayout(query: NestSolveQuery, result: NestSearchResult): MarkerLayout {
  return {
    fabricWidthMm: result.binWidth,
    usedLengthMm: result.usedLength,
    gapMm: result.spacing,
    placements: result.placements.map((placement) => {
      const item = query.items[placement.sourceIndex];
      if (!item) throw new Error(`Nesting result references missing item ${placement.sourceIndex}`);
      return {
        pieceId: item.pieceId,
        name: item.name,
        poly: placement.shape,
        outline: placement.reference,
        bbox: { w: placement.bounds.width, h: placement.bounds.height },
        rotationDeg: placement.rotationDeg,
        instanceId: placement.instanceId,
        bin: placement.binIndex
      };
    }),
    efficiency: result.efficiency,
    ...(result.bins
      ? {
          bins: result.bins.map((bin) => ({
            startYmm: bin.start,
            usedLengthMm: bin.usedLength
          }))
        }
      : {})
  };
}

function toProgress(progress: NestSearchProgress): NestProgress {
  return {
    generation: progress.generation,
    generations: progress.generations,
    bestLengthMm: progress.bestLength,
    efficiency: progress.efficiency
  };
}

/** Worker-side app/engine adapter. */
export function solveNestQuery(
  query: NestSolveQuery,
  onProgress?: (progress: NestProgress) => void
): MarkerLayout {
  const result = nestSearch(
    query.items.map((item) => ({
      id: item.pieceId,
      shape: item.cut,
      reference: item.outline,
      instanceId: item.instanceId
    })),
    toNestSearchOptions(query.options),
    onProgress ? (progress) => onProgress(toProgress(progress)) : undefined
  );
  return toMarkerLayout(query, result);
}
