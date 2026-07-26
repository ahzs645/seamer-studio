// Per-machine cut-file generation + piece labels — the local-first "Send to cutting room".
// Takes a nested marker (utils/markerLayout) and a CuttingMachine and emits the machine's native
// format: HPGL, CUT (the same dialect utils/cutImport.ts parses:
// '*'-delimited tokens, N-blocks, M14/M15 pen codes, 0.254 mm units) or plain SVG. The marker is
// validated against the bed — too-wide markers warn, too-long markers are split into one file per
// bed length. printPieceLabels opens a print window with one label per placed piece (mirrors the
// production app's label printing).

import type { Pattern } from '@seamer/pattern-model';
import {
  machineUsableLengthMm,
  machineUsableWidthMm,
  markerToCutFile as drawingToCutFile,
  type Drawing
} from '@atelier/io';
import type { CuttingMachine } from '$lib/stores/machines';
import { markerToSVG, type MarkerLayout, type Placement } from './markerLayout';

export { machineUsableLengthMm, machineUsableWidthMm };

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

/** Flatten one identity-aware marker segment into Atelier's neutral Drawing. */
function markerDrawing(segment: MarkerLayout, format: CuttingMachine['format']): Drawing {
  const includeReference = format !== 'cut';
  return {
    layers: [
      { id: 'outline', name: 'Stitch outline', style: { color: '#000000', width: 0.5 } },
      { id: 'cut', name: 'Cut line', style: { color: '#888888', width: 0.4 } }
    ],
    // Preserve the old per-piece cut/stitch ordering; it determines plotter travel.
    polys: segment.placements.flatMap((placement) => [
      {
        pts: placement.poly,
        closed: true,
        layer: 'cut'
      },
      ...(includeReference
        ? [{
            pts: placement.outline,
            closed: true,
            layer: 'outline'
          }]
        : [])
    ]),
    texts: [],
    boundsMm: {
      minX: 0,
      minY: 0,
      maxX: segment.fabricWidthMm,
      maxY: segment.usedLengthMm
    }
  };
}

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
  // Identity-aware splitting stays app-side so a piece is never divided between output files.
  // Each resulting neutral Drawing is emitted by @atelier/io with engine splitting disabled.
  const engineMachine = {
    ...machine,
    bedWidthMm: Math.max(machine.bedWidthMm, layout.fabricWidthMm + machine.marginMm * 2 + 1),
    bedLengthMm: Number.MAX_SAFE_INTEGER
  };
  const files: CutFilePart[] = segments.map((seg, i) => {
    const partLabel = segments.length > 1 ? `part ${i + 1} of ${segments.length}` : '';
    // The machine SVG is deliberately identity-aware: its fabric/piece fills and printed labels
    // cannot be represented by Atelier's neutral, stroke-only Drawing.
    const text = machine.format === 'svg'
      ? markerToSVG(seg)
      : drawingToCutFile(markerDrawing(seg, machine.format), engineMachine).files[0]?.text ?? '';
    return { text, partLabel };
  });
  const metadata = drawingToCutFile(markerDrawing(segments[0] ?? layout, machine.format), engineMachine);
  return { files, extension: metadata.extension, mime: metadata.mime, warnings };
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
