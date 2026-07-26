// CUT (Gerber/plotter cut-file) importer — faithful port of the original studio's CutImporter.
// A .cut file is a flat command stream: blocks delimited by `N<n>` ids, pen state via M-codes
// (M14 = pen down/draw, M15/M0 = pen up/move, M19 = notch, M43 trailing flag = key/stitch point),
// and coordinate tokens `X<int>Y<int>[M<n>]`. Coordinates are in plotter units (default 0.254 mm).
//
// Draw segments are accumulated per block, stitched into closed contours, nested by containment
// (largest = piece boundary, contained = internal cutouts), and emitted as repo pieces: the outer
// contour becomes the boundary loop, cutouts become closed internalPaths, drill points become
// 'drill' markers, and short open paths touching the boundary become notches.

import { createEmptyPattern } from '@seamer/pattern-model';
import type { Pattern, Piece, PiecePath, ConstrainablePath, PathPoint, PieceMarker } from '@seamer/pattern-model';

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;

class P {
  constructor(public x: number, public y: number) {}
  clone() { return new P(this.x, this.y); }
  equals(o: P, eps = 1e-6) { return Math.abs(this.x - o.x) <= eps && Math.abs(this.y - o.y) <= eps; }
  add(o: P) { return new P(this.x + o.x, this.y + o.y); }
  sub(o: P) { return new P(this.x - o.x, this.y - o.y); }
  multiplyScalar(s: number) { return new P(this.x * s, this.y * s); }
  divideScalar(s: number) { return new P(this.x / s, this.y / s); }
  length() { return Math.hypot(this.x, this.y); }
  distanceTo(o: P) { return Math.hypot(this.x - o.x, this.y - o.y); }
}

class Polyline {
  isClosed = false;
  constructor(public points: P[]) {}
  clone() { const pl = new Polyline(this.points.map((p) => p.clone())); pl.isClosed = this.isClosed; return pl; }
  get firstPoint() { return this.points[0]; }
  get lastPoint() { return this.points[this.points.length - 1]; }
  /** Signed shoelace area / 2. Positive = counter-clockwise (y-up). */
  signedArea() {
    let a = 0;
    const n = this.points.length;
    for (let i = 0; i < n; i++) { const p = this.points[i], q = this.points[(i + 1) % n]; a += p.x * q.y - q.x * p.y; }
    return a / 2;
  }
  getArea() { return Math.abs(this.signedArea()); }
  isClockwise() { return this.signedArea() < 0; }
  getLength() {
    let len = 0;
    const n = this.isClosed ? this.points.length : this.points.length - 1;
    for (let i = 0; i < n; i++) len += this.points[i].distanceTo(this.points[(i + 1) % this.points.length]);
    return len;
  }
  isPointInside(pt: P, includeOnEdge = false) {
    const pts = this.points;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if (includeOnEdge && distanceToSegment(pt, a, b) <= 1e-6) return true;
      const intersect = (a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
      if (intersect) inside = !inside;
    }
    return inside;
  }
}

function distanceToSegment(e: P, r: P, a: P) {
  const s = a.x - r.x, d = a.y - r.y, u = s * s + d * d;
  if (u <= 1e-9) return e.distanceTo(r);
  const c = Math.max(0, Math.min(1, ((e.x - r.x) * s + (e.y - r.y) * d) / u));
  return e.distanceTo(new P(r.x + s * c, r.y + d * c));
}

interface Segment { from: P; to: P; blockId: string }
interface DrawPath { blockId: string; startWithMarker: boolean; points: P[] }
interface Contour { polyline: Polyline; area: number; firstPoint: P }

const KEY_TOL_UNITS = 2.5;
const STITCH_MAX_UNITS = 30;

export function cutToPattern(text: string, name = 'Imported CUT', mmPerUnit = 0.254): Pattern {
  const keyTolMm = KEY_TOL_UNITS * mmPerUnit;
  const stitchMaxMm = STITCH_MAX_UNITS * mmPerUnit;

  const raw = String(text ?? '').trim();
  if (!raw.length) throw new Error('Empty CUT input');
  const tokens = raw.split('*').map((t) => t.trim()).filter((t) => t.length > 0);
  if (!tokens.length) throw new Error('Invalid CUT content');

  let mode: 'move' | 'draw' = 'move';
  let last: P | null = null;
  let curX: number | null = null, curY: number | null = null;
  let blockId = 'N0';
  let segmentCount = 0;
  const segments: Segment[] = [];
  const drawPathsByBlock = new Map<string, DrawPath[]>();
  const drillByBlock = new Map<string, P[]>();
  let markerFlag = false;
  let curDraw: DrawPath | null = null;
  let pendingMarker: { blockId: string; point: P } | null = null;

  const toPoint = (x: number, y: number) => new P(x * mmPerUnit, y * mmPerUnit);
  const addDrill = (bid: string, pt: P) => {
    const arr = drillByBlock.get(bid) ?? [];
    if (!arr.some((q) => q.equals(pt, 1e-6))) arr.push(pt.clone());
    drillByBlock.set(bid, arr);
  };
  const flushPendingMarkerAsDrill = () => { if (pendingMarker) { addDrill(pendingMarker.blockId, pendingMarker.point); pendingMarker = null; } };
  const flushDrawPath = () => {
    if (!curDraw || curDraw.points.length < 2) { curDraw = null; return; }
    const arr = drawPathsByBlock.get(curDraw.blockId) ?? [];
    arr.push({ blockId: curDraw.blockId, startWithMarker: curDraw.startWithMarker, points: curDraw.points.map((p) => p.clone()) });
    drawPathsByBlock.set(curDraw.blockId, arr);
    curDraw = null;
  };
  const addOpenDrawPath = (bid: string, pts: P[], startWithMarker = false) => {
    if (pts.length < 2) return;
    const arr = drawPathsByBlock.get(bid) ?? [];
    arr.push({ blockId: bid, startWithMarker, points: pts.map((p) => p.clone()) });
    drawPathsByBlock.set(bid, arr);
  };
  const beginDrawPath = () => { if (last) curDraw = { blockId, points: [last.clone()], startWithMarker: markerFlag }; };
  const extractM19Notch = () => {
    if (!curDraw || curDraw.points.length < 2) return;
    const j = curDraw.points[curDraw.points.length - 1], te = curDraw.points[curDraw.points.length - 2];
    if (j.distanceTo(te) > 25) return;
    const lastSeg = segments[segments.length - 1];
    if (lastSeg && lastSeg.blockId === curDraw.blockId && lastSeg.from.equals(te, 1e-6) && lastSeg.to.equals(j, 1e-6)) segments.pop();
    addOpenDrawPath(curDraw.blockId, [te, j], false);
    curDraw.points.pop();
  };
  const parseCoord = (tok: string): { x?: number; y?: number; trailingM?: number } | null => {
    let m = tok.match(/^X(-?\d+)?Y(-?\d+)?(?:M(\d+))?$/i);
    if (m) return { x: m[1] !== undefined ? Number(m[1]) : undefined, y: m[2] !== undefined ? Number(m[2]) : undefined, trailingM: m[3] !== undefined ? Number(m[3]) : undefined };
    m = tok.match(/^X(-?\d+)(?:M(\d+))?$/i);
    if (m) return { x: Number(m[1]), trailingM: m[2] !== undefined ? Number(m[2]) : undefined };
    m = tok.match(/^Y(-?\d+)(?:M(\d+))?$/i);
    if (m) return { y: Number(m[1]), trailingM: m[2] !== undefined ? Number(m[2]) : undefined };
    return null;
  };

  let unparsed = 0;
  for (const tok of tokens) {
    const nm = tok.match(/^N(\d+)$/i);
    if (nm) { flushPendingMarkerAsDrill(); flushDrawPath(); blockId = `N${nm[1]}`; mode = 'move'; last = null; markerFlag = false; continue; }
    if (tok === 'M14') { if (pendingMarker && last && pendingMarker.blockId === blockId && pendingMarker.point.equals(last, 1e-6)) pendingMarker = null; mode = 'draw'; if (!curDraw) beginDrawPath(); continue; }
    if (tok === 'M15' || tok === 'M0') { flushPendingMarkerAsDrill(); flushDrawPath(); mode = 'move'; continue; }
    if (tok === 'M19') { extractM19Notch(); continue; }
    if (/^M\d+$/.test(tok) || /^D\d+$/i.test(tok) || /^H\d+$/i.test(tok)) continue;
    const oe = parseCoord(tok);
    if (!oe) { unparsed += 1; continue; }
    let bx: number | null = curX, by: number | null = curY;
    if (oe.x !== undefined) bx = oe.x;
    if (oe.y !== undefined) by = oe.y;
    if (bx === null || by === null || !Number.isFinite(bx) || !Number.isFinite(by)) { unparsed += 1; continue; }
    curX = bx; curY = by;
    const pt = toPoint(bx, by);
    if (pendingMarker && (!last || !pendingMarker.point.equals(pt, 1e-6))) flushPendingMarkerAsDrill();
    if (mode === 'draw' && last && !last.equals(pt, 1e-6)) {
      if (!curDraw) beginDrawPath();
      curDraw!.points.push(pt.clone());
      segments.push({ from: last, to: pt, blockId });
      segmentCount += 1;
    }
    last = pt;
    markerFlag = oe.trailingM === 43;
    if (markerFlag) pendingMarker = { blockId, point: pt.clone() };
    if (oe.trailingM !== undefined) {
      if (oe.trailingM === 14) { pendingMarker = null; mode = 'draw'; if (!curDraw) beginDrawPath(); }
      else if (oe.trailingM === 15 || oe.trailingM === 0) { flushPendingMarkerAsDrill(); flushDrawPath(); mode = 'move'; }
      else if (oe.trailingM === 19) extractM19Notch();
    }
  }
  flushPendingMarkerAsDrill();
  flushDrawPath();
  if (!segmentCount) throw new Error('CUT file contained no drawable geometry');

  // ---- contour extraction ------------------------------------------------------------------------
  const closedFromDrawPaths = extractClosedContoursFromDrawPaths(drawPathsByBlock);
  const fromSegments = extractClosedContoursByBlock(segments, keyTolMm, stitchMaxMm);
  const contoursByBlock = new Map<string, Contour[]>();
  const blockIds = [...new Set([...closedFromDrawPaths.keys(), ...fromSegments.contoursByBlock.keys()])];
  for (const bid of blockIds) {
    const drawn = closedFromDrawPaths.get(bid) ?? [];
    if (drawn.length) contoursByBlock.set(bid, drawn);
    else { const seg = fromSegments.contoursByBlock.get(bid) ?? []; if (seg.length) contoursByBlock.set(bid, seg); }
  }
  if (![...contoursByBlock.values()].reduce((n, c) => n + c.length, 0)) throw new Error('CUT file contained no closed contours to create pieces');

  // ---- build the repo pattern --------------------------------------------------------------------
  const pattern = createEmptyPattern();
  pattern.name = name;
  let pieceCount = 0, cutoutCount = 0, drillCount = 0;
  const piecesByBlock = new Map<string, { piece: Piece; contour: Polyline }[]>();
  for (const bid of blockIds) {
    const contours = contoursByBlock.get(bid) ?? [];
    const built = createPiecesFromContours(pattern, contours, bid);
    pieceCount += built.length;
    cutoutCount += built.reduce((n, b) => n + b.cutouts, 0);
    piecesByBlock.set(bid, built.map((b) => ({ piece: b.piece, contour: b.contour })));
  }
  // drill points → markers on the containing piece
  for (const [bid, points] of drillByBlock.entries()) {
    const built = piecesByBlock.get(bid) ?? [];
    if (!built.length) continue;
    for (const pt of points) {
      const target = findPieceForPoint(pt, built);
      if (!target) continue;
      const local = toPieceLocal(pt, target.piece, pattern);
      target.piece.markers = [...(target.piece.markers ?? []), { id: uid('PieceMarker'), type: 'drill', x: local.x, y: local.y } as PieceMarker];
      drillCount += 1;
    }
  }
  pattern.hasChanged = true;
  void cutoutCount; void drillCount;
  return pattern;
}

// Trace closed contours from accumulated draw-paths that already close on themselves.
function extractClosedContoursFromDrawPaths(byBlock: Map<string, DrawPath[]>): Map<string, Contour[]> {
  const out = new Map<string, Contour[]>();
  for (const [bid, paths] of byBlock.entries()) {
    const contours: Contour[] = [];
    for (const dp of paths) {
      if (dp.points.length < 3 || !dp.points[0].equals(dp.points[dp.points.length - 1], 1e-6)) continue;
      const pl = new Polyline(dp.points.map((p) => p.clone())); pl.isClosed = true;
      const area = pl.getArea();
      if (area < 0.001) continue;
      contours.push({ polyline: pl, area, firstPoint: pl.firstPoint.clone() });
    }
    if (contours.length) out.set(bid, contours);
  }
  return out;
}

// Stitch free segments per block into closed loops (graph walk with odd-degree-node bridging).
function extractClosedContoursByBlock(segments: Segment[], keyTolMm: number, stitchMaxMm: number) {
  const byBlock = new Map<string, Segment[]>();
  for (const s of segments) { const arr = byBlock.get(s.blockId) ?? []; arr.push(s); byBlock.set(s.blockId, arr); }
  const contoursByBlock = new Map<string, Contour[]>();
  for (const [bid, segs] of byBlock.entries()) {
    const contours = extractClosedContoursFromSegments(segs, keyTolMm, stitchMaxMm);
    if (contours.length) contoursByBlock.set(bid, contours);
  }
  return { contoursByBlock };
}

function extractClosedContoursFromSegments(segs: Segment[], keyTolMm: number, stitchMaxMm: number): Contour[] {
  const keyFor = (p: P) => `${Math.round(p.x / keyTolMm)},${Math.round(p.y / keyTolMm)}`;
  const pointByKey = new Map<string, P>();
  const adj = new Map<string, number[]>();
  const edges = segs.map((s) => {
    const fk = keyFor(s.from), tk = keyFor(s.to);
    if (!pointByKey.has(fk)) pointByKey.set(fk, s.from);
    if (!pointByKey.has(tk)) pointByKey.set(tk, s.to);
    return { fromKey: fk, toKey: tk, used: false };
  });
  const addAdj = (k: string, i: number) => { const arr = adj.get(k) ?? []; arr.push(i); adj.set(k, arr); };
  for (let i = 0; i < edges.length; i++) { addAdj(edges[i].fromKey, i); addAdj(edges[i].toKey, i); }
  const dist = (a: string, b: string) => { const pa = pointByKey.get(a), pb = pointByKey.get(b); return !pa || !pb ? Infinity : pa.sub(pb).length(); };
  const oddKeys = () => [...adj.entries()].filter(([, e]) => e.length % 2 === 1).map(([k]) => k);

  // bridge odd-degree nodes within stitch range so contours can close
  for (;;) {
    const odd = oddKeys();
    if (odd.length < 2) break;
    let best: { a: string; b: string; distance: number } | null = null;
    for (let m = 0; m < odd.length; m++) for (let g = m + 1; g < odd.length; g++) {
      const d = dist(odd[m], odd[g]);
      if (!Number.isFinite(d) || d > stitchMaxMm) continue;
      if (!best || d < best.distance) best = { a: odd[m], b: odd[g], distance: d };
    }
    if (!best) break;
    const idx = edges.length;
    edges.push({ fromKey: best.a, toKey: best.b, used: false });
    addAdj(best.a, idx); addAdj(best.b, idx);
  }

  const collect = (): Contour[] => {
    for (const e of edges) e.used = false;
    const out: Contour[] = [];
    const other = (ei: number, k: string) => (edges[ei].fromKey === k ? edges[ei].toKey : edges[ei].fromKey);
    for (let i = 0; i < edges.length; i++) {
      if (edges[i].used) continue;
      const e = edges[i]; e.used = true;
      const loop = [e.fromKey, e.toKey];
      let prev = e.fromKey, cur = e.toKey, closed = false;
      for (;;) {
        if (cur === loop[0] && loop.length > 2) { closed = true; break; }
        const cand = (adj.get(cur) ?? []).filter((c) => !edges[c].used);
        if (!cand.length) break;
        let pick = cand.find((c) => other(c, cur) !== prev);
        if (pick === undefined) pick = cand[0];
        if (pick === undefined) break;
        edges[pick].used = true;
        const next = other(pick, cur);
        loop.push(next); prev = cur; cur = next;
      }
      if (!closed || loop.length < 4) continue;
      const pts = loop.map((k) => pointByKey.get(k)).filter((p): p is P => !!p);
      if (pts.length < 4) continue;
      const pl = new Polyline(pts); pl.isClosed = true;
      const area = pl.getArea();
      if (area < 0.001) continue;
      out.push({ polyline: pl, area, firstPoint: pts[0] });
    }
    return out;
  };

  let contours = collect();
  if (!contours.length) {
    const odd = oddKeys();
    if (odd.length === 2) {
      const idx = edges.length;
      edges.push({ fromKey: odd[0], toKey: odd[1], used: false });
      addAdj(odd[0], idx); addAdj(odd[1], idx);
      contours = collect();
    }
  }
  return contours;
}

// Nest contours by containment; the outermost become piece boundaries, the contained become cutouts.
function createPiecesFromContours(pattern: Pattern, contours: Contour[], blockId: string) {
  const sorted = contours.map((c, i) => ({ ...c, index: i })).sort((a, b) => b.area - a.area);
  const parent = new Map<number, number | null>();
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    let p: number | null = null, pa = Infinity;
    for (let j = 0; j < sorted.length; j++) {
      if (i === j) continue;
      const o = sorted[j];
      if (o.area <= c.area) continue;
      if (o.polyline.isPointInside(c.firstPoint, true) && o.area < pa) { p = j; pa = o.area; }
    }
    parent.set(i, p);
  }
  const tops = sorted.map((_, i) => i).filter((i) => parent.get(i) === null);
  const built: { piece: Piece; contour: Polyline; cutouts: number }[] = [];
  for (let h = 0; h < tops.length; h++) {
    const outerIdx = tops[h];
    const outer = normalizeWinding(sorted[outerIdx].polyline, 'ccw');
    const cutoutIdxs = sorted.map((_, j) => j).filter((j) => parent.get(j) === outerIdx).sort((a, b) => sorted[b].area - sorted[a].area);
    const cutouts = cutoutIdxs.map((j) => normalizeWinding(sorted[j].polyline, 'cw'));
    const piece = buildPiece(pattern, outer, cutouts, `${blockId} Piece ${h + 1}`);
    built.push({ piece, contour: outer.clone(), cutouts: cutouts.length });
  }
  return built;
}

function normalizeWinding(pl: Polyline, want: 'cw' | 'ccw') {
  const out = pl.clone(); out.isClosed = true;
  if (out.points.length < 3) return out;
  const isCw = out.isClockwise();
  if ((want === 'cw') !== isCw) out.points.reverse();
  return out;
}

// Build a repo Piece (boundary loop of straight edges) + closed internalPaths for cutouts.
function buildPiece(pattern: Pattern, outer: Polyline, cutouts: Polyline[], name: string): Piece {
  const addLoop = (pts: P[]) => {
    const ids = pts.map((v) => { const id = uid('ConstrainablePoint'); pattern.points.push({ id, name: `${pattern.pointPrefix || 'A'}${pattern.points.length}`, x: v.x, y: v.y }); return id; });
    const piecePaths: PiecePath[] = [];
    for (let i = 0; i < ids.length; i++) {
      const j = (i + 1) % ids.length;
      const path: ConstrainablePath = { id: uid('ConstrainablePath'), name: '', pathType: 'line', pathPoints: [{ id: ids[i] }, { id: ids[j] }] as PathPoint[], version: 1 };
      pattern.paths.push(path);
      piecePaths.push({ id: uid('PiecePath'), name: '', path: path.id, from: ids[i], to: ids[j], reversed: false, notches: [] });
    }
    return { ids, piecePaths };
  };
  const dedupe = (pts: P[]) => { const out: P[] = []; for (const p of pts) { const last = out[out.length - 1]; if (!last || last.distanceTo(p) > 1e-3) out.push(p); } if (out.length > 2 && out[0].distanceTo(out[out.length - 1]) < 1e-3) out.pop(); return out; };

  const outerPts = dedupe(outer.points);
  const main = addLoop(outerPts);
  const internalPaths: PiecePath[] = [];
  for (const co of cutouts) {
    const cp = dedupe(co.points);
    if (cp.length < 3) continue;
    internalPaths.push(...addLoop(cp).piecePaths);
  }
  const op = pattern.points.find((q) => q.id === main.ids[0])!;
  const piece: Piece = {
    id: uid('Piece'), name, type: 'dynamic',
    materialId: pattern.materials[0]?.id ?? '', origin: { id: uid('Point'), name: '', x: 0, y: 0 },
    originPoint: main.ids[0], position: { x: op.x, y: op.y }, rotation: 0,
    grainVector: { id: uid('Point'), name: '', x: 0, y: 1 }, text: null,
    rightPieces: 0, leftPieces: 0, mirrorLeftPiecesAxis: 'X', mirrorX: false, mirrorY: false,
    seamAllowanceInside: false, mainPaths: main.piecePaths, internalPaths,
    settings3d: {
      arrangement: { mode: 'flat', cylinderName: '', uDegrees: 0, v: 0.5, uOffsetMm: 0, vOffsetMm: 0, radialOffsetMm: 0, use2DPosition: true, positionChanged: false, matrixWorld: [], position: [] },
      enable3d: true, frozen: false, flipNormals: false, filterExternalCollisionsByClothNormal: false, collisionLayer: 0, savedPositions: []
    }
  };
  pattern.pieces.push(piece);
  return piece;
}

/** Convert a world (drafting-space) point to the piece-local frame markers are stored in. */
function toPieceLocal(pt: P, piece: Piece, pattern: Pattern) {
  const op = pattern.points.find((q) => q.id === piece.originPoint);
  return { x: pt.x - (op?.x ?? 0), y: pt.y - (op?.y ?? 0) };
}

function findPieceForPoint(pt: P, built: { piece: Piece; contour: Polyline }[]) {
  let best: { piece: Piece; contour: Polyline } | null = null, score = -Infinity;
  for (const b of built) {
    let s = b.contour.isPointInside(pt, true) ? 2 : -1;
    if (s > score) { score = s; best = b; }
  }
  return best;
}
