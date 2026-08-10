import { describe, expect, it } from 'vitest';
import { createEmptyPattern } from '@seamer/pattern-model';
import { createSSPArchive, patternToSSP, readSSPEnvelope, sspToPattern } from './exporters';

const TEXTURE = 'data:image/png;base64,iVBORw0KGgo=';
const PREVIEW = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

describe('legacy SSP avatar compatibility', () => {
  it('preserves body measurements while marking a settled SeamScape snapshot for its default avatar', async () => {
    const pattern = createEmptyPattern();
    pattern.body.fields = { age: 35, height: 65.2, weight: 182, hipGirth: 46 };
    pattern.pieces = [{
      id: 'piece',
      name: 'Back',
      settings3d: {
        savedMeshSnapshot: { positions: [0, 0, 0] },
        savedPositions: []
      }
    } as never];

    const restored = await sspToPattern(await patternToSSP(pattern));

    expect(restored.body.fields).toEqual(pattern.body.fields);
    expect(restored.body.useLegacyDefaultAvatar).toBe(true);
  });

  it('does not change the avatar mode of a native Seamer SSP', async () => {
    const pattern = createEmptyPattern();
    const restored = await sspToPattern(await patternToSSP(pattern));
    expect(restored.body.useLegacyDefaultAvatar).toBeUndefined();
  });

  it('writes a versioned SSP v2 envelope with workspace and zero-velocity checkpoint metadata', async () => {
    const pattern = createEmptyPattern();
    pattern.viewMode = '3d';
    pattern.settings3d.lightingMode = 'sunset';
    pattern.settings3d.cameraPosition = [1, 2, 3];
    pattern.settings3d.controlsTarget = [0, 1, 0];
    pattern.settings3d.cameraFov = 37;
    pattern.pieces = [{
      id: 'piece',
      name: 'Front',
      settings3d: { savedPositions: [0, 0, 1, 2, 3, 10, 0, 4, 5, 6] }
    } as never];
    pattern.images = [
      { id: 'one', url: TEXTURE, x: 0, y: 0, width: 10, height: 10 },
      { id: 'two', url: TEXTURE, x: 10, y: 0, width: 10, height: 10 }
    ];

    const { blob, manifest } = await createSSPArchive(pattern, {
      previewDataUrl: PREVIEW,
      now: () => new Date('2026-08-10T12:00:00.000Z')
    });
    const envelope = await readSSPEnvelope(blob);

    expect(envelope?.format).toBe('seamer-project');
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      minimumReaderSchemaVersion: 2,
      createdAt: '2026-08-10T12:00:00.000Z',
      workspace: {
        viewMode: '3d', lightingMode: 'sunset', cameraPosition: [1, 2, 3],
        controlsTarget: [0, 1, 0], cameraFov: 37
      },
      checkpoint: { kind: 'particle-positions', resumePolicy: 'zero-velocity', pieceCount: 1, particleCount: 2 },
      assetCount: 2,
      unresolvedAssets: []
    });
    expect(envelope?.assets).toHaveLength(2); // duplicate image URLs are stored once + one preview
    expect(envelope?.pattern.images[0].url).toBe(envelope?.pattern.images[1].url);
    expect(envelope?.pattern.images[0].url).toMatch(/^ssp-asset:\/\//);

    const restored = await sspToPattern(blob);
    expect(restored.images[0].url).toBe(TEXTURE);
    expect(restored.images[1].url).toBe(TEXTURE);
    expect(restored.thumbnailUrl).toBe(PREVIEW);
    expect(restored.pieces[0].settings3d.savedPositions).toEqual(pattern.pieces[0].settings3d.savedPositions);
  });

  it('archives a remote texture from its local mirror and reports URLs that cannot be fetched', async () => {
    const pattern = createEmptyPattern();
    pattern.images = [
      { id: 'ok', url: 'https://media.seamscape.com/fabric.png', x: 0, y: 0, width: 10, height: 10 },
      { id: 'missing', url: 'https://example.com/missing.png', x: 0, y: 0, width: 10, height: 10 }
    ];
    const requests: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === '/seamer-studio/templates/textures/fabric.png') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const { blob, manifest } = await createSSPArchive(pattern, { basePath: '/seamer-studio', fetcher });
    const restored = await sspToPattern(blob);

    expect(requests[0]).toBe('/seamer-studio/templates/textures/fabric.png');
    expect(restored.images[0].url).toBe('data:image/png;base64,AQID');
    expect(restored.images[1].url).toBe('https://example.com/missing.png');
    expect(manifest.unresolvedAssets).toEqual(['https://example.com/missing.png']);
  });

  it('keeps URL-only material maps linked while embedding downloaded material maps', async () => {
    const pattern = createEmptyPattern();
    pattern.materials = [{
      id: 'fabric', name: 'Mixed storage', useSeparateBackSide: false,
      frontTexture: {
        url: 'https://cdn.example.com/linked.png', sourceMode: 'linked', sourceUrl: 'https://cdn.example.com/linked.png',
        mediaId: null, color: '#ffffff', scale: 100,
        normalUrl: 'https://cdn.example.com/normal.png', normalSourceMode: 'downloaded', normalSourceUrl: 'https://cdn.example.com/normal.png',
        normalMediaId: null, normalMapScale: 100,
        opacityUrl: '', opacityMediaId: null, opacityMapScale: 100
      },
      backTexture: null,
      stretchWarpValue: 10, stretchWeftValue: 10, bendValue: 10, thickness: 0.5, weight: 150,
      roughness: 0.8, metalness: 0, specularIntensity: 0.5, opacity: 1, normalScale: 1, alphaCutoff: 0,
      libraryItemId: null, libraryVersion: null, libraryUpdatedAt: null
    }];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/normal.png')) {
        return new Response(new Uint8Array([4, 5, 6]), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`URL-only map must not be fetched: ${url}`);
    }) as typeof fetch;

    const { blob, manifest } = await createSSPArchive(pattern, { fetcher });
    const envelope = await readSSPEnvelope(blob);
    const restored = await sspToPattern(blob);

    expect(manifest.assetCount).toBe(1);
    expect(envelope?.pattern.materials[0].frontTexture?.url).toBe('https://cdn.example.com/linked.png');
    expect(envelope?.pattern.materials[0].frontTexture?.normalUrl).toMatch(/^ssp-asset:\/\//);
    expect(restored.materials[0].frontTexture?.url).toBe('https://cdn.example.com/linked.png');
    expect(restored.materials[0].frontTexture?.normalUrl).toBe('data:image/png;base64,BAUG');
    expect(restored.materials[0].frontTexture?.sourceMode).toBe('linked');
    expect(restored.materials[0].frontTexture?.normalSourceMode).toBe('downloaded');
  });

  it('still opens the old gzip Pattern-root format', async () => {
    const pattern = createEmptyPattern();
    pattern.name = 'SSP v1 project';
    const stream = new Blob([JSON.stringify(pattern)]).stream().pipeThrough(new CompressionStream('gzip'));
    const legacyBlob = await new Response(stream).blob();

    expect((await sspToPattern(legacyBlob)).name).toBe('SSP v1 project');
    expect(await readSSPEnvelope(legacyBlob)).toBeNull();
  });

  it('still opens legacy SeamScape deflate projects', async () => {
    const pattern = createEmptyPattern();
    pattern.name = 'Legacy SeamScape project';
    const stream = new Blob([JSON.stringify(pattern)]).stream().pipeThrough(new CompressionStream('deflate'));
    const legacyBlob = await new Response(stream).blob();

    expect((await sspToPattern(legacyBlob)).name).toBe('Legacy SeamScape project');
  });
});
