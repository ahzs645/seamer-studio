/// <reference types="node" />

import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pattern } from '@seamer/pattern-model';

const DEFAULT_PENCIL_SKIRT_SSP = new URL(
  '../../../static/templates/pencil-skirt.seamer.ssp',
  import.meta.url
);

describe('default Pencil Skirt SSP', () => {
  it('bundles the source-faithful native project without a phantom saved drape', () => {
    const bytes = readFileSync(DEFAULT_PENCIL_SKIRT_SSP);
    expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);

    const pattern = JSON.parse(gunzipSync(bytes).toString('utf8')) as Pattern;
    expect(pattern.name).toBe('Pencil skirt - 3D');
    expect(pattern.pieces).toHaveLength(4);
    expect(pattern.seams).toHaveLength(12);
    expect(pattern.materials).toHaveLength(2);
    expect(pattern.pieces.reduce(
      (count, piece) => count + (piece.settings3d.savedPositions?.length ?? 0),
      0
    )).toBe(0);
  });
});
