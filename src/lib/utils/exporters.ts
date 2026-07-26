// 2D pattern exporters: SVG, DXF (R12 LWPOLYLINE), CSV. All in millimetres.
// Geometry is taken from the placed (world) piece outlines + internal paths.

import type { Pattern } from '@seamer/pattern-model';
import {
  polylinesToHPGL,
  polylinesToPDF,
  tilePageCount,
  toDXF,
  toSVG,
  type Drawing,
  type MmPoly,
  type MmText,
  type PdfLayoutOpts,
  type PdfStroke
} from '@atelier/io';
export { downloadBlob, downloadText } from '@atelier/io/browser';
export { toGLTF as sceneToGLTF } from '@atelier/io/three';
import {
  indexPaths, indexPoints, pieceWorldOutline, pieceWorldInternalPolylines, pieceAllowancePolygon, pieceTransform, pieceShrinkageScale, polygonCentroid, type Vec2
} from '@seamer/pattern-model';

export type Layer = 'pattern' | 'seam-allowance' | 'internal' | 'marker';
export interface Poly { pts: Vec2[]; closed: boolean; layer: Layer }

export function collectPolylines(pattern: Pattern): Poly[] {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const out: Poly[] = [];
  for (const piece of pattern.pieces) {
    const outline = pieceWorldOutline(pattern, piece, paths, points, 2);
    if (outline.length >= 2) {
      out.push({ pts: outline, closed: true, layer: 'pattern' });
      // seam allowance: the cut line, offset from the stitch outline (per-piece width + corner joins)
      const sa = piece.seamAllowance ?? pattern.seamAllowance ?? 0;
      if (sa > 0.05 && outline.length >= 3) {
        const allow = pieceAllowancePolygon(pattern, piece, piece.seamAllowanceInside ? -sa : sa, paths, points, 2);
        if (allow.length >= 3) out.push({ pts: allow, closed: true, layer: 'seam-allowance' });
      }
    }
    for (const ip of pieceWorldInternalPolylines(pattern, piece, paths, points, 2)) {
      if (ip.length >= 2) out.push({ pts: ip, closed: false, layer: 'internal' });
    }
    // drill holes / punch markers → small circle (drill) or cross (punch)
    if (piece.markers?.length) {
      const tf = pieceTransform(piece, points, pieceShrinkageScale(pattern, piece));
      for (const m of piece.markers) {
        const w = tf({ x: m.x, y: m.y });
        if (m.type === 'drill') {
          const r = 2.5; const circle: Vec2[] = [];
          for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI * 2; circle.push({ x: w.x + Math.cos(a) * r, y: w.y + Math.sin(a) * r }); }
          out.push({ pts: circle, closed: true, layer: 'marker' });
        } else {
          out.push({ pts: [{ x: w.x - 2, y: w.y - 2 }, { x: w.x + 2, y: w.y + 2 }], closed: false, layer: 'marker' });
          out.push({ pts: [{ x: w.x - 2, y: w.y + 2 }, { x: w.x + 2, y: w.y - 2 }], closed: false, layer: 'marker' });
        }
      }
    }
  }
  return out;
}

function bounds(polys: Poly[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const v of p.pts) {
    minX = Math.min(minX, v.x); minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y);
  }
  if (!isFinite(minX)) { minX = minY = 0; maxX = maxY = 100; }
  return { minX, minY, maxX, maxY };
}

/** Bounding box (mm) of the placed pattern geometry — used by the print dialog's page-count preview. */
export function patternBoundsMm(pattern: Pattern): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  const b = bounds(collectPolylines(pattern));
  return { ...b, width: b.maxX - b.minX, height: b.maxY - b.minY };
}

/** Flatten the parametric Pattern domain into Atelier's neutral millimetre Drawing. */
export function patternToDrawing(pattern: Pattern): Drawing {
  const polys = collectPolylines(pattern);
  const b = bounds(polys);
  return {
    layers: [
      { id: 'pattern', name: 'Pattern', style: { color: '#000000', width: 0.5 } },
      { id: 'seam-allowance', name: 'Seam allowance', style: { color: '#888888', width: 0.4, dashed: true } },
      { id: 'internal', name: 'Internal', style: { color: '#444444', width: 0.35, dashed: true } },
      { id: 'marker', name: 'Marker', style: { color: '#c0392b', width: 0.4 } },
      { id: 'text', name: 'Text', style: { color: '#000000', width: 0.35 } }
    ],
    polys: polys.map((poly) => ({ pts: poly.pts, closed: poly.closed, layer: poly.layer })),
    texts: (pattern.texts ?? []).filter((text) => text.value).map((text) => ({
      text: text.value,
      at: { x: text.x, y: text.y },
      sizeMm: text.fontSize ?? 15,
      rotationDeg: text.rotation,
      layer: 'text'
    })),
    boundsMm: b
  };
}

export function patternToSVG(pattern: Pattern): string {
  return toSVG(patternToDrawing(pattern));
}

/**
 * "SVG 2 (Beta)": structured SVG export. One `<g>` per piece (id + data-name), with separate
 * cut / seam / internal / labels sub-groups (classed) so downstream tools can toggle layers.
 * Real-world units: width/height in mm with a matching 1-unit-per-mm viewBox. The `cut` layer is
 * the seam-allowance outline when the piece has an allowance, otherwise the stitch outline; the
 * `seam` layer is always the stitch outline.
 */
export function patternToSVG2(pattern: Pattern): string {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const polys = collectPolylines(pattern);
  const b = bounds(polys);
  const pad = 20;
  const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
  // SVG y is down; pattern y is up → flip y about maxY
  const X = (x: number) => (x - b.minX + pad).toFixed(2);
  const Y = (y: number) => (b.maxY - y + pad).toFixed(2);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const d = (pts: Vec2[], closed: boolean) => pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(v.x)},${Y(v.y)}`).join(' ') + (closed ? ' Z' : '');
  const pathEl = (pts: Vec2[], closed: boolean) => `      <path d="${d(pts, closed)}" fill="none"/>`;
  const layerGroup = (cls: string, els: string[]) => (els.length ? `    <g class="${cls}">\n${els.join('\n')}\n    </g>` : '');

  const STYLE = `  <style>
    .cut path { stroke: #000; stroke-width: 0.5; }
    .seam path { stroke: #888; stroke-width: 0.4; stroke-dasharray: 3,2; }
    .internal path { stroke: #444; stroke-width: 0.35; stroke-dasharray: 2,2; }
    .labels text { fill: #000; font-family: sans-serif; }
  </style>`;

  const groups: string[] = [];
  for (const piece of pattern.pieces) {
    const outline = pieceWorldOutline(pattern, piece, paths, points, 2);
    if (outline.length < 2) continue;
    const sa = piece.seamAllowance ?? pattern.seamAllowance ?? 0;
    let allow: Vec2[] = [];
    if (sa > 0.05 && outline.length >= 3) {
      allow = pieceAllowancePolygon(pattern, piece, piece.seamAllowanceInside ? -sa : sa, paths, points, 2);
    }
    const cut = [pathEl(allow.length >= 3 ? allow : outline, true)];
    const seam = allow.length >= 3 ? [pathEl(outline, true)] : [];
    const internal = pieceWorldInternalPolylines(pattern, piece, paths, points, 2)
      .filter((ip) => ip.length >= 2)
      .map((ip) => pathEl(ip, false));
    const cx = outline.reduce((s, v) => s + v.x, 0) / outline.length;
    const cy = outline.reduce((s, v) => s + v.y, 0) / outline.length;
    const labels = [`      <text x="${X(cx)}" y="${Y(cy)}" font-size="8" text-anchor="middle" dominant-baseline="middle">${esc(piece.name)}</text>`];
    const layers = [layerGroup('cut', cut), layerGroup('seam', seam), layerGroup('internal', internal), layerGroup('labels', labels)].filter(Boolean);
    groups.push(`  <g id="${esc(piece.id)}" data-name="${esc(piece.name)}">\n${layers.join('\n')}\n  </g>`);
  }

  // pattern-level text annotations as a top-level labels layer
  const texts = (pattern.texts ?? []).filter((t) => t.value).map((t) => {
    const anchor = t.align === 'left' ? 'start' : t.align === 'right' ? 'end' : 'middle';
    const rot = t.rotation ? ` transform="rotate(${(-t.rotation).toFixed(2)} ${X(t.x)} ${Y(t.y)})"` : '';
    return `    <text x="${X(t.x)}" y="${Y(t.y)}" font-size="${(t.fontSize ?? 15).toFixed(1)}" fill="${t.color ?? '#000'}" text-anchor="${anchor}" dominant-baseline="middle"${rot}>${esc(t.value)}</text>`;
  });
  if (texts.length) groups.push(`  <g class="labels">\n${texts.join('\n')}\n  </g>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}mm" height="${h.toFixed(1)}mm" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}">
${STYLE}
${groups.join('\n')}
</svg>`;
}

export function patternToDXF(pattern: Pattern): string {
  const drawing = patternToDrawing(pattern);
  // The previous DXF surface exported geometry only; keep text out so existing CAD output is stable.
  return toDXF({ ...drawing, texts: [] });
}

// --- Vector PDF (tiled, true-scale) ------------------------------------------

const PDF_LAYER_STYLE: Record<Layer, PdfStroke> = {
  'pattern': { color: [0, 0, 0], width: 0.6 },
  'seam-allowance': { color: [0.53, 0.53, 0.53], width: 0.4, dash: [3, 2] },
  'internal': { color: [0.27, 0.27, 0.27], width: 0.4, dash: [2, 2] },
  'marker': { color: [0.75, 0.22, 0.17], width: 0.4 }
};

function hexToRgb(hex?: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

const pdfBlob = (bytes: Uint8Array): Blob => new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });

/** Pattern → multi-page vector PDF Blob at true mm scale (tiled across the chosen page size). */
export async function patternToPDF(pattern: Pattern, opts: PdfLayoutOpts = {}): Promise<Blob> {
  const drawing = patternToDrawing(pattern);
  const polys = drawing.polys.map((poly) => ({
    pts: poly.pts,
    closed: poly.closed,
    style: PDF_LAYER_STYLE[poly.layer as Layer]
  }));
  const texts = (pattern.texts ?? []).filter((t) => t.value).map((t) => ({
    x: t.x, y: t.y, sizeMm: t.fontSize ?? 15, text: t.value,
    color: hexToRgb(t.color), anchor: (t.align === 'left' ? 'start' : t.align === 'right' ? 'end' : 'middle') as 'start' | 'middle' | 'end',
    rotation: t.rotation ?? 0
  }));
  return pdfBlob(polylinesToPDF(polys, texts, { title: pattern.name || 'Pattern', ...opts }));
}

/** Nested marker layout → multi-page vector PDF Blob (cut polygons dashed, stitch outlines solid). */
export async function markerToPDF(
  layout: { placements: { name: string; poly: Vec2[]; outline: Vec2[] }[]; fabricWidthMm: number; usedLengthMm: number },
  opts: PdfLayoutOpts = {}
): Promise<Blob> {
  const polys: MmPoly[] = [];
  const texts: MmText[] = [];
  // marker space has y down; flip to y-up mm for the PDF (about usedLength)
  const flip = (p: Vec2): Vec2 => ({ x: p.x, y: layout.usedLengthMm - p.y });
  for (const pl of layout.placements) {
    polys.push({ pts: pl.poly.map(flip), closed: true, style: PDF_LAYER_STYLE['seam-allowance'] });
    polys.push({ pts: pl.outline.map(flip), closed: true, style: PDF_LAYER_STYLE['pattern'] });
    const cx = pl.poly.reduce((s, p) => s + p.x, 0) / (pl.poly.length || 1);
    const cy = pl.poly.reduce((s, p) => s + p.y, 0) / (pl.poly.length || 1);
    texts.push({ ...flip({ x: cx, y: cy }), sizeMm: 8, text: pl.name, anchor: 'middle' });
  }
  // fabric edge
  polys.push({ pts: [{ x: 0, y: 0 }, { x: layout.fabricWidthMm, y: 0 }, { x: layout.fabricWidthMm, y: layout.usedLengthMm }, { x: 0, y: layout.usedLengthMm }], closed: true, style: { color: [0.05, 0.65, 0.91], width: 0.6 } });
  return pdfBlob(polylinesToPDF(polys, texts, { title: 'Marker', ...opts }));
}

// --- HPGL (plotter) ----------------------------------------------------------
const HPGL_PEN: Record<Layer, number> = { 'pattern': 1, 'seam-allowance': 2, 'internal': 3, 'marker': 4 };

/** Pattern → HPGL plotter program (pen 1 stitch line, 2 cut line, 3 internal dashed, 4 markers),
 *  with drill-hole crosses and piece-name labels written into the file (pens 5). */
export async function patternToHPGL(pattern: Pattern): Promise<string> {
  const drawing = patternToDrawing(pattern);
  const polys = drawing.polys.map((poly) => ({
    pts: poly.pts,
    closed: poly.closed,
    pen: HPGL_PEN[poly.layer as Layer],
    lineType: poly.layer === 'internal' ? 2 : undefined
  }));
  const points = indexPoints(pattern);
  const crosses: { x: number; y: number }[] = [];
  const texts: { text: string; x: number; y: number; sizeMm: number; rotationDeg?: number }[] = [];
  const paths = indexPaths(pattern);
  for (const piece of pattern.pieces) {
    if (piece.hidden) continue;
    const tf = pieceTransform(piece, points, pieceShrinkageScale(pattern, piece));
    for (const m of piece.markers ?? []) crosses.push(tf({ x: m.x, y: m.y }));
    const outline = pieceWorldOutline(pattern, piece, paths, points, 6);
    if (outline.length >= 3) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of outline) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
      const c = polygonCentroid(outline);
      texts.push({
        text: piece.name, x: c.x, y: c.y,
        sizeMm: Math.max(4, Math.min(12, Math.min(maxX - minX, maxY - minY) * 0.08)),
        rotationDeg: maxY - minY > maxX - minX ? 90 : 0 // tall piece → rotate the label upright
      });
    }
  }
  return polylinesToHPGL(polys, { crosses, texts });
}

/** Nested marker → HPGL (cut polygons on pen 2, stitch outlines on pen 1, labels on pen 5). */
export async function markerToHPGL(layout: { placements: { name?: string; poly: Vec2[]; outline: Vec2[] }[]; usedLengthMm: number }): Promise<string> {
  const flip = (p: Vec2): Vec2 => ({ x: p.x, y: layout.usedLengthMm - p.y });
  const polys: { pts: Vec2[]; closed: boolean; pen: number }[] = [];
  const texts: { text: string; x: number; y: number; sizeMm: number; rotationDeg?: number }[] = [];
  for (const pl of layout.placements) {
    polys.push({ pts: pl.poly.map(flip), closed: true, pen: 2 });
    polys.push({ pts: pl.outline.map(flip), closed: true, pen: 1 });
    if (pl.name) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pl.poly) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
      const c = flip({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
      texts.push({
        text: pl.name, x: c.x, y: c.y,
        sizeMm: Math.max(4, Math.min(12, Math.min(maxX - minX, maxY - minY) * 0.08)),
        rotationDeg: maxY - minY > maxX - minX ? 90 : 0
      });
    }
  }
  return polylinesToHPGL(polys, { texts });
}

// --- .ssp compressed project (the original's toCompressed) --------------------

/** Whole pattern → gzip-compressed JSON blob (.ssp). */
export async function patternToSSP(pattern: Pattern): Promise<Blob> {
  const stream = new Blob([JSON.stringify(pattern)]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(stream).blob();
}

/** .ssp blob → Pattern (gzip-decompressed JSON). */
export async function sspToPattern(blob: Blob): Promise<Pattern> {
  const text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text) as Pattern;
}

export function patternToCSV(pattern: Pattern): string {
  // @atelier/io.toCSV intentionally exports neutral Drawing vertices. This legacy CSV is the
  // named construction-point table and therefore still requires Pattern identity.
  const rows = ['point,x_mm,y_mm'];
  for (const p of pattern.points) rows.push(`${JSON.stringify(p.name)},${p.x.toFixed(3)},${p.y.toFixed(3)}`);
  return rows.join('\n');
}

/**
 * Pattern → raster PNG (Blob) of the flat plan: light-filled piece outlines + dashed internals,
 * scaled to fit `maxPx` on the long edge. Resolves null if the pattern has no geometry.
 */
export function patternToPNG(pattern: Pattern, maxPx = 2000, marginPx = 40): Promise<Blob | null> {
  // The engine rasterizer is stroke-only. Keep the studio's piece fill until Drawing gains fill
  // styles; dropping it makes nested/overlapping pattern pieces materially harder to read.
  const polys = collectPolylines(pattern);
  if (polys.length === 0) return Promise.resolve(null);
  const b = bounds(polys);
  const wMm = b.maxX - b.minX || 1;
  const hMm = b.maxY - b.minY || 1;
  const scale = (maxPx - marginPx * 2) / Math.max(wMm, hMm);
  const W = Math.ceil(wMm * scale + marginPx * 2);
  const H = Math.ceil(hMm * scale + marginPx * 2);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  if (!c) return Promise.resolve(null);
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, W, H);
  // pattern y is up; canvas y is down → flip about maxY
  const tx = (v: Vec2) => ({ x: (v.x - b.minX) * scale + marginPx, y: (b.maxY - v.y) * scale + marginPx });
  const trace = (pts: Vec2[]) => {
    c.beginPath();
    const a = tx(pts[0]); c.moveTo(a.x, a.y);
    for (let i = 1; i < pts.length; i++) { const q = tx(pts[i]); c.lineTo(q.x, q.y); }
  };
  for (const p of polys) {
    if (!p.closed) continue;
    trace(p.pts); c.closePath();
    c.fillStyle = 'rgba(148,163,184,0.15)'; c.fill();
    c.strokeStyle = '#1e293b'; c.lineWidth = 2; c.setLineDash([]); c.stroke();
  }
  c.strokeStyle = 'rgba(30,41,59,0.6)'; c.lineWidth = 1.5; c.setLineDash([6, 4]);
  for (const p of polys) { if (p.closed) continue; trace(p.pts); c.stroke(); }
  c.setLineDash([]);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

// --- Tiled multi-page print (true scale, assembly tiling) ------------------------------------
export interface TileOpts {
  pageWmm?: number; // 210 = A4 portrait, 216 = Letter
  pageHmm?: number; // 297 = A4, 279 = Letter
  marginMm?: number;
  overlapMm?: number; // shared band between adjacent tiles for gluing
  /** output scale factor (1 = true scale) */
  scale?: number;
  title?: string;
}

/** Default tiled-print overlap (mm) — the glue band shared between adjacent pages. */
export const TILE_OVERLAP_MM = 6;
interface TileItem { pts: Vec2[]; closed: boolean; dashed: boolean }

/** Build a printable multi-page HTML where the content is tiled at 1:1 scale across pages. */
function tiledPagesHTML(items: TileItem[], b: { minX: number; minY: number; maxX: number; maxY: number }, yUp: boolean, opts: TileOpts): string {
  const pageW = opts.pageWmm ?? 210, pageH = opts.pageHmm ?? 297;
  const margin = opts.marginMm ?? 8, overlap = opts.overlapMm ?? TILE_OVERLAP_MM;
  const pw = pageW - margin * 2, ph = pageH - margin * 2;
  const { cols, rows } = tilePageCount(Math.max(1, b.maxX - b.minX), Math.max(1, b.maxY - b.minY), { pageWmm: pageW, pageHmm: pageH, marginMm: margin, overlapMm: overlap });
  const strideX = Math.max(10, pw - overlap), strideY = Math.max(10, ph - overlap);

  const pages: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const xStart = b.minX + c * strideX;
      const yTop = yUp ? b.maxY - r * strideY : b.minY + r * strideY;
      const px = (x: number) => margin + (x - xStart);
      const py = (y: number) => margin + (yUp ? yTop - y : y - yTop);
      const paths = items.map((it) => {
        const d = it.pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(v.x).toFixed(2)},${py(v.y).toFixed(2)}`).join(' ') + (it.closed ? ' Z' : '');
        const dash = it.dashed ? ' stroke-dasharray="3,2"' : '';
        return `<path d="${d}" fill="none" stroke="#000" stroke-width="0.4"${dash}/>`;
      }).join('');
      // printable border, corner ticks, overlap seam guides, page label
      const more = (c < cols - 1) || (r < rows - 1) || c > 0 || r > 0;
      const seamGuides =
        (c < cols - 1 ? `<line x1="${(margin + pw).toFixed(1)}" y1="${margin}" x2="${(margin + pw).toFixed(1)}" y2="${(margin + ph).toFixed(1)}" stroke="#0ea5e9" stroke-width="0.3" stroke-dasharray="2,2"/>` : '') +
        (r < rows - 1 ? `<line x1="${margin}" y1="${(margin + ph).toFixed(1)}" x2="${(margin + pw).toFixed(1)}" y2="${(margin + ph).toFixed(1)}" stroke="#0ea5e9" stroke-width="0.3" stroke-dasharray="2,2"/>` : '');
      const tick = (x: number, y: number) => `<path d="M${x - 3},${y} L${x + 3},${y} M${x},${y - 3} L${x},${y + 3}" stroke="#000" stroke-width="0.3"/>`;
      const ticks = tick(margin, margin) + tick(margin + pw, margin) + tick(margin, margin + ph) + tick(margin + pw, margin + ph);
      const label = `<text x="${(margin + 2).toFixed(1)}" y="${(margin + 5).toFixed(1)}" font-size="4" fill="#94a3b8">R${r + 1}·C${c + 1} of ${rows}×${cols}${more ? '' : ''}</text>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}mm" height="${pageH}mm" viewBox="0 0 ${pageW} ${pageH}">` +
        `<rect x="${margin}" y="${margin}" width="${pw}" height="${ph}" fill="none" stroke="#cbd5e1" stroke-width="0.2"/>` +
        `<clipPath id="clip"><rect x="${margin}" y="${margin}" width="${pw}" height="${ph}"/></clipPath>` +
        `<g clip-path="url(#clip)">${paths}</g>${seamGuides}${ticks}${label}</svg>`;
      pages.push(`<div class="page">${svg}</div>`);
    }
  }
  return `<!doctype html><html><head><title>${opts.title ?? 'Tiled pattern'}</title>` +
    `<style>@page{size:${pageW}mm ${pageH}mm;margin:0}body{margin:0}` +
    `.page{width:${pageW}mm;height:${pageH}mm;page-break-after:always;overflow:hidden}` +
    `.page:last-child{page-break-after:auto}svg{display:block}</style></head><body>` +
    pages.join('') +
    `<script>window.onload=function(){window.focus();window.print();}<\/script></body></html>`;
}

function openPrintDoc(html: string) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(html);
  w.document.close();
}

/** Tiled multi-page print of the flat pattern (1:1 by default; `opts.scale` rescales the output). */
export function printPatternTiled(pattern: Pattern, opts: TileOpts = {}) {
  let polys = collectPolylines(pattern);
  if (!polys.length) return;
  const sc = opts.scale ?? 1;
  if (sc !== 1) polys = polys.map((p) => ({ ...p, pts: p.pts.map((v) => ({ x: v.x * sc, y: v.y * sc })) }));
  const b = bounds(polys);
  const items: TileItem[] = polys.map((p) => ({ pts: p.pts, closed: p.closed, dashed: p.layer !== 'pattern' }));
  openPrintDoc(tiledPagesHTML(items, b, true, { ...opts, title: opts.title ?? 'Pattern (tiled)' }));
}

/** Tiled multi-page print of a nested cutting marker at true scale. */
export function printMarkerTiled(layout: { placements: { poly: Vec2[]; outline: Vec2[] }[]; fabricWidthMm: number; usedLengthMm: number }, opts: TileOpts = {}) {
  const items: TileItem[] = [];
  for (const pl of layout.placements) {
    items.push({ pts: pl.poly, closed: true, dashed: true });
    items.push({ pts: pl.outline, closed: true, dashed: false });
  }
  const b = { minX: 0, minY: 0, maxX: layout.fabricWidthMm, maxY: layout.usedLengthMm };
  openPrintDoc(tiledPagesHTML(items, b, false, { ...opts, title: opts.title ?? 'Marker (tiled)' }));
}

/** Open the pattern's SVG in a new window and invoke the browser's print dialog. */
export function printPattern(pattern: Pattern, title = 'Pattern') {
  const svg = patternToSVG(pattern);
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(
    `<!doctype html><html><head><title>${title}</title>` +
      `<style>@page{margin:10mm}body{margin:0}svg{width:100%;height:auto;display:block}</style>` +
      `</head><body>${svg}` +
      `<script>window.onload=function(){window.focus();window.print();}<\/script>` +
      `</body></html>`
  );
  w.document.close();
}
