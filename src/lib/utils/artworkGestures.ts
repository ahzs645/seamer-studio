import { artworkPlacementProblem, artworkSourceUV, type PieceArtwork, type Vec2 } from '@seamer/pattern-model';
import type { ArtworkGestureMode } from '$lib/stores/artworkEditing';

/** Invalid imported placement remains a repair record until its dimensions are corrected. */
export function artworkGestureCanStart(before: PieceArtwork, point: Vec2): boolean {
  if(artworkPlacementProblem(before) || ![point.x,point.y].every(Number.isFinite))return false;
  const uv=artworkSourceUV(before,point);
  return [uv.x,uv.y].every(Number.isFinite) && uv.x>=-.15 && uv.x<=1.15 && uv.y>=-.15 && uv.y<=1.15;
}

/** Both viewports use the same canonical draft-space gesture; previews never enter history. */
export function artworkGesture(before: PieceArtwork, mode: ArtworkGestureMode, start: Vec2, point: Vec2): PieceArtwork {
  if (artworkPlacementProblem(before) || ![start.x, start.y, point.x, point.y].every(Number.isFinite)) return before;
  if (mode === 'translate') return { ...before, x: before.x + point.x - start.x, y: before.y + point.y - start.y };
  const initial = Math.atan2(start.y - before.y, start.x - before.x);
  const current = Math.atan2(point.y - before.y, point.x - before.x);
  if (mode === 'rotate') return { ...before, rotation: before.rotation + (current - initial) * 180 / Math.PI };
  const distance = Math.hypot(start.x - before.x, start.y - before.y);
  if (distance < 1e-6) return before;
  const scale = Math.min(10000 / Math.max(before.widthMm, before.heightMm), Math.max(.01 / Math.min(before.widthMm, before.heightMm), Math.hypot(point.x - before.x, point.y - before.y) / distance));
  return { ...before, widthMm: before.widthMm * scale, heightMm: before.heightMm * scale };
}
