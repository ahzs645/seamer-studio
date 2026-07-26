import { describe, it, expect } from 'vitest';
import { dxfToPattern } from './patternImport';

/** Build a DXF code/value pair stream from a flat list. */
const dxf = (...pairs: (string | number)[]) => pairs.map(String).join('\n');

const HEADER_INCHES = dxf(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 1, 0, 'ENDSEC');

/** Closed 100×50 rectangle LWPOLYLINE on `layer` with optional color index. */
const rect = (layer: string, color?: number) => dxf(
  0, 'LWPOLYLINE', 8, layer, ...(color !== undefined ? [62, color] : []),
  90, 4, 70, 1,
  10, 0, 20, 0, 10, 100, 20, 0, 10, 100, 20, 50, 10, 0, 20, 50
);

/** Open LINE on `layer` with optional color index. */
const line = (layer: string, color: number | undefined, x1: number, y1: number, x2: number, y2: number) => dxf(
  0, 'LINE', 8, layer, ...(color !== undefined ? [62, color] : []),
  10, x1, 20, y1, 11, x2, 21, y2
);

const entities = (...ents: string[]) => dxf(0, 'SECTION', 2, 'ENTITIES') + '\n' + ents.join('\n') + '\n' + dxf(0, 'ENDSEC', 0, 'EOF');

describe('dxfToPattern (no options — backward compatible)', () => {
  it('closed loop → piece, open line → loose path, coordinates read as mm', () => {
    const p = dxfToPattern(entities(rect('0'), line('0', undefined, 0, 0, 10, 10)));
    expect(p.pieces.length).toBe(1);
    expect(p.pieces[0].mainPaths.length).toBe(4);
    // 4 rect corners + 2 line endpoints
    expect(p.points.length).toBe(6);
    const xs = p.points.map((q) => q.x);
    expect(Math.max(...xs)).toBe(100);
  });

  it('ignores $INSUNITS without options (historic mm behavior)', () => {
    const p = dxfToPattern(HEADER_INCHES + '\n' + entities(rect('0')));
    expect(Math.max(...p.points.map((q) => q.x))).toBe(100);
  });
});

describe('dxfToPattern units override', () => {
  it("'auto' honours $INSUNITS (inches → ×25.4)", () => {
    const p = dxfToPattern(HEADER_INCHES + '\n' + entities(rect('0')), 'u', { unitsOverride: 'auto' });
    expect(Math.max(...p.points.map((q) => q.x))).toBeCloseTo(2540);
  });

  it("'auto' without a header stays mm", () => {
    const p = dxfToPattern(entities(rect('0')), 'u', { unitsOverride: 'auto' });
    expect(Math.max(...p.points.map((q) => q.x))).toBe(100);
  });

  it("'cm' forces ×10 regardless of the header", () => {
    const p = dxfToPattern(HEADER_INCHES + '\n' + entities(rect('0')), 'u', { unitsOverride: 'cm' });
    expect(Math.max(...p.points.map((q) => q.x))).toBeCloseTo(1000);
  });

  it("'inch' forces ×25.4 and scales bulge tangents too", () => {
    // open polyline with a bulge so the imported path carries handles
    const bulged = dxf(0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 0, 20, 0, 42, 1, 10, 10, 20, 0);
    const mm = dxfToPattern(entities(bulged));
    const inch = dxfToPattern(entities(bulged), 'u', { unitsOverride: 'inch' });
    const h = (p: typeof mm) => p.paths[0].pathPoints[0].handle!.v2.x;
    expect(h(inch)).toBeCloseTo(h(mm) * 25.4);
  });
});

describe('dxfToPattern line classification', () => {
  it('color index map overrides everything: seam color → loose path, not a piece', () => {
    const p = dxfToPattern(entities(rect('0', 2)), 'c', { classify: { colorMap: { 2: 'seam' } } });
    expect(p.pieces.length).toBe(0);
    expect(p.paths.length).toBe(1);
    expect(p.paths[0].name).toBe('Seam');
  });

  it('classifies by layer name when no color mapping matches', () => {
    const p = dxfToPattern(entities(rect('cut'), line('seam', undefined, 0, 0, 50, 25)), 'c', { classify: {} });
    expect(p.pieces.length).toBe(1);
    // seam line stays a loose path
    expect(p.paths.some((q) => q.name === 'Seam')).toBe(true);
  });

  it('"Import seam lines" off drops seam entities', () => {
    const p = dxfToPattern(entities(rect('cut'), line('seam', undefined, 0, 0, 50, 25)), 'c', { classify: { importSeam: false } });
    expect(p.pieces.length).toBe(1);
    expect(p.paths.some((q) => q.name === 'Seam')).toBe(false);
  });

  it('"Import cut lines" off drops the piece', () => {
    const p = dxfToPattern(entities(rect('cut')), 'c', { classify: { importCut: false } });
    expect(p.pieces.length).toBe(0);
  });

  it('internal lines inside a cut boundary attach to the piece as internal paths', () => {
    const p = dxfToPattern(entities(rect('cut'), line('internal', undefined, 10, 10, 90, 40)), 'c', { classify: {} });
    expect(p.pieces.length).toBe(1);
    expect(p.pieces[0].internalPaths.length).toBe(1);
    const ip = p.pieces[0].internalPaths[0];
    expect(p.paths.some((q) => q.id === ip.path)).toBe(true);
  });

  it('internal lines outside any piece stay loose', () => {
    const p = dxfToPattern(entities(rect('cut'), line('internal', undefined, 200, 200, 300, 300)), 'c', { classify: {} });
    expect(p.pieces[0].internalPaths.length).toBe(0);
  });

  it('unclassified topology default: closed → cut, open → internal', () => {
    const p = dxfToPattern(entities(rect('whatever'), line('whatever', undefined, 10, 10, 20, 20)), 'c', { classify: { importInternal: false } });
    expect(p.pieces.length).toBe(1); // closed loop kept as cut
    expect(p.paths.length).toBe(4); // only the piece's 4 edges — the open line was dropped
  });
});

describe('dxfToPattern extended entities (ARC/CIRCLE/SPLINE/TEXT/INSERT)', () => {
  const arc = (layer: string) => dxf(0, 'ARC', 8, layer, 10, 0, 20, 0, 40, 50, 50, 0, 51, 90);
  const circle = (layer: string) => dxf(0, 'CIRCLE', 8, layer, 10, 0, 20, 0, 40, 30);
  const splineCtrl = dxf(
    0, 'SPLINE', 8, '0', 70, 0, 71, 3, 73, 4,
    10, 0, 20, 0, 10, 30, 20, 60, 10, 70, 20, 60, 10, 100, 20, 0
  );
  const text = dxf(0, 'TEXT', 8, '0', 10, 12, 20, 34, 40, 8, 50, 45, 1, 'Front panel');

  it('ARC samples an open path from start to end angle', () => {
    const p = dxfToPattern(entities(arc('0')));
    expect(p.paths.length).toBe(1);
    const xs = p.points.map((q) => q.x);
    const ys = p.points.map((q) => q.y);
    expect(Math.max(...xs)).toBeCloseTo(50, 0); // starts at (50,0)
    expect(Math.max(...ys)).toBeCloseTo(50, 0); // ends at (0,50)
  });

  it('CIRCLE imports as a closed loop (a piece)', () => {
    const p = dxfToPattern(entities(circle('0')));
    expect(p.pieces.length).toBe(1);
  });

  it('SPLINE samples a smooth open path through its control hull', () => {
    const p = dxfToPattern(entities(splineCtrl));
    expect(p.paths.length).toBe(1);
    expect(p.points.length).toBeGreaterThan(4); // sampled, not just control points
    const ys = p.points.map((q) => q.y);
    expect(Math.max(...ys)).toBeLessThanOrEqual(60); // stays inside the hull
    expect(Math.max(...ys)).toBeGreaterThan(20); // but bends toward it
  });

  it('TEXT imports as a text annotation', () => {
    const p = dxfToPattern(entities(text));
    expect(p.texts.length).toBe(1);
    expect(p.texts[0].value).toBe('Front panel');
    expect(p.texts[0].x).toBe(12);
    expect(p.texts[0].fontSize).toBe(8);
    expect(p.texts[0].rotation).toBe(45);
  });

  it('INSERT expands a BLOCK transformed by position/scale/rotation; bare definitions don\'t import', () => {
    const blocks = dxf(
      0, 'SECTION', 2, 'BLOCKS',
      0, 'BLOCK', 2, 'SQ',
      0, 'LWPOLYLINE', 8, '0', 90, 4, 70, 1,
      10, 0, 20, 0, 10, 10, 20, 0, 10, 10, 20, 10, 10, 0, 20, 10,
      0, 'ENDBLK',
      0, 'ENDSEC'
    );
    const insert = dxf(0, 'INSERT', 2, 'SQ', 10, 100, 20, 50, 41, 2, 42, 2, 50, 0);
    const p = dxfToPattern(blocks + '\n' + entities(insert));
    expect(p.pieces.length).toBe(1); // exactly one square: the placed instance
    const xs = p.points.map((q) => q.x);
    const ys = p.points.map((q) => q.y);
    expect(Math.min(...xs)).toBeCloseTo(100, 5); // translated
    expect(Math.max(...xs)).toBeCloseTo(120, 5); // 10 × scale 2
    expect(Math.min(...ys)).toBeCloseTo(50, 5);
  });
});
