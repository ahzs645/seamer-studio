// Auto-trace a piece outline from a reference overlay: either the parsed HPGL polylines
// (find the closed loop nearest a click, gap-tolerant) or a raster image (flood-fill the
// clicked region, then marching-squares boundary). Outlines are simplified with
// Douglas-Peucker so the resulting piece has a manageable number of points.

import type { Vec2 } from './patternGeometry';
import { pointInPolygon } from './patternGeometry';

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** Perpendicular distance from `p` to the segment a–b. */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas-Peucker simplification of an open polyline (keeps endpoints). */
export function simplifyPolyline(pts: Vec2[], tolerance: number): Vec2[] {
  if (pts.length <= 2 || tolerance <= 0) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let worst = -1, worstD = tolerance;
    for (let i = i0 + 1; i < i1; i++) {
      const d = distToSegment(pts[i], pts[i0], pts[i1]);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([i0, worst], [worst, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplify a closed loop (no duplicated last point): split at the vertex farthest from
 *  the first, simplify both halves, rejoin. */
export function simplifyClosed(pts: Vec2[], tolerance: number): Vec2[] {
  if (pts.length <= 4 || tolerance <= 0) return pts.slice();
  let far = 1, farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[0], pts[i]);
    if (d > farD) { farD = d; far = i; }
  }
  const a = simplifyPolyline(pts.slice(0, far + 1), tolerance);
  const b = simplifyPolyline([...pts.slice(far), pts[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/**
 * Join polylines into closed loops, tolerating small gaps between segment endpoints.
 * Polylines are greedily chained end-to-end (reversing as needed) while an endpoint lies
 * within `gapTolerance`; a chain whose start and end meet within the tolerance is a loop.
 * Returns loops WITHOUT a duplicated closing point.
 */
export function closeLoops(polys: Vec2[][], gapTolerance = 2): Vec2[][] {
  const pool = polys.filter((p) => p.length >= 2).map((p) => p.slice());
  const loops: Vec2[][] = [];
  while (pool.length) {
    let chain = pool.shift()!;
    let extended = true;
    while (extended && dist(chain[0], chain[chain.length - 1]) > gapTolerance) {
      extended = false;
      const end = chain[chain.length - 1];
      for (let i = 0; i < pool.length; i++) {
        const cand = pool[i];
        if (dist(end, cand[0]) <= gapTolerance) { chain = [...chain, ...cand.slice(1)]; }
        else if (dist(end, cand[cand.length - 1]) <= gapTolerance) { chain = [...chain, ...cand.slice(0, -1).reverse()]; }
        else continue;
        pool.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (chain.length >= 3 && dist(chain[0], chain[chain.length - 1]) <= gapTolerance) {
      const loop = chain.slice();
      if (dist(loop[0], loop[loop.length - 1]) < 1e-9) loop.pop();
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

export interface HPGLTraceOptions {
  /** Max endpoint gap (mm) still considered "closed". */
  gapToleranceMm?: number;
  /** Douglas-Peucker tolerance (mm). */
  simplifyToleranceMm?: number;
  /** Max distance (mm) from the click to a loop boundary when the click is outside every loop. */
  maxDistanceMm?: number;
}

/**
 * Trace the closed (or nearly-closed) HPGL loop nearest `click` (mm, same space as the
 * polylines). Prefers the smallest loop containing the click; otherwise the loop whose
 * boundary is nearest, within `maxDistanceMm`. Returns simplified outline points, or null.
 */
export function traceFromHPGL(polys: Vec2[][], click: Vec2, opts: HPGLTraceOptions = {}): Vec2[] | null {
  const { gapToleranceMm = 2, simplifyToleranceMm = 0.5, maxDistanceMm = 20 } = opts;
  const loops = closeLoops(polys, gapToleranceMm);
  if (loops.length === 0) return null;

  let best: Vec2[] | null = null;
  let bestArea = Infinity;
  for (const loop of loops) {
    if (!pointInPolygon(click, loop)) continue;
    let area = 0;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) area += loop[j].x * loop[i].y - loop[i].x * loop[j].y;
    area = Math.abs(area) / 2;
    if (area < bestArea) { bestArea = area; best = loop; }
  }
  if (!best) {
    let bestD = maxDistanceMm;
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const d = distToSegment(click, loop[i], loop[(i + 1) % loop.length]);
        if (d < bestD) { bestD = d; best = loop; }
      }
    }
  }
  if (!best) return null;
  const out = simplifyClosed(best, simplifyToleranceMm);
  return out.length >= 3 ? out : null;
}

export interface ImageTraceOptions {
  /** Luminance threshold (0–255) separating "dark" from "light" pixels. */
  threshold?: number;
  /** Douglas-Peucker tolerance in pixels. */
  simplifyTolerancePx?: number;
  /** Safety cap on the flood-filled region size. */
  maxPixels?: number;
}

/**
 * Trace the boundary of the region around (seedX, seedY) in an ImageData: pixels are
 * classified by alpha + luminance threshold, the seed's class is flood-filled (4-connected)
 * and the region boundary is walked with marching squares. Returns the simplified boundary
 * in PIXEL coordinates (y down), or null if no usable region was found.
 */
export function traceImageRegion(data: ImageData, seedX: number, seedY: number, opts: ImageTraceOptions = {}): Vec2[] | null {
  const { threshold = 128, simplifyTolerancePx = 1.5, maxPixels = 4_000_000 } = opts;
  const { width: w, height: h, data: px } = data;
  seedX = Math.round(seedX); seedY = Math.round(seedY);
  if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h) return null;

  // class: 0 = transparent, 1 = dark, 2 = light
  const classOf = (x: number, y: number): number => {
    const i = (y * w + x) * 4;
    if (px[i + 3] < 32) return 0;
    const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    return lum < threshold ? 1 : 2;
  };
  const seedClass = classOf(seedX, seedY);

  // flood fill (4-connected) the seed's class
  const mask = new Uint8Array(w * h);
  const stack = [seedY * w + seedX];
  mask[stack[0]] = 1;
  let filled = 0;
  while (stack.length) {
    const idx = stack.pop()!;
    if (++filled > maxPixels) return null;
    const x = idx % w, y = (idx / w) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!mask[ni] && classOf(nx, ny) === seedClass) { mask[ni] = 1; stack.push(ni); }
    }
  }
  if (filled < 16) return null; // too small to be a piece

  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;

  // start at the leftmost boundary corner on the seed row
  let sx = seedX;
  while (inside(sx - 1, seedY)) sx--;

  // marching-squares walk (filled region kept on the left), corners in pixel units
  const pts: Vec2[] = [];
  let x = sx, y = seedY;
  let pdx = 0, pdy = 1;
  const maxSteps = 4 * (w + 2) * (h + 2);
  for (let step = 0; step < maxSteps; step++) {
    const state =
      (inside(x - 1, y - 1) ? 1 : 0) | (inside(x, y - 1) ? 2 : 0) |
      (inside(x - 1, y) ? 4 : 0) | (inside(x, y) ? 8 : 0);
    let dx = 0, dy = 0;
    switch (state) {
      case 1: case 5: case 13: dy = -1; break;            // up
      case 2: case 3: case 7: dx = 1; break;              // right
      case 4: case 12: case 14: dx = -1; break;           // left
      case 8: case 10: case 11: dy = 1; break;            // down
      case 6: dx = pdy === -1 ? -1 : 1; break;            // saddle UR|LL
      case 9: dy = pdx === 1 ? -1 : 1; break;             // saddle UL|LR
      default: return null;                               // 0 / 15: not a boundary
    }
    pts.push({ x, y });
    x += dx; y += dy; pdx = dx; pdy = dy;
    if (x === sx && y === seedY) break;
  }
  if (pts.length < 3) return null;
  const out = simplifyClosed(pts, simplifyTolerancePx);
  return out.length >= 3 ? out : null;
}
