import { describe, expect, it } from 'vitest';
import { createEmptyPattern, createTechPack, type Pattern, type TechPackCosting } from '@seamer/pattern-model';
import { convertSimplePattern } from './importSimplePattern';
import { convertTechPackMeasurementUnits, resolveSizeMeasurement, resolveTechPackCosting, techPackCostSummary } from './techPack';
import { escapeTechPackHtml, patternToTechPackCsv, patternToTechPackHtml, prepareTechPackHtml, techPackCsvCell, techPackRasterSource } from './techPackExport';
import { patternToSSP, sspToPattern } from './ssp';

const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';
function sample(): Pattern {
  const pattern = createEmptyPattern();
  pattern.name = 'Sample garment';
  pattern.productionSpec = { measurements: [{ id: 'hem', name: 'Hem width', annotationId: null, unit: 'cm', manualValue: 50, target: 50, tolMinus: 1, tolPlus: 2, notes: 'Flat laid' }], procurement: [{ id: 'zip', name: 'Invisible zip', category: 'trim', quantity: 2, unit: 'each', notes: '20 cm' }] };
  pattern.techPack = createTechPack();
  pattern.techPack.metadata = { ...pattern.techPack.metadata, styleCode: 'SK-01', revision: 'B', supplier: 'Factory A', currency: 'CAD' };
  pattern.techPack.sizes = [{ id: 'm', name: 'M' }, { id: 'l', name: 'L' }];
  pattern.techPack.sampleSizeId = 'm';
  pattern.techPack.sizeMeasurements = { hem: { m: { target: 50, actual: 51, notes: 'Sample checked' }, l: { target: 54, actual: null, notes: '' } } };
  return pattern;
}
function costing(patch: Partial<TechPackCosting> = {}): TechPackCosting {
  return { id: 'c', name: 'Zip', procurementId: 'zip', materialId: null, supplier: 'Supplier A', sku: 'Z-20', quantity: 99, unit: 'wrong', unitCost: 3.5, notes: '', ...patch };
}

describe('Tech Pack production document and exports', () => {
  it('exports identity, sample checks, explicit size targets and asymmetric tolerances', () => {
    const html = patternToTechPackHtml(sample(), { now: new Date('2026-10-11T01:02:03Z') });
    expect(html).toContain('SK-01'); expect(html).toContain('Factory A');
    expect(html).toContain('M (sample) target / actual / check');
    expect(html).toContain('54 / —');
    expect(html).toContain('Within tolerance'); expect(html).toContain('Enter sample actual');
    expect(html).toContain('<th>− tol</th><th>+ tol</th>');
    expect(html).toContain('2026-10-11T01:02:03.000Z');
    expect(html).toContain('not sewn garment measurements');
  });
  it('never substitutes zero or passing checks for missing annotation references', () => {
    const p = sample(); p.productionSpec!.measurements[0].annotationId = 'deleted';
    expect(patternToTechPackHtml(p)).toContain('Missing annotation');
    expect(patternToTechPackCsv(p, 'measurements')).toContain('"cm","","50"');
  });
  it('uses manual size values independently of linked geometry and exposes missing references', () => {
    const p = sample(); p.productionSpec!.measurements[0].annotationId = 'deleted';
    expect(resolveSizeMeasurement(p, 'hem', 'm')).toMatchObject({ actual: 51, status: 'Within tolerance' });
    p.techPack!.sizeMeasurements.deleted = { old: { target: 123, actual: 122, notes: 'Lost anchor' } };
    expect(resolveSizeMeasurement(p, 'hem', 'unknown')).toMatchObject({ actual: null, valid: false });
    expect(patternToTechPackHtml(p)).toContain('Missing POM or size reference: deleted / old');
  });
  it('converts every saved size target and actual when a POM unit changes without mutating the source', () => {
    const p = sample();
    const result = convertTechPackMeasurementUnits(p.techPack!, 'hem', 'cm', 'inch');
    expect(result.sizeMeasurements.hem.m.target).toBeCloseTo(50 / 2.54);
    expect(result.sizeMeasurements.hem.m.actual).toBeCloseTo(51 / 2.54);
    expect(result.sizeMeasurements.hem.l.actual).toBeNull();
    expect(result.sizeMeasurements.hem.m.notes).toBe('Sample checked');
    expect(p.techPack!.sizeMeasurements.hem.m.target).toBe(50);
    expect(convertTechPackMeasurementUnits(p.techPack!, 'hem', 'cm', 'deg').sizeMeasurements.hem.m).toMatchObject({ actual: null, target: null });
  });
  it('keeps supplier costs tied to live procurement quantities and excludes deleted sources', () => {
    const p = sample(); const entry = costing(); p.techPack!.costing = [entry];
    expect(resolveTechPackCosting(p, entry)).toMatchObject({ name: 'Invisible zip', quantity: 2, unit: 'each', total: 7 });
    p.productionSpec!.procurement[0].quantity = 3;
    expect(techPackCostSummary(p)).toMatchObject({ subtotal: 10.5, complete: true });
    p.productionSpec!.procurement = [];
    expect(resolveTechPackCosting(p, entry)).toMatchObject({ missing: true, total: null });
    expect(patternToTechPackHtml(p)).toContain('Missing BOM or fabric reference');
    expect(techPackCostSummary(p)).toMatchObject({ subtotal: 0, complete: false });
  });
  it('leaves unknown consumption and invalid costs unpriced, while zero cost is a real entered value', () => {
    const p = sample();
    p.techPack!.costing = [costing({ procurementId: null, quantity: null }), costing({ id: 'free', procurementId: null, quantity: 2, unitCost: 0 })];
    expect(techPackCostSummary(p)).toMatchObject({ subtotal: 0, pricedCount: 1, totalCount: 2, complete: false });
    expect(resolveTechPackCosting(p, costing({ unitCost: Infinity })).total).toBeNull();
    p.techPack!.costing = [costing({ procurementId: null, quantity: 1, unitCost: 1e308 }), costing({ id: 'huge2', procurementId: null, quantity: 1, unitCost: 1e308 })];
    expect(techPackCostSummary(p)).toMatchObject({ subtotal: null, complete: false });
  });
  it('escapes all editable text and keeps downloaded HTML free of executable or external resources', () => {
    const p = sample(); const attack = '</title><script>alert("x")</script><img src="https://evil.test/x">&';
    p.name = attack; p.description = attack; p.techPack!.metadata.notes = attack;
    p.techPack!.construction = [{ id: 'note', title: attack, pieceId: null, instruction: attack }];
    p.productionSpec!.measurements[0].name = attack;
    p.techPack!.metadata.currency = attack;
    p.thumbnailUrl = 'https://evil.test/remote.png';
    const html = patternToTechPackHtml(p);
    expect(html).toContain(escapeTechPackHtml(attack));
    expect(html).not.toMatch(/<script|<img[^>]+src="https?:|<link\b/i);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('@media print'); expect(html).toContain('break-inside:avoid');
  });
  it('only embeds bounded PNG/JPEG/WebP base64 raster previews', () => {
    expect(techPackRasterSource(PIXEL)).toBe(PIXEL);
    expect(techPackRasterSource('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(techPackRasterSource('https://example.com/a.png')).toBeNull();
    expect(techPackRasterSource('data:image/png;base64,abc" onerror="alert(1)')).toBeNull();
    expect(techPackRasterSource('data:image/png;base64,' + 'a'.repeat(4_000_000))).toBeNull();
  });
  it('renders active colorway from current assignments and preserves inactive missing-reference warnings', () => {
    const p = convertSimplePattern({ pieces: [{ name: 'Panel', sewLines: [], boundary: [[[0, 0], [10, 0]], [[10, 0], [0, 10]], [[0, 10], [0, 0]]] }] });
    const piece = p.pieces[0]; const material = p.materials[0]; material.frontTexture!.color = '#123456';
    p.colorways = { activeId: 'a', generatedMaterialSources: {}, variants: [
      { id: 'a', name: 'Active blue', pieces: { [piece.id]: { materialId: 'stale', frontColor: '#ffffff' } } },
      { id: 'b', name: 'Missing variant', pieces: { removed: { materialId: 'deleted', frontColor: '#abcdef' } } }
    ] };
    const before = JSON.stringify(p); const html = patternToTechPackHtml(p);
    expect(html).toContain('Active blue · active'); expect(html).toContain('#123456');
    expect(html).toContain('Missing piece (removed)'); expect(html).toContain('Missing fabric (deleted)');
    expect(html).not.toContain('Missing fabric (stale)'); expect(JSON.stringify(p)).toBe(before);
  });
  it('includes checked embedded artwork and exact placement metadata without leaking its URL as printable text', async () => {
    const p = sample();
    p.artwork = [{ id: 'art', name: 'Chest artwork', pieceId: 'deleted-piece', dataUrl: PIXEL, mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, x: 12, y: 34, widthMm: 100, heightMm: 80, rotation: 15, opacity: 0.8 }];
    const html = await prepareTechPackHtml(p, { decodeRaster: async () => ({ naturalWidth: 1, naturalHeight: 1 }) });
    expect(html).toContain(`<img src="${PIXEL}" alt="Chest artwork">`);
    expect(html).toContain('Missing piece (deleted-piece)');
    expect(html).toContain('100 × 80 mm'); expect(html).toContain('(12, 34) mm');
    expect(html).not.toContain(`<p>${PIXEL}</p>`);
  });
  it('does not embed corrupt, mismatched or unvalidated artwork and preserves a repair warning', async () => {
    const p = sample();
    p.artwork = [{ id: 'art', name: 'Chest artwork', pieceId: 'deleted-piece', dataUrl: PIXEL, mimeType: 'image/png', pixelWidth: 100, pixelHeight: 80, x: 12, y: 34, widthMm: 100, heightMm: 80, rotation: 15, opacity: 0.8 }];
    const mismatched = await prepareTechPackHtml(p, { decodeRaster: async () => ({ naturalWidth: 99, naturalHeight: 80 }) });
    expect(mismatched).not.toContain(`<img src="${PIXEL}"`);
    expect(mismatched).toContain('Preview unavailable: Decoded image dimensions do not match');
    expect(mismatched).toContain('100 × 80 mm');
    const corrupt = await prepareTechPackHtml(p, { decodeRaster: async () => { throw Error('corrupt PNG'); } });
    expect(corrupt).not.toContain(`<img src="${PIXEL}"`);
    expect(corrupt).toContain('Preview unavailable: Image cannot be decoded');
    expect(patternToTechPackHtml(p)).not.toContain(`<img src="${PIXEL}"`);
    expect(patternToTechPackHtml(p)).toContain('Image has not been decoded and validated');
  });
  it('binds checked raster evidence to exact source and current dimensions and rejects invalid placement', () => {
    const p = sample();
    p.artwork = [{ id: 'art', name: 'Chest artwork', pieceId: 'deleted-piece', dataUrl: PIXEL, mimeType: 'image/png', pixelWidth: 100, pixelHeight: 80, x: 0, y: 0, widthMm: 100, heightMm: 80, rotation: 0, opacity: 1 }];
    const checkedArtwork = new Map([['art', { dataUrl: PIXEL, naturalWidth: 100, naturalHeight: 80 }]]);
    expect(patternToTechPackHtml(p, { checkedArtwork })).toContain(`<img src="${PIXEL}"`);
    p.artwork[0].pixelWidth = 99;
    expect(patternToTechPackHtml(p, { checkedArtwork })).not.toContain(`<img src="${PIXEL}"`);
    p.artwork[0].pixelWidth = 100; p.artwork[0].widthMm = -1;
    expect(patternToTechPackHtml(p, { checkedArtwork })).not.toContain(`<img src="${PIXEL}"`);
    expect(patternToTechPackHtml(p, { checkedArtwork })).toContain('Preview unavailable: Artwork width and height');
  });
  it('neutralizes formula strings without changing signed numeric cells and quotes multiline CSV', () => {
    expect(techPackCsvCell('=SUM(A1)')).toBe('"\'=SUM(A1)"');
    expect(techPackCsvCell(' \t@SUM(A1)')).toBe('"\' \t@SUM(A1)"');
    expect(techPackCsvCell('-12')).toBe('"\'-12"');
    expect(techPackCsvCell(-12)).toBe('"-12"');
    expect(techPackCsvCell('Line "A",\nB')).toBe('"Line ""A"",\nB"');
    const p = sample(); p.productionSpec!.measurements[0].name = '=WEBSERVICE("evil")';
    expect(patternToTechPackCsv(p, 'measurements')).toContain('"\'=WEBSERVICE(""evil"")"');
    expect(patternToTechPackCsv(p, 'measurements')).toContain('"M","Manual override","cm","51","50"');
  });
  it('archives authored Tech Pack metadata, manual sizes, construction and supplier costs with SSP', async () => {
    const p = sample(); p.techPack!.construction = [{ id: 's', title: 'Finish seam', pieceId: null, instruction: 'Overlock 3 thread' }]; p.techPack!.costing = [costing()];
    const restored = await sspToPattern(await patternToSSP(p));
    expect(restored.techPack).toEqual(p.techPack);
    expect(restored.productionSpec).toEqual(p.productionSpec);
  });
});
