import { describe, expect, it } from 'vitest';
import { nestSearch } from '@atelier/geometry';
import type { Vec2 } from '@seamer/pattern-model';
import type { NestItem } from './markerLayout';
import {
  solveNestQuery,
  toMarkerLayout,
  toNestSearchOptions,
  type NestSolveQuery
} from './nestingProtocol';

const rectangle = (width: number, height: number): Vec2[] => [
  { x: 0, y: 0 },
  { x: width, y: 0 },
  { x: width, y: height },
  { x: 0, y: height }
];

const item = (id: string, width: number, height: number): NestItem => ({
  pieceId: id,
  name: id,
  cut: rectangle(width, height),
  outline: rectangle(width - 2, height - 2),
  instanceId: `${id}#0`,
  area: width * height
});

const query = (items: NestItem[]): NestSolveQuery => ({
  items,
  options: {
    fabricWidthMm: 100,
    gapMm: 2,
    rotations: [0, 180],
    generations: 3,
    population: 4,
    strategy: 'nfp',
    seed: 42,
    curveToleranceMm: 0.5,
    maxLengthMm: 55,
    gravity: 'bottom'
  }
});

describe('nesting worker protocol adapter', () => {
  it('maps every app option to nestSearch and streams real per-generation progress', () => {
    const input = query([item('a', 45, 35), item('b', 45, 35), item('c', 45, 35)]);
    expect(toNestSearchOptions(input.options)).toEqual({
      binWidth: 100,
      spacing: 2,
      rotations: [0, 180],
      generations: 3,
      population: 4,
      strategy: 'nfp',
      seed: 42,
      curveTolerance: 0.5,
      maxLength: 55,
      gravity: 'bottom'
    });

    const progress: number[] = [];
    const layout = solveNestQuery(input, (frame) => progress.push(frame.generation));
    expect(progress).toEqual([0, 1, 2, 3]);
    expect(layout.bins?.length).toBeGreaterThan(1);
    expect(layout.placements.every((placement) => placement.instanceId)).toBe(true);
  });

  it('preserves engine used-length and efficiency values and is deterministic under seed', () => {
    const input = query([item('a', 45, 35), item('b', 45, 35), item('c', 45, 35)]);
    const engineResult = nestSearch(
      input.items.map((entry) => ({
        id: entry.pieceId,
        shape: entry.cut,
        reference: entry.outline,
        instanceId: entry.instanceId
      })),
      toNestSearchOptions(input.options)
    );
    const adapted = toMarkerLayout(input, engineResult);
    const first = solveNestQuery(input);
    const second = solveNestQuery(input);

    expect(first).toEqual(second);
    expect(first.usedLengthMm).toBe(108);
    expect(first.efficiency).toBeCloseTo(0.6217105263157895, 12);
    expect(first.usedLengthMm).toBe(engineResult.usedLength);
    expect(first.efficiency).toBe(engineResult.efficiency);
    expect(first).toEqual(adapted);
  });
});
