import { describe, expect, it } from 'vitest';
import { surfaceTopologyExclusions } from './surfaceTopology';

describe('surface contact topology', () => {
  it('records exact paired seam segments and thresholds without exempting remote panel contacts', () => {
    const triangles = new Uint32Array([0, 1, 2, 0, 1, 3, 2, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
    const seams = new Int32Array(40).fill(-1);
    const order = new Int32Array(40).fill(-1);
    seams[0] = 4; seams[16] = 0;
    order[0] = 7; order[16] = 7;
    const packed = surfaceTopologyExclusions(triangles, seams, order, [{ pairs: [0, 4, 1, 5] }]);
    const row = (face: number) => {
      const values: number[][] = [];
      for (let at = packed[face]; at < packed[face + 1]; at += 5) values.push(Array.from(packed.slice(at, at + 5)));
      return values;
    };
    expect(row(0)).toContainEqual([2, 7, 2, 0, 0]);
    expect(row(2)).toContainEqual([0, 7, 2, 0, 0]);
    expect(row(1)).toContainEqual([2, 7, 2, 0, 0]); // One-ring record still requires local contact-distance/closure checks.
    expect(row(2).some(record => record[0] === 3)).toBe(false);
    expect(packed.byteLength).toBeLessThan(256); // Sparse rather than a quadratic GPU buffer.
  });
});
