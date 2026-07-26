// Minimal HPGL (plotter) parser → polylines in millimetres, for the 2D trace overlay.
// Handles the common drawing subset: PU (pen-up move), PD (pen-down draw), PA (plot absolute);
// other mnemonics (IN, SP, SC, PR, …) are ignored. Plotter units are 1/40 mm (40 units/mm).

import type { Vec2 } from './patternGeometry';

const UNIT_MM = 0.025; // 1 plotter unit = 0.025 mm
const ETX = '\x03'; // HPGL label terminator

export interface HpglPoly {
  pts: Vec2[];
  closed?: boolean;
  pen?: number;
  /** HPGL LT line-type number (e.g. 2 = dashed); undefined = solid */
  lineType?: number;
}
export interface HpglText {
  text: string;
  x: number; // mm
  y: number;
  sizeMm: number; // character height
  rotationDeg?: number; // label direction (DI)
  pen?: number;
}
export interface HpglCross {
  x: number; // mm
  y: number;
  sizeMm?: number; // arm length (default 3 mm)
  pen?: number;
}

/**
 * Polylines (mm) → HPGL plotter program. Each polyline = pen-up to its start, pen-down through its
 * points; closed polylines repeat their first point. Pens select per line role, LT sets dashed line
 * types, and `extras` add in-file piece labels (DI/SI/LB) and drill-hole cross markers.
 */
export function toHPGL(
  polys: HpglPoly[],
  extras: { texts?: HpglText[]; crosses?: HpglCross[] } = {}
): string {
  const u = (v: number) => Math.round(v / UNIT_MM); // mm → plotter units
  const out: string[] = ['IN;', 'SP1;'];
  let pen = 1;
  let lt: number | null = null;
  const setPen = (p?: number) => { if (p && p !== pen) { pen = p; out.push(`SP${pen};`); } };
  const setLt = (t: number | null) => {
    if (t === lt) return;
    lt = t;
    out.push(t === null ? 'LT;' : `LT${t};`);
  };
  for (const poly of polys) {
    const pts = poly.pts;
    if (pts.length < 2) continue;
    setPen(poly.pen);
    setLt(poly.lineType ?? null);
    out.push(`PU${u(pts[0].x)},${u(pts[0].y)};`);
    const seq = poly.closed ? [...pts.slice(1), pts[0]] : pts.slice(1);
    out.push('PD' + seq.map((p) => `${u(p.x)},${u(p.y)}`).join(',') + ';');
  }
  setLt(null);
  // drill-hole crosses: two short strokes through the point
  for (const c of extras.crosses ?? []) {
    setPen(c.pen ?? 5);
    const a = c.sizeMm ?? 3;
    out.push(`PU${u(c.x - a)},${u(c.y)};`, `PD${u(c.x + a)},${u(c.y)};`);
    out.push(`PU${u(c.x)},${u(c.y - a)};`, `PD${u(c.x)},${u(c.y + a)};`);
  }
  // piece labels, rotated via DI (direction run/rise) and sized via SI (cm character cell)
  for (const t of extras.texts ?? []) {
    if (!t.text) continue;
    setPen(t.pen ?? 5);
    const rad = ((t.rotationDeg ?? 0) * Math.PI) / 180;
    out.push(`PU${u(t.x)},${u(t.y)};`);
    out.push(`DI${Math.cos(rad).toFixed(4)},${Math.sin(rad).toFixed(4)};`);
    out.push(`SI${((t.sizeMm * 0.66) / 10).toFixed(3)},${(t.sizeMm / 10).toFixed(3)};`);
    out.push(`LB${t.text.replace(new RegExp(ETX, 'g'), '')}${ETX};`);
  }
  if (extras.texts?.length) out.push('DI1,0;');
  out.push('PU;', 'SP0;', 'IN;');
  return out.join('\n');
}

export function parseHPGL(text: string): Vec2[][] {
  const polys: Vec2[][] = [];
  let cur: Vec2[] = [];
  let penDown = false;
  let x = 0, y = 0;
  const flush = () => { if (cur.length > 1) polys.push(cur); cur = []; };

  for (const raw of text.replace(/[\r\n]+/g, '').split(';')) {
    const cmd = raw.trim();
    if (cmd.length < 2) continue;
    const op = cmd.slice(0, 2).toUpperCase();
    const args = cmd.slice(2).split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    if (op === 'PU') {
      flush();
      penDown = false;
      for (let i = 0; i + 1 < args.length; i += 2) { x = args[i]; y = args[i + 1]; }
      cur = [{ x: x * UNIT_MM, y: y * UNIT_MM }];
    } else if (op === 'PD') {
      penDown = true;
      if (cur.length === 0) cur = [{ x: x * UNIT_MM, y: y * UNIT_MM }];
      for (let i = 0; i + 1 < args.length; i += 2) { x = args[i]; y = args[i + 1]; cur.push({ x: x * UNIT_MM, y: y * UNIT_MM }); }
    } else if (op === 'PA') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        x = args[i]; y = args[i + 1];
        if (penDown) cur.push({ x: x * UNIT_MM, y: y * UNIT_MM });
        else { flush(); cur = [{ x: x * UNIT_MM, y: y * UNIT_MM }]; }
      }
    }
  }
  flush();
  return polys;
}
