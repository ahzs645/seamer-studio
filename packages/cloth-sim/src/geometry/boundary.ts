// Build a piece's cloth mesh from the pattern schema: resolve + stitch the boundary edges (one per
// mainPath), resample by particle spacing (tracking which PiecePath each boundary particle belongs
// to, for seam matching), incorporate internal lines, and triangulate.

import Delaunator from 'delaunator';
import { pointInPolygon, triangulate, type TriMesh as ClothMesh } from '@atelier/geometry';
import type { Pattern, Piece } from '@seamer/pattern-model';
import {
  indexPaths,
  indexPoints,
  piecePathPolyline,
  type Vec2
} from '@seamer/pattern-model/utils/patternGeometry';

export interface PieceCloth {
  pieceId: string;
  materialId: string;
  mesh: ClothMesh;
  /** ordered boundary particle indices per PiecePath id (for seam correspondence) */
  edgeParticles: Map<string, number[]>;
  /** 2D centroid (mm) of the boundary, used by arrangement */
  particleDistanceMm: number;
}

/** SeamScape ClothConfig.particleDistance default (millimetres). */
export const DEFAULT_PARTICLE_DISTANCE = 10;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polylineLength(poly: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) len += dist(poly[i - 1], poly[i]);
  return len;
}

function pointSegmentDistance(point: Vec2, from: Vec2, to: Vec2): number {
  const dx = to.x - from.x, dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return dist(point, from);
  const t = Math.max(0, Math.min(1,
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared
  ));
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}

function properlyIntersects(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const same = (left: Vec2, right: Vec2) => dist(left, right) < 1e-7;
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  const orient = (p: Vec2, q: Vec2, r: Vec2) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const ac = orient(a, b, c), ad = orient(a, b, d);
  const ca = orient(c, d, a), cb = orient(c, d, b);
  return ((ac > 0 && ad < 0) || (ac < 0 && ad > 0))
    && ((ca > 0 && cb < 0) || (ca < 0 && cb > 0));
}

/**
 * Legacy sampled outlines can contain sub-millimetre wedges that make the strict constrained
 * triangulator reject an otherwise usable mesh when its area check misses a few slivers. SeamScape
 * accepted these public garments. This fallback keeps the same 10 mm interior density and rejects
 * triangles outside/crossing the outline, but deliberately tolerates those boundary slivers.
 */
function triangulateLegacyOutline(outer: Vec2[], internalPoints: Vec2[], spacing: number): ClothMesh {
  const minX = Math.min(...outer.map((point) => point.x));
  const maxX = Math.max(...outer.map((point) => point.x));
  const minY = Math.min(...outer.map((point) => point.y));
  const maxY = Math.max(...outer.map((point) => point.y));
  const boundarySegments = outer.map((point, index) => [point, outer[(index + 1) % outer.length]] as const);
  const grid: Vec2[] = [];
  const clearance = spacing * 0.35;
  for (let y = Math.ceil(minY / spacing) * spacing; y < maxY; y += spacing) {
    for (let x = Math.ceil(minX / spacing) * spacing; x < maxX; x += spacing) {
      const point = { x, y };
      if (!pointInPolygon(point, outer)) continue;
      if (boundarySegments.some(([from, to]) => pointSegmentDistance(point, from, to) < clearance)) continue;
      grid.push(point);
    }
  }
  const all = [...outer, ...internalPoints, ...grid];
  const coords = new Float64Array(all.length * 2);
  all.forEach((point, index) => {
    coords[index * 2] = point.x;
    coords[index * 2 + 1] = point.y;
  });
  const delaunay = new Delaunator(coords);
  const kept: number[] = [];
  const crossesBoundary = (a: number, b: number) => boundarySegments.some(([from, to]) =>
    properlyIntersects(all[a], all[b], from, to)
  );
  for (let index = 0; index < delaunay.triangles.length; index += 3) {
    const a = delaunay.triangles[index];
    const b = delaunay.triangles[index + 1];
    const c = delaunay.triangles[index + 2];
    const centroid = {
      x: (all[a].x + all[b].x + all[c].x) / 3,
      y: (all[a].y + all[b].y + all[c].y) / 3
    };
    if (!pointInPolygon(centroid, outer)) continue;
    if (crossesBoundary(a, b) || crossesBoundary(b, c) || crossesBoundary(c, a)) continue;
    const area = Math.abs(
      (all[b].x - all[a].x) * (all[c].y - all[a].y)
      - (all[b].y - all[a].y) * (all[c].x - all[a].x)
    ) / 2;
    if (area < spacing * spacing * 0.001) continue;
    kept.push(a, b, c);
  }
  if (kept.length < 3) throw new Error('Legacy outline fallback produced no cloth triangles');

  const originalToCompact = new Int32Array(all.length).fill(-1);
  const points: Vec2[] = [];
  const remap = (original: number) => {
    if (originalToCompact[original] < 0) {
      originalToCompact[original] = points.length;
      points.push(all[original]);
    }
    return originalToCompact[original];
  };
  const triangles = kept.map(remap);
  const edgeSet = new Map<number, [number, number]>();
  const edgeKey = (a: number, b: number) => Math.min(a, b) * points.length + Math.max(a, b);
  for (let index = 0; index < triangles.length; index += 3) {
    for (const [a, b] of [
      [triangles[index], triangles[index + 1]],
      [triangles[index + 1], triangles[index + 2]],
      [triangles[index + 2], triangles[index]]
    ] as [number, number][]) edgeSet.set(edgeKey(a, b), [a, b]);
  }
  const boundary = outer.map((_point, index) => originalToCompact[index]);
  return {
    points,
    triangles,
    edges: [...edgeSet.values()],
    boundary,
    numBoundary: boundary.filter((index) => index >= 0).length,
    internal: internalPoints.map((_point, index) => originalToCompact[outer.length + index])
  };
}

/** Resample a polyline to evenly spaced points (~spacing apart), keeping both endpoints.
 *  `forceIntervals` overrides the interval count (seam-matched edges resample both sides equally). */
function resample(poly: Vec2[], spacing: number, forceIntervals?: number): Vec2[] {
  if (poly.length < 2) return poly.slice();
  const total = polylineLength(poly);
  const n = Math.max(1, forceIntervals ?? Math.round(total / spacing));
  const out: Vec2[] = [poly[0]];
  const step = total / n;
  let segIdx = 0;
  let segPos = 0; // distance consumed in current segment
  let acc = 0;
  for (let k = 1; k < n; k++) {
    const target = k * step;
    while (segIdx < poly.length - 1) {
      const segLen = dist(poly[segIdx], poly[segIdx + 1]);
      if (acc + (segLen - segPos) >= target) {
        const remain = target - acc;
        const t = segLen > 1e-9 ? (segPos + remain) / segLen : 0;
        out.push({
          x: poly[segIdx].x + (poly[segIdx + 1].x - poly[segIdx].x) * t,
          y: poly[segIdx].y + (poly[segIdx + 1].y - poly[segIdx].y) * t
        });
        break;
      }
      acc += segLen - segPos;
      segPos = 0;
      segIdx++;
    }
  }
  out.push(poly[poly.length - 1]);
  return out;
}

interface LoopEdge {
  ppId: string;
  poly: Vec2[];
}

/** Stitch the mainPath edges into an ordered closed loop by matching shared endpoints. */
function stitchLoop(edges: LoopEdge[]): LoopEdge[] {
  if (edges.length === 0) return [];
  const used = new Array(edges.length).fill(false);
  const tol = 1.5;
  const loop: LoopEdge[] = [{ ...edges[0] }];
  used[0] = true;
  let tail = edges[0].poly[edges[0].poly.length - 1];
  let guard = edges.length * 2;
  while (guard-- > 0) {
    let found = -1;
    let flip = false;
    let best = tol;
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const e = edges[i];
      const dS = dist(tail, e.poly[0]);
      const dE = dist(tail, e.poly[e.poly.length - 1]);
      if (dS <= best) { best = dS; found = i; flip = false; }
      if (dE <= best) { best = dE; found = i; flip = true; }
    }
    if (found === -1) break;
    used[found] = true;
    const poly = flip ? edges[found].poly.slice().reverse() : edges[found].poly;
    loop.push({ ppId: edges[found].ppId, poly });
    tail = poly[poly.length - 1];
  }
  return loop;
}

/**
 * SeamScape-compatible seam density allocation. The source first gives a seam
 * `ceil(max(sideLength) / minParticleDistance)` intervals, propagates the largest count across
 * seams that share a path, and then applies the common count to both composite sides. We distribute
 * that count over this schema's PiecePaths by arc length; buildSimData performs the source's fixed
 * count composite sampling, including pinned path boundaries for darts and ease.
 */
export function computeSeamEdgeIntervals(pattern: Pattern): Map<string, number> {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const out = new Map<string, number>();
  // pd + polyline length per PiecePath id (owner piece determines pd)
  const info = new Map<string, { len: number; pd: number }>();
  for (const piece of pattern.pieces) {
    const pd = piece.settings3d.particleDistance ?? DEFAULT_PARTICLE_DISTANCE;
    for (const pp of [...piece.mainPaths, ...piece.internalPaths]) {
      const poly = piecePathPolyline(pp, paths, points, Math.min(4, pd / 2));
      if (poly.length >= 2) info.set(pp.id, { len: polylineLength(poly), pd });
    }
  }
  const sides = new Map<string, {
    from: ReturnType<typeof side>;
    to: ReturnType<typeof side>;
  }>();
  function side(refs: { id: string }[]) {
      const items = refs
        .map((ref) => info.get(ref.id))
        .filter((item): item is { len: number; pd: number } => !!item);
      return { items, refs: refs.filter((ref) => info.has(ref.id)) };
  }

  // Source generateParticleCountForSeams().
  const seamCounts = new Map<string, number>();
  for (const seam of pattern.seams) {
    const from = side(seam.fromPaths);
    const to = side(seam.toPaths);
    if (from.items.length === 0 || to.items.length === 0) continue;
    sides.set(seam.id, { from, to });
    const fromLength = from.items.reduce((sum, item) => sum + item.len, 0);
    const toLength = to.items.reduce((sum, item) => sum + item.len, 0);
    const distances = [...from.items, ...to.items].map((item) => item.pd).filter((pd) => pd > 0);
    const particleDistance = distances.length ? Math.min(...distances) : DEFAULT_PARTICLE_DISTANCE;
    seamCounts.set(seam.id, Math.max(1, Math.ceil(Math.max(fromLength, toLength) / particleDistance)));
  }

  // A path participating in several seams uses their largest count. Iterate to a fixed point so
  // propagation is deterministic instead of depending on piece/path ordering.
  let changed = true;
  while (changed) {
    changed = false;
    for (const piece of pattern.pieces) {
      for (const path of [...piece.mainPaths, ...piece.internalPaths]) {
        const touching = pattern.seams.filter((seam) =>
          [...seam.fromPaths, ...seam.toPaths].some((ref) => ref.id === path.id)
        );
        const maximum = Math.max(0, ...touching.map((seam) => seamCounts.get(seam.id) ?? 0));
        for (const seam of touching) {
          if ((seamCounts.get(seam.id) ?? 0) < maximum) {
            seamCounts.set(seam.id, maximum);
            changed = true;
          }
        }
      }
    }
  }

  for (const seam of pattern.seams) {
    const resolved = sides.get(seam.id);
    const intervalCount = seamCounts.get(seam.id);
    if (!resolved || !intervalCount) continue;
    // Distribute the common interval count over a side's edges by length share (largest remainder,
    // at least one interval per edge).
    const distribute = (s: ReturnType<typeof side>) => {
      const totalLen = s.items.reduce((a, it) => a + it.len, 0) || 1;
      const raw = s.items.map((it) => (intervalCount * it.len) / totalLen);
      const base = raw.map((r) => Math.max(1, Math.floor(r)));
      let rem = intervalCount - base.reduce((a, b) => a + b, 0);
      const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
      for (let k = 0; rem > 0 && k < order.length; k++, rem--) base[order[k].i]++;
      // With more path entries than intervals the ≥1 rule can over-allocate; retain the source's
      // safe minimum rather than attempting a negative redistribution.
      s.refs.forEach((r, i) => out.set(r.id, Math.max(out.get(r.id) ?? 0, base[i])));
    };
    distribute(resolved.from);
    distribute(resolved.to);
  }
  return out;
}

export function buildPieceCloth(
  pattern: Pattern,
  piece: Piece,
  particleDistanceMm?: number,
  edgeIntervals?: Map<string, number>
): PieceCloth | null {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const pd = particleDistanceMm ?? piece.settings3d.particleDistance ?? DEFAULT_PARTICLE_DISTANCE;

  const mirrorPpId = piece.mainPaths.find((pp) => pp.isMirrorLine)?.id;
  const rawEdges: LoopEdge[] = piece.mainPaths
    .map((pp) => ({ ppId: pp.id, poly: piecePathPolyline(pp, paths, points, Math.min(4, pd / 2)) }))
    .filter((e) => e.poly.length >= 2);
  if (rawEdges.length === 0) return null;

  let loop = stitchLoop(rawEdges);

  // If the piece is a half (has a mirror-line edge), drop that edge and rotate so the remaining
  // edges form one contiguous open arc between the mirror-line endpoints; we reflect it below.
  let mirrorEnds: [Vec2, Vec2] | null = null;
  if (mirrorPpId) {
    const ml = loop.findIndex((e) => e.ppId === mirrorPpId);
    if (ml !== -1) {
      const mEdge = loop[ml];
      mirrorEnds = [mEdge.poly[0], mEdge.poly[mEdge.poly.length - 1]];
      loop = [...loop.slice(ml + 1), ...loop.slice(0, ml)];
    }
  }

  // Resample each edge and concatenate into the outer loop, tracking per-edge particle indices.
  const outer: Vec2[] = [];
  const edgeOuterRanges = new Map<string, number[]>();
  for (let li = 0; li < loop.length; li++) {
    const e = loop[li];
    const rs = resample(e.poly, pd, edgeIntervals?.get(e.ppId));
    const idxs: number[] = [];
    for (let i = 0; i < rs.length; i++) {
      // skip the first point if it duplicates the current tail (shared endpoint)
      if (i === 0 && outer.length > 0 && dist(outer[outer.length - 1], rs[0]) < 1e-6) {
        idxs.push(outer.length - 1);
        continue;
      }
      // skip the last point if it closes onto the very first outer point
      if (li === loop.length - 1 && i === rs.length - 1 && outer.length > 0 && dist(outer[0], rs[i]) < 1e-6) {
        idxs.push(0);
        continue;
      }
      idxs.push(outer.length);
      outer.push(rs[i]);
    }
    const existing = edgeOuterRanges.get(e.ppId) ?? [];
    edgeOuterRanges.set(e.ppId, existing.concat(idxs));
  }

  // Reflect the open arc across the mirror line to form the full piece (half -> full). The reflected
  // copy of each edge is tracked under `${ppId}#M` so seam refs with `mirrored: true` resolve to it.
  if (mirrorEnds && outer.length >= 2) {
    const [A, B] = mirrorEnds;
    const dx = B.x - A.x, dy = B.y - A.y;
    const len2 = dx * dx + dy * dy || 1;
    const reflect = (p: Vec2): Vec2 => {
      const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / len2;
      const px = A.x + dx * t, py = A.y + dy * t;
      return { x: 2 * px - p.x, y: 2 * py - p.y };
    };
    const baseOuterLength = outer.length;
    const reflected = outer.map(reflect);
    // The two arc endpoints lie on the mirror line and therefore reuse their original particles.
    // Interior points get appended in reverse order to close the reflected half.
    const reflectedIndex = new Map<number, number>([
      [0, 0],
      [baseOuterLength - 1, baseOuterLength - 1]
    ]);
    for (let i = baseOuterLength - 2; i >= 1; i--) {
      const newIdx = outer.length;
      outer.push(reflected[i]);
      reflectedIndex.set(i, newIdx);
    }
    // Mirror every edge run independently. This preserves shared endpoints on adjacent edges and
    // gives every reflected seam edge exactly the same particle count and length as its source.
    for (const [ppId, idxs] of [...edgeOuterRanges]) {
      const mirrored = idxs
        .slice()
        .reverse()
        .map((index) => reflectedIndex.get(index))
        .filter((index): index is number => index !== undefined);
      edgeOuterRanges.set(`${ppId}#M`, mirrored);
    }
  }

  // internal lines -> constraint points (darts / internal seams / fold hinges), tracking which
  // range of internalPoints belongs to each internal PiecePath so its particles stay addressable.
  const internalPoints: Vec2[] = [];
  const internalRanges = new Map<string, { start: number; count: number }>();
  for (const ip of piece.internalPaths) {
    const poly = piecePathPolyline(ip, paths, points, Math.min(4, pd / 2));
    const rs = resample(poly, pd, edgeIntervals?.get(ip.id));
    internalRanges.set(ip.id, { start: internalPoints.length, count: rs.length });
    for (const p of rs) internalPoints.push(p);
  }

  let mesh: ClothMesh;
  try {
    mesh = triangulate({
      outer,
      internalPoints,
      spacing: pd,
      grid: piece.grainVector
    });
  } catch (error) {
    if (piece.legacyGeometry?.format !== 'seamscape-json') throw error;
    console.warn(`Piece "${piece.name}" used tolerant SeamScape outline triangulation`);
    mesh = triangulateLegacyOutline(outer, internalPoints, pd);
  }

  // Map outer-input indices -> compacted particle indices via mesh.boundary (aligned to outer order).
  const outerToParticle = mesh.boundary; // boundary[i] is the particle index of outer[i]
  const edgeParticles = new Map<string, number[]>();
  for (const [ppId, outerIdxs] of edgeOuterRanges) {
    const mapped: number[] = [];
    for (const oi of outerIdxs) {
      if (oi < outerToParticle.length && outerToParticle[oi] >= 0) mapped.push(outerToParticle[oi]);
    }
    edgeParticles.set(ppId, mapped);
  }

  // Internal paths register their ordered particle runs too, so seams can reference an internal
  // line (pockets, yokes) and fold hinges (foldAngle) can be located in the mesh.
  for (const [ppId, range] of internalRanges) {
    const mapped: number[] = [];
    for (let k = range.start; k < range.start + range.count; k++) {
      const pi = mesh.internal[k];
      if (pi !== undefined && pi >= 0) mapped.push(pi);
    }
    if (mapped.length >= 2) edgeParticles.set(ppId, mapped);
  }

  return { pieceId: piece.id, materialId: piece.materialId, mesh, edgeParticles, particleDistanceMm: pd };
}

export interface SavedCloth {
  cloth: PieceCloth;
  positions3d: Float32Array; // saved settled 3D positions (meters), per particle
  boundaryParticles: number[]; // indices of particles on the mesh boundary (for seam linking)
}

export interface SavedSurfaceReuse {
  positions3d: Float32Array;
  safeCoverage: number;
  exactCount: number;
  interpolatedCount: number;
  extrapolatedCount: number;
  fallbackCount: number;
}

type SavedMeshSnapshot = NonNullable<Piece['settings3d']['savedMeshSnapshot']>;

function unpackSavedFaces(snapshot: SavedMeshSnapshot, vertexCount: number): number[] | null {
  if (!snapshot.faces || (snapshot.vertexCount && snapshot.vertexCount !== vertexCount)) return null;
  try {
    const binary = atob(snapshot.faces);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = snapshot.faceIndexType === 'u32' ? 4 : 2;
    if (bytes.byteLength % (width * 3) !== 0) return null;
    const faces = new Array<number>(bytes.byteLength / width);
    for (let index = 0; index < faces.length; index += 1) {
      faces[index] = width === 4
        ? view.getUint32(index * width, true)
        : view.getUint16(index * width, true);
    }
    return faces.some((index) => index >= vertexCount) ? null : faces;
  } catch {
    return null;
  }
}

interface SurfaceTriangle {
  faceIndex: number;
  a: number;
  b: number;
  c: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  maxEdgeLength: number;
}

function barycentricWeights(point: Vec2, a: Vec2, b: Vec2, c: Vec2): [number, number, number] | null {
  const v0x = b.x - a.x, v0y = b.y - a.y;
  const v1x = c.x - a.x, v1y = c.y - a.y;
  const v2x = point.x - a.x, v2y = point.y - a.y;
  const denominator = v0x * v1y - v1x * v0y;
  if (Math.abs(denominator) < 1e-10) return null;
  const v = (v2x * v1y - v1x * v2y) / denominator;
  const w = (v0x * v2y - v2x * v0y) / denominator;
  return [1 - v - w, v, w];
}

function distanceSquaredToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) return (point.x - a.x) ** 2 + (point.y - a.y) ** 2;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return (point.x - (a.x + t * dx)) ** 2 + (point.y - (a.y + t * dy)) ** 2;
}

/** Source-compatible legacy drape restoration. SeamScape maps the freshly triangulated piece onto
 * the saved piece-local 2D triangle surface, then barycentrically interpolates settled XYZ. This is
 * materially different from nearest-vertex reuse and from drawing the old indexed mesh directly. */
export function reuseSavedSurface(
  meshPoints: Vec2[],
  savedPositions: number[] | undefined,
  snapshot: SavedMeshSnapshot | undefined
): SavedSurfaceReuse | null {
  if (!snapshot || snapshot.coordinateSpace !== 'piece-local' || !savedPositions || savedPositions.length < 15) return null;
  const vertexCount = Math.floor(savedPositions.length / 5);
  const faces = unpackSavedFaces(snapshot, vertexCount);
  if (!faces?.length || meshPoints.length === 0) return null;

  const saved2d = new Array<Vec2>(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) {
    saved2d[index] = { x: savedPositions[index * 5], y: savedPositions[index * 5 + 1] };
  }

  const triangles: SurfaceTriangle[] = [];
  const edgeLengths: number[] = [];
  for (let faceIndex = 0; faceIndex + 2 < faces.length; faceIndex += 3) {
    const a = faces[faceIndex], b = faces[faceIndex + 1], c = faces[faceIndex + 2];
    const pa = saved2d[a], pb = saved2d[b], pc = saved2d[c];
    if (!barycentricWeights(pa, pa, pb, pc)) continue;
    const ab = dist(pa, pb), bc = dist(pb, pc), ca = dist(pc, pa);
    const maxEdgeLength = Math.max(ab, bc, ca);
    edgeLengths.push(ab, bc, ca);
    triangles.push({
      faceIndex, a, b, c,
      minX: Math.min(pa.x, pb.x, pc.x), maxX: Math.max(pa.x, pb.x, pc.x),
      minY: Math.min(pa.y, pb.y, pc.y), maxY: Math.max(pa.y, pb.y, pc.y),
      maxEdgeLength
    });
  }
  if (!triangles.length) return null;

  edgeLengths.sort((a, b) => a - b);
  const cellSize = Math.max(5, edgeLengths[Math.floor(edgeLengths.length / 2)] || 14);
  const grid = new Map<string, number[]>();
  const cell = (value: number) => Math.floor(value / cellSize);
  for (let index = 0; index < triangles.length; index += 1) {
    const triangle = triangles[index];
    for (let x = cell(triangle.minX); x <= cell(triangle.maxX); x += 1) {
      for (let y = cell(triangle.minY); y <= cell(triangle.maxY); y += 1) {
        const key = `${x}:${y}`;
        const bucket = grid.get(key) ?? [];
        bucket.push(index);
        grid.set(key, bucket);
      }
    }
  }

  const positions3d = new Float32Array(meshPoints.length * 3);
  const exactMap = new Map<string, number[]>();
  for (let index = 0; index < vertexCount; index += 1) {
    const key = `${saved2d[index].x.toFixed(6)}:${saved2d[index].y.toFixed(6)}`;
    const entries = exactMap.get(key) ?? [];
    entries.push(index);
    exactMap.set(key, entries);
  }
  const exactUse = new Map<string, number>();
  let exactCount = 0, interpolatedCount = 0, extrapolatedCount = 0, fallbackCount = 0;

  const writeVertex = (targetIndex: number, sourceIndex: number) => {
    positions3d[targetIndex * 3] = savedPositions[sourceIndex * 5 + 2];
    positions3d[targetIndex * 3 + 1] = savedPositions[sourceIndex * 5 + 3];
    positions3d[targetIndex * 3 + 2] = savedPositions[sourceIndex * 5 + 4];
  };
  const writeTriangle = (targetIndex: number, triangle: SurfaceTriangle, weights: [number, number, number]) => {
    const vertices = [triangle.a, triangle.b, triangle.c];
    for (let axis = 0; axis < 3; axis += 1) {
      positions3d[targetIndex * 3 + axis] = vertices.reduce(
        (sum, sourceIndex, weightIndex) => sum + weights[weightIndex] * savedPositions[sourceIndex * 5 + 2 + axis],
        0
      );
    }
  };

  for (let targetIndex = 0; targetIndex < meshPoints.length; targetIndex += 1) {
    const point = meshPoints[targetIndex];
    const exactKey = `${point.x.toFixed(6)}:${point.y.toFixed(6)}`;
    const exactEntries = exactMap.get(exactKey);
    const used = exactUse.get(exactKey) ?? 0;
    if (exactEntries?.[used] !== undefined) {
      writeVertex(targetIndex, exactEntries[used]);
      exactUse.set(exactKey, used + 1);
      exactCount += 1;
      continue;
    }

    const bucket = grid.get(`${cell(point.x)}:${cell(point.y)}`) ?? [];
    let containing: { triangle: SurfaceTriangle; weights: [number, number, number] } | null = null;
    for (const triangleIndex of bucket) {
      const triangle = triangles[triangleIndex];
      if (point.x < triangle.minX - 1e-7 || point.x > triangle.maxX + 1e-7 || point.y < triangle.minY - 1e-7 || point.y > triangle.maxY + 1e-7) continue;
      const weights = barycentricWeights(point, saved2d[triangle.a], saved2d[triangle.b], saved2d[triangle.c]);
      if (weights?.every((weight) => weight >= -1e-7)) { containing = { triangle, weights }; break; }
    }
    if (containing) {
      writeTriangle(targetIndex, containing.triangle, containing.weights);
      interpolatedCount += 1;
      continue;
    }

    let nearest: { triangle: SurfaceTriangle; weights: [number, number, number]; distanceSquared: number } | null = null;
    // Most misses are immediately outside a boundary, so inspect nearby grid cells first. Fall back
    // to the complete surface only when the local neighbourhood has no candidate.
    const nearby = new Set<number>();
    for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) {
      for (const triangleIndex of grid.get(`${cell(point.x) + dx}:${cell(point.y) + dy}`) ?? []) nearby.add(triangleIndex);
    }
    const candidates = nearby.size ? [...nearby].map((index) => triangles[index]) : triangles;
    for (const triangle of candidates) {
      const pa = saved2d[triangle.a], pb = saved2d[triangle.b], pc = saved2d[triangle.c];
      const weights = barycentricWeights(point, pa, pb, pc);
      if (!weights) continue;
      const distanceSquared = weights.every((weight) => weight >= 0) ? 0 : Math.min(
        distanceSquaredToSegment(point, pa, pb),
        distanceSquaredToSegment(point, pb, pc),
        distanceSquaredToSegment(point, pc, pa)
      );
      if (!nearest || distanceSquared < nearest.distanceSquared - 1e-9 ||
        (Math.abs(distanceSquared - nearest.distanceSquared) <= 1e-9 && triangle.faceIndex < nearest.triangle.faceIndex)) {
        nearest = { triangle, weights, distanceSquared };
      }
    }
    if (nearest && Math.sqrt(nearest.distanceSquared) <= Math.max(5, nearest.triangle.maxEdgeLength * 1.5) &&
      nearest.weights.every((weight) => weight >= -2 && weight <= 3)) {
      writeTriangle(targetIndex, nearest.triangle, nearest.weights);
      extrapolatedCount += 1;
      continue;
    }

    // Source uses an eight-neighbour smooth extrapolator here. Inverse-distance weighting is the
    // deterministic last-resort equivalent; these points are excluded from safeCoverage.
    const nearestVertices = saved2d.map((savedPoint, sourceIndex) => ({
      sourceIndex,
      distanceSquared: (point.x - savedPoint.x) ** 2 + (point.y - savedPoint.y) ** 2
    })).sort((a, b) => a.distanceSquared - b.distanceSquared).slice(0, 8);
    let weightSum = 0;
    for (const entry of nearestVertices) {
      const weight = 1 / (entry.distanceSquared + 1e-8);
      weightSum += weight;
      for (let axis = 0; axis < 3; axis += 1) {
        positions3d[targetIndex * 3 + axis] += weight * savedPositions[entry.sourceIndex * 5 + 2 + axis];
      }
    }
    if (weightSum > 0) for (let axis = 0; axis < 3; axis += 1) positions3d[targetIndex * 3 + axis] /= weightSum;
    fallbackCount += 1;
  }

  const safeCount = exactCount + interpolatedCount + extrapolatedCount;
  return {
    positions3d,
    safeCoverage: safeCount / meshPoints.length,
    exactCount,
    interpolatedCount,
    extrapolatedCount,
    fallbackCount
  };
}

/**
 * Build a piece's cloth mesh directly from its cached `savedPositions` (stride 5: x2d,y2d, x3d,y3d,z3d).
 * Uses the saved particles as-is (their 2D for topology + UV, their 3D as the settled drape), so the
 * result reproduces the original render exactly — no boundary re-triangulation or mapping error.
 * Triangulated via Delaunay over the 2D points with long concavity-bridging edges pruned.
 */
export function buildSavedCloth(piece: Piece): SavedCloth | null {
  const sp = piece.settings3d.savedPositions;
  if (!sp || sp.length < 15) return null;
  const n = Math.floor(sp.length / 5);
  const points: Vec2[] = new Array(n);
  const positions3d = new Float32Array(n * 3);
  const coords: number[] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    points[i] = { x: sp[i * 5], y: sp[i * 5 + 1] };
    coords[i * 2] = sp[i * 5];
    coords[i * 2 + 1] = sp[i * 5 + 1];
    positions3d[i * 3] = sp[i * 5 + 2];
    positions3d[i * 3 + 1] = sp[i * 5 + 3];
    positions3d[i * 3 + 2] = sp[i * 5 + 4];
  }
  if (n < 3) return null;

  const snapshot = piece.settings3d.savedMeshSnapshot;
  const sourceTriangles = snapshot ? unpackSavedFaces(snapshot, n) : null;

  const del = sourceTriangles ? null : new Delaunator(Float64Array.from(coords));
  const tri = sourceTriangles ?? [...del!.triangles];
  // median edge length -> prune triangles that bridge concavities / the convex hull when there is
  // no authoritative indexed topology. Legacy snapshots keep their source faces exactly.
  const edgeLens: number[] = [];
  const elen = (a: number, b: number) => Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);
  for (let t = 0; t < tri.length; t += 3) {
    edgeLens.push(elen(tri[t], tri[t + 1]), elen(tri[t + 1], tri[t + 2]), elen(tri[t + 2], tri[t]));
  }
  edgeLens.sort((a, b) => a - b);
  const median = edgeLens[Math.floor(edgeLens.length / 2)] || 10;
  const maxEdge = median * 2.5;

  const triangles: number[] = sourceTriangles ?? [];
  if (!sourceTriangles) {
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t], b = tri[t + 1], c = tri[t + 2];
      if (elen(a, b) > maxEdge || elen(b, c) > maxEdge || elen(c, a) > maxEdge) continue;
      triangles.push(a, b, c);
    }
  }

  // unique edges + boundary detection (edges used by exactly one triangle)
  const edgeCount = new Map<number, number>();
  const ekey = (a: number, b: number) => Math.min(a, b) * n + Math.max(a, b);
  const addE = (a: number, b: number) => edgeCount.set(ekey(a, b), (edgeCount.get(ekey(a, b)) ?? 0) + 1);
  for (let t = 0; t < triangles.length; t += 3) {
    addE(triangles[t], triangles[t + 1]);
    addE(triangles[t + 1], triangles[t + 2]);
    addE(triangles[t + 2], triangles[t]);
  }
  const edges: [number, number][] = [];
  const boundarySet = new Set<number>();
  for (const [k, count] of edgeCount) {
    const a = Math.floor(k / n), b = k % n;
    edges.push([a, b]);
    if (count === 1) { boundarySet.add(a); boundarySet.add(b); }
  }

  const mesh: ClothMesh = { points, triangles, edges, boundary: [...boundarySet], numBoundary: boundarySet.size, internal: [] };
  const pd = piece.settings3d.particleDistance ?? median;
  return {
    cloth: { pieceId: piece.id, materialId: piece.materialId, mesh, edgeParticles: new Map(), particleDistanceMm: pd },
    positions3d,
    boundaryParticles: [...boundarySet]
  };
}

// Source-matched thresholds (Dg1PbtmY.js): a fresh particle within `tol` of a saved one reuses its
// drape verbatim; the whole-piece reuse is abandoned for a flat arranged seed once too much of the new
// shape lies outside the saved footprint.
const ARRANGED_FALLBACK_OUTSIDE_RATIO = 0.5;

/**
 * Map a freshly triangulated mesh onto a piece's cached drape so a 2D-edited piece keeps the drape it
 * already had wherever its shape is unchanged. Three-way seed, mirroring the original's
 * `tryReuseSavedPositions`:
 *   1. EXACT REUSE — a fresh particle within `tol` mm of a saved particle inherits its settled 3D
 *      verbatim (the shape there is unchanged).
 *   2. KNN-FROM-DRAPE — a particle in an ADDED region (no saved particle within `tol`) is estimated by
 *      inverse-distance-weighting the K nearest saved particles' 3D, so the new area FOLLOWS the
 *      existing drape instead of sitting flat-on-body.
 *   3. OUTSIDE-RATIO FALLBACK — if too much of the new shape lies outside the saved 2D footprint
 *      (≥ 0.5), the edit changed the piece too much to reuse coherently → return null so the caller
 *      seeds from the fresh cylinder arrangement instead.
 * Returns the seeded positions + the fraction of particles that EXACTLY matched (informational).
 *
 * `meshPoints` and the blob's stride-5 x2d/y2d coordinates must use the same millimetre-space frame.
 * Saved template drapes use placed plan coordinates, so prepareCloth transforms its rebuilt drafting
 * mesh into that frame before calling this function.
 */
export function reuseSavedDrape(
  meshPoints: Vec2[],
  savedPositions: number[] | undefined,
  particleDistanceMm: number
): { positions3d: Float32Array; matchRatio: number } | null {
  if (!savedPositions || savedPositions.length < 15) return null;
  const m = Math.floor(savedPositions.length / 5);
  const n = meshPoints.length;
  if (n === 0 || m === 0) return null;

  // saved 2D footprint (mm), padded by a particle-spacing margin, to gauge how much of the new shape is new
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let j = 0; j < m; j++) {
    const x = savedPositions[j * 5], y = savedPositions[j * 5 + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const margin = Math.max(particleDistanceMm, 8);
  minX -= margin; minY -= margin; maxX += margin; maxY += margin;

  const out = new Float32Array(n * 3);
  const tol = Math.max(particleDistanceMm * 1.5, 8); // mm — unmoved particles reuse exactly
  const tol2 = tol * tol;
  const K = Math.min(3, m);
  const kd = new Float64Array(K); // K nearest distances²
  const ki = new Int32Array(K); // their saved indices
  let matched = 0;
  let outside = 0;

  for (let i = 0; i < n; i++) {
    const px = meshPoints[i].x;
    const py = meshPoints[i].y;
    if (px < minX || px > maxX || py < minY || py > maxY) outside++;

    // K nearest saved particles (insertion into a tiny sorted list)
    for (let t = 0; t < K; t++) { kd[t] = Infinity; ki[t] = -1; }
    for (let j = 0; j < m; j++) {
      const dx = px - savedPositions[j * 5];
      const dy = py - savedPositions[j * 5 + 1];
      const d2 = dx * dx + dy * dy;
      if (d2 < kd[K - 1]) {
        let t = K - 1;
        while (t > 0 && kd[t - 1] > d2) { kd[t] = kd[t - 1]; ki[t] = ki[t - 1]; t--; }
        kd[t] = d2; ki[t] = j;
      }
    }

    if (kd[0] <= tol2) {
      const j = ki[0];
      out[i * 3] = savedPositions[j * 5 + 2];
      out[i * 3 + 1] = savedPositions[j * 5 + 3];
      out[i * 3 + 2] = savedPositions[j * 5 + 4];
      matched++;
    } else {
      // inverse-distance-weighted estimate from the K nearest settled particles
      let wsum = 0, x = 0, y = 0, z = 0;
      for (let t = 0; t < K; t++) {
        const j = ki[t];
        if (j < 0) continue;
        const w = 1 / (Math.sqrt(kd[t]) + 1e-6);
        wsum += w;
        x += w * savedPositions[j * 5 + 2];
        y += w * savedPositions[j * 5 + 3];
        z += w * savedPositions[j * 5 + 4];
      }
      if (wsum > 0) { out[i * 3] = x / wsum; out[i * 3 + 1] = y / wsum; out[i * 3 + 2] = z / wsum; }
    }
  }

  if (outside / n >= ARRANGED_FALLBACK_OUTSIDE_RATIO) return null;
  return { positions3d: out, matchRatio: matched / n };
}
