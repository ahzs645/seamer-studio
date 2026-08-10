/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Pattern } from '@seamer/pattern-model';
import { assertPatternBuildable3d } from '$lib/utils/importSimplePattern';
import { referenceSspTemplates } from './referenceSspTemplates';

function readBundledPattern(file: string): Pattern {
  const url = new URL(`../../../static/templates/${file}`, import.meta.url);
  const bytes = readFileSync(url);
  expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
  return JSON.parse(gunzipSync(bytes).toString('utf8')) as Pattern;
}

describe('reference SSP sample library', () => {
  it('catalogs all 21 complete projects with unique keys and files', () => {
    expect(referenceSspTemplates).toHaveLength(21);
    expect(new Set(referenceSspTemplates.map(({ key }) => key)).size).toBe(21);
    expect(new Set(referenceSspTemplates.map(({ file }) => file)).size).toBe(21);
  });

  it.each(referenceSspTemplates)('$name loads as a complete native SSP', (template) => {
    const pattern = readBundledPattern(template.file);
    // Saved drapes store five values per vertex (XYZ position + UV).
    const cached3dVertices = pattern.pieces.reduce(
      (count, piece) => count + (piece.settings3d.savedPositions?.length ?? 0) / 5,
      0
    );

    expect(pattern.name.trim()).toBe(template.sourceName);
    expect(pattern.pieces).toHaveLength(template.pieces);
    expect(pattern.seams).toHaveLength(template.seams);
    expect(pattern.materials).toHaveLength(template.materials);
    expect(cached3dVertices).toBe(template.cached3dVertices);
    expect(pattern.enable3d !== false).toBe(template.dimension === '3D');

    if (template.dimension === '3D') {
      expect(() => assertPatternBuildable3d(pattern)).not.toThrow();
    }
  });
});
