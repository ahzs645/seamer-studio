/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPieceCloth, computeSeamEdgeIntervals } from '@seamer/cloth-sim';
import { assertPatternBuildable3d, convertSimplePattern, type SimpleFile } from './importSimplePattern';

const LEGACY_PENCIL_SKIRT = new URL('../../../e2e/fixtures/pencil-skirt-legacy.json', import.meta.url);
const CANONICAL_PENCIL_SKIRT = new URL('../../../static/templates/pencil-skirt.json', import.meta.url);

describe('convertSimplePattern legacy pencil skirt', () => {
  const source = JSON.parse(readFileSync(LEGACY_PENCIL_SKIRT, 'utf8')) as SimpleFile;
  const canonical = JSON.parse(readFileSync(CANONICAL_PENCIL_SKIRT, 'utf8'));

  it('restores the canonical editable draft, seam topology, arrangement, and saved drape', () => {
    expect(source.pieces).toHaveLength(4);
    expect(source.pieces.reduce((count, piece) => count + piece.boundary.length, 0)).toBe(82);
    expect(source.pieces.reduce((count, piece) => count + piece.sewLines.length, 0)).toBe(48);
    const pattern = convertSimplePattern(source, canonical);
    const intervals = computeSeamEdgeIntervals(pattern);

    expect(pattern.name).toBe(source.name);
    expect(pattern.description).toBe(source.description);
    expect(pattern.points).toHaveLength(35);
    expect(pattern.paths).toHaveLength(36);
    expect(pattern.points.map((point) => point.name)).toEqual(Array.from({ length: 35 }, (_, index) => `A${index}`));
    expect(pattern.pieces).toHaveLength(4);
    expect(pattern.pieces.map((piece) => piece.name)).toEqual(['Front', 'Back', 'WaistbandFront', 'WaistbandBack']);
    expect(pattern.seams).toHaveLength(12);
    expect(pattern.seams.map((seam) => [seam.fromPaths.length, seam.toPaths.length])).toEqual([
      [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1],
      [4, 6], [4, 6], [1, 1], [1, 1]
    ]);
    expect(pattern.pieces.reduce((count, piece) => count + piece.settings3d.savedPositions.length, 0)).toBe(32985);
    expect(() => assertPatternBuildable3d(pattern)).not.toThrow();
    for (const piece of pattern.pieces) {
      expect(piece.originPoint, `${piece.name} origin point`).not.toBe('');
      expect(() => buildPieceCloth(pattern, piece, undefined, intervals), piece.name).not.toThrow();
      expect(buildPieceCloth(pattern, piece, undefined, intervals), piece.name).not.toBeNull();
    }
    expect(pattern.pieces.map((piece) => piece.settings3d.arrangement.uDegrees)).toEqual([0, 180, 0, 180]);
    expect(pattern.pieces.map((piece) => piece.settings3d.flipNormals)).toEqual([false, true, false, true]);
  });

  it('does not substitute the sample for a merely similar skirt', () => {
    const changed = structuredClone(source);
    changed.pieces[0].origin![0] += 1;
    const pattern = convertSimplePattern(changed, canonical);

    expect(pattern.points).not.toHaveLength(35);
    expect(pattern.pieces.every((piece) => piece.settings3d.savedPositions.length === 0)).toBe(true);
  });
});
