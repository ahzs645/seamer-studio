// Compact 2D vector thumbnail of a pattern (the original's generateFromPattern): piece outlines
// filled with their material colors over a light background, fit to a small canvas. Stored as a
// JPEG data URL in pattern.thumbnailUrl at save time and shown on the pattern list.

import type { Pattern } from '@seamer/pattern-model';
import { indexPaths, indexPoints, pieceWorldOutline, type Vec2 } from './patternGeometry';

export function patternThumbnail(pattern: Pattern, w = 320, h = 240): string | null {
  if (typeof document === 'undefined') return null;
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const pieces = pattern.pieces
    .filter((p) => !p.hidden)
    .map((p) => ({
      poly: pieceWorldOutline(pattern, p, paths, points, 6),
      color: pattern.materials.find((m) => m.id === p.materialId)?.frontTexture?.color || '#cdd5df'
    }))
    .filter((o) => o.poly.length >= 3);
  if (pieces.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pc of pieces) {
    for (const p of pc.poly) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const s = Math.min((w * 0.86) / bw, (h * 0.86) / bh);
  const toPx = (p: Vec2): Vec2 => ({
    x: w / 2 + (p.x - (minX + maxX) / 2) * s,
    y: h / 2 - (p.y - (minY + maxY) / 2) * s // pattern y-up -> canvas y-down
  });

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, w, h);
  for (const pc of pieces) {
    ctx.beginPath();
    const p0 = toPx(pc.poly[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pc.poly.length; i++) { const p = toPx(pc.poly[i]); ctx.lineTo(p.x, p.y); }
    ctx.closePath();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = pc.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(51,65,85,0.55)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }
  try {
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  }
}
