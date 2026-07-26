import { describe, it, expect } from 'vitest';
import { buildPdf, polylinesToPDF, tilePageCount, PAGE_SIZES_MM, type MmPoly } from './pdf';
import { toHPGL } from './hpgl';
import { patternToSVG2 } from './exporters';
import { dxfToPattern } from './patternImport';

const decode = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };

describe('PDF writer', () => {
  it('produces a structurally valid single-page PDF', () => {
    const pdf = buildPdf([{ widthPt: 200, heightPt: 200, strokes: [{ pts: [{ x: 10, y: 10 }, { x: 100, y: 100 }], closed: false, style: {} }], texts: [] }]);
    const s = decode(pdf);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s).toContain('/Type /Catalog');
    expect(s).toContain('/Type /Pages');
    expect(s).toContain('/Type /Page');
    expect(s).toContain('startxref');
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('xref offsets point at real "N 0 obj" positions', () => {
    const pdf = buildPdf([{ widthPt: 100, heightPt: 100, strokes: [], texts: [{ x: 10, y: 10, size: 12, text: 'hi' }] }]);
    const s = decode(pdf);
    const xrefIdx = s.indexOf('xref\n');
    const startxref = parseInt(s.slice(s.lastIndexOf('startxref') + 'startxref'.length).trim(), 10);
    expect(startxref).toBe(xrefIdx);
    // parse the offset rows and verify each points at "<n> 0 obj"
    const rows = s.slice(xrefIdx).split('\n').filter((l) => / 00000 n/.test(l));
    rows.forEach((row, i) => {
      const off = parseInt(row.slice(0, 10), 10);
      expect(s.startsWith(`${i + 1} 0 obj`, off)).toBe(true);
    });
  });

  it('tiles content across multiple pages when it exceeds one page', () => {
    // a 1000mm-wide line on A4 portrait (210mm) must span several pages
    const polys: MmPoly[] = [{ pts: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], closed: false, style: {} }];
    const pdf = polylinesToPDF(polys, [], { page: 'A4', tile: true, marginMm: 10 });
    const s = decode(pdf);
    const pageCount = (s.match(/\/Type \/Page[^s]/g) || []).length;
    expect(pageCount).toBeGreaterThan(1);
  });

  it('fits to a single page when tiling is off', () => {
    const polys: MmPoly[] = [{ pts: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], closed: false, style: {} }];
    const pdf = polylinesToPDF(polys, [], { page: 'A4', tile: false });
    const s = decode(pdf);
    expect((s.match(/\/Type \/Page[^s]/g) || []).length).toBe(1);
  });

  it('A0 is larger than A4', () => {
    expect(PAGE_SIZES_MM.A0[0] * PAGE_SIZES_MM.A0[1]).toBeGreaterThan(PAGE_SIZES_MM.A4[0] * PAGE_SIZES_MM.A4[1]);
  });
});

describe('tilePageCount', () => {
  it('matches the tiled PDF page count', () => {
    const polys: MmPoly[] = [{ pts: [{ x: 0, y: 0 }, { x: 1000, y: 600 }], closed: false, style: {} }];
    const s = decode(polylinesToPDF(polys, [], { page: 'A4', tile: true, marginMm: 10 }));
    const pages = (s.match(/\/Type \/Page[^s]/g) || []).length;
    expect(tilePageCount(1000, 600, { pageWmm: 210, pageHmm: 297, marginMm: 10 }).total).toBe(pages);
  });
  it('small content needs one page; overlap increases the count', () => {
    expect(tilePageCount(100, 100, { pageWmm: 210, pageHmm: 297, marginMm: 10 }).total).toBe(1);
    const noOv = tilePageCount(1000, 100, { pageWmm: 210, pageHmm: 297, marginMm: 10 });
    const ov = tilePageCount(1000, 100, { pageWmm: 210, pageHmm: 297, marginMm: 10, overlapMm: 50 });
    expect(ov.total).toBeGreaterThan(noOv.total);
  });
});

describe('PDF scale option', () => {
  it('scale 0.5 halves the tiled page count of wide content', () => {
    const polys: MmPoly[] = [{ pts: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], closed: false, style: {} }];
    const full = (decode(polylinesToPDF(polys, [], { page: 'A4', tile: true })).match(/\/Type \/Page[^s]/g) || []).length;
    const half = (decode(polylinesToPDF(polys, [], { page: 'A4', tile: true, scale: 0.5 })).match(/\/Type \/Page[^s]/g) || []).length;
    expect(half).toBeLessThan(full);
  });
});

// a 100×50mm closed rect (→ piece) with one internal line inside it, via the DXF importer
function svg2Fixture() {
  const dxf = [
    0, 'SECTION', 2, 'ENTITIES',
    0, 'LWPOLYLINE', 8, 'cut', 90, 4, 70, 1, 10, 0, 20, 0, 10, 100, 20, 0, 10, 100, 20, 50, 10, 0, 20, 50,
    0, 'LINE', 8, 'internal', 10, 10, 20, 10, 11, 90, 21, 40,
    0, 'ENDSEC', 0, 'EOF'
  ].join('\n');
  const p = dxfToPattern(dxf, 'svg2 fixture', { classify: {} });
  p.seamAllowance = 10;
  return p;
}

describe('patternToSVG2 (Beta)', () => {
  const svg = patternToSVG2(svg2Fixture());

  it('uses real-world mm units with a matching viewBox', () => {
    expect(svg).toMatch(/<svg [^>]*width="[\d.]+mm" height="[\d.]+mm" viewBox="0 0 [\d.]+ [\d.]+"/);
    const m = svg.match(/width="([\d.]+)mm".*viewBox="0 0 ([\d.]+)/s)!;
    expect(parseFloat(m[1])).toBeCloseTo(parseFloat(m[2]));
  });

  it('emits one <g> per piece with id and data-name', () => {
    expect(svg).toMatch(/<g id="Piece_[^"]+" data-name="Piece 1">/);
  });

  it('has cut / seam / internal / labels sub-groups', () => {
    for (const cls of ['cut', 'seam', 'internal', 'labels']) {
      expect(svg).toContain(`<g class="${cls}">`);
    }
  });

  it('cut layer is the seam-allowance outline (larger than the stitch outline)', () => {
    const grab = (cls: string) => {
      const g = svg.match(new RegExp(`<g class="${cls}">([\\s\\S]*?)</g>`))![1];
      const nums = [...g.matchAll(/[ML]([\d.]+),/g)].map((m) => parseFloat(m[1]));
      return { min: Math.min(...nums), max: Math.max(...nums) };
    };
    const cut = grab('cut'), seam = grab('seam');
    expect(cut.max - cut.min).toBeGreaterThan(seam.max - seam.min);
  });

  it('labels the piece by name', () => {
    expect(svg).toContain('>Piece 1</text>');
  });

  it('omits the seam group when the pattern has no allowance', () => {
    const p = svg2Fixture();
    p.seamAllowance = 0;
    const s = patternToSVG2(p);
    expect(s).toContain('<g class="cut">');
    expect(s).not.toContain('<g class="seam">');
  });
});

describe('HPGL writer', () => {
  it('emits IN/SP/PU/PD program in plotter units (40/mm)', () => {
    const hpgl = toHPGL([{ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, pen: 2 }]);
    expect(hpgl).toContain('IN;');
    expect(hpgl).toContain('SP2;');
    expect(hpgl).toContain('PU0,0;');
    // 10mm = 400 plotter units; closed → returns to start (0,0)
    expect(hpgl).toContain('PD400,0,400,400,0,0;');
    expect(hpgl.trim().endsWith('IN;')).toBe(true);
  });
  it('skips degenerate polylines', () => {
    const hpgl = toHPGL([{ pts: [{ x: 0, y: 0 }] }]);
    expect(hpgl).not.toContain('PD');
  });
});
