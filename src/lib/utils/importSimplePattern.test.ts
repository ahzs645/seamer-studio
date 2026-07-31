/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPieceCloth, computeSeamEdgeIntervals } from '@seamer/cloth-sim';
import { pieceWorldOutline } from '@seamer/pattern-model';
import { assertPatternBuildable3d, convertSimplePattern, type SimpleFile } from './importSimplePattern';

const LEGACY_PENCIL_SKIRT = new URL('../../../e2e/fixtures/pencil-skirt-legacy.json', import.meta.url);

describe('convertSimplePattern legacy pencil skirt', () => {
  const source = JSON.parse(readFileSync(LEGACY_PENCIL_SKIRT, 'utf8')) as SimpleFile;

  it('produces closed, triangulatable pieces in their original plan positions', () => {
    expect(source.pieces).toHaveLength(4);
    expect(source.pieces.reduce((count, piece) => count + piece.boundary.length, 0)).toBe(82);
    expect(source.pieces.reduce((count, piece) => count + piece.sewLines.length, 0)).toBe(48);
    const pattern = convertSimplePattern(source);
    const intervals = computeSeamEdgeIntervals(pattern);

    expect(pattern.pieces).toHaveLength(4);
    expect(pattern.seams).toHaveLength(12);
    expect(() => assertPatternBuildable3d(pattern)).not.toThrow();
    for (const [index, piece] of pattern.pieces.entries()) {
      const outline = pieceWorldOutline(pattern, piece);
      const sourcePoints = source.pieces[index].sewLines.flat();
      expect(outline.length, piece.name).toBeGreaterThan(2);
      expect(Math.min(...outline.map((point) => point.x)), `${piece.name} min plan x`).toBeCloseTo(Math.min(...sourcePoints.map(([x]) => x)), 3);
      expect(Math.max(...outline.map((point) => point.x)), `${piece.name} max plan x`).toBeCloseTo(Math.max(...sourcePoints.map(([x]) => x)), 3);
      expect(Math.min(...outline.map((point) => point.y)), `${piece.name} min plan y`).toBeCloseTo(Math.min(...sourcePoints.map(([, y]) => y)), 3);
      expect(Math.max(...outline.map((point) => point.y)), `${piece.name} max plan y`).toBeCloseTo(Math.max(...sourcePoints.map(([, y]) => y)), 3);
      expect(() => buildPieceCloth(pattern, piece, undefined, intervals), piece.name).not.toThrow();
      expect(buildPieceCloth(pattern, piece, undefined, intervals), piece.name).not.toBeNull();
    }
    expect(pattern.pieces.map((piece) => piece.settings3d.arrangement.uDegrees)).toEqual([0, 180, 0, 180]);
    expect(pattern.pieces.map((piece) => piece.settings3d.flipNormals)).toEqual([false, true, false, true]);
  });
});
