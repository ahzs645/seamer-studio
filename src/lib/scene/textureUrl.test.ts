import { describe, expect, it } from 'vitest';
import { loadImageFromCandidates, textureUrlCandidates } from './textureUrl';

describe('textureUrlCandidates', () => {
  it('resolves legacy SeamScape media through the complete bundled template archive first', () => {
    const remote = 'https://media.seamscape.com/media/owner/40d3d618-a280-4a53-b5e3-d600f6244e6f.jpg';
    expect(textureUrlCandidates(remote, '/seamer-studio')).toEqual([
      '/seamer-studio/templates/textures/40d3d618-a280-4a53-b5e3-d600f6244e6f.jpg',
      '/seamer-studio/textures/40d3d618-a280-4a53-b5e3-d600f6244e6f.jpg',
      remote
    ]);
  });

  it('preserves local, data, and blob URLs', () => {
    expect(textureUrlCandidates('/templates/textures/plaid.jpg', '/seamer-studio')).toEqual([
      '/seamer-studio/templates/textures/plaid.jpg'
    ]);
    expect(textureUrlCandidates('/seamer-studio/textures/plaid.jpg', '/seamer-studio')).toEqual([
      '/seamer-studio/textures/plaid.jpg'
    ]);
    expect(textureUrlCandidates('data:image/png;base64,abc')).toEqual(['data:image/png;base64,abc']);
    expect(textureUrlCandidates('blob:http://localhost/id')).toEqual(['blob:http://localhost/id']);
  });

  it('advances through local mirrors before the original URL', () => {
    const image = { src: '', onerror: null } as unknown as HTMLImageElement;
    loadImageFromCandidates(image, ['/templates/plaid.jpg', '/textures/plaid.jpg', 'https://media.example/plaid.jpg']);
    expect(image.src).toBe('/templates/plaid.jpg');
    image.onerror?.(undefined as unknown as Event);
    expect(image.src).toBe('/textures/plaid.jpg');
    image.onerror?.(undefined as unknown as Event);
    expect(image.src).toBe('https://media.example/plaid.jpg');
  });
});
