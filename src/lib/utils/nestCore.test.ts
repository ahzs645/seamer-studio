import { describe, it, expect } from 'vitest';
import { offsetPolygon, simplifyPolyline } from '@atelier/geometry';
import {
  nestItemsWithAtelier,
  polysOverlap,
  type NestItem
} from './markerLayout';
import type { Vec2 } from '@seamer/pattern-model';

const square = (s: number): Vec2[] => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];

// L covering [0,200]² minus the [100,200]×[0,100] notch (marker space, y down).
const ELL: Vec2[] = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 },
  { x: 200, y: 200 }, { x: 0, y: 200 }
];

function item(id: string, poly: Vec2[]): NestItem {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    area += p.x * q.y - q.x * p.y;
  }
  return { pieceId: id, name: id, cut: poly, outline: poly, instanceId: id, area: Math.abs(area) / 2 };
}

const OPTS = { fabricWidthMm: 220, gapMm: 2, rotations: [0] as number[] };

describe('@atelier/geometry nest adapter', () => {
  it('packs squares without overlap and within the fabric', () => {
    const items = Array.from({ length: 6 }, (_, i) => item(`p${i}`, square(100)));
    const layout = nestItemsWithAtelier(items, { ...OPTS, fabricWidthMm: 320 });
    expect(layout.placements).toHaveLength(6);
    for (let i = 0; i < layout.placements.length; i++) {
      for (const p of layout.placements[i].poly) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(320);
      }
      for (let j = i + 1; j < layout.placements.length; j++) {
        expect(polysOverlap(layout.placements[i].poly, layout.placements[j].poly)).toBe(false);
      }
    }
  });

  it('tucks a piece into a concavity that bbox-corner candidates cannot reach', () => {
    const items = [item('L', ELL), item('sq', square(90))];
    const nfp = nestItemsWithAtelier(items, OPTS);
    expect(nfp.placements).toHaveLength(2);
    expect(polysOverlap(nfp.placements[0].poly, nfp.placements[1].poly)).toBe(false);
    // the square fits inside the L's notch -> marker barely longer than the L itself
    expect(nfp.usedLengthMm).toBeLessThan(280);
    const legacyShelfLength = OPTS.gapMm + 200 + OPTS.gapMm + 90 + OPTS.gapMm;
    expect(nfp.usedLengthMm).toBeLessThan(legacyShelfLength);
  });

  it('is deterministic', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`p${i}`, square(60 + i * 10)));
    const a = nestItemsWithAtelier(items, { ...OPTS, fabricWidthMm: 400 });
    const b = nestItemsWithAtelier(items, { ...OPTS, fabricWidthMm: 400 });
    expect(a.usedLengthMm).toBe(b.usedLengthMm);
    expect(a.placements.map((p) => p.instanceId)).toEqual(b.placements.map((p) => p.instanceId));
  });

  it('respects the gap between pieces', () => {
    const items = [item('a', square(50)), item('b', square(50))];
    const layout = nestItemsWithAtelier(items, { ...OPTS, fabricWidthMm: 500, gapMm: 8 });
    const [a, b] = layout.placements.map((p) => p.poly);
    let min = Infinity;
    for (const p of a) for (const q of b) min = Math.min(min, Math.hypot(p.x - q.x, p.y - q.y));
    expect(min).toBeGreaterThanOrEqual(7); // 8mm gap, small miter tolerance
  });
});

describe('multi-bin nesting', () => {
  it('spills overflow pieces onto additional sheets when maxLengthMm is set', () => {
    // four 100×100 squares on a 120-wide fabric capped at 250mm per sheet: 2 fit per sheet
    const items = Array.from({ length: 4 }, (_, i) => item(`p${i}`, square(100)));
    const layout = nestItemsWithAtelier(items, { ...OPTS, fabricWidthMm: 120, gapMm: 5, maxLengthMm: 250 });
    expect(layout.placements).toHaveLength(4);
    expect(layout.bins?.length).toBe(2);
    // every piece sits inside its sheet's band
    for (const pl of layout.placements) {
      const band = layout.bins![pl.bin ?? 0];
      for (const p of pl.poly) {
        expect(p.y).toBeGreaterThanOrEqual(band.startYmm - 1e-6);
        expect(p.y).toBeLessThanOrEqual(band.startYmm + band.usedLengthMm + 1e-6);
      }
    }
    // no overlaps across the whole continuous marker
    for (let i = 0; i < layout.placements.length; i++) {
      for (let j = i + 1; j < layout.placements.length; j++) {
        expect(polysOverlap(layout.placements[i].poly, layout.placements[j].poly)).toBe(false);
      }
    }
  });

  it('without a cap the layout stays single-bin (no bins field)', () => {
    const items = Array.from({ length: 3 }, (_, i) => item(`p${i}`, square(80)));
    const layout = nestItemsWithAtelier(items, { ...OPTS, fabricWidthMm: 300 });
    expect(layout.bins).toBeUndefined();
    expect(layout.placements.every((p) => (p.bin ?? 0) === 0)).toBe(true);
  });
});

describe('geometry helpers', () => {
  it('offsetPoly grows the bounding box by the offset distance', () => {
    const out = offsetPolygon(square(100), 10);
    const xs = out.map((p) => p.x), ys = out.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-10, 5);
    expect(Math.max(...xs)).toBeCloseTo(110, 5);
    expect(Math.min(...ys)).toBeCloseTo(-10, 5);
    expect(Math.max(...ys)).toBeCloseTo(110, 5);
  });

  it('simplifyClosedPoly drops collinear points but keeps corners', () => {
    const dense: Vec2[] = [];
    for (let i = 0; i <= 10; i++) dense.push({ x: i * 10, y: 0 });
    for (let i = 0; i <= 10; i++) dense.push({ x: 100, y: i * 10 });
    for (let i = 10; i >= 0; i--) dense.push({ x: i * 10, y: 100 });
    for (let i = 10; i > 0; i--) dense.push({ x: 0, y: i * 10 });
    const out = simplifyPolyline(dense, 0.5);
    expect(out.length).toBeLessThan(10);
    expect(out.length).toBeGreaterThanOrEqual(4);
  });
});
