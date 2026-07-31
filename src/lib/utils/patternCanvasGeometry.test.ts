/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { indexPaths, indexPoints, pieceWorldOutline, type Pattern } from '@seamer/pattern-model';
import { pieceDisplayEdgePolylines, pieceDisplayOutline } from './patternCanvasGeometry';

const PENCIL_SKIRT = new URL('../../../static/templates/pencil-skirt.json', import.meta.url);

function width(points: Array<{ x: number; y: number }>): number {
  return Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
}

describe('pattern canvas cut-on-fold display geometry', () => {
  const pattern = JSON.parse(readFileSync(PENCIL_SKIRT, 'utf8')) as Pattern;
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);

  it('shows the legacy front as a full mirrored cut piece without mutating its half-piece topology', () => {
    const front = pattern.pieces.find((piece) => piece.name === 'Front')!;
    const before = JSON.stringify(pattern);
    const solverOutline = pieceWorldOutline(pattern, front, paths, points, 4);
    const displayOutline = pieceDisplayOutline(pattern, front, paths, points, 4);

    expect(width(displayOutline)).toBeCloseTo(width(solverOutline) * 2, 0);
    expect(JSON.stringify(pattern)).toBe(before);
  });

  it('duplicates cut edges across the fold but does not render the fold as a cut edge', () => {
    const front = pattern.pieces.find((piece) => piece.name === 'Front')!;
    const fold = front.mainPaths.find((piecePath) => piecePath.isMirrorLine)!;
    const cutEdge = front.mainPaths.find((piecePath) => !piecePath.isMirrorLine)!;

    expect(pieceDisplayEdgePolylines(pattern, front, fold, paths, points, 4)).toEqual([]);
    expect(pieceDisplayEdgePolylines(pattern, front, cutEdge, paths, points, 4)).toHaveLength(2);
  });
});
