import { describe, expect, it } from 'vitest';
import {
  createEmptyPattern, createTechPack, validateDocumentExtensions,
  MAX_ARTWORK_SOURCE_BYTES, MAX_ARTWORK_PROJECT_BYTES,
  type Pattern, type PieceArtwork
} from '@seamer/pattern-model';
import { patternToSSP, sspToPattern } from './ssp';

const print = (id = 'print'): PieceArtwork => ({
  id, pieceId: 'deleted-piece', name: 'Recoverable print', dataUrl: 'https://example.invalid/print.png',
  mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, x: 0, y: 0,
  widthMm: 20, heightMm: 20, rotation: 0, opacity: 1
});
function fixture(): Pattern {
  return {
    ...createEmptyPattern(),
    techPack: { ...createTechPack(), sampleSizeId: 'stale-size',
      sizeMeasurements: { 'stale-pom': { 'stale-size': { target: 10, actual: null, notes: '' } } },
      construction: [{ id: 'construction', title: 'Missing owner retained', pieceId: 'deleted-piece', instruction: 'Repair reference.' }],
      costing: [{ id: 'cost', name: 'Fabric', procurementId: 'deleted-bom', materialId: null, supplier: '', sku: '', quantity: null, unit: 'm', unitCost: 7, notes: '' }] },
    colorways: { activeId: 'stale-active', variants: [{ id: 'variant', name: 'Saved', pieces: { 'deleted-piece': { materialId: 'deleted-fabric', frontColor: '#123456' } } }], generatedMaterialSources: { 'deleted-copy': 'deleted-source' } },
    artwork: [print()]
  };
}
async function compressed(value: unknown): Promise<Blob> {
  return new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

describe('optional document extension admission', () => {
  it('preserves absence, valid stale references and repairable source/placement data without fetching or mutating', () => {
    expect(() => validateDocumentExtensions(createEmptyPattern())).not.toThrow();
    const pattern = fixture();
    pattern.artwork![0].widthMm = -1; // Finite invalid bounds are surfaced by the existing repair UI.
    const before = structuredClone(pattern);
    expect(() => validateDocumentExtensions(pattern)).not.toThrow();
    expect(pattern).toEqual(before);
    pattern.artwork![0].dataUrl = 'data:image/png;base64,broken!';
    expect(() => validateDocumentExtensions(pattern)).not.toThrow();
  });

  it.each([
    ['artwork', [null]], ['artwork', {}], ['artwork', [{ ...print(), opacity: Infinity }]],
    ['artwork', [{ ...print(), mimeType: 'image/svg+xml' }]], ['artwork', [{ ...print(), pixelWidth: '1' }]],
    ['artwork', [{ ...print(), pixelWidth: 8192, pixelHeight: 8192 }]],
    ['artwork', [print(), print()]], ['colorways', {}], ['colorways', null],
    ['colorways', { ...fixture().colorways, variants: [null] }],
    ['colorways', { ...fixture().colorways, generatedMaterialSources: { clone: 5 } }],
    ['colorways', { ...fixture().colorways, variants: [{ id: 'v', name: 'Name', pieces: { owner: { materialId: 10 } } }] }],
    ['colorways', { ...fixture().colorways, variants: [{ id: 'v', name: 'Name', pieces: { owner: { materialId: '', frontColor: 10 } } }] }],
    ['techPack', {}], ['techPack', { ...createTechPack(), sizes: [null] }],
    ['techPack', { ...createTechPack(), metadata: { ...createTechPack().metadata, status: 'unknown' } }],
    ['techPack', { ...createTechPack(), sizeMeasurements: { pom: { size: { target: 1, actual: null } } } }],
    ['techPack', { ...createTechPack(), construction: [{ id: 'x', title: '', pieceId: 5, instruction: '' }] }],
    ['techPack', { ...createTechPack(), costing: [{ id: 'cost' }] }]
  ])('rejects malformed %s records with a descriptive field path', (key, value) => {
    expect(() => validateDocumentExtensions({ [key as string]: value })).toThrow(/Invalid document extension:/);
  });

  it('enforces embedded per-source and total project byte limits before adoption', () => {
    const oversized = `data:image/png;base64,${Buffer.alloc(MAX_ARTWORK_SOURCE_BYTES + 1).toString('base64')}`;
    expect(() => validateDocumentExtensions({ artwork: [{ ...print(), dataUrl: oversized }] })).toThrow(/2 MiB/);
    const sourceBytes = Math.floor(MAX_ARTWORK_PROJECT_BYTES / 5) + 1;
    const source = `data:image/png;base64,${Buffer.alloc(sourceBytes).toString('base64')}`;
    expect(() => validateDocumentExtensions({ artwork: Array.from({ length: 5 }, (_, index) => ({ ...print(`print-${index}`), dataUrl: source })) })).toThrow(/8 MiB/);
  });

  it('keeps the current document unchanged when malformed native gzip or SSP envelopes fail admission', async () => {
    const current = fixture(), snapshot = structuredClone(current);
    for (const extension of [{ artwork: [null] }, { techPack: {} }, { colorways: {} }]) {
      const malformed = { ...createEmptyPattern(), ...extension };
      for (const payload of [malformed, { format: 'seamer-project', pattern: malformed, manifest: { schemaVersion: 2 }, assets: [] }]) {
        const archive = await compressed(payload);
        await expect(sspToPattern(archive)).rejects.toThrow(/Invalid document extension:/);
        expect(current).toEqual(snapshot);
      }
    }
  });

  it('round-trips valid optional extensions and stale/repair references through JSON and native SSP', async () => {
    const pattern = fixture();
    const parsed = JSON.parse(JSON.stringify(pattern));
    expect(() => validateDocumentExtensions(parsed)).not.toThrow();
    const restored = await sspToPattern(await patternToSSP(pattern));
    expect(restored.techPack).toEqual(pattern.techPack);
    expect(restored.colorways).toEqual(pattern.colorways);
    expect(restored.artwork).toEqual(pattern.artwork);
  });
});
