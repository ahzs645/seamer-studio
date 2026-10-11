import { describe, expect, it, vi } from 'vitest';
import { Texture } from 'three';
import { artworkImageMatchesSource, bindPieceTextureImages } from './pieceTextureImages';

function image() {
  return { src: '', crossOrigin: '', onload: null, onerror: null, removeAttribute: vi.fn() } as unknown as HTMLImageElement;
}

describe('piece texture decoding lifetime', () => {
  it('rejects oversized decoded images and lying dimensions before inserting a print layer, while leaving fabric unrestricted', () => {
    const declared = { pixelWidth: 200, pixelHeight: 80 };
    expect(artworkImageMatchesSource({ naturalWidth: 200, naturalHeight: 80 }, declared)).toBe(true);
    expect(artworkImageMatchesSource({ naturalWidth: 201, naturalHeight: 80 }, declared)).toBe(false);
    expect(artworkImageMatchesSource({ naturalWidth: 8193, naturalHeight: 1 }, { pixelWidth: 8193, pixelHeight: 1 })).toBe(false);
    expect(artworkImageMatchesSource({ naturalWidth: 5000, naturalHeight: 5000 }, { pixelWidth: 5000, pixelHeight: 5000 })).toBe(false);
    const texture = new Texture(), images = new Map<string, HTMLImageElement>(), ready = vi.fn();
    const print = Object.assign(image(), { naturalWidth: 5000, naturalHeight: 5000 });
    const fabric = Object.assign(image(), { naturalWidth: 5000, naturalHeight: 5000 });
    const queue = [print, fabric];
    bindPieceTextureImages(texture, ['data:image/png;base64,AAAA', '/fabric.png'], images, ready, '', () => queue.shift()!,
      (source, decoded) => source === '/fabric.png' || artworkImageMatchesSource(decoded, declared));
    print.onload?.(new Event('load'));
    expect(images.size).toBe(0);
    expect(ready).not.toHaveBeenCalled();
    fabric.onload?.(new Event('load'));
    expect([...images.keys()]).toEqual(['/fabric.png']);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('retains every decoded layer regardless of fabric/artwork completion order and deduplicates sources', () => {
    const texture = new Texture(), images = new Map<string, HTMLImageElement>();
    const fabric = image(), artwork = image(), queue = [fabric, artwork];
    const source = 'data:image/png;base64,AAAA';
    const ready = vi.fn();
    bindPieceTextureImages(texture, ['/fabric.png', source, source], images, ready, '', () => queue.shift()!);
    artwork.onload?.(new Event('load'));
    expect([...images.keys()]).toEqual([source]);
    fabric.onload?.(new Event('load'));
    expect([...images.keys()]).toEqual([source, '/fabric.png']);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(queue).toHaveLength(0);
  });

  it('cancels pending decoding and ignores callbacks already queued when an old map is disposed', () => {
    const texture = new Texture(), images = new Map<string, HTMLImageElement>(), pending = image();
    const ready = vi.fn();
    bindPieceTextureImages(texture, ['data:image/png;base64,AAAA'], images, ready, '', () => pending);
    const late = pending.onload;
    texture.dispose();
    expect(pending.onload).toBeNull();
    expect(pending.onerror).toBeNull();
    expect(pending.removeAttribute).toHaveBeenCalledWith('src');
    late?.call(pending, new Event('load'));
    expect(images.size).toBe(0);
    expect(ready).not.toHaveBeenCalled();
  });
});
