// Front-view silhouette of the measurement-driven avatar, rasterised to an offscreen
// canvas for use as the 2D plan background (the original app does the same via an
// offscreen 3D render — here we project the reconstructed rest-pose mesh on the CPU).
//
// Output coordinates: the avatar is reconstructed in meters (+Y up, mirror plane X=0);
// we convert to millimetres to match the pattern's 2D coordinate space.

import { loadAvatarAssets, loadGenderAssets } from './assets';
import { solveBodyCoefficients } from './measurements';
import { reconstructVertices } from './avatar';
import type { Body } from '@seamer/pattern-model';

export interface Silhouette {
  /** offscreen raster of the filled front projection */
  canvas: HTMLCanvasElement;
  /** world-mm bounding box the raster maps onto */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Build (or rebuild) the avatar silhouette raster for a body. Returns null on failure. */
export async function buildSilhouette(body: Body, color = '#9aa6b6'): Promise<Silhouette | null> {
  if (typeof document === 'undefined') return null;
  const assets = await loadAvatarAssets();
  const gender = body.gender === 'male' ? 'male' : 'female';
  const genderAssets = await loadGenderAssets(gender);
  const { coeff } = solveBodyCoefficients(genderAssets.model, body);
  const verts = reconstructVertices(assets.baseModel, genderAssets.coefficients, coeff, assets.numVertices);
  const idx = assets.indices;
  if (verts.length === 0 || idx.length === 0) return null;

  // project front view (x,y), in mm
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i] * 1000, y = verts[i + 1] * 1000;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const wMM = maxX - minX, hMM = maxY - minY;
  if (hMM <= 0 || wMM <= 0) return null;

  const RES_H = 720;                 // raster height in px (blitted scaled to the view)
  const px = RES_H / hMM;            // px per mm
  const cw = Math.max(1, Math.round(wMM * px));
  const ch = RES_H;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const c = canvas.getContext('2d');
  if (!c) return null;

  // Fill every projected triangle (front + back) opaquely; the union is the solid body
  // shape. (A single nonzero/evenodd path would cancel front-vs-back winding and come out
  // empty, so we paint each triangle as its own fill.) Final opacity is set at blit time.
  c.fillStyle = color;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, d = idx[t + 2] * 3;
    const ax = (verts[a] * 1000 - minX) * px,     ay = (maxY - verts[a + 1] * 1000) * px;
    const bx = (verts[b] * 1000 - minX) * px,     by = (maxY - verts[b + 1] * 1000) * px;
    const dx = (verts[d] * 1000 - minX) * px,     dy = (maxY - verts[d + 1] * 1000) * px;
    c.beginPath();
    c.moveTo(ax, ay); c.lineTo(bx, by); c.lineTo(dx, dy); c.closePath();
    c.fill();
  }

  return { canvas, minX, minY, maxX, maxY };
}
