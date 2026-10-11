import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { zipSync, strToU8 } from 'fflate';
import { createTechPack, convertTechPackAmount, captureColorwayPieces, type Pattern } from '@seamer/pattern-model';
import { assignedMaterialRows, evaluateSpecMeasurement } from './productionSpec';
import { resolveSizeMeasurement, resolveTechPackCosting, techPackCostSummary } from './techPack';
import { productionApprovalState, productionGeometryFingerprint, resolveProductionConsumption } from './productionAutomation';
import { checkedTechPackCapture } from './techPackCapture';
import { renderTechPackMockups, type TechPackMockup } from './techPackMockups';

export interface TechPackSheet { name: string; rows: Array<Array<string | number | null>>; }
export function techPackSheets(pattern: Pattern, now = new Date()): TechPackSheet[] {
  const doc = pattern.techPack ?? createTechPack();
  const summary = techPackCostSummary(pattern);
  return [
    { name: 'Document', rows: [['Field', 'Value'], ['Garment', pattern.name], ['Exported', now.toISOString()], ...Object.entries(doc.metadata), ['Project ID', pattern.id], ['Version ID', pattern.versionId], ['Approval', productionApprovalState(pattern)], ['Approval name', pattern.productionAutomation?.approval?.name ?? ''], ['Approval date', pattern.productionAutomation?.approval?.approvedAt ?? '']] },
    { name: 'Measurements', rows: [['POM', 'Size', 'Unit', 'Target', 'Actual', 'Minus tolerance', 'Plus tolerance', 'Check', 'Target source', 'Notes'], ...(pattern.productionSpec?.measurements ?? []).flatMap(row => {
      const result = evaluateSpecMeasurement(pattern, row);
      return [[row.name, 'Sample', row.unit, row.target, result.actual, row.tolMinus, row.tolPlus, result.label, row.surfaceMeasurementId ? 'Captured 3D garment measurement' : row.annotationId ? '2D annotation' : 'Entered actual', row.notes], ...doc.sizes.map(size => {
        const resolved = resolveSizeMeasurement(pattern, row.id, size.id);
        return [row.name, size.name, row.unit, resolved.values.target, resolved.actual, row.tolMinus, row.tolPlus, resolved.status, resolved.targetSource ?? 'Missing reference', resolved.values.notes];
      })];
    })] },
    { name: 'Fabrics', rows: [['Fabric', 'Pieces', 'Cut copies'], ...assignedMaterialRows(pattern).map(row => [row.name, row.pieces.join(', '), row.cutCopies])] },
    { name: 'BOM', rows: [['Item', 'Category', 'Quantity', 'Unit', 'Notes'], ...(pattern.productionSpec?.procurement ?? []).map(row => [row.name, row.category, row.quantity, row.unit, row.notes])] },
    { name: 'Costing', rows: [['Item', 'Supplier', 'SKU', 'Quantity', 'Unit', 'Unit cost', 'Total', 'Currency', 'Quantity source', 'Notes'], ...doc.costing.map(row => {
      const resolved = resolveTechPackCosting(pattern, row);
      return [resolved.name, row.supplier, row.sku, resolved.quantity, resolved.unit, row.unitCost, resolved.total, doc.metadata.currency, resolved.missing ? 'Missing reference' : resolved.quantityStatus, row.notes];
    }), [summary.complete ? 'Recorded total' : 'Known subtotal', '', '', null, '', null, summary.subtotal, doc.metadata.currency, `${summary.pricedCount}/${summary.totalCount} priced`, '']] },
    { name: 'Exchange rates', rows: [['From', 'To', 'Rate', 'Quote date', 'Source', 'Converted known subtotal'], ...(doc.exchangeRates ?? []).map(quote => [quote.fromCurrency, quote.toCurrency, quote.rate, quote.date, quote.source, convertTechPackAmount(summary.subtotal, doc.metadata.currency, quote)])] },
    { name: 'Construction', rows: [['Order', 'Title', 'Piece', 'Instruction', 'View captured', 'Capture label', 'Capture version'], ...doc.construction.map((row, index) => [index + 1, row.title, row.pieceId ? pattern.pieces.find(piece => piece.id === row.pieceId)?.name ?? `Missing piece: ${row.pieceId}` : 'Whole garment', row.instruction, row.capture?.capturedAt ?? '', row.capture?.label ?? '', row.capture?.sourceVersionId ?? ''])] },
    { name: 'Artwork', rows: [['Name', 'Owner piece', 'Width mm', 'Height mm', 'X mm', 'Y mm', 'Rotation CCW', 'Opacity', 'Repeat', 'Gap X mm', 'Gap Y mm', 'Ink blend', 'Ink tint', 'Zone draft points', 'Vector shape count', 'Source U reflection'], ...(pattern.artwork ?? []).map(row => [row.name, pattern.pieces.find(piece => piece.id === row.pieceId)?.name ?? `Missing piece: ${row.pieceId}`, row.widthMm, row.heightMm, row.x, row.y, row.rotation, row.opacity, row.repeat?.mode ?? '', row.repeat?.gapXmm ?? null, row.repeat?.gapYmm ?? null, row.treatment?.blend ?? 'source-over', row.treatment?.tint ?? '', row.zone ? JSON.stringify(row.zone) : '', row.vectorDesign?.shapes.length ?? null, row.flipX ? 'Reflected' : 'Unreflected'])] }
    , { name: 'Colorways', rows: [['Variant', 'Piece', 'Fabric', 'Front tint', 'Back tint', 'Reference state'], ...(pattern.colorways?.variants ?? []).flatMap(variant => Object.entries(variant.id === pattern.colorways?.activeId ? { ...variant.pieces, ...captureColorwayPieces(pattern) } : variant.pieces).map(([pieceId, treatment]) => {
      const piece = pattern.pieces.find(piece => piece.id === pieceId), material = pattern.materials.find(material => material.id === treatment.materialId);
      return [variant.name, piece?.name ?? `Missing piece: ${pieceId}`, material?.name ?? `Missing fabric: ${treatment.materialId}`, treatment.frontColor ?? material?.frontTexture?.color ?? '', treatment.backColor ?? material?.backTexture?.color ?? treatment.frontColor ?? material?.frontTexture?.color ?? '', !piece || !material ? 'Missing reference' : 'Available'];
    }))] }
    , { name: 'Grade rules', rows: [['POM', 'Base size', 'Base target', 'Increment per size step', 'Unit', 'Base source'], ...(pattern.productionAutomation?.grades ?? []).map(row => [pattern.productionSpec?.measurements.find(pom => pom.id === row.pomId)?.name ?? `Missing POM: ${row.pomId}`, doc.sizes.find(size => size.id === row.baseSizeId)?.name ?? `Missing size: ${row.baseSizeId}`, row.baseTarget, row.increment, row.unit, row.source])] }
    , { name: 'Body chart', rows: [['Body POM', 'Unit', ...doc.sizes.map(size => size.name)], ...(pattern.productionAutomation?.bodyChart ?? []).map(row => [row.name, row.unit, ...doc.sizes.map(size => row.values[size.id] ?? null)])] }
    , { name: 'Body mapping', rows: [['Garment POM', 'Body POM', 'Factor', 'Ease', 'Ease unit'], ...(pattern.productionAutomation?.bodyMappings ?? []).map(row => [pattern.productionSpec?.measurements.find(pom => pom.id === row.pomId)?.name ?? `Missing POM: ${row.pomId}`, pattern.productionAutomation?.bodyChart.find(body => body.id === row.bodyRowId)?.name ?? `Missing body POM: ${row.bodyRowId}`, row.factor, row.ease, row.unit])] }
    , { name: 'Marker consumption', rows: [['Fabric', 'Quantity m', 'State', 'Width mm', 'Gap mm', 'Waste percent', 'Allow half turn', 'Cut copies', 'Marker length mm', 'Calculated at'], ...(pattern.productionAutomation?.consumption ?? []).map(row => {
      const resolved = resolveProductionConsumption(pattern, row.materialId);
      return [pattern.materials.find(material => material.id === row.materialId)?.name ?? `Missing fabric: ${row.materialId}`, resolved.quantity, resolved.status, row.settings.fabricWidthMm, row.settings.gapMm, row.settings.wastePercent, String(row.settings.allowHalfTurn), row.cutCopies, row.usedLengthMm, row.calculatedAt];
    })] }
    , { name: 'Surface measurements', rows: [['POM', 'Piece', 'Method', 'Captured length mm', 'State', 'Source', 'Captured at'], ...(pattern.productionAutomation?.surfaceMeasurements ?? []).map(row => [row.name, pattern.pieces.find(piece => piece.id === row.pieceId)?.name ?? `Missing piece: ${row.pieceId}`, row.method, row.captured?.valueMm ?? null, !row.captured ? 'Not captured' : row.captured.geometryFingerprint === productionGeometryFingerprint(pattern) ? 'Current geometry capture' : 'Stale geometry capture', row.captured?.source ?? '', row.captured?.capturedAt ?? ''])] }
  ];
}
const xml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!).split('').filter(char => char.charCodeAt(0) >= 32 || [9, 10, 13].includes(char.charCodeAt(0))).join('');
const columnName = (index: number): string => { let text = ''; for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) text = String.fromCharCode(65 + (value - 1) % 26) + text; return text; };
/** OOXML inline-string cells preserve user text and cannot become spreadsheet formulas. */
export function patternToTechPackXlsx(pattern: Pattern, now = new Date(), mockups: TechPackMockup[] = []): Uint8Array {
  const sheets = techPackSheets(pattern, now);
  const warnings = mockups.flatMap(mockup => mockup.warnings.map(warning => [mockup.name, warning]));
  if (warnings.length) sheets.push({ name: 'Export warnings', rows: [['Variant / view', 'Warning'], ...warnings] });
  const images = [...mockups.map(row => ({ title: `Fresh flat mockup: ${row.name}`, dataUrl: row.dataUrl })), ...(pattern.techPack?.construction ?? []).flatMap(row => row.capture ? [{ title: `${row.title} · ${row.capture.label} · ${row.capture.capturedAt} · ${row.capture.sourceVersionId}`, dataUrl: row.capture.dataUrl }] : [])].filter(row => checkedTechPackCapture(row.dataUrl));
  if (images.length) sheets.push({ name: 'Production views', rows: images.map(row => [row.title]) });
  const imageExtents = images.map(image => { const bytes = Uint8Array.from(atob(image.dataUrl.split(',')[1].slice(0, 44)), char => char.charCodeAt(0)); const view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20); const scale = Math.min(960 / width, 300 / height); return { cx: Math.round(width * scale * 9525), cy: Math.round(height * scale * 9525) }; });
  const files: Record<string, Uint8Array> = {};
  const put = (name: string, data: string) => files[name] = strToU8(data);
  put('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${images.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  put('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  put('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  put('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((sheet, index) => put(`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheet.rows.map((row, r) => `<row r="${r + 1}"${sheet.name === 'Production views' ? ' ht="250" customHeight="1"' : ''}>${row.map((value, c) => {
    if (value == null || typeof value === 'number' && !Number.isFinite(value)) return '';
    const ref = `${columnName(c)}${r + 1}`;
    return typeof value === 'number' ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }).join('')}</row>`).join('')}</sheetData>${sheet.name === 'Production views' ? '<drawing r:id="rId1"/>' : ''}</worksheet>`));
  if (images.length) {
    put(`xl/worksheets/_rels/sheet${sheets.length}.xml.rels`, '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
    put('xl/drawings/_rels/drawing1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${images.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.png"/>`).join('')}</Relationships>`);
    put('xl/drawings/drawing1.xml', `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${images.map((_, i) => `<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${i}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${imageExtents[i].cx}" cy="${imageExtents[i].cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="Production view ${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${imageExtents[i].cx}" cy="${imageExtents[i].cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join('')}</xdr:wsDr>`);
    images.forEach((image, i) => files[`xl/media/image${i + 1}.png`] = Uint8Array.from(atob(image.dataUrl.split(',')[1]), c => c.charCodeAt(0)));
  }
  return zipSync(files);
}

/** Deterministic paginated PDF with live tables and newly rendered flat colorway/artwork pages. */
export async function patternToTechPackPdf(pattern: Pattern, options: { now?: Date; fontBytes?: Uint8Array; mockups?: TechPackMockup[]; onUnsupportedCharacters?: (characters: string[]) => void } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  let fontBytes = options.fontBytes;
  if (!fontBytes) { const { base } = await import('$app/paths'); const response = await fetch(`${base}/fonts/tech-pack-dejavu.ttf`); if (!response.ok) throw Error('PDF font unavailable.'); fontBytes = new Uint8Array(await response.arrayBuffer()); }
  const font = await doc.embedFont(fontBytes, { subset: true });
  const supported = new Set(font.getCharacterSet());
  const unsupported = new Set<string>();
  const safe = (value: string) => Array.from(value).map(char => { if (supported.has(char.codePointAt(0)!)) return char; unsupported.add(char); return '?'; }).join('');
  let page = doc.addPage([842, 595]), y = 555;
  const newPage = () => { page = doc.addPage([842, 595]); y = 555; };
  const line = (value: string, size = 10) => {
    for (const paragraph of value.split(/\r?\n/)) {
      const characters = Array.from(safe(paragraph)); let position = 0;
      do {
        if (y < 40) newPage();
        let length = Math.min(characters.length - position, 256);
        while (length > 1 && font.widthOfTextAtSize(characters.slice(position, position + length).join(''), size) > 760) length--;
        page.drawText(characters.slice(position, position + length).join(''), { x: 40, y, size, font, color: rgb(.09, .13, .2) }); y -= size + 5; position += length;
      } while (position < characters.length);
    }
  };
  doc.setTitle(`${pattern.name} — Tech Pack`); doc.setCreator('Seamer Studio'); doc.setCreationDate(options.now ?? new Date());
  line(`${pattern.name} — Tech Pack`, 22);
  line('Production values and captured views are references. Document approval does not certify fit.');
  for (const sheet of techPackSheets(pattern, options.now)) {
    if (y < 100) newPage(); line(sheet.name, 16);
    for (const row of sheet.rows) line(row.map(value => value == null ? 'Unspecified' : String(value)).join(' | '));
    y -= 10;
  }
  const embedPng = async (dataUrl: string, title: string, caption: string) => {
    const image = await doc.embedPng(dataUrl); newPage(); line(title, 18); line(caption);
    const fit = image.scale(Math.min(750 / image.width, 450 / image.height));
    page.drawImage(image, { x: 40, y: Math.max(40, y - fit.height), width: fit.width, height: fit.height });
  };
  for (const mockup of options.mockups ?? await renderTechPackMockups(pattern)) {
    await embedPng(mockup.dataUrl, `Colorway: ${mockup.name}`, 'Fresh flat front-face production mockup; no simulated fit or saved-thumbnail substitute.');
    if (mockup.warnings.length) { newPage(); line(`${mockup.name} — missing references`, 16); mockup.warnings.forEach(warning => line(warning)); }
  }
  for (const row of pattern.techPack?.construction ?? []) if (row.capture && checkedTechPackCapture(row.capture.dataUrl)) {
    try { await embedPng(row.capture.dataUrl, `Construction: ${row.title}`, `${row.capture.label} · ${row.capture.capturedAt} · source version ${row.capture.sourceVersionId}`); }
    catch { newPage(); line(`Construction: ${row.title}`); line('Captured image unavailable. Capture this view again.'); }
  }
  if (unsupported.size) { newPage(); line('PDF character substitutions', 18); line('Some document characters are unavailable in the embedded font and appear as ?. HTML and XLSX retain the original text.'); options.onUnsupportedCharacters?.([...unsupported]); }
  return doc.save();
}
