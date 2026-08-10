import { describe, expect, it } from 'vitest';
import type { TextureSlot } from '@seamer/pattern-model';
import {
  clearTexturePatch,
  downloadTextureUrl,
  linkedTexturePatch,
  storedTexturePatch,
  textureMapMode,
  textureMapSourceUrl
} from './materialAssets';

const slot = (): TextureSlot => ({
  url: '', mediaId: null, color: '#fff', scale: 100,
  normalUrl: '', normalMediaId: null, normalMapScale: 100,
  opacityUrl: '', opacityMediaId: null, opacityMapScale: 100
});

describe('material texture sources', () => {
  it('builds explicit linked, uploaded, downloaded, and clear patches', () => {
    expect(linkedTexturePatch('base', ' https://example.com/fabric.jpg ')).toEqual({
      url: 'https://example.com/fabric.jpg', sourceMode: 'linked', sourceUrl: 'https://example.com/fabric.jpg'
    });
    expect(storedTexturePatch('normal', 'data:image/png;base64,AQID', 'downloaded', 'https://example.com/n.png')).toEqual({
      normalUrl: 'data:image/png;base64,AQID', normalSourceMode: 'downloaded', normalSourceUrl: 'https://example.com/n.png'
    });
    expect(clearTexturePatch('opacity')).toEqual({ opacityUrl: '', opacitySourceMode: undefined, opacitySourceUrl: undefined });
  });

  it('retains the original URL after a downloaded map replaces it with data', () => {
    const value = { ...slot(), ...storedTexturePatch('base', 'data:image/png;base64,AQID', 'downloaded', 'https://example.com/f.png') };
    expect(textureMapMode(value, 'base')).toBe('downloaded');
    expect(textureMapSourceUrl(value, 'base')).toBe('https://example.com/f.png');
  });

  it('downloads through the local texture mirror before the remote URL', async () => {
    const requests: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    const data = await downloadTextureUrl('https://media.seamscape.com/fabric.png', { basePath: '/seamer-studio', fetcher });
    expect(requests).toEqual(['/seamer-studio/templates/textures/fabric.png']);
    expect(data).toBe('data:image/png;base64,AQID');
  });
});
