import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { createEmptyPattern, createTechPack, captureColorwayPieces, convertTechPackAmount, switchColorway, techPackExchangeProblem, type Pattern } from '@seamer/pattern-model';
import { checkedTechPackCapture } from './techPackCapture';
import { patternToTechPackPdf, patternToTechPackXlsx, techPackSheets } from './techPackFiles';
import { resolveTechPackColorwayPieces } from './techPackMockups';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5sAAAAASUVORK5CYII=';
function sample() {
  const pattern = createEmptyPattern(); pattern.name = 'Garment Ελληνικά'; pattern.techPack = createTechPack();
  pattern.productionSpec = { measurements: [], procurement: [] };
  pattern.techPack.costing = [{ id: 'cost', name: '=WEBSERVICE("evil")', supplier: 'Supplier', sku: 'zip', procurementId: null, materialId: null, quantity: 2, unit: 'each', unitCost: 4, notes: '<script>bad</script>' }];
  pattern.techPack.exchangeRates = [{ id: 'eur', fromCurrency: 'USD', toCurrency: 'EUR', rate: .92, date: '2026-10-11', source: 'Supplier quote' }];
  pattern.techPack.construction = [{ id: 'stitch', title: 'Hem finish', pieceId: null, instruction: 'Double fold', capture: { dataUrl: png, capturedAt: '2026-10-11T00:00:00.000Z', sourceVersionId: pattern.versionId, label: 'Front garment view' } }];
  return pattern;
}
describe('Dedicated production downloads', () => {
  it('exports newly added piece fabrics as actual colorway activation resolves them', () => {
    const pattern = JSON.parse(readFileSync('static/templates/pencil-skirt.json', 'utf8')) as Pattern;
    const first = pattern.pieces[0];
    const saved = { id: 'saved-before-new-piece', name: 'Saved before new geometry', pieces: captureColorwayPieces({ ...pattern, pieces: [first] }) };
    pattern.colorways = { activeId: null, variants: [saved], generatedMaterialSources: {} };
    const newMaterial = { ...structuredClone(pattern.materials[0]), id: 'new-piece-fabric', frontTexture: { ...pattern.materials[0].frontTexture!, color: '#0088ff' } };
    pattern.materials.push(newMaterial);
    pattern.pieces = [first, { ...structuredClone(first), id: 'new-piece', materialId: newMaterial.id }];
    const before = JSON.stringify(pattern);
    const activated = switchColorway(pattern, saved.id);
    expect(activated.errors).toEqual([]);
    expect(resolveTechPackColorwayPieces(pattern, saved)).toEqual(captureColorwayPieces(activated.pattern));
    expect(resolveTechPackColorwayPieces(pattern, saved)['new-piece'].materialId).toBe(newMaterial.id);
    expect(resolveTechPackColorwayPieces(pattern, { ...saved, pieces: { ...saved.pieces, 'new-piece': { materialId: 'missing-fabric' } } })['new-piece'].materialId).toBe('missing-fabric');
    expect(resolveTechPackColorwayPieces(pattern, { ...saved, pieces: { ...saved.pieces, 'new-piece': { materialId: '' } } })['new-piece'].materialId).toBe('');
    expect(JSON.stringify(pattern)).toBe(before);
  });
  it('writes a standard OOXML workbook with numeric totals, safe text and actual image parts', () => {
    const files = unzipSync(patternToTechPackXlsx(sample(), new Date('2026-10-11'), [{ name: 'Blue', dataUrl: png, warnings: [] }]));
    expect(strFromU8(files['xl/workbook.xml'])).toContain('Production views');
    const costing = strFromU8(files['xl/worksheets/sheet5.xml']);
    expect(costing).toContain('<v>8</v>'); expect(costing).toContain('t="inlineStr"'); expect(costing).toContain('=WEBSERVICE'); expect(costing).not.toContain('<f>');
    expect(files['xl/media/image1.png']).toEqual(files['xl/media/image2.png']);
    expect(strFromU8(files['xl/drawings/drawing1.xml'])).toContain('r:embed="rId2"');
    expect(strFromU8(files['xl/drawings/drawing1.xml'])).toContain('cx="2857500" cy="2857500"');
    expect(Object.entries(files).filter(([name]) => name.startsWith('xl/worksheets/sheet')).some(([, bytes]) => strFromU8(bytes).includes('Front garment view'))).toBe(true);
  });
  it('generates a readable PDF with multiple pages and actual mockup/callout images', async () => {
    const bytes = await patternToTechPackPdf(sample(), { fontBytes: new Uint8Array(readFileSync('static/fonts/tech-pack-dejavu.ttf')), mockups: [{ name: 'Blue', dataUrl: png, warnings: [] }], now: new Date('2026-10-11') });
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toContain('%PDF-');
    const parsed = await PDFDocument.load(bytes); expect(parsed.getPageCount()).toBeGreaterThan(2); expect(parsed.getTitle()).toContain('Ελληνικά');
  });
  it('retains fallback warnings with their variant and real view image in the workbook', () => {
    const files = unzipSync(patternToTechPackXlsx(sample(), new Date('2026-10-11'), [{ name: 'Blocked fabric variant', dataUrl: png, warnings: ['Diffuse fabric texture unavailable. Flat tint shown.', 'Logo image unavailable or dimensions do not match.'] }]));
    const workbook = strFromU8(files['xl/workbook.xml']);
    expect(workbook).toContain('name="Export warnings"');
    const warningSheetId = workbook.match(/name="Export warnings" sheetId="(\d+)"/)![1];
    const warningSheet = strFromU8(files[`xl/worksheets/sheet${warningSheetId}.xml`]);
    expect(warningSheet).toContain('Blocked fabric variant');
    expect(warningSheet).toContain('Diffuse fabric texture unavailable. Flat tint shown.');
    expect(warningSheet).toContain('Logo image unavailable or dimensions do not match.');
    expect(files['xl/media/image1.png']).toEqual(Uint8Array.from(atob(png.split(',')[1]), c => c.charCodeAt(0)));
    const viewSheetId = workbook.match(/name="Production views" sheetId="(\d+)"/)![1];
    expect(files[`xl/worksheets/_rels/sheet${viewSheetId}.xml.rels`]).toBeDefined();
  });
  it('reports unavailable PDF glyphs while retaining source text in spreadsheets', async () => {
    const pattern = sample(); pattern.name = '测试中文'; let missing: string[] = [];
    const bytes = await patternToTechPackPdf(pattern, { fontBytes: new Uint8Array(readFileSync('static/fonts/tech-pack-dejavu.ttf')), mockups: [], onUnsupportedCharacters: characters => { missing = characters; } });
    expect(missing).toContain('测'); expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
    const files = unzipSync(patternToTechPackXlsx(pattern)); expect(strFromU8(files['xl/worksheets/sheet1.xml'])).toContain('测试中文');
  });
  it('uses only explicit dated currency quotes and keeps unknown totals unknown', () => {
    const quote = sample().techPack!.exchangeRates![0];
    expect(convertTechPackAmount(8, 'USD', quote)).toBe(7.36); expect(convertTechPackAmount(null, 'USD', quote)).toBeNull(); expect(convertTechPackAmount(8, 'GBP', quote)).toBeNull();
    expect(techPackExchangeProblem({ ...quote, date: '2026-02-30' })).toContain('valid quote date'); expect(techPackExchangeProblem({ ...quote, date: '2026-00-11' })).toContain('valid quote date');
    expect(techPackExchangeProblem({ ...quote, rate: Infinity })).toContain('positive finite');
    expect(techPackSheets(sample())[5].rows[1]).toContain(7.36);
  });
  it('rejects external/SVG/corrupt/oversized captures before image embedding', () => {
    expect(checkedTechPackCapture(png)).toBe(png); expect(checkedTechPackCapture('https://evil.test/a.png')).toBeNull(); expect(checkedTechPackCapture('data:image/png;base64,YWJjZA==')).toBeNull();
    const bytes = Uint8Array.from(atob(png.split(',')[1]), c => c.charCodeAt(0)); new DataView(bytes.buffer).setUint32(16, 100000);
    expect(checkedTechPackCapture('data:image/png;base64,' + btoa(String.fromCharCode(...bytes)))).toBeNull();
  });
});
