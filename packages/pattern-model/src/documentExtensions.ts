import { MAX_ARTWORK_PIXELS, MAX_ARTWORK_PROJECT_BYTES, MAX_ARTWORK_SOURCE_BYTES, artworkSourceBytes } from './artwork';

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
  rows(doc.construction, `${path}.construction`, (row, at) => {
    strings(row, ['title', 'instruction'], at); reference(row.pieceId, `${at}.pieceId`);
  });
  rows(doc.costing, `${path}.costing`, (row, at) => {
    strings(row, ['name', 'supplier', 'sku', 'unit', 'notes'], at);
    reference(row.procurementId, `${at}.procurementId`); reference(row.materialId, `${at}.materialId`);
    finite(row.quantity, `${at}.quantity`, true); finite(row.unitCost, `${at}.unitCost`, true);
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
  if (document.techPack !== undefined) techPack(document.techPack);
  if (document.colorways !== undefined) colorways(document.colorways);
  if (document.artwork !== undefined) artwork(document.artwork);
}
