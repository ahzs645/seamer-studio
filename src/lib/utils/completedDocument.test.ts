import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProductionAutomation, createRangePlan, createTechPack, saveAppearanceVersion, validateDocumentExtensions, type Pattern, type PieceArtwork } from '@seamer/pattern-model';
import { patternToSSP, sspToPattern } from './ssp';
import { createLinkedMirror } from './linkedMirror';
import { synchronizeLinkedDraft } from './draftingSync';

const source = JSON.parse(readFileSync(new URL('../../../static/templates/pencil-skirt.json', import.meta.url), 'utf8')) as Pattern;
const artwork = (): PieceArtwork => ({ id: 'print', pieceId: source.pieces[0].id, name: 'Repeat motif', dataUrl: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, x: 0, y: 0, widthMm: 10, heightMm: 20, rotation: 35, opacity: .7,
  flipX: true, repeat: { mode: 'brick', gapXmm: 2, gapYmm: 3 }, treatment: { blend: 'multiply', tint: '#123456' }, zone: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 50 }] });
function fixture(): Pattern {
  const pattern = structuredClone(source);
  pattern.artwork = [artwork()]; pattern.techPack = createTechPack(); pattern.productionAutomation = createProductionAutomation(); pattern.rangePlan = createRangePlan('collection');
  pattern.productionSpec = { measurements: [{ id: 'pom', name: 'Sample', annotationId: null, surfaceMeasurementId: 'missing-capture', unit: 'cm', manualValue: null, target: 40, tolMinus: .5, tolPlus: 1, notes: '' }], procurement: [] };
  pattern.techPack.exchangeRates = [{ id: 'fx', fromCurrency: 'USD', toCurrency: 'EUR', rate: .92, date: '2026-10-11', source: 'Authored supplier quote' }];
  pattern.productionAutomation.grades = [{ pomId: 'pom', baseSizeId: 'missing-size', baseTarget: 40, increment: 2, unit: 'cm', source: 'entered' }];
  return saveAppearanceVersion(pattern, 'appearance', 'Sample look', '2026-10-11T00:00:00Z');
}
describe('complete design document admission and persistence', () => {
  it('round-trips every implemented extension with structured surface edits and repairable references', async () => {
    const pattern = fixture(), before = structuredClone(pattern);
    validateDocumentExtensions(pattern);
    const json = JSON.parse(JSON.stringify(pattern)); validateDocumentExtensions(json);
    const restored = await sspToPattern(await patternToSSP(pattern));
    for (const key of ['productionSpec', 'productionAutomation', 'techPack', 'rangePlan', 'artwork', 'appearanceHistory'] as const) expect(restored[key]).toEqual(pattern[key]);
    expect(pattern).toEqual(before);
  });
  it('rejects malformed relationships before renderer, export, or historical restore', () => {
    const pattern = fixture();
    for (const update of [
      { productionSpec: { measurements: [null], procurement: [] } },
      { productionAutomation: { ...pattern.productionAutomation, grades: [...pattern.productionAutomation!.grades, ...pattern.productionAutomation!.grades] } },
      { rangePlan: { ...pattern.rangePlan, styles: [null] } },
      { artwork: [{ ...artwork(), repeat: { mode: 'brick', gapXmm: Infinity, gapYmm: 0 } }] },
      { artwork: [{ ...artwork(), flipX: 'true' }] },
      { artwork: [{ ...artwork(), vectorDesign: { width: 100, height: 100, shapes: [{ kind: 'script' }] } }] },
      { techPack: { ...pattern.techPack, exchangeRates: [{ ...pattern.techPack!.exchangeRates![0], rate: 0 }] } },
      { appearanceHistory: { versions: [{ ...pattern.appearanceHistory!.versions[0], materials: [{ id: 'bad', name: 'Bad material' }] }] } },
      { pieces: [{ ...pattern.pieces[0], linkedMirror: { sourcePieceId: 'source', axisPathId: 'axis', pointMap: { a: 'same', b: 'same' } } }] },
      { pieces: [{ ...pattern.pieces[0], firstEdgeSymmetryAffine: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } }] },
      { pieces: [{ ...pattern.pieces[0], firstEdgeSymmetryAffine: { a: -1, b: 0, c: 0, d: 1, tx: 0, ty: Infinity } }] }
    ]) expect(() => validateDocumentExtensions({ ...pattern, ...update })).toThrow();
  });
  it('updates linked geometry within a canonical command result while appearance changes retain solved geometry', () => {
    const pattern = structuredClone(source), piece = pattern.pieces[0];
    const origin = pattern.points.find(point => point.id === piece.originPoint)!;
    pattern.points.push({ id: 'axis-a', name: 'Axis A', x: origin.x - 100, y: origin.y - 100 }, { id: 'axis-b', name: 'Axis B', x: origin.x - 100, y: origin.y + 100 });
    pattern.paths.push({ id: 'axis', name: 'Axis', pathType: 'line', pathPoints: [{ id: 'axis-a' }, { id: 'axis-b' }], version: 1 });
    const linked = createLinkedMirror(pattern, piece.id, 'axis');
    const changed = { ...linked, points: linked.points.map(point => point.id === origin.id ? { ...point, x: point.x + 10, constraint: undefined } : point) };
    const synchronized = synchronizeLinkedDraft(linked, changed);
    const mirrored = synchronized.points.find(point => point.constraint?.type === 'mirror' && point.constraint.source === origin.id)!;
    expect(mirrored.x).toBeCloseTo(2 * (origin.x - 100) - (origin.x + 10));
    const appearance = { ...synchronized, artwork: [artwork()], rangePlan: createRangePlan('new-collection') };
    expect(synchronizeLinkedDraft(synchronized, appearance)).toBe(appearance);
    expect(appearance.points).toBe(synchronized.points);
  });
});
