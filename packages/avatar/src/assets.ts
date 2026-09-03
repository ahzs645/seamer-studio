// The app's side of the shared body model: where the files are served from, and
// per-asset caching around the loaders in @seamer/body-model. The model's own
// types, parsers and formats live there; this re-exports them so a caller has
// one import either way.

import {
  loadBodyModel,
  parseIndices,
  parseSkinIndices,
  parseSkinWeights,
  parseCoefficients
} from '@seamer/body-model';
import type { BaseModel, GenderModel } from '@seamer/body-model';

export type {
  ArrangementPointDef,
  BaseModel,
  Bone,
  BoneData,
  Cylinder,
  GenderModel,
  Landmark,
  LoadedBodyModel,
  PoseData,
  Skeleton,
  Skin
} from '@seamer/body-model';

export { parseIndices, parseSkinIndices, parseSkinWeights, parseCoefficients };

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

let modelsBase = '/models';

// The JSON assets are read as-is; these name the shape rather than convert it.
export function parseBaseModel(json: unknown): BaseModel {
  return json as BaseModel;
}

export function parseGenderModel(json: unknown): GenderModel {
  return json as GenderModel;
}

// ---- browser loaders --------------------------------------------------------

let avatarAssetsCache: Promise<AvatarAssets> | null = null;
const genderCache = new Map<string, Promise<GenderAssets>>();
const genderModelCache = new Map<string, Promise<GenderModel>>();

/** Load just a gender's statistical model JSON (no coefficient .bin) — for measurement estimates. */
export function setAvatarAssetsBase(base: string): void {
  if (base === modelsBase) return;
  modelsBase = base;
  avatarAssetsCache = null;
  genderCache.clear();
  genderModelCache.clear();
}

export function loadGenderModel(gender: string, base = modelsBase): Promise<GenderModel> {
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

export function loadAvatarAssets(base = modelsBase): Promise<AvatarAssets> {
  if (avatarAssetsCache) return avatarAssetsCache;
  avatarAssetsCache = (async () => {
    const { baseModel, indices, skin } = await loadBodyModel(base, { fetchJson, fetchBytes: fetchArrayBuffer });
    return {
      baseModel,
      indices,
      skinIndices: skin.indices,
      skinWeights: skin.weights,
      numVertices: skin.weights.length / 4,
      numTriangles: indices.length / 3
    };
  })();
  return avatarAssetsCache;
}

/**
 * Load a gender's statistical model + per-vertex coefficient basis. Falls back to female when the
 * requested gender's coefficient asset is not bundled (only female_coefficients.bin ships today).
 */
export function loadGenderAssets(gender: string, base = modelsBase): Promise<GenderAssets> {
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
