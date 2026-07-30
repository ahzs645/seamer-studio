import { describe, expect, it, vi } from 'vitest';
import type { Pattern } from '@seamer/pattern-model';
import pencilSkirt from '../../../../static/templates/pencil-skirt.json';
import { buildPieceCloth, computeSeamEdgeIntervals } from './boundary';
import { buildSimData, type ArrangedPiece } from '../build';

describe('mirrored half-piece seam sampling', () => {
  it('keeps reflected seam runs equal in particle count and rest length', () => {
    const pattern = structuredClone(pencilSkirt) as unknown as Pattern;
    const intervals = computeSeamEdgeIntervals(pattern);
    let compared = 0;

    for (const piece of pattern.pieces) {
      const cloth = buildPieceCloth(pattern, piece, undefined, intervals);
      if (!cloth) continue;
      for (const edge of piece.mainPaths) {
        const original = cloth.edgeParticles.get(edge.id);
        const mirrored = cloth.edgeParticles.get(`${edge.id}#M`);
        if (!original || !mirrored) continue;
        compared++;
        expect(mirrored).toHaveLength(original.length);
        const length = (run: number[]): number => {
          let total = 0;
          for (let index = 1; index < run.length; index++) {
            const from = cloth.mesh.points[run[index - 1]];
            const to = cloth.mesh.points[run[index]];
            total += Math.hypot(to.x - from.x, to.y - from.y);
          }
          return total;
        };
        expect(length(mirrored)).toBeCloseTo(length(original), 6);
      }
    }

    expect(compared).toBeGreaterThan(0);
  });

  it('builds the default template without seam count or length mismatch warnings', () => {
    const pattern = structuredClone(pencilSkirt) as unknown as Pattern;
    const intervals = computeSeamEdgeIntervals(pattern);
    const arranged: ArrangedPiece[] = [];
    for (const piece of pattern.pieces) {
      const cloth = buildPieceCloth(pattern, piece, undefined, intervals);
      if (!cloth) continue;
      const positions3d = new Float32Array(cloth.mesh.points.length * 3);
      cloth.mesh.points.forEach((point, index) => {
        positions3d[index * 3] = point.x / 1000;
        positions3d[index * 3 + 1] = point.y / 1000;
      });
      arranged.push({
        cloth,
        positions3d,
        frozen: false,
        fromSaved: false
      });
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      buildSimData(pattern, arranged);
      const mismatches = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => /Seam (?:particle count|length) mismatch/.test(message));
      expect(mismatches).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
