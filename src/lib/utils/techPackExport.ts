import { artworkPlacementProblem, artworkSourceProblem, captureColorwayPieces, createTechPack, convertTechPackAmount, type Pattern } from '@seamer/pattern-model';
import { artworkSurfaceProblem } from './artworkSurface';
import { productionApprovalState, productionGeometryFingerprint, resolveProductionConsumption } from './productionAutomation';
import { checkedTechPackCapture } from './techPackCapture';
import { renderTechPackMockups, type TechPackMockup } from './techPackMockups';
import { artworkImageMatchesSource } from '$lib/scene/pieceTextureImages';
import { assignedMaterialRows, evaluateSpecMeasurement } from './productionSpec';
import { resolveSizeMeasurement, resolveTechPackCosting, techPackCostSummary } from './techPack';

export function escapeTechPackHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
const h = escapeTechPackHtml;
const number = (value: number | null | undefined): string => value == null || !Number.isFinite(value) ? '—' : String(Number(value.toFixed(4)));
const text = (value: string | null | undefined): string => h(value?.trim() || '—');
const paragraph = (value: string) => `<p class="notes">${h(value)}</p>`;
const table = (headers: string[], rows: string[][], empty: string) => rows.length
  ? `<table><thead><tr>${headers.map(header => `<th>${h(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  : `<p class="muted">${h(empty)}</p>`;
const swatch = (color: string | undefined) => `<span class="swatch" style="background:${/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color ?? '') ? color : '#94a3b8'}"></span>`;

/** Standalone exports embed only local raster images. SVG, scripts and remote image URLs cannot
 * introduce active content or cause the recipient's browser to fetch third-party resources. */
export function techPackRasterSource(url: string | null | undefined): string | null {
  return url && url.length <= 4_000_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url) ? url : null;
}

type DecodedRaster = Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>;
interface CheckedArtworkRaster extends DecodedRaster { dataUrl: string; }
export interface TechPackHtmlOptions {
  now?: Date;
  checkedArtwork?: ReadonlyMap<string, CheckedArtworkRaster>;
  artworkProblems?: ReadonlyMap<string, string>;
  mockups?: TechPackMockup[];
}

const decodedRasterCache = new Map<string, Promise<DecodedRaster>>();
function decodeTechPackRaster(dataUrl: string): Promise<DecodedRaster> {
  const existing = decodedRasterCache.get(dataUrl);
  if (existing) return existing;
  const decoding = (async () => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    return { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
  })();
  if (decodedRasterCache.size >= 8) decodedRasterCache.delete(decodedRasterCache.keys().next().value!);
  decodedRasterCache.set(dataUrl, decoding);
  return decoding;
}

/** Decode the document snapshot before preview/download/print. Validation evidence is bound to
 * the exact source bytes and declared dimensions so it cannot validate a subsequently edited row. */
export async function prepareTechPackHtml(pattern: Pattern, options: { now?: Date; decodeRaster?: (dataUrl: string) => Promise<DecodedRaster>; renderMockups?: boolean } = {}): Promise<string> {
  const checkedArtwork = new Map<string, CheckedArtworkRaster>();
  const artworkProblems = new Map<string, string>();
  await Promise.all((pattern.artwork ?? []).map(async artwork => {
    const problem = artworkSourceProblem(artwork) ?? artworkPlacementProblem(artwork) ?? artworkSurfaceProblem(artwork);
    if (problem) { artworkProblems.set(artwork.id, problem); return; }
    try {
      const decoded = await (options.decodeRaster ?? decodeTechPackRaster)(artwork.dataUrl);
      if (!artworkImageMatchesSource(decoded, artwork)) {
        artworkProblems.set(artwork.id, 'Decoded image dimensions do not match the declared artwork dimensions. Replace its source.');
        return;
      }
      checkedArtwork.set(artwork.id, { ...decoded, dataUrl: artwork.dataUrl });
    } catch {
      artworkProblems.set(artwork.id, 'Image cannot be decoded. Replace its source.');
    }
  }));
  const mockups = options.renderMockups ? await renderTechPackMockups(pattern) : undefined;
  return patternToTechPackHtml(pattern, { now: options.now, checkedArtwork, artworkProblems, mockups });
}

export function patternToTechPackHtml(pattern: Pattern, options: TechPackHtmlOptions = {}): string {
  const doc = pattern.techPack ?? createTechPack();
  const meta = doc.metadata;
  const poms = pattern.productionSpec?.measurements ?? [];
  const procurement = pattern.productionSpec?.procurement ?? [];
  const issuedAt = (options.now ?? new Date()).toISOString();
  const measurements = poms.map(row => {
    const result = evaluateSpecMeasurement(pattern, row);
    const annotation = pattern.measurements?.find(m => m.id === row.annotationId);
    const source = row.surfaceMeasurementId ? 'Captured 3D garment measurement' : row.annotationId ? `${annotation?.name ?? 'Missing annotation'} · 2D ${annotation?.kind === 'angle' ? 'angle' : 'endpoint distance'}` : 'Entered sample actual';
    return [text(row.name), h(source), h(row.unit), number(result.actual), number(row.target), number(row.tolMinus), number(row.tolPlus), h(result.label), text(row.notes)];
  });
  const sizeHeaders = ['Point of measure', 'Unit', '− tol / + tol', ...doc.sizes.map(size => `${size.name}${size.id === doc.sampleSizeId ? ' (sample)' : ''} target / actual / check`)];
  const sizes = poms.map(row => [text(row.name), h(row.unit), `${number(row.tolMinus)} / ${number(row.tolPlus)}`, ...doc.sizes.map(size => {
    const resolved = resolveSizeMeasurement(pattern, row.id, size.id);
    return `${number(resolved.values.target)} / ${number(resolved.actual)}<br><small>${h(resolved.status)} · ${h(resolved.targetSource ?? 'Missing reference')}</small>${resolved.values.notes ? paragraph(resolved.values.notes) : ''}`;
  })]);
  const orphanSizeValues: string[] = [];
  for (const [pomId, values] of Object.entries(doc.sizeMeasurements)) {
    for (const [sizeId, value] of Object.entries(values)) {
      if (poms.some(row => row.id === pomId) && doc.sizes.some(size => size.id === sizeId)) continue;
      orphanSizeValues.push(`Missing POM or size reference: ${pomId} / ${sizeId}; target ${number(value.target)}, actual ${number(value.actual)}; original unit unavailable. ${value.notes}`);
    }
  }
  const construction = doc.construction.map((row, index) => {
    const piece = row.pieceId ? pattern.pieces.find(piece => piece.id === row.pieceId) : null;
    const capture = row.capture && checkedTechPackCapture(row.capture.dataUrl) ? `<img class="preview" src="${h(row.capture.dataUrl)}" alt="${h(row.capture.label)}"><p>${h(row.capture.label)} · ${h(row.capture.capturedAt)} · source version ${h(row.capture.sourceVersionId)}</p>` : row.capture ? '<p class="warning">Captured image unavailable. Capture again.</p>' : '';
    return [String(index + 1), text(row.title), row.pieceId ? h(piece?.name ?? `Missing piece (${row.pieceId})`) : 'Whole garment', paragraph(row.instruction) + capture];
  });
  const costRows = doc.costing.map(row => {
    const resolved = resolveTechPackCosting(pattern, row);
    return [text(resolved.name), text(row.supplier), text(row.sku), number(resolved.quantity), text(resolved.unit), number(row.unitCost), number(resolved.total), resolved.missing ? 'Missing BOM or fabric reference' : row.procurementId ? 'Linked procurement' : row.materialId ? `Linked fabric; ${resolved.quantityStatus}` : 'Entered item', text(row.notes)];
  });
  const costSummary = techPackCostSummary(pattern);
  const colorways = pattern.colorways?.variants ?? [];
  const colorwaySections = colorways.map(variant => {
    const treatments = variant.id === pattern.colorways?.activeId ? { ...variant.pieces, ...captureColorwayPieces(pattern) } : variant.pieces;
    const rows = Object.entries(treatments).map(([pieceId, treatment]) => {
      const piece = pattern.pieces.find(piece => piece.id === pieceId);
      const material = pattern.materials.find(material => material.id === treatment.materialId);
      const front = treatment.frontColor ?? material?.frontTexture?.color;
      const back = treatment.backColor ?? (material?.useSeparateBackSide ? material?.backTexture?.color : front);
      return [h(piece?.name ?? `Missing piece (${pieceId})`), h(material?.name ?? `Missing fabric (${treatment.materialId})`), `${swatch(front)}${text(front)}`, `${swatch(back)}${text(back)}`];
    });
    return `<h3>${h(variant.name)}${variant.id === pattern.colorways?.activeId ? ' · active' : ''}</h3>${table(['Piece', 'Fabric', 'Front color', 'Back color'], rows, 'No piece assignments in this colorway.')}`;
  }).join('');
  const artworks = (pattern.artwork ?? []).map(artwork => {
    const piece = pattern.pieces.find(piece => piece.id === artwork.pieceId);
    const checked = options.checkedArtwork?.get(artwork.id);
    const problem = artworkSourceProblem(artwork) ?? artworkPlacementProblem(artwork) ?? artworkSurfaceProblem(artwork) ?? options.artworkProblems?.get(artwork.id);
    const verified = !problem && checked?.dataUrl === artwork.dataUrl && artworkImageMatchesSource(checked, artwork);
    const raster = verified ? techPackRasterSource(artwork.dataUrl) : null;
    const unavailable = problem ?? 'Image has not been decoded and validated for this export.';
    return `<article class="artwork"><h3>${h(artwork.name)}</h3>${raster ? `<img src="${h(raster)}" alt="${h(artwork.name)}">` : `<p class="warning">Preview unavailable: ${h(unavailable)}</p>`}<p>Piece: ${h(piece?.name ?? `Missing piece (${artwork.pieceId})`)}</p><p>Size: ${number(artwork.widthMm)} × ${number(artwork.heightMm)} mm · center: (${number(artwork.x)}, ${number(artwork.y)}) mm in draft coordinates · rotation: ${number(artwork.rotation)}° CCW · opacity: ${number(artwork.opacity)}</p><p>Repeat: ${h(artwork.repeat?.mode ?? 'single placement')} · gap ${number(artwork.repeat?.gapXmm)} / ${number(artwork.repeat?.gapYmm)} mm · ink blend ${h(artwork.treatment?.blend ?? 'source-over')} · tint ${text(artwork.treatment?.tint)} · print zone ${artwork.zone ? h(JSON.stringify(artwork.zone)) : 'whole piece'} · vector primitives ${number(artwork.vectorDesign?.shapes.length)} · source U ${artwork.flipX ? 'reflected' : 'unreflected'}</p><p class="muted">Placement is a design reference; confirm print registration and production method with the supplier.</p></article>`;
  }).join('');
  const mockupSections = (options.mockups ?? []).map(mockup => `<article><h3>${h(mockup.name)}</h3><img style="max-width:100%;max-height:500px" src="${h(mockup.dataUrl)}" alt="Fresh flat mockup ${h(mockup.name)}">${mockup.warnings.map(warning => `<p class="warning">${h(warning)}</p>`).join('')}</article>`).join('');
  const exchanges = (doc.exchangeRates ?? []).map(quote => [h(quote.fromCurrency), h(quote.toCurrency), number(quote.rate), h(quote.date), text(quote.source), number(convertTechPackAmount(costSummary.subtotal, meta.currency, quote))]);
  const bodyChart = table(['Body POM', 'Unit', ...doc.sizes.map(size => size.name)], (pattern.productionAutomation?.bodyChart ?? []).map(row => [h(row.name), h(row.unit), ...doc.sizes.map(size => number(row.values[size.id]))]), 'No body chart recorded.');
  const consumption = table(['Fabric', 'Current purchase quantity (m)', 'State', 'Width (mm)', 'Gap (mm)', 'Waste (%)', 'Cut copies', 'Calculated at'], (pattern.productionAutomation?.consumption ?? []).map(row => {
    const resolved = resolveProductionConsumption(pattern, row.materialId);
    return [h(pattern.materials.find(material => material.id === row.materialId)?.name ?? `Missing fabric (${row.materialId})`), number(resolved.quantity), h(resolved.status), number(row.settings.fabricWidthMm), number(row.settings.gapMm), number(row.settings.wastePercent), number(row.cutCopies), h(row.calculatedAt)];
  }), 'No marker consumption calculated.');
  const surface = table(['Measurement', 'Piece', 'Method', 'Captured length (mm)', 'State', 'Source', 'Captured at'], (pattern.productionAutomation?.surfaceMeasurements ?? []).map(row => [h(row.name), h(pattern.pieces.find(piece => piece.id === row.pieceId)?.name ?? `Missing piece (${row.pieceId})`), h(row.method), number(row.captured?.valueMm), !row.captured ? 'Not captured' : row.captured.geometryFingerprint === productionGeometryFingerprint(pattern) ? 'Current geometry capture' : 'Stale geometry capture', h(row.captured?.source), h(row.captured?.capturedAt)]), 'No garment surface measurements recorded.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>${h(pattern.name)} — Tech Pack</title><style>
    *{box-sizing:border-box}body{font:13px/1.45 system-ui,sans-serif;color:#172033;background:#fff;margin:0}main{max-width:1120px;margin:0 auto;padding:36px}h1{font-size:28px;margin:0 0 8px}h2{font-size:20px;margin:26px 0 10px;border-bottom:2px solid #cbd5e1;padding-bottom:6px}h3{font-size:15px;margin:16px 0 8px}.muted{color:#596579}.warning{color:#9a3412}.notes{white-space:pre-wrap;margin:3px 0;overflow-wrap:anywhere}.identity{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0}.identity dt{font-size:11px;color:#596579;text-transform:uppercase}.identity dd{margin:3px 0;font-weight:600;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;margin:10px 0;table-layout:auto}th,td{padding:7px;border:1px solid #cbd5e1;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#f1f5f9;font-size:11px}thead{display:table-header-group}tr,article{break-inside:avoid}small{font-size:10px}.swatch{display:inline-block;width:14px;height:14px;border:1px solid #94a3b8;margin-right:5px;vertical-align:middle}.artwork{border:1px solid #cbd5e1;padding:14px;margin:14px 0}.artwork img,.preview{max-width:320px;max-height:240px;object-fit:contain}footer{margin-top:32px;border-top:1px solid #cbd5e1;padding-top:10px;font-size:11px;color:#596579}.size-chart{overflow:auto}@page{size:A4 landscape;margin:12mm}@media print{main{max-width:none;padding:0}body{font-size:10px}h2{break-after:avoid}th,td{padding:5px}.size-chart{overflow:visible}.preview{max-height:140px}footer{break-inside:avoid}a{color:inherit;text-decoration:none}}
  </style></head><body><main><header><p class="muted">Seamer Studio · Production document</p><h1>${h(pattern.name)}</h1>${paragraph(pattern.description)}</header>
  <section><h2>Document identity</h2><dl class="identity">${Object.entries({ 'Style code': meta.styleCode, Brand: meta.brand, Season: meta.season, Revision: meta.revision || pattern.versionName || String(pattern.versionNumber), 'Document status': meta.status, Supplier: meta.supplier, Currency: meta.currency, 'Project ID': pattern.id, 'Version ID': pattern.versionId }).map(([key, value]) => `<div><dt>${h(key)}</dt><dd>${text(value)}</dd></div>`).join('')}</dl>${paragraph(meta.notes)}<p class="muted">Approval state: ${h(productionApprovalState(pattern))}. Status and production values are authored by the document owner. This document does not certify manufacturing readiness or garment fit.</p></section>
  <section><h2>Sample measurements</h2><p class="muted">Targets and asymmetric tolerances use each row’s stated unit. Linked draft actuals are 2D annotation values, not sewn garment measurements. Captured 3D actuals identify a measured mesh and require recapture after changes.</p>${table(['POM', 'Actual source', 'Unit', 'Actual', 'Target', '− tol', '+ tol', 'Check', 'Notes'], measurements, 'No production measurements recorded.')}</section>
  <section><h2>Size chart</h2><p class="muted">Targets use explicit grade rules or body-chart mapping where configured; entered targets override automation. Actuals are entered measurements. Blank cells mean unspecified values.</p>${doc.sizes.length ? `<div class="size-chart">${table(sizeHeaders, sizes, 'Add production POMs to record size values.')}</div>` : '<p class="muted">No production sizes recorded.</p>'}${orphanSizeValues.map(value => `<p class="warning">${h(value)}</p>`).join('')}</section>
  <section><h2>Body chart</h2>${bodyChart}<p class="muted">Body values remain separate from garment targets; configured mapping applies explicit factors and ease.</p></section>
  <section><h2>Garment surface captures</h2>${surface}<p class="muted">Captures reference the garment mesh at the recorded moment. Stale geometry captures require remeasurement.</p></section>
  <section><h2>Calculated marker consumption</h2>${consumption}<p class="muted">True-shape markers use recorded fabric width, gap, cut copies and wastage. Stale markers do not contribute current costing quantities.</p></section>
  <section><h2>Assigned fabrics</h2><p class="muted">Cut copies count pattern pieces, not fabric consumption.</p>${table(['Fabric', 'Used by pieces', 'Cut copies'], assignedMaterialRows(pattern).map(row => [`${swatch(row.color)}${h(row.name)}${row.missing ? ' · missing reference' : ''}`, h(row.pieces.join(', ')), number(row.cutCopies)]), 'No piece fabric assignments.')}</section>
  <section><h2>Procurement bill of materials</h2>${table(['Item', 'Category', 'Quantity', 'Unit', 'Notes'], procurement.map(row => [text(row.name), h(row.category), number(row.quantity), text(row.unit), text(row.notes)]), 'No procurement items recorded.')}</section>
  <section><h2>Supplier costing</h2>${table(['Item', 'Supplier', 'SKU / reference', 'Quantity', 'Unit', `Unit cost (${meta.currency})`, `Line total (${meta.currency})`, 'Source', 'Notes'], costRows, 'No supplier costs recorded.')}<p><strong>${costSummary.complete ? 'Recorded item total' : 'Known cost subtotal'}: ${number(costSummary.subtotal)} ${h(meta.currency)}</strong> · ${costSummary.pricedCount} of ${costSummary.totalCount} rows priced.</p><p class="muted">Excludes any unrecorded labor, freight, tax, wastage and other charges.</p></section>
  <section><h2>Authored exchange quotes</h2>${table(['From', 'To', 'Rate', 'Quote date', 'Source', 'Converted known subtotal'], exchanges, 'No exchange quotes recorded.')}<p class="muted">Quotes are authored historical rates; no live market rate, inverse or cross-rate is inferred.</p></section>
  <section><h2>Fresh colorway production mockups</h2><p class="muted">Flat front-face draft references rendered from current geometry and appearance at export time. These are not simulated garment views.</p>${mockupSections || '<p class="muted">Mockups were not requested for this export.</p>'}</section>
  <section><h2>Construction instructions</h2>${table(['Order', 'Title', 'Piece', 'Instruction'], construction, 'No construction instructions recorded.')}</section>
  <section><h2>Colorways</h2>${colorwaySections || '<p class="muted">No named colorways recorded.</p>'}</section>
  <section><h2>Artwork and placement references</h2>${artworks || '<p class="muted">No piece artwork recorded.</p>'}</section>
  <footer>Exported ${h(issuedAt)} · Project version ${h(pattern.versionNumber)} · ${h(pattern.softwareVersion)}<br>Share this HTML file offline. Dedicated PDF and XLSX exports are available in Tech Pack. Confirm sample measurements, tolerances, consumption and placement with your production partner.</footer>
  </main></body></html>`;
}

/** Neutralize spreadsheet formulas only in string cells; numeric values retain their sign/type. */
export function techPackCsvCell(value: string | number | null | undefined): string {
  let content = value == null ? '' : typeof value === 'number' ? Number.isFinite(value) ? String(value) : '' : value;
  if (typeof value === 'string' && (/^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value))) content = `'${content}`;
  return `"${content.replace(/"/g, '""')}"`;
}
export function patternToTechPackCsv(pattern: Pattern, kind: 'measurements' | 'bom'): string {
  const rows: Array<Array<string | number | null>> = [];
  const doc = pattern.techPack ?? createTechPack();
  if (kind === 'measurements') {
    rows.push(['POM', 'Size', 'Source', 'Unit', 'Actual', 'Target', 'Minus tolerance', 'Plus tolerance', 'Check', 'Notes']);
    for (const row of pattern.productionSpec?.measurements ?? []) {
      const evaluated = evaluateSpecMeasurement(pattern, row);
      rows.push([row.name, 'Sample annotation / entry', row.surfaceMeasurementId ? 'Captured 3D garment measurement' : row.annotationId ? '2D annotation' : 'Manual sample', row.unit, evaluated.actual, row.target, row.tolMinus, row.tolPlus, evaluated.label, row.notes]);
      for (const size of doc.sizes) {
        const resolved = resolveSizeMeasurement(pattern, row.id, size.id);
        rows.push([row.name, size.name, resolved.targetSource ?? 'Missing reference', row.unit, resolved.actual, resolved.values.target, row.tolMinus, row.tolPlus, resolved.status, resolved.values.notes]);
      }
    }
    for (const [pomId, values] of Object.entries(doc.sizeMeasurements)) {
      for (const [sizeId, entry] of Object.entries(values)) {
        if (pattern.productionSpec?.measurements.some(row => row.id === pomId) && doc.sizes.some(size => size.id === sizeId)) continue;
        rows.push([`Missing POM (${pomId})`, doc.sizes.find(size => size.id === sizeId)?.name ?? `Missing size (${sizeId})`, 'Stored manual entry', 'Original unit unavailable', entry.actual, entry.target, null, null, 'Missing POM or size reference', entry.notes]);
      }
    }
  } else {
    rows.push(['Item', 'Category', 'Quantity', 'Unit', 'Supplier', 'SKU', 'Unit cost', 'Currency', 'Line total', 'Reference state', 'Notes']);
    for (const row of pattern.productionSpec?.procurement ?? []) rows.push([row.name, row.category, row.quantity, row.unit, '', '', null, doc.metadata.currency, null, 'Procurement entry', row.notes]);
    for (const row of doc.costing) {
      const resolved = resolveTechPackCosting(pattern, row);
      rows.push([resolved.name, 'Costing entry', resolved.quantity, resolved.unit, row.supplier, row.sku, row.unitCost, doc.metadata.currency, resolved.total, resolved.missing ? 'Missing reference' : row.procurementId ? 'Linked procurement' : row.materialId ? 'Linked fabric' : 'Manual item', row.notes]);
    }
  }
  return rows.map(row => row.map(techPackCsvCell).join(',')).join('\r\n') + '\r\n';
}

export async function printTechPack(pattern: Pattern): Promise<boolean> {
  const printWindow = window.open('', '_blank', 'width=1100,height=800');
  if (!printWindow) return false;
  printWindow.document.open();
  printWindow.document.write(await prepareTechPackHtml(pattern, { renderMockups: true }));
  printWindow.document.close();
  await Promise.all(Array.from(printWindow.document.images).map(image => image.decode().catch(() => undefined)));
  printWindow.focus();
  printWindow.print();
  return true;
}
