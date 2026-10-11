import { MAX_ARTWORK_PIXELS, MAX_ARTWORK_PROJECT_BYTES, MAX_ARTWORK_SOURCE_BYTES, artworkSourceBytes, validateArtworkSurface } from './artwork';
import { validateAppearanceHistory } from './appearanceHistory';
import { validateProductionAutomation } from './productionAutomation';
import { validateRangePlan } from './rangePlan';
import { foldAffineProblem } from './utils/patternGeometry';

type ObjectRecord = Record<string, unknown>;
function fail(path: string, reason: string): never {
  throw new Error(`Invalid document extension: ${path} ${reason}`);
}
function record(value: unknown, path: string): ObjectRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be an object.');
  return value as ObjectRecord;
}
function string(value: unknown, path: string, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || (nonempty && !value.trim())) fail(path, `must be ${nonempty ? 'a nonempty' : 'a'} string.`);
}
function reference(value: unknown, path: string): void {
  if (value !== null) string(value, path, true);
}
function finite(value: unknown, path: string, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, `must be ${nullable ? 'null or ' : ''}a finite number.`);
}
function strings(value: ObjectRecord, fields: readonly string[], path: string): void {
  for (const key of fields) string(value[key], `${path}.${key}`);
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array.');
  return value;
}
function rows(value: unknown, path: string, check: (row: ObjectRecord, path: string) => void): void {
  const ids = new Set<string>();
  array(value, path).forEach((value, index) => {
    const at = `${path}[${index}]`, row = record(value, at);
    string(row.id, `${at}.id`, true);
    if (ids.has(row.id)) fail(`${at}.id`, 'duplicates an existing record ID.');
    ids.add(row.id);
    check(row, at);
  });
}

function techPack(value: unknown): void {
  const path = 'techPack', doc = record(value, path), metadata = record(doc.metadata, `${path}.metadata`);
  strings(metadata, ['styleCode', 'brand', 'season', 'revision', 'supplier', 'currency', 'notes'], `${path}.metadata`);
  if (!['draft', 'sampling', 'released'].includes(metadata.status as string)) fail(`${path}.metadata.status`, 'must be draft, sampling or released.');
  rows(doc.sizes, `${path}.sizes`, (row, at) => string(row.name, `${at}.name`));
  reference(doc.sampleSizeId, `${path}.sampleSizeId`);
  const measurements = record(doc.sizeMeasurements, `${path}.sizeMeasurements`);
  for (const [measurementId, value] of Object.entries(measurements)) {
    string(measurementId, `${path}.sizeMeasurements key`, true);
    const values = record(value, `${path}.sizeMeasurements.${measurementId}`);
    for (const [sizeId, value] of Object.entries(values)) {
      string(sizeId, `${path}.sizeMeasurements.${measurementId} key`, true);
      const at = `${path}.sizeMeasurements.${measurementId}.${sizeId}`, row = record(value, at);
      finite(row.target, `${at}.target`, true); finite(row.actual, `${at}.actual`, true); string(row.notes, `${at}.notes`);
    }
  }
  let captureBytes = 0;
  rows(doc.construction, `${path}.construction`, (row, at) => {
    strings(row, ['title', 'instruction'], at); reference(row.pieceId, `${at}.pieceId`);
    if (row.capture !== undefined) {
      const capture = record(row.capture, `${at}.capture`);
      strings(capture, ['dataUrl', 'capturedAt', 'label', 'sourceVersionId'], `${at}.capture`);
      if ((capture.dataUrl as string).length > 4_000_000) fail(`${at}.capture.dataUrl`, 'exceeds the construction image limit.');
      captureBytes += artworkSourceBytes(capture.dataUrl as string);
      if (captureBytes > MAX_ARTWORK_PROJECT_BYTES) fail(`${path}.construction`, 'exceeds the 8 MiB construction image budget.');
    }
  });
  rows(doc.costing, `${path}.costing`, (row, at) => {
    strings(row, ['name', 'supplier', 'sku', 'unit', 'notes'], at);
    reference(row.procurementId, `${at}.procurementId`); reference(row.materialId, `${at}.materialId`);
    finite(row.quantity, `${at}.quantity`, true); finite(row.unitCost, `${at}.unitCost`, true);
    if (row.quantitySource !== undefined && !['manual', 'marker'].includes(row.quantitySource as string)) fail(`${at}.quantitySource`, 'must be manual or marker.');
  });
  if (doc.exchangeRates !== undefined) rows(doc.exchangeRates, `${path}.exchangeRates`, (row, at) => {
    strings(row, ['fromCurrency', 'toCurrency', 'date', 'source'], at);
    finite(row.rate, `${at}.rate`);
    if ((row.rate as number) <= 0) fail(`${at}.rate`, 'must be positive.');
  });
}

function productionSpec(value: unknown): void {
  const path = 'productionSpec', spec = record(value, path);
  rows(spec.measurements, `${path}.measurements`, (row, at) => {
    strings(row, ['name', 'notes'], at); reference(row.annotationId, `${at}.annotationId`);
    if (row.surfaceMeasurementId !== undefined) reference(row.surfaceMeasurementId, `${at}.surfaceMeasurementId`);
    if (!['mm', 'cm', 'inch', 'deg'].includes(row.unit as string)) fail(`${at}.unit`, 'must be mm, cm, inch or deg.');
    finite(row.manualValue, `${at}.manualValue`, true); finite(row.target, `${at}.target`, true);
    for (const key of ['tolMinus', 'tolPlus']) {
      finite(row[key], `${at}.${key}`);
      if ((row[key] as number) < 0) fail(`${at}.${key}`, 'must be nonnegative.');
    }
  });
  rows(spec.procurement, `${path}.procurement`, (row, at) => {
    strings(row, ['name', 'unit', 'notes'], at);
    if (!['material', 'trim', 'thread', 'fusing', 'label', 'packaging'].includes(row.category as string)) fail(`${at}.category`, 'must name a supported procurement category.');
    finite(row.quantity, `${at}.quantity`, true);
    if (row.quantity !== null && (row.quantity as number) < 0) fail(`${at}.quantity`, 'must be nonnegative.');
  });
}

function colorways(value: unknown): void {
  const path = 'colorways', state = record(value, path);
  reference(state.activeId, `${path}.activeId`);
  const sources = record(state.generatedMaterialSources, `${path}.generatedMaterialSources`);
  for (const [id, source] of Object.entries(sources)) {
    string(id, `${path}.generatedMaterialSources key`, true); string(source, `${path}.generatedMaterialSources.${id}`, true);
  }
  rows(state.variants, `${path}.variants`, (row, at) => {
    string(row.name, `${at}.name`);
    const pieces = record(row.pieces, `${at}.pieces`);
    for (const [pieceId, value] of Object.entries(pieces)) {
      string(pieceId, `${at}.pieces key`, true);
      const pieceAt = `${at}.pieces.${pieceId}`, override = record(value, pieceAt);
      string(override.materialId, `${pieceAt}.materialId`); // Empty means explicitly unassigned.
      for (const key of ['frontColor', 'backColor']) {
        if (override[key] === undefined) continue;
        string(override[key], `${pieceAt}.${key}`);
        if (!/^#[0-9a-f]{6}$/i.test(override[key])) fail(`${pieceAt}.${key}`, 'must be a six-digit hex color.');
      }
    }
  });
}

function artwork(value: unknown): void {
  let bytes = 0;
  rows(value, 'artwork', (row, at) => {
    strings(row, ['pieceId', 'name', 'dataUrl'], at);
    string(row.pieceId, `${at}.pieceId`, true);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(row.mimeType as string)) fail(`${at}.mimeType`, 'must be PNG, JPEG or WebP.');
    for (const key of ['pixelWidth', 'pixelHeight']) {
      finite(row[key], `${at}.${key}`);
      if (!Number.isInteger(row[key]) || (row[key] as number) < 1 || (row[key] as number) > 8192) fail(`${at}.${key}`, 'must be an integer from 1 to 8192.');
    }
    if ((row.pixelWidth as number) * (row.pixelHeight as number) > MAX_ARTWORK_PIXELS) fail(at, 'declares more than 16 megapixels.');
    for (const key of ['x', 'y', 'widthMm', 'heightMm', 'rotation', 'opacity']) finite(row[key], `${at}.${key}`);
    validateArtworkSurface(row);
    // Finite invalid placement and remote/corrupt source strings remain visible repair records.
    // Only embedded sources consume the import byte budget; no source is fetched or decoded here.
    const source = row.dataUrl as string;
    if (/^data:/i.test(source)) {
      const sourceBytes = artworkSourceBytes(source);
      if (sourceBytes > MAX_ARTWORK_SOURCE_BYTES || source.length > Math.ceil(MAX_ARTWORK_SOURCE_BYTES / 3) * 4 + 128) fail(`${at}.dataUrl`, 'exceeds the 2 MiB embedded image limit.');
      bytes += sourceBytes;
      if (bytes > MAX_ARTWORK_PROJECT_BYTES) fail('artwork', 'exceeds the 8 MiB project image limit.');
    }
  });
}

/** Admission check for optional production/design extensions. It never mutates a document or
 * resolves references. Missing entities and unsupported image source strings stay repairable;
 * malformed record shapes are rejected before a renderer/editor sees them. Layout retains the
 * separate existing normalizeWorkspaceLayout behavior rather than blocking a garment import.
 */
export function validateDocumentExtensions(value: unknown): void {
  const document = record(value, 'document');
  if (Array.isArray(document.points)) for (const [index, value] of document.points.entries()) {
    const point = record(value, `points[${index}]`);
    const constraint = point.constraint as ObjectRecord | undefined;
    if (constraint?.type === 'mirror' && constraint.compensation !== undefined) {
      const compensation = record(constraint.compensation, `points[${index}].constraint.compensation`);
      string(compensation.originPointId, `points[${index}].constraint.compensation.originPointId`, true);
      for (const key of ['scaleX', 'scaleY']) {
        finite(compensation[key], `points[${index}].constraint.compensation.${key}`);
        if ((compensation[key] as number) <= 0) fail(`points[${index}].constraint.compensation.${key}`, 'must be positive.');
      }
    }
  }
  if (document.productionSpec !== undefined) productionSpec(document.productionSpec);
  if (Array.isArray(document.pieces)) for (const [index, value] of document.pieces.entries()) {
    const piece = record(value, `pieces[${index}]`);
    if (piece.firstEdgeSymmetryAffine !== undefined) {
      const problem = foldAffineProblem(piece.firstEdgeSymmetryAffine);
      if (problem) fail(`pieces[${index}].firstEdgeSymmetryAffine`, problem);
    }
    if (piece.linkedMirror !== undefined) {
      const link = record(piece.linkedMirror, `pieces[${index}].linkedMirror`);
      string(link.sourcePieceId, `pieces[${index}].linkedMirror.sourcePieceId`, true);
      string(link.axisPathId, `pieces[${index}].linkedMirror.axisPathId`, true);
      if (link.ownerPieceId !== undefined) string(link.ownerPieceId, `pieces[${index}].linkedMirror.ownerPieceId`, true);
      for (const key of ['edgeMap', 'pointMap']) if (link[key] !== undefined) {
        const map = record(link[key], `pieces[${index}].linkedMirror.${key}`);
        const targets = new Set<string>();
        for (const [source, target] of Object.entries(map)) {
          string(source, `pieces[${index}].linkedMirror.${key} key`, true);
          string(target, `pieces[${index}].linkedMirror.${key}.${source}`, true);
          if (targets.has(target)) fail(`pieces[${index}].linkedMirror.${key}`, 'has duplicate target identities.');
          targets.add(target);
        }
      }
    }
  }
  if (Array.isArray(document.seams)) for (const [index, value] of document.seams.entries()) {
    const seam = record(value, `seams[${index}]`);
    if (seam.expectedEaseMm !== undefined) finite(seam.expectedEaseMm, `seams[${index}].expectedEaseMm`);
    if (seam.toleranceMm !== undefined) {
      finite(seam.toleranceMm, `seams[${index}].toleranceMm`);
      if ((seam.toleranceMm as number) < 0) fail(`seams[${index}].toleranceMm`, 'must be nonnegative.');
    }
  }
  if (document.techPack !== undefined) techPack(document.techPack);
  if (document.productionAutomation !== undefined) validateProductionAutomation(document.productionAutomation);
  if (document.rangePlan !== undefined) validateRangePlan(document.rangePlan);
  if (document.colorways !== undefined) colorways(document.colorways);
  if (document.artwork !== undefined) artwork(document.artwork);
  if (document.appearanceHistory !== undefined) validateAppearanceHistory(document.appearanceHistory);
  const sources = new Set<string>();
  let sourceBytes = 0;
  const collect = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const source = (row as ObjectRecord).dataUrl as string;
      if (/^data:/i.test(source) && !sources.has(source)) {
        sources.add(source); sourceBytes += artworkSourceBytes(source);
        if (sourceBytes > MAX_ARTWORK_PROJECT_BYTES) fail('appearanceHistory', 'and current artwork exceed 8 MiB of unique embedded images.');
      }
    }
  };
  collect(document.artwork);
  if (document.appearanceHistory !== undefined) for (const version of (document.appearanceHistory as { versions: ObjectRecord[] }).versions) collect(version.artwork);
}
