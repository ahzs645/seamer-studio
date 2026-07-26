// Shared resolution of the real Seamer schema into renderable 2D geometry.
// Used by the 2D canvas (display) and by the 3D boundary/triangulation builder (Phase 4).
// All coordinates are in millimeters.
//
// Piece outlines are built by: (1) resolving each mainPath into a polyline along its referenced
// ConstrainablePath between the `from` and `to` points (which may be sliding points lying ON the
// path), then (2) stitching the edges into a single closed loop by matching shared endpoints
// (the mainPaths array is NOT guaranteed to already be in boundary order/orientation).

import type { Pattern, ConstrainablePoint, ConstrainablePath, PathPoint, PiecePath, Piece, Seam } from '../pattern';
import {
  applyCornerJoins,
  cubicAt as geometryCubicAt,
  cubicLength as geometryCubicLength,
  offsetPolygon,
  offsetPolygonVariable,
  pointInPolygon,
  polygonCentroid as geometryPolygonCentroid,
  reflectAcrossLine,
  resamplePolyline as geometryResamplePolyline,
  type CornerJoin,
  type CubicSegment as GeometryCubicSegment,
  type Vec2
} from '@atelier/geometry';

export {
  applyCornerJoins,
  offsetPolygon,
  offsetPolygonVariable,
  pointInPolygon,
  reflectAcrossLine,
  type CornerJoin,
  type Vec2
};

/**
 * Preserve the legacy empty-input result (`NaN`, `NaN`). Atelier returns the more defensive
 * origin, but changing this public helper would hide invalid empty piece outlines from callers.
 */
export function polygonCentroid(poly: Vec2[]): Vec2 {
  return poly.length === 0 ? { x: Number.NaN, y: Number.NaN } : geometryPolygonCentroid(poly);
}

/** Preserve the legacy RangeError for nonsensical negative counts; delegate valid work to Atelier. */
export function resamplePolyline(poly: Vec2[], n: number): Vec2[] {
  if (poly.length > 0 && n < 0) throw new RangeError('Invalid array length');
  return geometryResamplePolyline(poly, n);
}

/** A piece-local point mapped to its placed position on the 2D plan. */
export type Transform = (p: Vec2) => Vec2;

export interface CubicSegment {
  a: Vec2;
  c1: Vec2;
  c2: Vec2;
  b: Vec2;
  curve: boolean;
}

const geometryCubic = (segment: CubicSegment): GeometryCubicSegment => ({
  p0: segment.a,
  c0: segment.c1,
  c1: segment.c2,
  p1: segment.b
});

/**
 * Adapt Seamer's public segment shape and retain its `curve: false` linear semantics. Atelier's
 * evaluator deliberately has no curve flag and would otherwise honour arbitrary control points.
 */
export function cubicAt(segment: CubicSegment, t: number): Vec2 {
  return segment.curve
    ? geometryCubicAt(geometryCubic(segment), t)
    : {
        x: segment.a.x + (segment.b.x - segment.a.x) * t,
        y: segment.a.y + (segment.b.y - segment.a.y) * t
      };
}

/** Use Atelier for normal curve lengths while preserving Seamer's public edge-case semantics. */
export function segmentLength(segment: CubicSegment, samples = 24): number {
  if (!segment.curve) return Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
  if (Number.isInteger(samples) && samples >= 1) {
    return geometryCubicLength(geometryCubic(segment), samples);
  }
  let length = 0;
  let previous = segment.a;
  for (let i = 1; i <= samples; i += 1) {
    const point = cubicAt(segment, i / samples);
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  return length;
}

export function indexPoints(pattern: Pattern): Map<string, ConstrainablePoint> {
  const m = new Map<string, ConstrainablePoint>();
  for (const p of pattern.points) m.set(p.id, p);
  return m;
}

export function indexPaths(pattern: Pattern): Map<string, ConstrainablePath> {
  const m = new Map<string, ConstrainablePath>();
  for (const p of pattern.paths) m.set(p.id, p);
  return m;
}

export function indexPiecePaths(pattern: Pattern): Map<string, PiecePath> {
  const m = new Map<string, PiecePath>();
  for (const piece of pattern.pieces) {
    for (const pp of piece.mainPaths) m.set(pp.id, pp);
    for (const pp of piece.internalPaths) m.set(pp.id, pp);
  }
  return m;
}

/** Ordered cubic segments between a ConstrainablePath's successive anchor points. */
export function pathSegments(
  path: ConstrainablePath,
  points: Map<string, ConstrainablePoint>
): CubicSegment[] {
  const anchors: { pt: ConstrainablePoint; handle: PathPoint['handle'] }[] = [];
  for (const pp of path.pathPoints) {
    const pt = points.get(pp.id);
    if (pt) anchors.push({ pt, handle: pp.handle });
  }
  const segs: CubicSegment[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const A = anchors[i];
    const B = anchors[i + 1];
    const a: Vec2 = { x: A.pt.x, y: A.pt.y };
    const b: Vec2 = { x: B.pt.x, y: B.pt.y };
    const out = A.handle?.v2;
    const inc = B.handle?.v1;
    const curve = !!(out || inc);
    const c1: Vec2 = out ? { x: a.x + out.x, y: a.y + out.y } : { x: a.x, y: a.y };
    const c2: Vec2 = inc ? { x: b.x + inc.x, y: b.y + inc.y } : { x: b.x, y: b.y };
    segs.push({ a, c1, c2, b, curve });
  }
  return segs;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Flatten a path's full geometry into a dense ordered polyline (anchor order). */
export function pathPolyline(
  path: ConstrainablePath,
  points: Map<string, ConstrainablePoint>,
  spacingMm = 4
): Vec2[] {
  const segs = pathSegments(path, points);
  const pts: Vec2[] = [];
  const push = (p: Vec2) => {
    const last = pts[pts.length - 1];
    if (!last || dist(last, p) > 1e-6) pts.push(p);
  };
  for (const s of segs) {
    if (!s.curve) {
      push(s.a);
      push(s.b);
    } else {
      const n = Math.max(2, Math.ceil(segmentLength(s) / spacingMm));
      for (let i = 0; i <= n; i++) push(cubicAt(s, i / n));
    }
  }
  return pts;
}

function nearestIndex(poly: Vec2[], target?: ConstrainablePoint): number {
  if (!target) return 0;
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = dist(poly[i], target);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/**
 * Resolve a PiecePath into a polyline oriented from `from` to `to`, sliced from its referenced
 * path between the (possibly interior / sliding) endpoints. Honors the `reversed` flag.
 */
export function piecePathPolyline(
  pp: PiecePath,
  paths: Map<string, ConstrainablePath>,
  points: Map<string, ConstrainablePoint>,
  spacingMm = 4
): Vec2[] {
  const path = paths.get(pp.path);
  const fromPt = points.get(pp.from);
  const toPt = points.get(pp.to);
  if (!path) {
    return fromPt && toPt ? [fromPt, toPt] : [];
  }
  const chord = (): Vec2[] => (fromPt && toPt ? [{ x: fromPt.x, y: fromPt.y }, { x: toPt.x, y: toPt.y }] : []);
  const full = pathPolyline(path, points, spacingMm);
  if (full.length < 2 || !fromPt || !toPt) return chord();

  const iFrom = nearestIndex(full, fromPt);
  const iTo = nearestIndex(full, toPt);
  // If the endpoints land on the same/adjacent samples the path is too coarse to represent the
  // span (e.g. an interior span of a straight line) — use the straight chord instead.
  if (Math.abs(iFrom - iTo) < 1) return chord();

  let slice = iFrom <= iTo ? full.slice(iFrom, iTo + 1) : full.slice(iTo, iFrom + 1).reverse();
  // Orient from `from` to `to`.
  if (dist(slice[0], fromPt) > dist(slice[slice.length - 1], fromPt)) slice = slice.slice().reverse();
  // Reject a span that doesn't actually connect the two endpoints (coarse/interior mismatch).
  if (dist(slice[0], fromPt) > 2 || dist(slice[slice.length - 1], toPt) > 2) return chord();
  slice[0] = { x: fromPt.x, y: fromPt.y };
  slice[slice.length - 1] = { x: toPt.x, y: toPt.y };
  if (pp.reversed) slice = slice.slice().reverse();
  return slice;
}

/**
 * Build a single closed boundary polyline for a piece by stitching its mainPath edges on shared
 * endpoints. Robust to arbitrary edge order/orientation.
 */
/**
 * Turn a half-piece boundary loop into the full symmetric outline by mirroring across the fold line
 * (a→b). Interior points lying on the fold are dropped; the remaining free boundary is reflected and
 * appended so the result is a closed loop covering both halves. Used for first-edge symmetry.
 */
export function mirrorHalfOutline(loop: Vec2[], a: Vec2, b: Vec2): Vec2[] {
  if (loop.length < 2) return loop;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const onFoldInterior = (p: Vec2): boolean => {
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    const fx = a.x + t * dx, fy = a.y + t * dy;
    const perp = Math.hypot(p.x - fx, p.y - fy);
    return perp < 0.5 && t > 0.02 && t < 0.98; // on the fold, strictly between the endpoints
  };
  const free = loop.filter((p) => !onFoldInterior(p));
  const reflected = free.map((p) => reflectAcrossLine(p, a, b)).reverse();
  const full = [...free, ...reflected];
  // drop consecutive (near-)duplicate vertices created at the two fold endpoints
  const out: Vec2[] = [];
  for (const p of full) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-4) out.push(p);
  }
  return out;
}

/** The fold-line endpoints (drafting space) for a piece's first main edge, or null. */
function firstEdgeEndpoints(piece: Piece, points: Map<string, ConstrainablePoint>): { a: Vec2; b: Vec2 } | null {
  const fold = piece.mainPaths[0];
  if (!fold) return null;
  const a = points.get(fold.from), b = points.get(fold.to);
  if (!a || !b) return null;
  return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
}

/** The piece's mirror axis in drafting space: an explicit isMirrorLine path wins, else the
 *  first-edge fold when firstEdgeSymmetry is set. Null when the piece has no mirrored half. */
export function pieceMirrorAxis(piece: Piece, points: Map<string, ConstrainablePoint>): { a: Vec2; b: Vec2 } | null {
  const ml = [...piece.mainPaths, ...piece.internalPaths].find((pp) => pp.isMirrorLine);
  if (ml) {
    const a = points.get(ml.from), b = points.get(ml.to);
    if (a && b) return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
  }
  if (piece.firstEdgeSymmetry) return firstEdgeEndpoints(piece, points);
  return null;
}

export function pieceOutline(
  pattern: Pattern,
  piece: Piece,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): Vec2[] {
  const edges = piece.mainPaths.map((pp) => piecePathPolyline(pp, paths, points, spacingMm)).filter((e) => e.length >= 2);
  if (edges.length === 0) return [];

  const used = new Array(edges.length).fill(false);
  const tol = 1.0; // mm
  const loop: Vec2[] = [...edges[0]];
  used[0] = true;
  let guard = edges.length * 2;
  while (guard-- > 0) {
    const tail = loop[loop.length - 1];
    let found = -1;
    let flip = false;
    let bestGap = tol;
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const e = edges[i];
      const dStart = dist(tail, e[0]);
      const dEnd = dist(tail, e[e.length - 1]);
      if (dStart <= bestGap) { bestGap = dStart; found = i; flip = false; }
      if (dEnd <= bestGap) { bestGap = dEnd; found = i; flip = true; }
    }
    if (found === -1) break;
    used[found] = true;
    const e = flip ? edges[found].slice().reverse() : edges[found];
    for (let k = 1; k < e.length; k++) loop.push(e[k]);
  }
  if (piece.firstEdgeSymmetry) {
    const fe = firstEdgeEndpoints(piece, points);
    if (fe) return mirrorHalfOutline(loop, fe.a, fe.b);
  }
  return loop;
}

/** Internal paths (darts, internal seams) as individual polylines. */
export function pieceInternalPolylines(
  pattern: Pattern,
  piece: Piece,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): Vec2[][] {
  return piece.internalPaths.map((pp) => piecePathPolyline(pp, paths, points, spacingMm)).filter((e) => e.length >= 2);
}

/**
 * A compact fingerprint of a piece's RESOLVED 2D geometry: its stitched outline, internal lines, grain
 * direction, and particle spacing. It changes whenever the piece's shape changes — moving a point,
 * dragging a bézier handle, retargeting a path — because those all alter the flattened polylines.
 * The 3D view uses this to (a) trigger a rebuild when a shape is edited and (b) detect WHICH pieces
 * changed, so only those re-triangulate from live geometry while the rest keep their cached drape.
 * Rounded to 0.1 mm to absorb float jitter that should not force a rebuild.
 */
export function pieceGeometrySignature(pattern: Pattern, piece: Piece): string {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const r = (n: number) => Math.round(n * 10) / 10; // 0.1 mm
  const enc = (poly: Vec2[]) => poly.map((p) => `${r(p.x)},${r(p.y)}`).join(' ');
  const outline = enc(pieceOutline(pattern, piece, paths, points, 4));
  const internals = pieceInternalPolylines(pattern, piece, paths, points, 4).map(enc).join('|');
  const g = piece.grainVector ?? { x: 0, y: 1 };
  // the mirror/fold line changes the 3D cloth (it reflects across it), so it must affect the signature
  const mirror = piece.mainPaths.find((pp) => pp.isMirrorLine)?.id ?? '';
  // baked-texture inputs: which internal lines show in 3D (toggling must refresh the piece map)
  const shown3d = piece.internalPaths.filter((pp) => pp.showIn3d !== false).map((pp) => pp.id).join(',');
  return `${outline}#${internals}#g${r(g.x)},${r(g.y)}#pd${piece.settings3d.particleDistance ?? ''}#m${mirror}#i3d${shown3d}`;
}

// ---------------------------------------------------------------------------
// 2D-plan placement (matches the original app's pattern layout).
//
// A ConstrainablePoint lives in shared drafting space; the same point can be
// referenced by several pieces (e.g. a piece and its mirrored copy). Each piece
// is *placed* on the plan by its own transform, so its geometry must be mapped
// from drafting space into world (canvas) space before drawing or hit-testing:
//
//   local = mirror(P - originPoint)        // mirrorX/Y about the origin point
//   world = position + rotate(local, θ)    // rotate by piece.rotation, translate
//
// `piece.origin` caches (position - originPoint); we recompute from the live
// origin point so edits to that point keep the placement correct.
// ---------------------------------------------------------------------------

/**
 * How many times a piece is cut: `asIs` straight copies plus `mirrored` reflected copies
 * (left/right pairs). A piece with no counts set is cut once. `total` is always ≥ 1.
 */
export function pieceCutCounts(piece: Piece): { asIs: number; mirrored: number; total: number } {
  const right = piece.rightPieces ?? 0;
  const left = piece.leftPieces ?? 0;
  const asIs = right > 0 ? right : left > 0 ? 0 : 1;
  return { asIs, mirrored: left, total: Math.max(1, asIs + left) };
}

/** Build the drafting-space → plan-space transform for a piece. */
/**
 * Per-piece shrinkage scale factors (about the piece origin, in the local frame). Returns {1,1}
 * unless the piece opts in via `useMaterialScaling` AND its assigned material declares a non-zero
 * shrinkage %. A material that shrinks h% is compensated by cutting (1 + h/100)× larger.
 */
export function pieceShrinkageScale(pattern: Pattern, piece: Piece): { x: number; y: number } {
  if (!piece.useMaterialScaling) return { x: 1, y: 1 };
  const mat = pattern.materials.find((m) => m.id === piece.materialId);
  if (!mat) return { x: 1, y: 1 };
  const f = (pct?: number) => (Number.isFinite(pct) && pct ? Math.max(0.0001, 1 + (pct as number) / 100) : 1);
  return { x: f(mat.shrinkageHorizontalPercentage), y: f(mat.shrinkageVerticalPercentage) };
}

export function pieceTransform(
  piece: Piece,
  points: Map<string, ConstrainablePoint>,
  scale: { x: number; y: number } = { x: 1, y: 1 }
): Transform {
  const op = points.get(piece.originPoint);
  const ox = op ? op.x : 0;
  const oy = op ? op.y : 0;
  const rad = ((piece.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mx = piece.mirrorX ? -1 : 1;
  const my = piece.mirrorY ? -1 : 1;
  const px = piece.position?.x ?? 0;
  const py = piece.position?.y ?? 0;
  return (p: Vec2): Vec2 => {
    const lx = (p.x - ox) * mx * scale.x;
    const ly = (p.y - oy) * my * scale.y;
    return { x: px + lx * cos - ly * sin, y: py + lx * sin + ly * cos };
  };
}

function applyTransform(poly: Vec2[], t: Transform): Vec2[] {
  return poly.map(t);
}

/** Piece boundary outline placed on the plan (drafting space → world). */
export function pieceWorldOutline(
  pattern: Pattern,
  piece: Piece,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): Vec2[] {
  return applyTransform(pieceOutline(pattern, piece, paths, points, spacingMm), pieceTransform(piece, points, pieceShrinkageScale(pattern, piece)));
}

/** Internal piece paths (darts, fold lines) placed on the plan. */
export function pieceWorldInternalPolylines(
  pattern: Pattern,
  piece: Piece,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): Vec2[][] {
  const t = pieceTransform(piece, points, pieceShrinkageScale(pattern, piece));
  return pieceInternalPolylines(pattern, piece, paths, points, spacingMm).map((poly) => applyTransform(poly, t));
}

export interface PlacedPoint {
  pointId: string;
  pieceId: string;
  world: Vec2;
  /** invert: map a world position back to a drafting-space coordinate for this piece. */
  invert: Transform;
}

/** Inverse of pieceTransform: world → drafting space (for dragging placed points). */
export function pieceInverseTransform(
  piece: Piece,
  points: Map<string, ConstrainablePoint>
): Transform {
  const op = points.get(piece.originPoint);
  const ox = op ? op.x : 0;
  const oy = op ? op.y : 0;
  const rad = ((piece.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mx = piece.mirrorX ? -1 : 1;
  const my = piece.mirrorY ? -1 : 1;
  const px = piece.position?.x ?? 0;
  const py = piece.position?.y ?? 0;
  return (w: Vec2): Vec2 => {
    const dx = w.x - px;
    const dy = w.y - py;
    // inverse rotation
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    return { x: lx * mx + ox, y: ly * my + oy };
  };
}

/**
 * Every ConstrainablePoint as it appears on the plan — one entry per (piece,point)
 * pair plus loose points not used by any piece. Used for hit-testing and dragging.
 */
export function placedPoints(
  pattern: Pattern,
  points = indexPoints(pattern)
): PlacedPoint[] {
  const out: PlacedPoint[] = [];
  const seen = new Set<string>();
  for (const piece of pattern.pieces) {
    const t = pieceTransform(piece, points);
    const inv = pieceInverseTransform(piece, points);
    const ids = new Set<string>();
    for (const pp of piece.mainPaths) { ids.add(pp.from); ids.add(pp.to); }
    for (const pp of piece.internalPaths) { ids.add(pp.from); ids.add(pp.to); }
    // include all anchor points of the referenced paths so curve anchors are draggable too
    for (const pp of [...piece.mainPaths, ...piece.internalPaths]) {
      const path = pattern.paths.find((p) => p.id === pp.path);
      if (path) for (const ap of path.pathPoints) ids.add(ap.id);
    }
    for (const id of ids) {
      const p = points.get(id);
      if (!p) continue;
      out.push({ pointId: id, pieceId: piece.id, world: t(p), invert: inv });
      seen.add(id);
    }
  }
  for (const p of pattern.points) {
    if (seen.has(p.id)) continue;
    out.push({ pointId: p.id, pieceId: '', world: { x: p.x, y: p.y }, invert: (w) => w });
  }
  return out;
}

/** Map a PiecePath id to its owning piece and the PiecePath itself. */
export function indexPiecePathOwners(pattern: Pattern): Map<string, { piece: Piece; pp: PiecePath }> {
  const m = new Map<string, { piece: Piece; pp: PiecePath }>();
  for (const piece of pattern.pieces) {
    for (const pp of piece.mainPaths) m.set(pp.id, { piece, pp });
    for (const pp of piece.internalPaths) m.set(pp.id, { piece, pp });
  }
  return m;
}

/** Human label for one side of a seam: "PieceName: EdgeName" (resolved through the owner index). */
function seamRefLabel(
  pattern: Pattern,
  ref: { id: string },
  owners: Map<string, { piece: Piece; pp: PiecePath }>
): string {
  const owner = owners.get(ref.id);
  if (!owner) return ref.id;
  const edge = owner.pp.name || pattern.paths.find((p) => p.id === owner.pp.path)?.name || owner.pp.path;
  return `${owner.piece.name}: ${edge}`;
}

/**
 * Faithful seam label matching the original app's getSeamTitle:
 *   - "Unassigned seam" when a side has no entries
 *   - "Seam (N -> M)" when either side has more than one entry
 *   - "Piece2: LineA8A4 -> Piece: LineA2A3 (mirrored) (reversed)" otherwise
 * Falls back to a stored seam.name if one was set.
 */
export function seamLabel(
  pattern: Pattern,
  seam: Seam,
  owners: Map<string, { piece: Piece; pp: PiecePath }> = indexPiecePathOwners(pattern)
): string {
  if (seam.name && seam.name.trim()) return seam.name;
  const from = seam.fromPaths[0];
  const to = seam.toPaths[0];
  if (!from || !to) return 'Unassigned seam';
  if (seam.fromPaths.length !== 1 || seam.toPaths.length !== 1) {
    return `Seam (${seam.fromPaths.length} -> ${seam.toPaths.length})`;
  }
  const mirrored = from.mirrored || to.mirrored ? ' (mirrored)' : '';
  const reversed = from.reversed || to.reversed ? ' (reversed)' : '';
  return `${seamRefLabel(pattern, from, owners)} -> ${seamRefLabel(pattern, to, owners)}${mirrored}${reversed}`;
}

export interface SeamGeometry {
  id: string;
  /** index of the seam in pattern.seams (drives its colour) */
  index: number;
  /** ids of the pieces this seam joins */
  pieceIds: string[];
  /** the two sewn edges, placed on the plan */
  fromEdge: Vec2[];
  toEdge: Vec2[];
  /** rung lines tying corresponding points on the two edges together */
  rungs: { a: Vec2; b: Vec2 }[];
}

/** The original app's per-seam colour: golden-angle hue spacing so adjacent seams stay distinct. */
export function seamColor(index: number): string {
  return `hsl(${(Math.max(0, index) * 137.508) % 360}, 70%, 45%)`;
}

/**
 * Resolve a notch to its arc-length ratio along a piece edge. Anchored notches (referencePointId +
 * distance, the original's "Distance from point") measure `distance` mm from the referenced
 * endpoint; otherwise the parametric `position` (0..1) applies.
 */
export function notchRatio(
  notch: { position?: number; referencePointId?: string; distance?: number },
  pp: PiecePath,
  paths: Map<string, ConstrainablePath>,
  points: Map<string, ConstrainablePoint>
): number {
  if (notch.referencePointId && typeof notch.distance === 'number' && Number.isFinite(notch.distance)) {
    const poly = piecePathPolyline(pp, paths, points, 2);
    const len = polylineLength(poly);
    if (len > 1e-6) {
      const r = Math.max(0, Math.min(1, notch.distance / len));
      return notch.referencePointId === pp.to ? 1 - r : r;
    }
  }
  return typeof notch.position === 'number' ? notch.position : 0.5;
}

/**
 * Resolve a seam's two sides into placed (world) polylines and the connector
 * "rungs" the original app draws between them as red dashed lines — this is what
 * makes the 2D pieces read as *connected*.
 */
export function seamGeometry(
  pattern: Pattern,
  seam: Seam,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  owners = indexPiecePathOwners(pattern),
  spacingMm = 4
): SeamGeometry | null {
  const pieceIds = new Set<string>();
  const side = (refs: Seam['fromPaths']): Vec2[] => {
    const segs: Vec2[] = [];
    for (const ref of refs) {
      const owner = owners.get(ref.id);
      if (!owner) continue;
      pieceIds.add(owner.piece.id);
      const t = pieceTransform(owner.piece, points);
      let raw = piecePathPolyline(owner.pp, paths, points, spacingMm);
      if (ref.mirrored) {
        // a ref into the mirrored half: reflect across the piece's mirror axis (draft space)
        const ax = pieceMirrorAxis(owner.piece, points);
        if (ax) raw = raw.map((pt) => reflectAcrossLine(pt, ax.a, ax.b));
      }
      let poly = applyTransform(raw, t);
      if (ref.reversed) poly = poly.slice().reverse();
      if (segs.length && poly.length) segs.push(...poly.slice(1));
      else segs.push(...poly);
    }
    return segs;
  };
  const fromEdge = side(seam.fromPaths);
  const toEdge = side(seam.toPaths);
  if (fromEdge.length < 2 || toEdge.length < 2) return null;

  const n = Math.max(2, Math.min(8, Math.round(Math.max(
    polylineLength(fromEdge), polylineLength(toEdge)
  ) / 60)));
  const a = resamplePolyline(fromEdge, n);
  const b = resamplePolyline(toEdge, n);
  const rungs = a.map((p, i) => ({ a: p, b: b[i] }));
  const index = pattern.seams.indexOf(seam);
  return { id: seam.id, index, pieceIds: [...pieceIds], fromEdge, toEdge, rungs };
}

function polylineLength(poly: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) len += dist(poly[i - 1], poly[i]);
  return len;
}

export function allSeamGeometry(
  pattern: Pattern,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): SeamGeometry[] {
  const owners = indexPiecePathOwners(pattern);
  const out: SeamGeometry[] = [];
  for (const seam of pattern.seams) {
    const g = seamGeometry(pattern, seam, paths, points, owners, spacingMm);
    if (g) out.push(g);
  }
  return out;
}

// --- Seam-allowance corner joins -------------------------------------------------------------
// The seam-allowance cut line is the boundary outline offset by the allowance. Where two edges
// meet, the corner can be finished in the original's full vocabulary (Seamly/Valentina lineage):
//   intersection        — extend both offset edges to their miter point (optionally capped)
//   radius              — round the corner with a fillet arc of the given radius
//   byLength            — chamfer the corner square at a fixed distance from the corner
//   noJoin              — no corner material: allowance pinches back to the true corner point
//   firstEdgeSymmetry   — cut along the FIRST original edge mirrored across the second offset edge
//   secondEdgeSymmetry  — cut along the SECOND original edge mirrored across the first offset edge
//   firstEdgeRightAngle — cut perpendicular to the first edge through the true corner
//   secondEdgeRightAngle— cut perpendicular to the second edge through the true corner
/**
 * Stitch a piece's boundary like pieceOutline, but also return, per outline segment i (from vertex i
 * to vertex i+1), the id of the mainPath that produced it — so per-edge widths can be applied.
 */
export function pieceOutlineTagged(
  pattern: Pattern,
  piece: Piece,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): { pts: Vec2[]; edgeOf: string[] } {
  const edges = piece.mainPaths
    .map((pp) => ({ id: pp.id, poly: piecePathPolyline(pp, paths, points, spacingMm) }))
    .filter((e) => e.poly.length >= 2);
  if (edges.length === 0) return { pts: [], edgeOf: [] };
  const used = new Array(edges.length).fill(false);
  const tol = 1.0;
  const loop: Vec2[] = [...edges[0].poly];
  const edgeOf: string[] = [];
  for (let k = 1; k < edges[0].poly.length; k++) edgeOf.push(edges[0].id);
  used[0] = true;
  let guard = edges.length * 2;
  while (guard-- > 0) {
    const tail = loop[loop.length - 1];
    let found = -1, flip = false, bestGap = tol;
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const e = edges[i].poly;
      const dStart = dist(tail, e[0]);
      const dEnd = dist(tail, e[e.length - 1]);
      if (dStart <= bestGap) { bestGap = dStart; found = i; flip = false; }
      if (dEnd <= bestGap) { bestGap = dEnd; found = i; flip = true; }
    }
    if (found === -1) break;
    used[found] = true;
    const e = flip ? edges[found].poly.slice().reverse() : edges[found].poly;
    for (let k = 1; k < e.length; k++) { loop.push(e[k]); edgeOf.push(edges[found].id); }
  }
  edgeOf.push(edgeOf[edgeOf.length - 1] ?? edges[0].id); // closing segment
  return { pts: loop, edgeOf };
}

/**
 * The seam-allowance cut-line polygon for a piece, placed on the plan, with per-edge corner joins
 * applied. `signedDist` is the allowance width (negative => inside the seam line). When any boundary
 * edge carries a per-edge seamAllowance override, a variable-width offset is used. Shared by the 2D
 * canvas and the exporters so both render identical corners.
 */
export function pieceAllowancePolygon(
  pattern: Pattern,
  piece: Piece,
  signedDist: number,
  paths = indexPaths(pattern),
  points = indexPoints(pattern),
  spacingMm = 4
): Vec2[] {
  if (Math.abs(signedDist) < 0.05) return [];
  const inside = signedDist < 0 ? -1 : 1;
  const baseMag = Math.abs(signedDist);
  const hasPerEdge = piece.mainPaths.some((pp) => pp.seamAllowance !== undefined && pp.seamAllowance !== baseMag);

  const shrink = pieceShrinkageScale(pattern, piece);
  let outline: Vec2[];
  let allow: Vec2[];
  if (hasPerEdge) {
    const tagged = pieceOutlineTagged(pattern, piece, paths, points, spacingMm);
    if (tagged.pts.length < 3) return [];
    const tf = pieceTransform(piece, points, shrink);
    outline = tagged.pts.map(tf);
    const widthById = new Map(piece.mainPaths.map((pp) => [pp.id, inside * (pp.seamAllowance ?? baseMag)]));
    allow = offsetPolygonVariable(outline, (i) => widthById.get(tagged.edgeOf[i]) ?? inside * baseMag);
  } else {
    outline = pieceWorldOutline(pattern, piece, paths, points, spacingMm);
    if (outline.length < 3) return [];
    allow = offsetPolygon(outline, signedDist);
  }
  const tf = pieceTransform(piece, points, shrink);
  const joins: { p: Vec2; join: CornerJoin }[] = [];
  // "uncovered" endpoints (cover flag false) cut the allowance corner back square — collected first
  // so they win over any styling join at the same point.
  const cuts: { p: Vec2; join: CornerJoin }[] = [];
  const squareCut: CornerJoin = { type: 'byLength', length: baseMag };
  for (const pp of piece.mainPaths) {
    const fp = points.get(pp.from), tp = points.get(pp.to);
    if (pp.coverSeamAllowanceStart === false && fp) cuts.push({ p: tf({ x: fp.x, y: fp.y }), join: squareCut });
    if (pp.coverSeamAllowanceEnd === false && tp) cuts.push({ p: tf({ x: tp.x, y: tp.y }), join: squareCut });
    const type = (pp.seamCornerJoinType ?? 'intersection') as CornerJoin['type'];
    const active = type === 'intersection' ? (pp.seamCornerMaxLength ?? 0) > 0 : true;
    if (!active) continue;
    const join: CornerJoin = { type, radius: pp.cornerRadius ?? 0, maxLength: pp.seamCornerMaxLength ?? 0, length: pp.seamCornerLength ?? 0 };
    if (fp) joins.push({ p: tf({ x: fp.x, y: fp.y }), join });
    if (tp) joins.push({ p: tf({ x: tp.x, y: tp.y }), join });
  }
  if (!joins.length && !cuts.length) return allow;
  const joinFor = (c: Vec2): CornerJoin | null => {
    for (const j of cuts) if (Math.hypot(j.p.x - c.x, j.p.y - c.y) < 1.5) return j.join;
    for (const j of joins) if (Math.hypot(j.p.x - c.x, j.p.y - c.y) < 1.5) return j.join;
    return null;
  };
  return applyCornerJoins(allow, outline, joinFor, Math.abs(signedDist));
}
