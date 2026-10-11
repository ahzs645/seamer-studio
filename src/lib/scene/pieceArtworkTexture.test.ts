import { describe, expect, it, vi } from 'vitest';
import { artworkDraftPoint, type PieceArtwork } from '@seamer/pattern-model';
import { artworkCanvasTransform, drawPieceArtwork, pieceArtworkFingerprint } from './pieceArtworkTexture';

const artwork: PieceArtwork = { id: 'print', pieceId: 'panel', name: 'Asymmetric print', dataUrl: 'data:image/png;base64,AAAA',
  mimeType: 'image/png', pixelWidth: 200, pixelHeight: 80, x: 70, y: 95, widthMm: 40, heightMm: 25, rotation: 37, opacity: .65 };

describe('piece-bound artwork UV texture', () => {
  it.each([false, true])('maps every image corner and center to canonical mesh UV with mirrored=%s', mirrored => {
    const bounds = { uMin: mirrored ? -180 : -20, vMin: 5, wMM: 200, hMM: 150 };
    const transform = artworkCanvasTransform(artwork, bounds, 1001, 751, 200, 80, mirrored)!;
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [.5, .5]]) {
      const draft = artworkDraftPoint(artwork, u, v);
      const x = transform[0] * u * 200 + transform[2] * v * 80 + transform[4];
      const y = transform[1] * u * 200 + transform[3] * v * 80 + transform[5];
      expect(x).toBeCloseTo(((mirrored ? -draft.x : draft.x) - bounds.uMin) * 1001 / bounds.wMM, 8);
      expect(y).toBeCloseTo(751 - (draft.y - bounds.vMin) * 751 / bounds.hMM, 8);
    }
  });

  it.each([false,true])('preserves reflected source UV orientation with mirrored cut=%s',mirrored=>{
    const reflected={...artwork,flipX:true};const bounds={uMin:mirrored?-180:-20,vMin:5,wMM:200,hMM:150};
    const transform=artworkCanvasTransform(reflected,bounds,1001,751,200,80,mirrored)!;
    for(const [u,v]of [[0,0],[1,0],[1,1],[.2,.7]]){
      const draft=artworkDraftPoint(reflected,u,v);
      expect(transform[0]*u*200+transform[2]*v*80+transform[4]).toBeCloseTo(((mirrored?-draft.x:draft.x)-bounds.uMin)*1001/bounds.wMM,8);
      expect(transform[1]*u*200+transform[3]*v*80+transform[5]).toBeCloseTo(751-(draft.y-bounds.vMin)*751/bounds.hMM,8);
    }
  });

  it('keeps physical print dimensions when the owner UV bounds change after grading', () => {
    const a = artworkCanvasTransform({ ...artwork, rotation: 0 }, { uMin: 0, vMin: 0, wMM: 100, hMM: 100 }, 1000, 1000, 200, 80)!;
    const b = artworkCanvasTransform({ ...artwork, rotation: 0 }, { uMin: -50, vMin: -10, wMM: 250, hMM: 150 }, 1000, 1000, 200, 80)!;
    expect(a[0] * 200 / 10).toBe(40);
    expect(b[0] * 200 / 4).toBe(40);
    expect(b[3] * 80 / (1000 / 150)).toBeCloseTo(25);
  });

  it('rejects malformed placement/bounds and isolates opacity between prints', () => {
    const bounds = { uMin: 0, vMin: 0, wMM: 100, hMM: 100 };
    expect(artworkCanvasTransform({ ...artwork, widthMm: 0 }, bounds, 1000, 1000, 200, 80)).toBeNull();
    expect(artworkCanvasTransform({ ...artwork, rotation: Infinity }, bounds, 1000, 1000, 200, 80)).toBeNull();
    const context = { save: vi.fn(), setTransform: vi.fn(), globalAlpha: 1, drawImage: vi.fn(), restore: vi.fn() };
    const image = { naturalWidth: 200, naturalHeight: 80 } as HTMLImageElement;
    drawPieceArtwork(context as unknown as CanvasRenderingContext2D,
      [artwork, { ...artwork, id: 'hidden', opacity: 0 }, { ...artwork, id: 'invalid', widthMm: NaN },
        { ...artwork, id: 'mismatched-source', pixelWidth: 201 }],
      new Map([[artwork.dataUrl, image]]), bounds, 1000, 1000);
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    expect(context.save).toHaveBeenCalledTimes(1);
    expect(context.restore).toHaveBeenCalledTimes(1);
    expect(context.globalAlpha).toBe(.65);
  });

  it('detects source replacements with equal length and URL tails, without changing for a rename', () => {
    const first = { ...artwork, dataUrl: `data:image/png;base64,${'A'.repeat(40)}${'Z'.repeat(30)}` };
    const second = { ...first, dataUrl: first.dataUrl.replace('AAAA', 'BBBB') };
    expect(pieceArtworkFingerprint([first])).not.toBe(pieceArtworkFingerprint([second]));
    expect(pieceArtworkFingerprint([first])).toBe(pieceArtworkFingerprint([{ ...first, name: 'Renamed' }]));
    expect(pieceArtworkFingerprint([first])).not.toBe(pieceArtworkFingerprint([{ ...first, x: first.x + 1 }]));
    expect(pieceArtworkFingerprint([first])).not.toBe(pieceArtworkFingerprint([{ ...first, pixelWidth: first.pixelWidth + 1 }]));
    expect(() => pieceArtworkFingerprint([{ ...first, dataUrl: undefined as unknown as string }])).not.toThrow();
  });
});
