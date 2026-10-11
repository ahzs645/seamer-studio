import { artworkPlacementProblem, type PieceArtwork } from '@seamer/pattern-model';
import { artworkRepeatTiles, artworkSurfaceProblem, artworkInkImage } from '$lib/utils/artworkSurface';
import { artworkImageMatchesSource } from './pieceTextureImages';

export interface ArtworkTextureBounds {
  uMin: number;
  vMin: number;
  wMM: number;
  hMM: number;
}

// Source strings are immutable; keep a small bounded cache so moving a multi-MB print does not
// hash its pixels again on every pointer update. Include all bytes rather than URL length/tail.
const sourceHashes = new Map<string, string>();
function sourceHash(source: string): string {
  if (typeof source !== 'string') return `invalid-source:${typeof source}`;
  const cached = sourceHashes.get(source);
  if (cached) return cached;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  const value = `${source.length}:${hash >>> 0}`;
  if (sourceHashes.size >= 16) sourceHashes.delete(sourceHashes.keys().next().value!);
  sourceHashes.set(source, value);
  return value;
}

export function pieceArtworkFingerprint(artwork: readonly PieceArtwork[]): string {
  return JSON.stringify(artwork.map(item => ({ id: item.id, piece: item.pieceId, source: sourceHash(item.dataUrl),
    mime: item.mimeType, pixelWidth: item.pixelWidth, pixelHeight: item.pixelHeight,
    x: item.x, y: item.y, w: item.widthMm, h: item.heightMm, r: item.rotation, opacity: item.opacity, flipX: item.flipX, repeat: item.repeat, treatment: item.treatment, zone: item.zone })));
}

/** Source pixels -> piece UV canvas. Mesh UVs are canonical drafting millimetres;
 * mirrored cut instances negate only U. Source images have V down, drafting has Y up. */
export function artworkCanvasTransform(
  artwork: PieceArtwork,
  bounds: ArtworkTextureBounds,
  canvasWidth: number,
  canvasHeight: number,
  imageWidth: number,
  imageHeight: number,
  mirrored = false
): [number, number, number, number, number, number] | null {
  const values = [artwork.x, artwork.y, artwork.rotation, artwork.widthMm, artwork.heightMm,
    bounds.uMin, bounds.vMin, bounds.wMM, bounds.hMM, canvasWidth, canvasHeight, imageWidth, imageHeight];
  if (!values.every(Number.isFinite) || [artwork.widthMm, artwork.heightMm, bounds.wMM, bounds.hMM,
    canvasWidth, canvasHeight, imageWidth, imageHeight].some(value => value <= 0)) return null;
  const sign = mirrored ? -1 : 1;
  const radians = artwork.rotation * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const px = canvasWidth / bounds.wMM, py = canvasHeight / bounds.hMM;
  const inkU = artwork.flipX ? -1 : 1;
  const a = inkU * sign * artwork.widthMm * cos * px / imageWidth;
  const b = -inkU * artwork.widthMm * sin * py / imageWidth;
  const c = sign * artwork.heightMm * sin * px / imageHeight;
  const d = artwork.heightMm * cos * py / imageHeight;
  const centerX = (sign * artwork.x - bounds.uMin) * px;
  const centerY = canvasHeight - (artwork.y - bounds.vMin) * py;
  return [a, b, c, d, centerX - (a * imageWidth + c * imageHeight) / 2,
    centerY - (b * imageWidth + d * imageHeight) / 2];
}

/** Draw in document order; the garment mesh clips the resulting map to its actual boundary. */
export function drawPieceArtwork(
  context: CanvasRenderingContext2D,
  artwork: readonly PieceArtwork[],
  images: ReadonlyMap<string, HTMLImageElement>,
  bounds: ArtworkTextureBounds,
  width: number,
  height: number,
  mirrored = false
): void {
  for (const item of artwork) {
    const image = images.get(item.dataUrl);
    if (!image || !artworkImageMatchesSource(image, item) || !Number.isFinite(item.opacity) || item.opacity <= 0 || artworkSurfaceProblem(item) || artworkPlacementProblem(item)) continue;
    let tiles: PieceArtwork[];
    try { tiles=artworkRepeatTiles(item,{minX:mirrored?-(bounds.uMin+bounds.wMM):bounds.uMin,maxX:mirrored?-bounds.uMin:bounds.uMin+bounds.wMM,minY:bounds.vMin,maxY:bounds.vMin+bounds.hMM}); } catch {continue;}
    context.save();
    context.setTransform(1,0,0,1,0,0);
    if(item.zone) {
      context.beginPath();item.zone.forEach((point,index)=>{const x=((mirrored?-point.x:point.x)-bounds.uMin)*width/bounds.wMM,y=height-(point.y-bounds.vMin)*height/bounds.hMM;if(index)context.lineTo(x,y);else context.moveTo(x,y);});context.closePath();context.clip();
    }
    context.globalAlpha = Math.min(1, item.opacity);context.globalCompositeOperation=item.treatment?.blend??'source-over';
    for(const tile of tiles) {
      const transform = artworkCanvasTransform(tile, bounds, width, height, image.naturalWidth, image.naturalHeight, mirrored);
      if (!transform) continue;
      context.setTransform(...transform);context.drawImage(artworkInkImage(image,item.treatment?.tint),0,0);
    }
    context.restore();
  }
}
