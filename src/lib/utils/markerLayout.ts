// Marker / cut-nesting layout: pack every piece's cut outline (seam-allowance line, or the stitch
// outline when there's no allowance) onto a fabric of a fixed width, minimising total length. Uses a
// simple shelf (first-fit decreasing by height) packer on axis-aligned bounding boxes — good enough
// for a usable cutting marker; rotation/true-shape nesting is intentionally out of scope.

import type { Pattern } from '@seamer/pattern-model';
import {
  indexPaths, indexPoints, pieceWorldOutline, pieceAllowancePolygon, pieceCutCounts, type Vec2
} from '@seamer/pattern-model';
import { boundingBox, convexHull, concaveHull } from './hull';

export interface Placement {
  pieceId: string;
  name: string;
  /** translated cut polygon in marker space (mm, origin top-left, y down) */
  poly: Vec2[];
  /** translated stitch outline (for reference inside the cut line) */
  outline: Vec2[];
  bbox: { w: number; h: number };
  /** rotation applied to this instance, degrees (true-shape nester only; 0 for the shelf packer) */
  rotationDeg?: number;
  /** stable instance id (pieceId + occurrence) — used for cut tracking */
  instanceId?: string;
  /** multi-bin nests: which fabric sheet this piece landed on (0-based) */
  bin?: number;
}

export interface MarkerLayout {
  fabricWidthMm: number;
  usedLengthMm: number;
  gapMm: number;
  placements: Placement[];
  /** fabric utilisation: sum of piece areas ÷ (fabricWidth × usedLength), 0..1 (true-shape only) */
  efficiency?: number;
  /** multi-bin nests: each sheet's vertical band in the continuous marker space */
  bins?: { startYmm: number; usedLengthMm: number }[];
}

function polyBounds(poly: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Pack pieces onto a fabric of width `fabricWidthMm`, returning per-piece marker placements. */
export function nestPieces(pattern: Pattern, fabricWidthMm = 1400, gapMm = 10): MarkerLayout {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);

  // Each piece → its cut polygon (allowance if any) + stitch outline, both normalised to local (0,0).
  interface Item { pieceId: string; name: string; cut: Vec2[]; outline: Vec2[]; w: number; h: number }
  const items: Item[] = [];
  for (const piece of pattern.pieces) {
    if (piece.hidden) continue;
    const outline = pieceWorldOutline(pattern, piece, paths, points, 2);
    if (outline.length < 3) continue;
    const sa = piece.seamAllowance ?? pattern.seamAllowance ?? 0;
    const cut = sa > 0.05 ? pieceAllowancePolygon(pattern, piece, piece.seamAllowanceInside ? -sa : sa, paths, points, 2) : outline;
    const ref = cut.length >= 3 ? cut : outline;
    const bb = polyBounds(ref);
    const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
    const norm = (poly: Vec2[]) => poly.map((p) => ({ x: p.x - bb.minX, y: p.y - bb.minY }));
    // mirror a normalised poly within its own bbox, across the configured axis
    const mirror = (poly: Vec2[]) => poly.map((p) => (piece.mirrorLeftPiecesAxis === 'Y' ? { x: p.x, y: h - p.y } : { x: w - p.x, y: p.y }));
    const baseCut = norm(ref), baseOut = norm(outline);
    const { asIs, mirrored } = pieceCutCounts(piece);
    for (let i = 0; i < asIs; i++) items.push({ pieceId: piece.id, name: piece.name, cut: baseCut, outline: baseOut, w, h });
    for (let i = 0; i < mirrored; i++) items.push({ pieceId: piece.id, name: `${piece.name} (mirror)`, cut: mirror(baseCut), outline: mirror(baseOut), w, h });
  }

  // First-fit decreasing by height (shelf packing).
  items.sort((a, b) => b.h - a.h);
  const placements: Placement[] = [];
  let shelfY = gapMm;
  let cursorX = gapMm;
  let shelfH = 0;
  let usedLength = gapMm;
  for (const it of items) {
    if (cursorX + it.w + gapMm > fabricWidthMm && cursorX > gapMm) {
      // new shelf
      shelfY += shelfH + gapMm;
      cursorX = gapMm;
      shelfH = 0;
    }
    const dx = cursorX, dy = shelfY;
    placements.push({
      pieceId: it.pieceId,
      name: it.name,
      poly: it.cut.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      outline: it.outline.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      bbox: { w: it.w, h: it.h }
    });
    cursorX += it.w + gapMm;
    shelfH = Math.max(shelfH, it.h);
    usedLength = Math.max(usedLength, shelfY + it.h + gapMm);
  }
  return { fabricWidthMm, usedLengthMm: usedLength, gapMm, placements };
}

// ---------------------------------------------------------------------------
// True-shape nesting (rotations + bottom-left fill + light genetic ordering).
// A faithful-in-spirit port of the original cutting room's GA nester: pieces are
// placed as real polygons (not bounding boxes), may rotate by configurable angles,
// and a small genetic algorithm searches piece orderings to minimise marker length.
// ---------------------------------------------------------------------------

export interface NestOptions {
  fabricWidthMm?: number;
  gapMm?: number;
  /** rotations (degrees) each piece may take; e.g. [0], [0,180], [0,90,180,270]. Default [0,180]. */
  allowedRotations?: number[];
  /** GA generations (0 = single greedy pass, no evolution). Default 12. */
  generations?: number;
  /** GA population size. Default 16. */
  population?: number;
  /** max marker length per fabric sheet (mm); overflow spills into more bins. 0 = unlimited. */
  maxLengthMm?: number;
}

function rotatePoly(poly: Vec2[], deg: number): Vec2[] {
  if (deg % 360 === 0) return poly.map((p) => ({ ...p }));
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return poly.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
}

function normalize(poly: Vec2[]): { poly: Vec2[]; w: number; h: number } {
  const b = polyBounds(poly);
  return { poly: poly.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY })), w: b.maxX - b.minX, h: b.maxY - b.minY };
}

function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function segIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return ((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0));
}

function pointInPoly(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.y > pt.y) !== (b.y > pt.y)) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** True iff two simple polygons overlap (edge crossing or one contains a vertex of the other). */
export function polysOverlap(a: Vec2[], b: Vec2[]): boolean {
  const ba = polyBounds(a), bb = polyBounds(b);
  if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxY < bb.minY || bb.maxY < ba.minY) return false;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return pointInPoly(a[0], b) || pointInPoly(b[0], a);
}

export interface NestItem { pieceId: string; name: string; cut: Vec2[]; outline: Vec2[]; instanceId: string; area: number }

/** Build the per-instance cut/outline polygons for nesting (one entry per cut count, incl. mirrors). */
export function buildNestItems(pattern: Pattern): NestItem[] {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const items: NestItem[] = [];
  for (const piece of pattern.pieces) {
    if (piece.hidden) continue;
    const outline = pieceWorldOutline(pattern, piece, paths, points, 2);
    if (outline.length < 3) continue;
    const sa = piece.seamAllowance ?? pattern.seamAllowance ?? 0;
    const cut = sa > 0.05 ? pieceAllowancePolygon(pattern, piece, piece.seamAllowanceInside ? -sa : sa, paths, points, 2) : outline;
    const ref = cut.length >= 3 ? cut : outline;
    const n = normalize(ref);
    const nOut = ref === outline ? n : normalize(outline);
    const mirror = (poly: Vec2[], w: number, h: number) => poly.map((p) => (piece.mirrorLeftPiecesAxis === 'Y' ? { x: p.x, y: h - p.y } : { x: w - p.x, y: p.y }));
    const { asIs, mirrored } = pieceCutCounts(piece);
    const area = polygonArea(n.poly);
    for (let i = 0; i < asIs; i++) items.push({ pieceId: piece.id, name: piece.name, cut: n.poly, outline: nOut.poly, instanceId: `${piece.id}#${i}`, area });
    for (let i = 0; i < mirrored; i++) items.push({ pieceId: piece.id, name: `${piece.name} (mirror)`, cut: mirror(n.poly, n.w, n.h), outline: mirror(nOut.poly, n.w, n.h), instanceId: `${piece.id}#m${i}`, area });
  }
  return items;
}

/** Place ordered items with the given rotation choices using bottom-left corner-candidate fill. */
export function placeBottomLeft(
  order: NestItem[], rotIdx: number[], rotations: number[], fabricWidthMm: number, gapMm: number
): { placements: Placement[]; usedLength: number } {
  const placed: { poly: Vec2[]; bounds: ReturnType<typeof polyBounds> }[] = [];
  const placements: Placement[] = [];
  let usedLength = gapMm;

  for (let k = 0; k < order.length; k++) {
    const it = order[k];
    const deg = rotations[rotIdx[k] % rotations.length];
    const rot = normalize(rotatePoly(it.cut, deg));
    const rotOut = normalize(rotatePoly(it.outline, deg));
    const w = rot.w, h = rot.h;

    // Candidate anchors: top-left corner, and the corners spawned by already-placed pieces.
    const xs = new Set<number>([gapMm]);
    const ys = new Set<number>([gapMm]);
    for (const pl of placed) { xs.add(pl.bounds.maxX + gapMm); ys.add(pl.bounds.maxY + gapMm); }

    let best: { x: number; y: number } | null = null;
    for (const y of [...ys].sort((a, b) => a - b)) {
      for (const x of [...xs].sort((a, b) => a - b)) {
        if (x + w + gapMm > fabricWidthMm) continue;
        const cand = rot.poly.map((p) => ({ x: p.x + x, y: p.y + y }));
        const cb = polyBounds(cand);
        let ok = true;
        for (const pl of placed) {
          if (cb.maxX < pl.bounds.minX - gapMm || pl.bounds.maxX < cb.minX - gapMm || cb.maxY < pl.bounds.minY - gapMm || pl.bounds.maxY < cb.minY - gapMm) continue;
          if (polysOverlap(cand, pl.poly)) { ok = false; break; }
        }
        if (ok && (!best || y < best.y || (y === best.y && x < best.x))) { best = { x, y }; break; }
      }
      if (best && best.y <= [...ys].sort((a, b) => a - b)[0]) break; // can't beat the lowest row
    }
    const pos = best ?? { x: gapMm, y: usedLength };
    const poly = rot.poly.map((p) => ({ x: p.x + pos.x, y: p.y + pos.y }));
    const outline = rotOut.poly.map((p) => ({ x: p.x + pos.x, y: p.y + pos.y }));
    placed.push({ poly, bounds: polyBounds(poly) });
    placements.push({ pieceId: it.pieceId, name: it.name, poly, outline, bbox: { w, h }, rotationDeg: deg, instanceId: it.instanceId });
    usedLength = Math.max(usedLength, pos.y + h + gapMm);
  }
  return { placements, usedLength };
}

/** Nest pieces as true shapes with rotation and a small genetic ordering search. */
export function nestPiecesTrueShape(pattern: Pattern, opts: NestOptions = {}): MarkerLayout {
  const fabricWidthMm = opts.fabricWidthMm ?? 1400;
  const gapMm = opts.gapMm ?? 10;
  const rotations = (opts.allowedRotations?.length ? opts.allowedRotations : [0, 180]);
  const generations = opts.generations ?? 12;
  const population = Math.max(4, opts.population ?? 16);
  const items = buildNestItems(pattern);
  if (items.length === 0) return { fabricWidthMm, usedLengthMm: gapMm, gapMm, placements: [], efficiency: 0 };

  const totalArea = items.reduce((s, it) => s + it.area, 0);
  const evaluate = (order: NestItem[], rotIdx: number[]) => {
    const r = placeBottomLeft(order, rotIdx, rotations, fabricWidthMm, gapMm);
    return { ...r, fitness: r.usedLength };
  };

  // Greedy seed: largest-area first, rotation 0.
  const seedOrder = [...items].sort((a, b) => b.area - a.area);
  const idxOf = new Map(items.map((it, i) => [it.instanceId, i] as const));
  type Chrom = { order: number[]; rot: number[] };
  const toChrom = (ord: NestItem[]): Chrom => ({ order: ord.map((it) => idxOf.get(it.instanceId)!), rot: ord.map(() => 0) });
  const fromChrom = (c: Chrom): NestItem[] => c.order.map((i) => items[i]);

  let pop: Chrom[] = [toChrom(seedOrder)];
  const rndInt = (n: number) => Math.floor(Math.random() * n);
  while (pop.length < population) {
    const ord = [...items];
    for (let i = ord.length - 1; i > 0; i--) { const j = rndInt(i + 1); [ord[i], ord[j]] = [ord[j], ord[i]]; }
    pop.push({ order: ord.map((it) => idxOf.get(it.instanceId)!), rot: ord.map(() => rndInt(rotations.length)) });
  }

  const score = (c: Chrom) => evaluate(fromChrom(c), c.rot).fitness;
  let best = pop[0]; let bestScore = score(best);
  for (const c of pop) { const s = score(c); if (s < bestScore) { best = c; bestScore = s; } }

  for (let g = 0; g < generations; g++) {
    const scored = pop.map((c) => ({ c, s: score(c) })).sort((a, b) => a.s - b.s);
    if (scored[0].s < bestScore) { best = scored[0].c; bestScore = scored[0].s; }
    const elite = scored.slice(0, Math.max(2, Math.floor(population / 4))).map((x) => x.c);
    const next: Chrom[] = [...elite];
    while (next.length < population) {
      const p1 = elite[rndInt(elite.length)], p2 = elite[rndInt(elite.length)];
      // order crossover (OX) on order; uniform on rotation.
      const n = p1.order.length, a = rndInt(n), b = a + rndInt(n - a);
      const childOrder: number[] = new Array(n).fill(-1);
      const taken = new Set<number>();
      for (let i = a; i <= b; i++) { childOrder[i] = p1.order[i]; taken.add(p1.order[i]); }
      let fill = 0;
      for (let i = 0; i < n; i++) { if (childOrder[i] === -1) { while (taken.has(p2.order[fill])) fill++; childOrder[i] = p2.order[fill++]; } }
      const rot = childOrder.map((_, i) => (Math.random() < 0.5 ? p1.rot[i % p1.rot.length] : p2.rot[i % p2.rot.length]));
      // mutation: swap two, and flip a rotation.
      if (Math.random() < 0.3) { const i = rndInt(n), j = rndInt(n); [childOrder[i], childOrder[j]] = [childOrder[j], childOrder[i]]; }
      if (Math.random() < 0.3 && rotations.length > 1) rot[rndInt(n)] = rndInt(rotations.length);
      next.push({ order: childOrder, rot });
    }
    pop = next;
  }

  const final = evaluate(fromChrom(best), best.rot);
  const efficiency = totalArea / Math.max(1, fabricWidthMm * (final.usedLength - gapMm));
  return { fabricWidthMm, usedLengthMm: final.usedLength, gapMm, placements: final.placements, efficiency: Math.min(1, efficiency) };
}

/**
 * Cut-off boundary type — the wrap shape drawn around all placed pieces for cutting, mirroring the
 * original studio's cutting-room "cut-off type" (ConvexHull / ConcaveHull / BoundingBox). `'none'`
 * skips it. ConcaveHull hugs the pieces more tightly than the convex hull, saving fabric.
 */
export type CutOffType = 'none' | 'boundingBox' | 'convexHull' | 'concaveHull';

/**
 * Boundary polygon wrapping every placed piece's cut polygon, by the chosen cut-off type. Returns a
 * closed polygon (last point === first) in marker space, or [] for `'none'`/empty layouts.
 * `concavity` (≥1) tunes the concave hull: larger → closer to the convex hull.
 */
export function markerCutOff(layout: MarkerLayout, type: CutOffType, concavity = 2): Vec2[] {
  if (type === 'none') return [];
  const pts: Vec2[] = [];
  for (const pl of layout.placements) for (const p of pl.poly) pts.push(p);
  if (pts.length < 3) return [];
  if (type === 'boundingBox') return boundingBox(pts);
  if (type === 'convexHull') { const h = convexHull(pts); return h.length ? [...h, h[0]] : []; }
  return concaveHull(pts, concavity);
}

/** Render a nesting layout as a true-scale SVG (mm), fabric outlined, pieces labelled. Placements
 *  whose instanceId is in `cutIds` are drawn greyed-out (already cut, for the cutting room). */
export function markerToSVG(layout: MarkerLayout, cutOff: CutOffType = 'none', cutIds?: ReadonlySet<string>): string {
  const W = layout.fabricWidthMm;
  const H = Math.max(layout.usedLengthMm, 50);
  const path = (poly: Vec2[], closed = true) =>
    poly.map((v, i) => `${i === 0 ? 'M' : 'L'}${v.x.toFixed(2)},${v.y.toFixed(2)}`).join(' ') + (closed ? ' Z' : '');
  const cut = markerCutOff(layout, cutOff);
  const cutSVG = cut.length >= 3
    ? `  <path d="${path(cut, false)}" fill="none" stroke="#ef4444" stroke-width="0.8" stroke-dasharray="6,3"/>\n`
    : '';
  // multi-bin layouts: outline each fabric sheet's band + label it
  const binsSVG = (layout.bins ?? []).map((b, i) =>
    `  <rect x="0" y="${b.startYmm.toFixed(1)}" width="${W.toFixed(1)}" height="${b.usedLengthMm.toFixed(1)}" fill="none" stroke="#ef4444" stroke-width="0.6" stroke-dasharray="8,4"/>\n` +
    `  <text x="2" y="${(b.startYmm + 10).toFixed(1)}" font-size="9" fill="#ef4444">Sheet ${i + 1}</text>`
  ).join('\n');
  const body = layout.placements.map((pl) => {
    const cx = pl.poly.reduce((s, p) => s + p.x, 0) / (pl.poly.length || 1);
    const cy = pl.poly.reduce((s, p) => s + p.y, 0) / (pl.poly.length || 1);
    const isCut = cutIds?.has(pl.instanceId ?? '') ?? false;
    return (
      `  <path d="${path(pl.poly)}" fill="${isCut ? 'rgba(34,197,94,0.18)' : 'rgba(148,163,184,0.12)'}" stroke="#888" stroke-width="0.4" stroke-dasharray="3,2"/>\n` +
      `  <path d="${path(pl.outline)}" fill="none" stroke="${isCut ? '#16a34a' : '#000'}" stroke-width="0.5"/>\n` +
      `  <text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="10" fill="#334155" text-anchor="middle" dominant-baseline="middle">${pl.name.replace(/[<&>]/g, '')}${isCut ? ' ✓' : ''}</text>`
    );
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(1)}mm" height="${H.toFixed(1)}mm" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}">
  <rect x="0" y="0" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="none" stroke="#0ea5e9" stroke-width="0.6"/>
${binsSVG}${cutSVG}${body}
</svg>`;
}

// ---- nest-onto-paper (the original's print-dialog re-nest) -----------------------------------------

import { nestCore, polygonArea as corePolygonArea, type CoreItem } from './nestCore';

/**
 * Re-position the pattern's pieces onto a strip as wide as the printable paper area, so tiled
 * printing uses the fewest pages (the original nests with rotations [0,90,180,270] before printing).
 * Returns a COPY of the pattern with piece position/rotation rewritten; the drafting geometry is
 * untouched. Falls back to the original pattern when there's nothing to nest.
 */
export function nestPatternForPaper(pattern: Pattern, usableWidthMm: number): Pattern {
  if (usableWidthMm < 50) return pattern;
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const items: CoreItem[] = [];
  for (const piece of pattern.pieces) {
    if (piece.hidden) continue;
    const outline = pieceWorldOutline(pattern, piece, paths, points, 4);
    if (outline.length < 3) continue;
    items.push({ pieceId: piece.id, instanceId: piece.id, name: piece.name, cut: outline, outline, area: corePolygonArea(outline) });
  }
  if (items.length < 2) return pattern;
  const layout = nestCore(items, {
    fabricWidthMm: usableWidthMm,
    gapMm: 8,
    rotations: [0, 90, 180, 270],
    generations: 6,
    population: 12,
    strategy: 'nfp',
    seed: 42 // deterministic: the preview page count matches the printed result
  });
  const byPiece = new Map(layout.placements.map((pl) => [pl.pieceId, pl]));
  const itemByPiece = new Map(items.map((it) => [it.pieceId, it]));
  const pieces = pattern.pieces.map((piece) => {
    const pl = byPiece.get(piece.id);
    const it = itemByPiece.get(piece.id);
    if (!pl || !it) return piece;
    // rigid transform old-world → placement: rotation Δ, then translation derived from the first
    // vertex (vertex order survives rotate/normalize/translate in the nester)
    const deg = pl.rotationDeg ?? 0;
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const o0 = it.cut[0];
    const t = { x: pl.poly[0].x - (o0.x * cos - o0.y * sin), y: pl.poly[0].y - (o0.x * sin + o0.y * cos) };
    return {
      ...piece,
      rotation: piece.rotation + deg,
      position: {
        x: piece.position.x * cos - piece.position.y * sin + t.x,
        y: piece.position.x * sin + piece.position.y * cos + t.y
      }
    };
  });
  return { ...pattern, pieces };
}

// ---- fabric-distortion warp (the original's ThinPlateSpline warpToMesh) ----------------------------

import { buildWarp, type MatchPair } from './thinPlateSpline';

export interface FabricDistortion {
  /** lateral mid-length bow of the fabric (mm; weft arcs sideways on the table) */
  bowMm: number;
  /** skew of the far end relative to the near end (mm; weft runs off-square) */
  skewMm: number;
}

/**
 * Warp a nested layout onto the REAL (distorted) fabric so cuts land on-grain: a thin-plate spline
 * is fitted from the ideal marker rectangle onto the measured bow/skew shape, and every placement
 * polygon is mapped through it. Identity when both adjustments are 0.
 */
export function warpLayoutToFabric(layout: MarkerLayout, distortion: FabricDistortion): MarkerLayout {
  const { bowMm, skewMm } = distortion;
  if (!bowMm && !skewMm) return layout;
  const w = layout.fabricWidthMm;
  const len = Math.max(1, layout.usedLengthMm);
  // 3×3 control grid over the marker: bow arcs sideways (max at mid-length, zero at the ends),
  // skew shifts proportionally along the length
  const pairs: MatchPair[] = [];
  for (const v of [0, 0.5, 1]) {
    for (const u of [0, 0.5, 1]) {
      const src = { x: u * w, y: v * len };
      const dx = bowMm * Math.sin(Math.PI * v) + skewMm * v;
      pairs.push({ src, dst: { x: src.x + dx, y: src.y } });
    }
  }
  const warp = buildWarp(pairs);
  return {
    ...layout,
    placements: layout.placements.map((pl) => ({
      ...pl,
      poly: pl.poly.map(warp),
      outline: pl.outline.map(warp)
    }))
  };
}

// ---- print/plaid pattern matching (the original's matching nest options) ---------------------------

import { polyBounds as nestPolyBounds, polysOverlap as nestPolysOverlap, offsetPoly as nestOffsetPoly } from './nestCore';

export interface PatternMatching {
  /** horizontal repeat of the print (mm) */
  cellWidthMm: number;
  /** vertical repeat of the print (mm) */
  cellHeightMm: number;
}

/**
 * Align a nested layout to the fabric's print repeat: every placement snaps to the nearest
 * repeat-grid position (searching outward when the snap would overlap a neighbour or leave the
 * fabric), so checks/stripes land identically on every piece — the grid-snap core of the
 * original's plaid/print matching. Re-measures the used length afterwards.
 */
export function matchLayoutToRepeat(layout: MarkerLayout, match: PatternMatching, gapMm = 0): MarkerLayout {
  const cw = Math.max(1, match.cellWidthMm);
  const ch = Math.max(1, match.cellHeightMm);
  const placed: { test: Vec2[]; bounds: ReturnType<typeof nestPolyBounds> }[] = [];
  let usedLength = gapMm;
  const order = [...layout.placements].sort((a, b) => {
    const ba = nestPolyBounds(a.poly), bb = nestPolyBounds(b.poly);
    return ba.minY - bb.minY || ba.minX - bb.minX;
  });
  const out = new Map<typeof order[number], { dx: number; dy: number }>();
  for (const pl of order) {
    const b = nestPolyBounds(pl.poly);
    // candidate grid shifts, nearest first (rings around the snapped origin)
    const snapX = Math.round(b.minX / cw) * cw - b.minX;
    const snapY = Math.round(b.minY / ch) * ch - b.minY;
    let chosen: { dx: number; dy: number } | null = null;
    outer: for (let ring = 0; ring <= 6 && !chosen; ring++) {
      for (let ky = -ring; ky <= ring; ky++) {
        for (let kx = -ring; kx <= ring; kx++) {
          if (Math.max(Math.abs(kx), Math.abs(ky)) !== ring) continue; // ring shell only
          const dx = snapX + kx * cw;
          const dy = snapY + ky * ch;
          if (b.minX + dx < 0 || b.maxX + dx > layout.fabricWidthMm || b.minY + dy < 0) continue;
          const cand = pl.poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
          const candTest = gapMm > 0 ? nestOffsetPoly(cand, gapMm * 0.49) : cand;
          const cb = nestPolyBounds(candTest);
          let ok = true;
          for (const q of placed) {
            if (cb.maxX < q.bounds.minX || q.bounds.maxX < cb.minX || cb.maxY < q.bounds.minY || q.bounds.maxY < cb.minY) continue;
            if (nestPolysOverlap(candTest, q.test)) { ok = false; break; }
          }
          if (ok) { chosen = { dx, dy }; placed.push({ test: candTest, bounds: cb }); continue outer; }
        }
      }
    }
    const shift = chosen ?? { dx: 0, dy: 0 };
    if (!chosen) {
      // keep the unmatched original placement occupied so later pieces avoid it
      const test = gapMm > 0 ? nestOffsetPoly(pl.poly, gapMm * 0.49) : pl.poly;
      placed.push({ test, bounds: nestPolyBounds(test) });
    }
    out.set(pl, shift);
    usedLength = Math.max(usedLength, b.maxY + shift.dy + gapMm);
  }
  return {
    ...layout,
    usedLengthMm: usedLength,
    placements: layout.placements.map((pl) => {
      const s = out.get(pl) ?? { dx: 0, dy: 0 };
      if (!s.dx && !s.dy) return pl;
      return {
        ...pl,
        poly: pl.poly.map((p) => ({ x: p.x + s.dx, y: p.y + s.dy })),
        outline: pl.outline.map((p) => ({ x: p.x + s.dx, y: p.y + s.dy }))
      };
    })
  };
}
