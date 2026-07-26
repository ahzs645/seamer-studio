import { describe, it, expect } from 'vitest';
import { simplifyPolyline, simplifyClosed, closeLoops, traceFromHPGL } from './autoTrace';
import type { Vec2 } from './patternGeometry';

const sq = (x0: number, y0: number, s: number): Vec2[] => [
  { x: x0, y: y0 }, { x: x0 + s, y: y0 }, { x: x0 + s, y: y0 + s }, { x: x0, y: y0 + s }, { x: x0, y: y0 }
];

describe('simplifyPolyline (Douglas-Peucker)', () => {
  it('collapses collinear points but keeps endpoints', () => {
    const pts: Vec2[] = Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: 0 }));
    const out = simplifyPolyline(pts, 0.5);
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it('keeps deviations above the tolerance', () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 50, y: 5 }, { x: 100, y: 0 }];
    expect(simplifyPolyline(pts, 1)).toHaveLength(3);
    expect(simplifyPolyline(pts, 10)).toHaveLength(2);
  });

  it('removes small noise within tolerance', () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 25, y: 0.2 }, { x: 50, y: -0.3 }, { x: 75, y: 0.1 }, { x: 100, y: 0 }];
    expect(simplifyPolyline(pts, 1)).toHaveLength(2);
  });
});

describe('simplifyClosed', () => {
  it('reduces a dense square loop to its 4 corners', () => {
    const loop: Vec2[] = [];
    for (let i = 0; i < 20; i++) loop.push({ x: i * 5, y: 0 });
    for (let i = 0; i < 20; i++) loop.push({ x: 100, y: i * 5 });
    for (let i = 0; i < 20; i++) loop.push({ x: 100 - i * 5, y: 100 });
    for (let i = 0; i < 20; i++) loop.push({ x: 0, y: 100 - i * 5 });
    const out = simplifyClosed(loop, 0.5);
    expect(out.length).toBeLessThanOrEqual(5);
    for (const c of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]) {
      expect(out.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < 1e-6)).toBe(true);
    }
  });
});

describe('closeLoops (gap-tolerant loop closing)', () => {
  it('detects an already-closed polyline', () => {
    const loops = closeLoops([sq(0, 0, 100)]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4); // closing duplicate dropped
  });

  it('chains separate segments into one loop, reversing as needed', () => {
    const polys: Vec2[][] = [
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      [{ x: 100, y: 100 }, { x: 100, y: 0 }], // reversed orientation
      [{ x: 100, y: 100 }, { x: 0, y: 100 }],
      [{ x: 0, y: 100 }, { x: 0, y: 0 }]
    ];
    const loops = closeLoops(polys, 0.1);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
  });

  it('closes loops across small gaps but not large ones', () => {
    const open: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 1.5 }];
    expect(closeLoops([open], 2)).toHaveLength(1);
    expect(closeLoops([open], 0.5)).toHaveLength(0);
  });

  it('ignores stray open segments and keeps independent loops separate', () => {
    const loops = closeLoops([sq(0, 0, 50), [{ x: 200, y: 200 }, { x: 300, y: 200 }], sq(100, 0, 30)]);
    expect(loops).toHaveLength(2);
  });
});

describe('traceFromHPGL', () => {
  it('returns the loop containing the click, simplified', () => {
    const dense: Vec2[] = [];
    for (let i = 0; i <= 40; i++) dense.push({ x: i * 2.5, y: 0 });
    for (let i = 1; i <= 40; i++) dense.push({ x: 100, y: i * 2.5 });
    for (let i = 1; i <= 40; i++) dense.push({ x: 100 - i * 2.5, y: 100 });
    for (let i = 1; i <= 40; i++) dense.push({ x: 0, y: 100 - i * 2.5 });
    const out = traceFromHPGL([dense], { x: 50, y: 50 });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(5);
  });

  it('prefers the smallest containing loop (nested outlines)', () => {
    const out = traceFromHPGL([sq(0, 0, 100), sq(25, 25, 50)], { x: 50, y: 50 }, { simplifyToleranceMm: 0 });
    expect(out).not.toBeNull();
    expect(Math.min(...out!.map((p) => p.x))).toBeCloseTo(25, 6);
  });

  it('falls back to the nearest loop boundary when clicking outside, within range', () => {
    const out = traceFromHPGL([sq(0, 0, 50)], { x: 60, y: 25 }, { maxDistanceMm: 20, simplifyToleranceMm: 0 });
    expect(out).not.toBeNull();
    expect(traceFromHPGL([sq(0, 0, 50)], { x: 200, y: 200 }, { maxDistanceMm: 20 })).toBeNull();
  });

  it('returns null when there are no closed loops', () => {
    expect(traceFromHPGL([[{ x: 0, y: 0 }, { x: 100, y: 0 }]], { x: 50, y: 1 })).toBeNull();
  });

  it('closes a nearly-closed outline (pen lifted just short of the start)', () => {
    const nearly: Vec2[] = [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 60 }, { x: 0, y: 60 }, { x: 0, y: 1 }];
    const out = traceFromHPGL([nearly], { x: 40, y: 30 }, { gapToleranceMm: 2 });
    expect(out).not.toBeNull();
  });
});
