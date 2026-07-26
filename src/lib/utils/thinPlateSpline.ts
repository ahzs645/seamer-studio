// Thin-plate-spline warp for scan calibration (the source's MatchPoint + ThinPlateSpline): given
// match-point pairs in WORLD mm, build a smooth world→world mapping that carries each source point
// exactly onto its target. 1 pair = translation, 2 pairs = similarity, ≥3 pairs = full TPS
// (affine part + r²·log r radial kernel).

import { invert, matVec } from '@seamer/avatar';

export interface Vec2 { x: number; y: number }
export interface MatchPair { src: Vec2; dst: Vec2 }

const U = (r2: number): number => (r2 <= 1e-12 ? 0 : 0.5 * r2 * Math.log(r2)); // r²·log r, via r²

/** Build the warp function for the given pairs. Returns identity for an empty list. */
export function buildWarp(pairs: MatchPair[]): (p: Vec2) => Vec2 {
  if (pairs.length === 0) return (p) => ({ ...p });
  if (pairs.length === 1) {
    const dx = pairs[0].dst.x - pairs[0].src.x;
    const dy = pairs[0].dst.y - pairs[0].src.y;
    return (p) => ({ x: p.x + dx, y: p.y + dy });
  }
  if (pairs.length === 2) {
    // similarity: rotation + uniform scale + translation carrying src0→dst0 and src1→dst1
    const [a, b] = pairs;
    const sv = { x: b.src.x - a.src.x, y: b.src.y - a.src.y };
    const tv = { x: b.dst.x - a.dst.x, y: b.dst.y - a.dst.y };
    const sLen2 = sv.x * sv.x + sv.y * sv.y;
    if (sLen2 < 1e-12) return buildWarp([a]);
    // complex division tv / sv = (cos·s, sin·s)
    const re = (tv.x * sv.x + tv.y * sv.y) / sLen2;
    const im = (tv.y * sv.x - tv.x * sv.y) / sLen2;
    return (p) => {
      const vx = p.x - a.src.x, vy = p.y - a.src.y;
      return { x: a.dst.x + vx * re - vy * im, y: a.dst.y + vx * im + vy * re };
    };
  }

  // full TPS: solve [[K + λI, P], [Pᵀ, 0]] · [w; c] = [v; 0] for x and y targets
  const n = pairs.length;
  const m = n + 3;
  const A: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = pairs[i].src.x - pairs[j].src.x;
      const dy = pairs[i].src.y - pairs[j].src.y;
      A[i][j] = U(dx * dx + dy * dy);
    }
    A[i][i] += 1e-6; // light regularisation: tolerates near-duplicate points
    A[i][n] = A[n][i] = 1;
    A[i][n + 1] = A[n + 1][i] = pairs[i].src.x;
    A[i][n + 2] = A[n + 2][i] = pairs[i].src.y;
  }
  const inv = invert(A);
  if (!inv) return buildWarp(pairs.slice(0, 2)); // degenerate (e.g. collinear) → similarity fallback
  const bx = [...pairs.map((q) => q.dst.x), 0, 0, 0];
  const by = [...pairs.map((q) => q.dst.y), 0, 0, 0];
  const wx = matVec(inv, bx);
  const wy = matVec(inv, by);

  return (p) => {
    let x = wx[n] + wx[n + 1] * p.x + wx[n + 2] * p.y;
    let y = wy[n] + wy[n + 1] * p.x + wy[n + 2] * p.y;
    for (let i = 0; i < n; i++) {
      const dx = p.x - pairs[i].src.x;
      const dy = p.y - pairs[i].src.y;
      const u = U(dx * dx + dy * dy);
      x += wx[i] * u;
      y += wy[i] * u;
    }
    return { x, y };
  };
}

/**
 * Draw `img` warped through `mapSrcToDst` onto `ctx` as a grid of textured triangles.
 * `srcW/srcH` are the source image dimensions; `mapPx` maps source-pixel coords to destination
 * canvas px. `grid` controls warp fidelity (cells per axis).
 */
export function drawWarpedImage(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  srcW: number,
  srcH: number,
  mapPx: (p: Vec2) => Vec2,
  grid = 24
): void {
  const nodes: Vec2[][] = [];
  for (let gy = 0; gy <= grid; gy++) {
    const row: Vec2[] = [];
    for (let gx = 0; gx <= grid; gx++) {
      row.push(mapPx({ x: (gx / grid) * srcW, y: (gy / grid) * srcH }));
    }
    nodes.push(row);
  }
  const tri = (s0: Vec2, s1: Vec2, s2: Vec2, d0: Vec2, d1: Vec2, d2: Vec2) => {
    // affine transform mapping the source triangle onto the destination triangle
    const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    if (Math.abs(den) < 1e-9) return;
    const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
    const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
    const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
    const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
    const e = d0.x - a * s0.x - c * s0.y;
    const f = d0.y - b * s0.x - d * s0.y;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(d0.x, d0.y);
    ctx.lineTo(d1.x, d1.y);
    ctx.lineTo(d2.x, d2.y);
    ctx.closePath();
    // expand the clip a hair to hide seams between triangles
    ctx.clip();
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  };
  const cw = srcW / grid, ch = srcH / grid;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const sx = gx * cw, sy = gy * ch;
      const s00 = { x: sx, y: sy }, s10 = { x: sx + cw, y: sy }, s01 = { x: sx, y: sy + ch }, s11 = { x: sx + cw, y: sy + ch };
      tri(s00, s10, s11, nodes[gy][gx], nodes[gy][gx + 1], nodes[gy + 1][gx + 1]);
      tri(s00, s11, s01, nodes[gy][gx], nodes[gy + 1][gx + 1], nodes[gy + 1][gx]);
    }
  }
}
