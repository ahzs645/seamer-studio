// Baked per-piece fabric texture (the original's buildPieceTextureCanvas / getPieceTextureSource):
// the material print is anchored at the PIECE ORIGIN and rotated by the GRAIN ANGLE, and the
// piece's internal style lines are drawn into the map — so prints follow grain and internal lines
// survive into 3D. The canvas covers the piece's UV bbox (mesh UVs are piece-local mm); the
// texture's offset/repeat map mm → 0..1 so the same geometry UVs sample it correctly.

import * as THREE from 'three';
import type { TextureSlot, Vec2 } from '@seamer/pattern-model';

export interface PieceBake {
  /** material texture slot driving the print (null = solid color piece) */
  slot: TextureSlot | null;
  /** base fill color when no image (or while it loads) */
  fillColor: string;
  /** internal style lines in UV space (piece-local mm, mirror sign already applied) */
  internalPolys: Vec2[][];
  /** piece origin in UV space (print anchor) */
  originUV: Vec2;
  /** grain angle in degrees, UV space (CCW from +x; mirror already applied) */
  grainDeg: number;
  /** mesh UV bbox (piece-local mm) */
  uMin: number;
  vMin: number;
  wMM: number;
  hMM: number;
  /** renderer anisotropy for the map (the original: 8 desktop, 2 mobile) */
  anisotropy: number;
}

const isMobile = (): boolean =>
  typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

/** A piece needs a bake when it has a print to align or internal lines to show. */
export function pieceNeedsBake(bake: Pick<PieceBake, 'slot' | 'internalPolys'>): boolean {
  return !!bake.slot?.url || bake.internalPolys.some((p) => p.length >= 2);
}

/** Resolve a media URL the way the 2D canvas does: data/blob pass through, remote media is served
 *  from a local copy by basename under /textures. */
function resolveTextureUrl(url: string): string {
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('/')) return url;
  const base = url.split('/').pop()?.split('?')[0] ?? '';
  return `/textures/${base}`;
}

function drawBake(canvas: HTMLCanvasElement, bake: PieceBake, image: HTMLImageElement | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const ppm = canvas.width / bake.wMM; // px per mm
  // mm (y up) -> canvas px (y down). With the default texture flipY, canvas top = v max.
  const toPx = (p: Vec2): Vec2 => ({ x: (p.x - bake.uMin) * ppm, y: canvas.height - (p.y - bake.vMin) * ppm });

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = bake.fillColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (image && bake.slot) {
    const pat = ctx.createPattern(image, 'repeat');
    if (pat) {
      const tileMm = bake.slot.scale && bake.slot.scale > 0 ? bake.slot.scale : 100;
      const f = (tileMm * ppm) / image.naturalWidth;
      const o = toPx(bake.originUV);
      // anchor at the piece origin, rotate so the print's vertical follows the grain
      // (grain (0,1) = default = upright print; mm CCW angles are CW in canvas space)
      pat.setTransform(new DOMMatrix().translateSelf(o.x, o.y).rotateSelf(90 - bake.grainDeg).scaleSelf(f));
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  // internal style lines (darts, fold lines, style seams) baked into the print
  if (bake.internalPolys.length) {
    ctx.strokeStyle = 'rgba(30,41,59,0.85)';
    ctx.lineWidth = Math.max(1, 0.6 * ppm); // ~0.6 mm line
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const poly of bake.internalPolys) {
      if (poly.length < 2) continue;
      ctx.beginPath();
      const p0 = toPx(poly[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < poly.length; i++) {
        const p = toPx(poly[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }
}

/**
 * Bake the piece map. Renders synchronously with the solid color + internal lines, then (if the
 * slot carries an image) loads it and re-bakes in place — the returned CanvasTexture stays stable.
 */
export function createPieceTexture(bake: PieceBake): THREE.CanvasTexture {
  const maxDim = isMobile() ? 1024 : 2048;
  const ppm = Math.min(4, maxDim / Math.max(bake.wMM, bake.hMM, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(8, Math.ceil(bake.wMM * ppm));
  canvas.height = Math.max(8, Math.ceil(bake.hMM * ppm));

  drawBake(canvas, bake, null);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = bake.anisotropy;
  tex.generateMipmaps = true;
  // geometry UVs are piece-local mm: map them onto the bbox-sized canvas
  tex.repeat.set(1 / bake.wMM, 1 / bake.hMM);
  tex.offset.set(-bake.uMin / bake.wMM, -bake.vMin / bake.hMM);

  if (bake.slot?.url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      drawBake(canvas, bake, img);
      tex.needsUpdate = true;
    };
    img.src = resolveTextureUrl(bake.slot.url);
  }
  return tex;
}
