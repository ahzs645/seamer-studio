import { describe, it, expect } from 'vitest';
import { buildWarp, type MatchPair } from './thinPlateSpline';

describe('thin-plate-spline warp', () => {
  it('0 pairs = identity', () => {
    const w = buildWarp([]);
    expect(w({ x: 12, y: -3 })).toEqual({ x: 12, y: -3 });
  });

  it('1 pair = translation', () => {
    const w = buildWarp([{ src: { x: 10, y: 10 }, dst: { x: 30, y: -5 } }]);
    expect(w({ x: 0, y: 0 })).toEqual({ x: 20, y: -15 });
  });

  it('2 pairs = similarity (rotate 90° + scale 2 here)', () => {
    const w = buildWarp([
      { src: { x: 0, y: 0 }, dst: { x: 0, y: 0 } },
      { src: { x: 10, y: 0 }, dst: { x: 0, y: 20 } }
    ]);
    const p = w({ x: 5, y: 0 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(10, 6);
    const q = w({ x: 0, y: 5 }); // perpendicular rotates too
    expect(q.x).toBeCloseTo(-10, 6);
    expect(q.y).toBeCloseTo(0, 6);
  });

  it('TPS interpolates every control point exactly', () => {
    const pairs: MatchPair[] = [
      { src: { x: 0, y: 0 }, dst: { x: 3, y: -2 } },
      { src: { x: 100, y: 0 }, dst: { x: 104, y: 1 } },
      { src: { x: 100, y: 100 }, dst: { x: 98, y: 103 } },
      { src: { x: 0, y: 100 }, dst: { x: -1, y: 99 } },
      { src: { x: 50, y: 50 }, dst: { x: 53, y: 49 } }
    ];
    const w = buildWarp(pairs);
    for (const { src, dst } of pairs) {
      const p = w(src);
      expect(p.x).toBeCloseTo(dst.x, 3);
      expect(p.y).toBeCloseTo(dst.y, 3);
    }
  });

  it('TPS reproduces an affine map when the pairs are affine', () => {
    // dst = src * 2 + (10, 20)
    const pairs: MatchPair[] = [
      { src: { x: 0, y: 0 }, dst: { x: 10, y: 20 } },
      { src: { x: 100, y: 0 }, dst: { x: 210, y: 20 } },
      { src: { x: 0, y: 100 }, dst: { x: 10, y: 220 } }
    ];
    const w = buildWarp(pairs);
    const p = w({ x: 50, y: 50 }); // any point should follow the affine map
    expect(p.x).toBeCloseTo(110, 3);
    expect(p.y).toBeCloseTo(120, 3);
  });
});
