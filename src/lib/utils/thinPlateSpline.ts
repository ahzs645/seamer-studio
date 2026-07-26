// Thin-plate-spline math is engine-owned; this module keeps only the browser canvas renderer.

import { buildWarp, type MatchPair, type Vec2 } from '@atelier/geometry';

export { buildWarp, type MatchPair };

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
