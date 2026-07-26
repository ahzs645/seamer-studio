import { describe, it, expect } from 'vitest';
import { markerToCutFile } from './cutfile';
import { cutToPattern } from './cutImport';
import { parseHPGL } from './hpgl';
import type { MarkerLayout, Placement } from './markerLayout';
import type { CuttingMachine } from '$lib/stores/machines';

const square = (s: number, dx = 0, dy = 0) =>
  [{ x: dx, y: dy }, { x: dx + s, y: dy }, { x: dx + s, y: dy + s }, { x: dx, y: dy + s }];

function placement(id: string, s: number, dx: number, dy: number): Placement {
  const poly = square(s, dx, dy);
  return { pieceId: id, name: id, poly, outline: poly.map((p) => ({ ...p })), bbox: { w: s, h: s }, instanceId: id };
}

function layoutOf(placements: Placement[], fabricWidthMm = 1000, gapMm = 10): MarkerLayout {
  const maxY = Math.max(...placements.flatMap((p) => p.poly.map((q) => q.y)));
  return { fabricWidthMm, usedLengthMm: maxY + gapMm, gapMm, placements };
}

function machine(over: Partial<CuttingMachine> = {}): CuttingMachine {
  return { id: 'm1', name: 'Test machine', format: 'hpgl', bedWidthMm: 1200, bedLengthMm: 2000, marginMm: 10, ...over };
}

describe('markerToCutFile — CUT round-trip', () => {
  it('generated CUT parses back through cutImport with the same pieces and dimensions', () => {
    const layout = layoutOf([placement('a', 100, 10, 10), placement('b', 80, 150, 10)]);
    const res = markerToCutFile(layout, machine({ format: 'cut' }));
    expect(res.extension).toBe('cut');
    expect(res.files).toHaveLength(1);
    expect(res.warnings).toHaveLength(0);

    const pattern = cutToPattern(res.files[0].text, 'Round trip');
    expect(pattern.pieces).toHaveLength(2);
    // each square contributes 4 unique boundary points
    expect(pattern.points).toHaveLength(8);
    // dimensions survive the mm → 0.254 mm-unit quantisation (±0.3 mm)
    const xs = pattern.points.map((p) => p.x), ys = pattern.points.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(220, 0); // 150+80 − 10, ±margin offsets cancel
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(100, 0);
  });
});

describe('markerToCutFile — HPGL', () => {
  it('contains PU/PD commands and keeps every coordinate inside the bed margin', () => {
    const m = machine({ format: 'hpgl', marginMm: 15 });
    const layout = layoutOf([placement('a', 100, 10, 10)]);
    const res = markerToCutFile(layout, m);
    expect(res.extension).toBe('hpgl');
    const text = res.files[0].text;
    expect(text).toContain('PU');
    expect(text).toContain('PD');
    expect(text).toContain('SP2;'); // cut polygon pen
    for (const poly of parseHPGL(text)) {
      for (const p of poly) {
        expect(p.x).toBeGreaterThanOrEqual(m.marginMm - 0.05);
        expect(p.y).toBeGreaterThanOrEqual(m.marginMm - 0.05);
      }
    }
  });

  it('emits a VS speed command when the machine has a speed', () => {
    const res = markerToCutFile(layoutOf([placement('a', 50, 10, 10)]), machine({ speed: 35 }));
    expect(res.files[0].text).toContain('VS35;');
  });
});

describe('markerToCutFile — bed validation and splitting', () => {
  it('warns when the marker is wider than the usable bed', () => {
    const res = markerToCutFile(layoutOf([placement('a', 100, 10, 10)], 1400), machine({ bedWidthMm: 1200, marginMm: 10 }));
    expect(res.warnings.some((w) => /exceeds bed width/.test(w))).toBe(true);
  });

  it('splits a marker longer than the bed into one file per bed length', () => {
    // bed usable length = 500 − 2×10 = 480; pieces at y=10 and y=600 need two files
    const layout = layoutOf([placement('a', 100, 10, 10), placement('b', 100, 10, 600)]);
    const res = markerToCutFile(layout, machine({ bedLengthMm: 500, marginMm: 10 }));
    expect(res.files).toHaveLength(2);
    expect(res.files[0].partLabel).toBe('part 1 of 2');
    expect(res.warnings.some((w) => /exceeds bed length/.test(w))).toBe(true);
    // each part restarts near the bed origin
    for (const f of res.files) {
      const ys = parseHPGL(f.text).flat().map((p) => p.y);
      expect(Math.max(...ys)).toBeLessThanOrEqual(480 + 20 + 0.05); // usable + margins
    }
  });

  it('warns when a single piece is taller than the bed', () => {
    const layout = layoutOf([placement('a', 600, 10, 10), placement('b', 100, 10, 700)]);
    const res = markerToCutFile(layout, machine({ bedLengthMm: 500, marginMm: 10 }));
    expect(res.warnings.some((w) => /Piece "a".*exceeds bed length/.test(w))).toBe(true);
  });

  it('SVG format produces a valid SVG document', () => {
    const res = markerToCutFile(layoutOf([placement('a', 100, 10, 10)]), machine({ format: 'svg' }));
    expect(res.extension).toBe('svg');
    expect(res.files[0].text).toContain('<svg');
    expect(res.files[0].text).toContain('</svg>');
  });
});

describe('toHPGL extras (pens, line types, labels, drill crosses)', () => {
  it('emits SP pens, LT line types, LB labels with DI rotation, and cross strokes', async () => {
    const { toHPGL } = await import('./hpgl');
    const out = toHPGL(
      [
        { pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }], pen: 2 },
        { pts: [{ x: 0, y: 10 }, { x: 100, y: 10 }], pen: 3, lineType: 2 }
      ],
      {
        texts: [{ text: 'Front', x: 50, y: 5, sizeMm: 8, rotationDeg: 90 }],
        crosses: [{ x: 20, y: 20 }]
      }
    );
    expect(out).toContain('SP2;');
    expect(out).toContain('SP3;');
    expect(out).toContain('LT2;');
    expect(out).toContain('LT;'); // reset to solid before extras
    expect(out).toContain('LBFront\x03;');
    expect(out).toContain('DI0.0000,1.0000;'); // 90° label direction
    // cross = two strokes through (20,20): 17mm→680u .. 23mm→920u
    expect(out).toContain('PU680,800;');
    expect(out).toContain('PD920,800;');
  });
});
