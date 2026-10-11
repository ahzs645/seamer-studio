import type { Texture } from 'three';
import { MAX_ARTWORK_PIXELS, type ArtworkSource } from '@seamer/pattern-model';
import { loadImageFromCandidates, textureUrlCandidates } from './textureUrl';

/** Imported declarations must match the decoded raster before it can enter a print map. */
export function artworkImageMatchesSource(image: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>, source: Pick<ArtworkSource, 'pixelWidth' | 'pixelHeight'>): boolean {
  const width = image.naturalWidth, height = image.naturalHeight;
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= 8192 && height <= 8192 && width * height <= MAX_ARTWORK_PIXELS &&
    width === source.pixelWidth && height === source.pixelHeight;
}

/** Per-map decoding lifetime: a released texture must never receive a late canvas upload. */
export function bindPieceTextureImages(
  texture: Texture,
  sources: readonly string[],
  images: Map<string, HTMLImageElement>,
  onReady: () => void,
  pathsBase = '',
  createImage: () => HTMLImageElement = () => new Image(),
  acceptImage: (source: string, image: HTMLImageElement) => boolean = () => true
): void {
  let disposed = false;
  const pending: HTMLImageElement[] = [];
  texture.addEventListener('dispose', () => {
    disposed = true;
    for (const image of pending) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
    }
    images.clear();
  });
  for (const source of new Set(sources)) {
    const image = createImage();
    pending.push(image);
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (disposed || !acceptImage(source, image)) return;
      images.set(source, image);
      onReady();
    };
    loadImageFromCandidates(image, textureUrlCandidates(source, pathsBase));
  }
}
