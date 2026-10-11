import type { Pattern } from './pattern';
import { indexPaths, indexPoints, pieceOutline, type Vec2 } from './utils/patternGeometry';

export type ArtworkMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

/** A front-face print in the owner's canonical drafting frame, before 2D placement transforms.
 * Coordinates and dimensions are millimetres; positive rotation is counterclockwise in y-up space.
 * Raster UV is u-right/v-down. Mirroring/rotation/shrinkage belong to the piece transform.
 */
export interface PieceArtwork {
  id: string;
  pieceId: string;
  name: string;
  dataUrl: string;
  mimeType: ArtworkMimeType;
  pixelWidth: number;
  pixelHeight: number;
  x: number;
  y: number;
  widthMm: number;
  heightMm: number;
  rotation: number;
  /** Reflect raster U within the print without changing its piece or physical dimensions. */
  flipX?: boolean;
  opacity: number;
  /** Local repeating ink, clipped to the owner; dimensions describe one tile. */
  repeat?: { mode: 'grid' | 'brick' | 'half-drop'; gapXmm: number; gapYmm: number };
  treatment?: { blend: 'source-over' | 'multiply' | 'screen'; tint?: string };
  /** Optional polygon in raw draft millimetres restricts the print zone. */
  zone?: Vec2[];
  vectorDesign?: VectorArtworkDesign;
}

export interface VectorArtworkDesign {
  width: number;
  height: number;
  shapes: Array<{
    kind: 'rectangle' | 'ellipse' | 'line' | 'text';
    x: number; y: number; width: number; height: number;
    fill: string; stroke: string; strokeWidth: number; text?: string;
  }>;
}

export type ArtworkSource = Pick<PieceArtwork, 'dataUrl' | 'mimeType' | 'pixelWidth' | 'pixelHeight'>;
export type ArtworkPlacement = Pick<PieceArtwork, 'x' | 'y' | 'widthMm' | 'heightMm' | 'rotation' | 'flipX'>;
export const MAX_ARTWORK_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_ARTWORK_PROJECT_BYTES = 8 * 1024 * 1024;
export const MAX_ARTWORK_PIXELS = 16 * 1024 * 1024;
const sourcePattern = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const embeddedSourceCache = new Map<string, { mimeType: string; valid: boolean }>();

export function artworkSourceBytes(dataUrl: string): number {
  if (typeof dataUrl !== 'string') return 0;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const base64 = dataUrl.slice(comma + 1);
  return Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

/** Imported records never cause remote requests or execute SVG markup. Browser decoding is also
 * required before a source is added/replaced; this pure validator protects every renderer/exporter.
 */
export function artworkSourceProblem(source: ArtworkSource): string | null {
  if (typeof source.dataUrl !== 'string' || !source.dataUrl) return 'Missing image source. Replace the image to restore this print.';
  if (source.dataUrl.length > Math.ceil(MAX_ARTWORK_SOURCE_BYTES / 3) * 4 + 64) return 'Image exceeds the 2 MiB source limit.';
  // A print is checked every canvas frame. Scan immutable source bytes once, with a bounded cache;
  // placement/dimensions remain validated independently on each call.
  let embedded = embeddedSourceCache.get(source.dataUrl);
  if (!embedded) {
    const match = sourcePattern.exec(source.dataUrl);
    embedded = { mimeType: match?.[1] ?? '', valid: Boolean(match && match[2].length % 4 === 0) };
    if (embeddedSourceCache.size >= 8) embeddedSourceCache.delete(embeddedSourceCache.keys().next().value!);
    embeddedSourceCache.set(source.dataUrl, embedded);
  }
  if (!embedded.valid || embedded.mimeType !== source.mimeType) return 'Use an embedded PNG, JPEG or WebP image.';
  if (artworkSourceBytes(source.dataUrl) > MAX_ARTWORK_SOURCE_BYTES) return 'Image exceeds the 2 MiB source limit.';
  if (!Number.isInteger(source.pixelWidth) || !Number.isInteger(source.pixelHeight) ||
    source.pixelWidth < 1 || source.pixelHeight < 1 || source.pixelWidth > 8192 || source.pixelHeight > 8192 ||
    source.pixelWidth * source.pixelHeight > MAX_ARTWORK_PIXELS) return 'Image dimensions exceed the 16 megapixel / 8192 pixel limit.';
  return null;
}

export function artworkPlacementProblem(placement: ArtworkPlacement & { opacity: number }): string | null {
  if (placement.flipX !== undefined && typeof placement.flipX !== 'boolean') return 'Artwork reflection must be a boolean.';
  if (![placement.x, placement.y, placement.rotation, placement.widthMm, placement.heightMm, placement.opacity].every(Number.isFinite)) return 'Artwork placement must use finite numbers.';
  if (placement.widthMm <= 0 || placement.heightMm <= 0 || placement.widthMm > 10000 || placement.heightMm > 10000) return 'Artwork width and height must be greater than zero and at most 10000 mm.';
  if (placement.opacity < 0 || placement.opacity > 1) return 'Artwork opacity must be between 0 and 1.';
  return null;
}

export function artworkDraftPoint(artwork: ArtworkPlacement, u: number, v: number): Vec2 {
  const angle = artwork.rotation * Math.PI / 180;
  const dx = (u - .5) * artwork.widthMm * (artwork.flipX ? -1 : 1), dy = (.5 - v) * artwork.heightMm;
  return { x: artwork.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: artwork.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
}

/** Inverse mapping, shared by true UV previews and placement hit-testing. Values outside 0..1
 * lie outside the print; callers clip against the owner piece independently.
 */
export function artworkSourceUV(artwork: ArtworkPlacement, point: Vec2): Vec2 {
  const angle = artwork.rotation * Math.PI / 180;
  const dx = point.x - artwork.x, dy = point.y - artwork.y;
  return { x: .5 + (dx * Math.cos(angle) + dy * Math.sin(angle)) / artwork.widthMm * (artwork.flipX ? -1 : 1),
    y: .5 - (-dx * Math.sin(angle) + dy * Math.cos(angle)) / artwork.heightMm };
}

export function pieceArtworkBounds(pattern: Pattern, pieceId: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const piece = pattern.pieces.find(item => item.id === pieceId);
  if (!piece) return null;
  const outline = pieceOutline(pattern, piece, indexPaths(pattern), indexPoints(pattern), 4);
  const boundary: Vec2[] = outline.length >= 3 ? outline :
    (piece.legacyGeometry?.boundary ?? []).flat().map(([x, y]) => ({ x, y }));
  if (boundary.length < 3 || !boundary.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
  let area = 0;
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let index = 0; index < boundary.length; index++) {
    const point = boundary[index], next = boundary[(index + 1) % boundary.length];
    area += point.x * next.y - next.x * point.y;
    bounds.minX = Math.min(bounds.minX, point.x); bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y); bounds.maxY = Math.max(bounds.maxY, point.y);
  }
  return Math.abs(area) > 1e-6 ? bounds : null;
}

function checkProjectBudget(pattern: Pattern, source: ArtworkSource, replacingId?: string): void {
  const bytes = (pattern.artwork ?? []).filter(item => item.id !== replacingId)
    .reduce((total, item) => total + artworkSourceBytes(item.dataUrl ?? ''), 0) + artworkSourceBytes(source.dataUrl);
  if (bytes > MAX_ARTWORK_PROJECT_BYTES) throw Error('Project artwork exceeds 8 MiB. Remove an image or use a smaller source.');
}

export function addPieceArtwork(pattern: Pattern, pieceId: string, source: ArtworkSource, id: string, name: string): Pattern {
  const sourceProblem = artworkSourceProblem(source);
  if (sourceProblem) throw Error(sourceProblem);
  const bounds = pieceArtworkBounds(pattern, pieceId);
  if (!bounds || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) throw Error('Select a piece with a valid closed boundary.');
  if ((pattern.artwork ?? []).some(item => item.id === id)) throw Error('Artwork ID already exists.');
  checkProjectBudget(pattern, source);
  const widthMm = Math.min(100, (bounds.maxX - bounds.minX) / 2, (bounds.maxY - bounds.minY) / 2 * source.pixelWidth / source.pixelHeight);
  const artwork: PieceArtwork = { ...source, id, pieceId, name: name.trim().slice(0, 200) || 'Artwork',
    x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2,
    widthMm, heightMm: widthMm * source.pixelHeight / source.pixelWidth, rotation: 0, opacity: 1 };
  return { ...pattern, artwork: [...(pattern.artwork ?? []), artwork], hasChanged: true };
}

export function updatePieceArtwork(pattern: Pattern, id: string, patch: Partial<Omit<PieceArtwork, 'id'>>): Pattern {
  const previous = (pattern.artwork ?? []).find(item => item.id === id);
  if (!previous) return pattern;
  const next = { ...previous, ...patch };
  validateArtworkSurface(next);
  const placementProblem = artworkPlacementProblem(next);
  if (placementProblem) throw Error(placementProblem);
  // Geometry remains editable on imported records whose image is missing; replacement restores it.
  if (['dataUrl', 'mimeType', 'pixelWidth', 'pixelHeight'].some(key => key in patch)) {
    const problem = artworkSourceProblem(next);
    if (problem) throw Error(problem);
    checkProjectBudget(pattern, next, id);
  }
  if ('pieceId' in patch && !pieceArtworkBounds(pattern, next.pieceId)) throw Error('Choose a piece with a valid boundary.');
  next.name = next.name.trim().slice(0, 200) || 'Artwork';
  if (Object.keys(patch).every(key => previous[key as keyof PieceArtwork] === next[key as keyof PieceArtwork])) return pattern;
  return { ...pattern, artwork: (pattern.artwork ?? []).map(item => item.id === id ? next : item), hasChanged: true };
}

export function removePieceArtwork(pattern: Pattern, id: string): Pattern {
  if (!(pattern.artwork ?? []).some(item => item.id === id)) return pattern;
  return { ...pattern, artwork: (pattern.artwork ?? []).filter(item => item.id !== id), hasChanged: true };
}

export function artworkSurfaceProblem(item: PieceArtwork): string | null {
  if (item.flipX !== undefined && typeof item.flipX !== 'boolean') return 'Artwork reflection must be a boolean.';
  if (item.repeat && (!['grid', 'brick', 'half-drop'].includes(item.repeat.mode) ||
    ![item.repeat.gapXmm, item.repeat.gapYmm].every(v => Number.isFinite(v) && v >= 0 && v <= 10000))) return 'Repeat spacing must be between 0 and 10000 mm.';
  if (item.treatment && (!['source-over', 'multiply', 'screen'].includes(item.treatment.blend) ||
    (item.treatment.tint !== undefined && !/^#[0-9a-f]{6}$/i.test(item.treatment.tint)))) return 'Choose a supported ink blend and hex colour.';
  if (item.zone && (item.zone.length < 3 || item.zone.length > 64 || !item.zone.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y)))) return 'A print zone needs 3–64 finite draft points.';
  return null;
}


export function vectorDesignProblem(design: VectorArtworkDesign): string | null {
  if (!design || !Number.isInteger(design.width) || !Number.isInteger(design.height) || design.width<1 || design.height<1 || design.width>2048 || design.height>2048 || !Array.isArray(design.shapes) || design.shapes.length>128) return 'Use a vector canvas up to 2048 × 2048 pixels and 128 shapes.';
  for (const shape of design.shapes) {
    if (!shape || !['rectangle','ellipse','line','text'].includes(shape.kind) || ![shape.x,shape.y,shape.width,shape.height,shape.strokeWidth].every(Number.isFinite) || shape.width<0 || shape.height<0 || shape.strokeWidth<0 || shape.strokeWidth>100 || !/^#[0-9a-f]{6}$/i.test(shape.fill) || !/^#[0-9a-f]{6}$/i.test(shape.stroke) || (shape.text!==undefined && (typeof shape.text!=='string' || shape.text.length>200))) return 'Vector shapes need finite dimensions, supported shapes and hex colours.';
  }
  return null;
}


/** Admission guard accepts unknown input and never executes vector markup. */
export function validateArtworkSurface(value: unknown): void {
  if(!value || typeof value!=='object'||Array.isArray(value))throw Error('Invalid artwork surface record.');
  const row=value as PieceArtwork;
  if(row.flipX!==undefined&&typeof row.flipX!=='boolean')throw Error('Artwork reflection must be a boolean.');
  if(row.repeat!==undefined && (!row.repeat||typeof row.repeat!=='object'||Array.isArray(row.repeat)))throw Error('Invalid artwork repeat.');
  if(row.treatment!==undefined && (!row.treatment||typeof row.treatment!=='object'||Array.isArray(row.treatment)))throw Error('Invalid artwork treatment.');
  if(row.zone!==undefined&&!Array.isArray(row.zone))throw Error('Invalid artwork print zone.');
  const problem=artworkSurfaceProblem(row);if(problem)throw Error(problem);
  if(row.vectorDesign!==undefined){const vectorProblem=vectorDesignProblem(row.vectorDesign);if(vectorProblem)throw Error(vectorProblem);}
}
