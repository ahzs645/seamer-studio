// Per-machine cut-file generation + piece labels — the local-first "Send to cutting room".
// Takes a nested marker (utils/markerLayout) and a CuttingMachine and emits the machine's native
// format: HPGL (shares toHPGL with utils/hpgl.ts), CUT (the same dialect utils/cutImport.ts parses:
// '*'-delimited tokens, N-blocks, M14/M15 pen codes, 0.254 mm units) or plain SVG. The marker is
// validated against the bed — too-wide markers warn, too-long markers are split into one file per
// bed length. printPieceLabels opens a print window with one label per placed piece (mirrors the
// production app's label printing).

import type { Pattern } from '@seamer/pattern-model';
import type { Vec2 } from './patternGeometry';
import type { CuttingMachine } from '$lib/stores/machines';
import { toHPGL } from './hpgl';
import { markerToSVG, type MarkerLayout, type Placement } from './markerLayout';

/** CUT plotter unit (mm) — must match cutImport's default mmPerUnit. */
const CUT_MM_PER_UNIT = 0.254;

/** Usable working width of a machine bed (bed width minus both side margins), never below 100 mm. */
export function machineUsableWidthMm(m: CuttingMachine): number {
  return Math.max(100, m.bedWidthMm - 2 * m.marginMm);
}

/** Usable working length of a machine bed (bed length minus both end margins), never below 100 mm. */
export function machineUsableLengthMm(m: CuttingMachine): number {
  return Math.max(100, m.bedLengthMm - 2 * m.marginMm);
}

export interface CutFilePart {
  text: string;
  /** human label for multi-part output ('' when the marker fits in one file) */
  partLabel: string;
}

export interface CutFileResult {
  files: CutFilePart[];
  extension: string;
  mime: string;
  warnings: string[];
}

function placementBounds(pl: Placement) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pl.poly) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  return { minY, maxY };
}

/** Split a marker into bed-length segments (each a self-contained sub-layout starting at y≈0).
 *  Pieces are never split — a piece taller than the bed stays whole and produces a warning. */
function splitByBedLength(layout: MarkerLayout, usableLengthMm: number, warnings: string[]): MarkerLayout[] {
  if (layout.usedLengthMm <= usableLengthMm || !layout.placements.length) return [layout];

  const sorted = layout.placements
    .map((pl) => ({ pl, ...placementBounds(pl) }))
    .sort((a, b) => a.minY - b.minY);

  const segments: { start: number; entries: typeof sorted }[] = [];
  let cur: { start: number; entries: typeof sorted } | null = null;
  for (const e of sorted) {
    const h = e.maxY - e.minY;
    if (h + 2 * layout.gapMm > usableLengthMm) {
      warnings.push(`Piece "${e.pl.name}" (${Math.round(h)} mm) exceeds bed length ${Math.round(usableLengthMm)} mm`);
    }
    if (!cur || e.maxY - cur.start + layout.gapMm > usableLengthMm) {
      cur = { start: Math.max(0, e.minY - layout.gapMm), entries: [] };
      segments.push(cur);
    }
    cur.entries.push(e);
  }

  warnings.push(`Marker length ${Math.round(layout.usedLengthMm)} mm exceeds bed length ${Math.round(usableLengthMm)} mm — split into ${segments.length} files`);

  return segments.map((seg) => {
    const dy = seg.start;
    const placements = seg.entries.map(({ pl }) => ({
      ...pl,
      poly: pl.poly.map((p) => ({ x: p.x, y: p.y - dy })),
      outline: pl.outline.map((p) => ({ x: p.x, y: p.y - dy }))
    }));
    const usedLengthMm = Math.max(...seg.entries.map((e) => e.maxY)) - dy + layout.gapMm;
    return { ...layout, placements, usedLengthMm };
  });
}

/** Marker segment → HPGL: cut polygons on pen 2, stitch outlines on pen 1, y flipped to plotter
 *  convention (y up) and everything offset by the machine's bed margin. */
function segmentToHPGL(seg: MarkerLayout, machine: CuttingMachine): string {
  const m = machine.marginMm;
  const tx = (p: Vec2): Vec2 => ({ x: p.x + m, y: seg.usedLengthMm - p.y + m });
  const polys: { pts: Vec2[]; closed: boolean; pen: number }[] = [];
  for (const pl of seg.placements) {
    polys.push({ pts: pl.poly.map(tx), closed: true, pen: 2 });
    polys.push({ pts: pl.outline.map(tx), closed: true, pen: 1 });
  }
  const body = toHPGL(polys);
  return machine.speed ? body.replace('SP1;', `SP1;\nVS${machine.speed};`) : body;
}

/** Marker segment → CUT command stream (the dialect cutImport.cutToPattern parses): one N-block per
 *  placement, pen-up move to the start (M15), pen-down trace (M14) closing back on the first point. */
function segmentToCUT(seg: MarkerLayout, machine: CuttingMachine): string {
  const m = machine.marginMm;
  const u = (mm: number) => Math.round(mm / CUT_MM_PER_UNIT);
  const out: string[] = [];
  seg.placements.forEach((pl, i) => {
    const pts = pl.poly.map((p) => ({ x: u(p.x + m), y: u(seg.usedLengthMm - p.y + m) }));
    if (pts.length < 3) return;
    out.push(`N${i + 1}`);
    out.push('M15', `X${pts[0].x}Y${pts[0].y}`, 'M14');
    for (let j = 1; j < pts.length; j++) out.push(`X${pts[j].x}Y${pts[j].y}`);
    out.push(`X${pts[0].x}Y${pts[0].y}`); // close the contour
    out.push('M15');
  });
  out.push('M0');
  return out.join('*') + '*';
}

const FORMAT_META = {
  hpgl: { extension: 'hpgl', mime: 'application/vnd.hp-hpgl' },
  cut: { extension: 'cut', mime: 'text/plain' },
  svg: { extension: 'svg', mime: 'image/svg+xml' }
} as const;

/**
 * Nested marker → machine-ready cut file(s) in the machine's native format, validated against the
 * bed: warns when the marker is wider than the usable bed, and splits into one file per bed length
 * when it is longer (each part restarts at the bed origin).
 */
export function markerToCutFile(layout: MarkerLayout, machine: CuttingMachine): CutFileResult {
  const warnings: string[] = [];
  const usableW = machineUsableWidthMm(machine);
  const usableL = machineUsableLengthMm(machine);
  if (layout.fabricWidthMm > usableW) {
    warnings.push(`Marker width ${Math.round(layout.fabricWidthMm)} mm exceeds bed width ${Math.round(usableW)} mm (bed ${machine.bedWidthMm} mm − 2×${machine.marginMm} mm margin)`);
  }

  const segments = splitByBedLength(layout, usableL, warnings);
  const meta = FORMAT_META[machine.format];
  const files: CutFilePart[] = segments.map((seg, i) => {
    const partLabel = segments.length > 1 ? `part ${i + 1} of ${segments.length}` : '';
    const text =
      machine.format === 'hpgl' ? segmentToHPGL(seg, machine) :
      machine.format === 'cut' ? segmentToCUT(seg, machine) :
      markerToSVG(seg);
    return { text, partLabel };
  });

  return { files, extension: meta.extension, mime: meta.mime, warnings };
}

// --- Piece labels -----------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Mini outline silhouette of a placement, normalised into a small inline SVG. */
function silhouetteSVG(pl: Placement, sizePx = 64): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pl.poly) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const s = (sizePx - 4) / Math.max(w, h);
  const ox = (sizePx - w * s) / 2, oy = (sizePx - h * s) / 2;
  const d = pl.poly.map((p, i) => `${i === 0 ? 'M' : 'L'}${(ox + (p.x - minX) * s).toFixed(1)},${(oy + (p.y - minY) * s).toFixed(1)}`).join(' ') + ' Z';
  return `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 ${sizePx} ${sizePx}"><path d="${d}" fill="rgba(148,163,184,0.15)" stroke="#1e293b" stroke-width="1"/></svg>`;
}

/**
 * Open a print window with one label per placed piece: pattern name, piece name, size (cut bbox),
 * cut count ("n of m" per piece) and material, plus a mini outline silhouette. Throws when there is
 * nothing to print or the popup is blocked — callers toast "Error printing label".
 */
export function printPieceLabels(layout: MarkerLayout, patternName: string, pattern?: Pattern): void {
  if (!layout.placements.length) throw new Error('No pieces to label');
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) throw new Error('Print window blocked');

  const totals = new Map<string, number>();
  for (const pl of layout.placements) totals.set(pl.pieceId, (totals.get(pl.pieceId) ?? 0) + 1);
  const materialName = (pieceId: string): string => {
    const piece = pattern?.pieces.find((p) => p.id === pieceId);
    return pattern?.materials.find((m) => m.id === piece?.materialId)?.name ?? '';
  };

  const seen = new Map<string, number>();
  const labels = layout.placements.map((pl) => {
    const n = (seen.get(pl.pieceId) ?? 0) + 1;
    seen.set(pl.pieceId, n);
    const mat = materialName(pl.pieceId);
    return `<div class="label">${silhouetteSVG(pl)}<div class="meta">` +
      `<div class="pattern">${esc(patternName)}</div>` +
      `<div class="piece">${esc(pl.name)}</div>` +
      `<div class="dims">${Math.round(pl.bbox.w)} × ${Math.round(pl.bbox.h)} mm${pl.rotationDeg ? ` · ${pl.rotationDeg}°` : ''}</div>` +
      `<div class="cut">Cut ${n} of ${totals.get(pl.pieceId)}${mat ? ` · ${esc(mat)}` : ''}</div>` +
      `</div></div>`;
  }).join('\n');

  w.document.write(
    `<!doctype html><html><head><title>${esc(patternName)} — piece labels</title>` +
      `<style>@page{margin:10mm}body{margin:0;font-family:system-ui,sans-serif;display:flex;flex-wrap:wrap;gap:4mm;align-content:flex-start}` +
      `.label{width:62mm;height:30mm;border:0.3mm dashed #94a3b8;border-radius:1.5mm;display:flex;gap:2mm;align-items:center;padding:2mm;box-sizing:border-box;break-inside:avoid}` +
      `.label svg{flex:none}.meta{min-width:0;overflow:hidden}` +
      `.pattern{font-size:7pt;color:#64748b;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}` +
      `.piece{font-size:10pt;font-weight:700;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}` +
      `.dims,.cut{font-size:8pt;color:#334155}</style></head><body>${labels}` +
      `<script>window.onload=function(){window.focus();window.print();}<\/script></body></html>`
  );
  w.document.close();
}
