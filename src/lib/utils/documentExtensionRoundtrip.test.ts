import { describe, expect, it } from 'vitest';
import { addPieceArtwork, createColorway, createTechPack, type Pattern } from '@seamer/pattern-model';
import { convertSimplePattern, convertSimplePatternWithLegacyProject, type SimpleFile } from './importSimplePattern';
import { patternToSSP, sspToPattern } from './ssp';
import { dockPane, workspacePreset } from './workspaceLayout';

const raw: SimpleFile = { pieces: [{ name: 'Panel', sewLines: [], boundary: [
  [[0, 0], [100, 0]], [[100, 0], [100, 100]], [[100, 100], [0, 100]], [[0, 100], [0, 0]]
] }] };

function document(): Pattern {
  let next = createColorway(convertSimplePattern(raw), 'Summer');
  next = addPieceArtwork(next, next.pieces[0].id, {
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=',
    mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1
  }, 'logo', 'Brand');
  next.techPack = createTechPack();
  next.techPack.metadata.styleCode = 'SS-101';
  next.techPack.construction = [{ id: 'finish', title: 'Edge finish', pieceId: next.pieces[0].id, instruction: 'Bind perimeter' }];
  next.workspaceLayout = dockPane(workspacePreset('all'), 'specs', '2d', 'below');
  next.viewMode = 'all';
  return next;
}

describe('production, appearance and workspace document integration', () => {
  it('preserves all extensions and canonical identities together through offline SSP and JSON', async () => {
    const source = document();
    for (const restored of [JSON.parse(JSON.stringify(source)) as Pattern, await sspToPattern(await patternToSSP(source))]) {
      expect(restored.techPack).toEqual(source.techPack);
      expect(restored.colorways).toEqual(source.colorways);
      expect(restored.artwork).toEqual(source.artwork);
      expect(restored.workspaceLayout).toEqual(source.workspaceLayout);
      expect(restored.points).toEqual(source.points);
      expect(restored.paths).toEqual(source.paths);
      expect(restored.pieces).toEqual(source.pieces);
      expect(restored.artwork![0].pieceId).toBe(restored.pieces[0].id);
      expect(restored.techPack!.construction[0].pieceId).toBe(restored.pieces[0].id);
    }
  });

  it('keeps extension data independent during paired legacy geometry import, including explicit stale references', () => {
    const source = document();
    source.artwork![0].pieceId = 'removed-piece';
    source.techPack!.construction[0].pieceId = 'removed-piece';
    const restored = convertSimplePatternWithLegacyProject(raw, source);
    for (const field of ['techPack', 'colorways', 'artwork', 'workspaceLayout'] as const) {
      expect(restored[field]).toEqual(source[field]);
      expect(restored[field]).not.toBe(source[field]);
    }
    expect(restored.artwork![0].pieceId).toBe('removed-piece');
    expect(restored.techPack!.construction[0].pieceId).toBe('removed-piece');
    restored.techPack!.metadata.styleCode = 'Changed';
    expect(source.techPack!.metadata.styleCode).toBe('SS-101');
  });

  it('loads older SSP projects without inventing production or appearance extensions', async () => {
    const restored = await sspToPattern(await patternToSSP(convertSimplePattern(raw)));
    expect(restored.techPack).toBeUndefined();
    expect(restored.colorways).toBeUndefined();
    expect(restored.artwork).toBeUndefined();
    expect(restored.workspaceLayout).toBeUndefined();
  });
});
