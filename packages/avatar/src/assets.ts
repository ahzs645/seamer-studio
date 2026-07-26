// Loading + parsing of the parametric body-model assets shipped in static/models/.
// Parsers are pure (operate on already-fetched JSON / ArrayBuffers) so they can be unit tested;
// loadAvatarAssets() / loadGenderAssets() wrap them with fetch and per-asset caching.
//
// Binary formats (little-endian), verified against byte sizes:
//   indices.bin       Float32  ×(numTris*3)  face indices stored as floats (cast to int)
//   skin_indices.bin  Uint16   ×(numVerts*4) bone indices
//   skin_weights.bin  Float32  ×(numVerts*4) skin weights (each quad sums to 1)
//   <gender>_coefficients.bin  Float32  layout [vertexInOrder][axis 0..2][coeff 0..17],
//       vertexInOrder = symmetry.centeredIndices then symmetry.pairs; 18 = 17 weights + 1 intercept.

export interface BoneData {
  indices: number[]; // 4 vertex indices whose weighted sum is the joint world position
  weights: number[]; // 4 weights (may be negative; ~sum to 1)
  parent: string | null;
  rotation: [number, number, number, string]; // rest euler [x,y,z,'XYZ']
}

export type PoseData = Record<string, { x: number; y: number; z: number }>; // boneName -> absolute euler (XYZ)

export interface Cylinder {
  id: string;
  name: string;
  startBone: string;
  endBone: string;
  vertexIndices: number[];
  padding: number;
  uOffsetDegrees: number;
  tapered: boolean;
  elliptical: boolean;
  axisReversed: boolean;
  enabled: boolean;
}

export interface ArrangementPointDef {
  id: string;
  name: string;
  cylinderName: string;
  uDegrees: number;
  v: number;
  enabled: boolean;
}

export interface Landmark {
  id: number;
  vertexIndex: number;
  name: string;
  x: number;
  y: number;
  z: number;
  enabled: boolean;
}

export interface BaseModel {
  bodyParts: Record<string, number[]>;
  symmetry: { centeredIndices: number[]; pairs: [number, number][] };
  measurements: unknown[];
  coefficientNames: string[];
  landmarks: Landmark[];
  bones: [string, BoneData][];
  poses: Record<string, PoseData>;
  cylinders: Cylinder[];
  arrangementPoints: ArrangementPointDef[];
}

export interface GenderModel {
  covariances: number[][]; // 69 x 69
  means: number[]; // 69
  min: number[];
  max: number[];
  columnNames: string[]; // 69
  numSamples: number;
}

export interface AvatarAssets {
  baseModel: BaseModel;
  indices: Uint32Array; // numTris*3
  skinIndices: Uint16Array; // numVerts*4
  skinWeights: Float32Array; // numVerts*4
  numVertices: number;
  numTriangles: number;
}

export interface GenderAssets {
  gender: string; // resolved gender (may differ from requested if a fallback was used)
  model: GenderModel;
  coefficients: Float32Array;
}

const MODELS_BASE = '/models';

// ---- pure parsers -----------------------------------------------------------

export function parseBaseModel(json: unknown): BaseModel {
  return json as BaseModel;
}

export function parseGenderModel(json: unknown): GenderModel {
  return json as GenderModel;
}

/** indices.bin holds integer face indices stored as Float32; cast to Uint32. */
export function parseIndices(buf: ArrayBuffer): Uint32Array {
  const f = new Float32Array(buf);
  const out = new Uint32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(f[i]);
  return out;
}

export function parseSkinIndices(buf: ArrayBuffer): Uint16Array {
  return new Uint16Array(buf);
}

export function parseSkinWeights(buf: ArrayBuffer): Float32Array {
  return new Float32Array(buf);
}

export function parseCoefficients(buf: ArrayBuffer): Float32Array {
  return new Float32Array(buf);
}

// ---- browser loaders --------------------------------------------------------

let avatarAssetsCache: Promise<AvatarAssets> | null = null;
const genderCache = new Map<string, Promise<GenderAssets>>();
const genderModelCache = new Map<string, Promise<GenderModel>>();

/** Load just a gender's statistical model JSON (no coefficient .bin) — for measurement estimates. */
export function loadGenderModel(gender: string, base = MODELS_BASE): Promise<GenderModel> {
  const g = gender === 'male' ? 'male' : 'female';
  const cached = genderModelCache.get(g);
  if (cached) return cached;
  const p = fetchJson(`${base}/${g}_model.json`).then(parseGenderModel);
  genderModelCache.set(g, p);
  return p;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.arrayBuffer();
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

export function loadAvatarAssets(base = MODELS_BASE): Promise<AvatarAssets> {
  if (avatarAssetsCache) return avatarAssetsCache;
  avatarAssetsCache = (async () => {
    const [baseJson, indicesBuf, skinIdxBuf, skinWBuf] = await Promise.all([
      fetchJson(`${base}/base_model.json`),
      fetchArrayBuffer(`${base}/indices.bin`),
      fetchArrayBuffer(`${base}/skin_indices.bin`),
      fetchArrayBuffer(`${base}/skin_weights.bin`)
    ]);
    const baseModel = parseBaseModel(baseJson);
    const indices = parseIndices(indicesBuf);
    const skinIndices = parseSkinIndices(skinIdxBuf);
    const skinWeights = parseSkinWeights(skinWBuf);
    return {
      baseModel,
      indices,
      skinIndices,
      skinWeights,
      numVertices: skinWeights.length / 4,
      numTriangles: indices.length / 3
    };
  })();
  return avatarAssetsCache;
}

/**
 * Load a gender's statistical model + per-vertex coefficient basis. Falls back to female when the
 * requested gender's coefficient asset is not bundled (only female_coefficients.bin ships today).
 */
export function loadGenderAssets(gender: string, base = MODELS_BASE): Promise<GenderAssets> {
  const g = gender === 'male' ? 'male' : 'female';
  const cached = genderCache.get(g);
  if (cached) return cached;
  const p = (async (): Promise<GenderAssets> => {
    const model = parseGenderModel(await fetchJson(`${base}/${g}_model.json`));
    try {
      const coefficients = parseCoefficients(await fetchArrayBuffer(`${base}/${g}_coefficients.bin`));
      return { gender: g, model, coefficients };
    } catch {
      if (g !== 'female') {
        // shape basis missing for this gender: reuse the female basis for reconstruction.
        const fallback = await loadGenderAssets('female', base);
        return { gender: 'female', model, coefficients: fallback.coefficients };
      }
      throw new Error('female_coefficients.bin is required but could not be loaded');
    }
  })();
  genderCache.set(g, p);
  return p;
}
