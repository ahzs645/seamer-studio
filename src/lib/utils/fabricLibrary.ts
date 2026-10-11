import type { Material } from '@seamer/pattern-model';
import type { LibraryItem } from '$lib/stores/materialLibrary';

export const FABRIC_CATALOG_LIMIT = 500;

export interface FabricCriteria { weight: number; stretchWarp: number; stretchWeft: number; bend: number; thickness: number }
export const FABRIC_TARGETS: Record<string, FabricCriteria> = {
  'Woven shirt': { weight: 120, stretchWarp: 8, stretchWeft: 10, bend: 22, thickness: 0.4 },
  'Stretch top': { weight: 180, stretchWarp: 55, stretchWeft: 70, bend: 8, thickness: 0.6 },
  'Structured outerwear': { weight: 340, stretchWarp: 5, stretchWeft: 6, bend: 55, thickness: 0.9 },
  'Fluid dress': { weight: 80, stretchWarp: 12, stretchWeft: 14, bend: 6, thickness: 0.2 }
};

/** Distance to explicit editable criteria, not a claim of tested garment suitability. */
export function recommendFabrics(items: readonly LibraryItem[], target: FabricCriteria) {
  const fields = [ ['weight', 'weight', 400], ['stretchWarpValue', 'stretchWarp', 100], ['stretchWeftValue', 'stretchWeft', 100], ['bendValue', 'bend', 100], ['thickness', 'thickness', 2] ] as const;
  return items.flatMap(item => {
    if (fields.some(([key, criterion]) => !Number.isFinite(item.material[key]) || !Number.isFinite(target[criterion]))) return [];
    const differences = fields.map(([key, criterion, scale]) => ({ name: criterion, actual: item.material[key], target: target[criterion], distance: Math.abs(item.material[key] - target[criterion]) / scale }));
    return [{ item, distance: differences.reduce((total, value) => total + value.distance, 0) / fields.length, differences }];
  }).sort((a, b) => a.distance - b.distance || a.item.name.localeCompare(b.item.name) || a.item.id.localeCompare(b.item.id));
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function safeUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) return false;
  if (value === '' || /^\/(?!\/)[^\\]*$/.test(value) || /^data:image\/(png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(value)) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
/** Catalog contract: {version:1, materials:[complete LibraryItem]}. Reject the entire response on malformed physics. */
export function parseFabricCatalog(value: unknown): LibraryItem[] {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.materials) || value.materials.length > FABRIC_CATALOG_LIMIT) throw new Error(`Expected catalog version 1 and at most ${FABRIC_CATALOG_LIMIT} materials.`);
  const ids = new Set<string>();
  return value.materials.map((item: unknown) => {
    if (!record(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || !Number.isInteger(item.version) || Number(item.version) < 1 || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)) || typeof item.writeProtected !== 'boolean' || !(item.ownerUserId === null || typeof item.ownerUserId === 'string') || !record(item.material)) throw new Error('Catalog contains an invalid or duplicate fabric.');
    ids.add(item.id);
    if (item.collection !== undefined && (typeof item.collection !== 'string' || item.collection.length > 120) || item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 30 || !item.tags.every(tag => typeof tag === 'string' && tag.length <= 120))) throw new Error('Invalid fabric collection or tags.');
    const material = item.material;
    if (typeof material.id !== 'string' || typeof material.name !== 'string' || typeof material.useSeparateBackSide !== 'boolean') throw new Error('Catalog fabric identity is invalid.');
    for (const [key, min, max] of [['stretchWarpValue', 0, 100], ['stretchWeftValue', 0, 100], ['bendValue', 0, 100], ['thickness', 0, 100], ['weight', 0, 10000], ['roughness', 0, 1], ['metalness', 0, 1], ['specularIntensity', 0, 100], ['opacity', 0, 1], ['normalScale', 0, 100], ['alphaCutoff', 0, 1]] as const) {
      const number = material[key];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) throw new Error(`Catalog fabric ${item.name}: invalid ${key}.`);
    }
    for (const key of ['visualizationThickness', 'shrinkageHorizontalPercentage', 'shrinkageVerticalPercentage']) {
      const number = material[key];
      if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number >= (key === 'visualizationThickness' ? 100 : 100))) throw new Error(`Invalid ${key}.`);
    }
    for (const side of ['frontTexture', 'backTexture']) {
      const slot = material[side];
      if (slot === null) continue;
      if (!record(slot) || !safeUrl(slot.url) || !safeUrl(slot.normalUrl) || !safeUrl(slot.opacityUrl) || typeof slot.color !== 'string' || !/^#[a-f\d]{6}$/i.test(slot.color) || ['scale', 'normalMapScale', 'opacityMapScale'].some(key => typeof slot[key] !== 'number' || !Number.isFinite(slot[key]) || Number(slot[key]) <= 0) || ['mediaId', 'normalMediaId', 'opacityMediaId'].some(key => !(slot[key] === null || typeof slot[key] === 'string'))) throw new Error('Catalog texture metadata is invalid or uses an unsupported URL.');
    }
    // Reconstruct with cloned validated values; provenance is catalog-local until saved by the user.
    return structuredClone(item) as unknown as LibraryItem;
  });
}

export async function fetchFabricCatalog(address: string, fetcher: typeof fetch = fetch): Promise<LibraryItem[]> {
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a public HTTP or HTTPS catalog URL without embedded credentials.');
  const response = await fetcher(url, { credentials: 'omit', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
  const assetBase = new URL(response.url || url.href);
  if (!['http:', 'https:'].includes(assetBase.protocol) || assetBase.username || assetBase.password) throw new Error('Catalog response URL must use public HTTP or HTTPS without embedded credentials.');
  const limit = 8 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Catalog exceeds the 8 MB limit.');
  if (!response.body) throw new Error('Catalog response is empty.');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0, body = '';
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error('Catalog exceeds the 8 MB limit.'); }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  const items = parseFabricCatalog(JSON.parse(body));
  // Relative catalog assets belong to the provider's origin, rather than the studio's origin.
  for (const item of items) {
    for (const slot of [item.material.frontTexture, item.material.backTexture]) {
      if (!slot) continue;
      for (const key of ['url', 'normalUrl', 'opacityUrl'] as const) if (slot[key].startsWith('/')) slot[key] = new URL(slot[key], assetBase).href;
    }
  }
  return items;
}

export function materialFacts(material: Pick<Material, 'weight' | 'thickness' | 'stretchWarpValue' | 'stretchWeftValue' | 'bendValue'>) {
  return `${material.weight} g/m² · ${material.thickness} mm · stretch ${material.stretchWarpValue}/${material.stretchWeftValue} · bend ${material.bendValue}`;
}
