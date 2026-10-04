import type { SimData } from './build';

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key =>
    [key, canonical((value as Record<string, unknown>)[key])])) : value;

/** Restore identity for a source assembly controller and its support prerequisites. Legacy
 * inputs retain the original serialized bytes. A refined mesh additionally binds the captured
 * numerical policy and actual child path/material dictionary, even when all IDs stay the same. */
export function sourceAssemblyTopologyIdentity(data: Pick<SimData, 'triangles' | 'sourceGatherRefinement' | 'sourceGatherCollisionGeometry'>,
  dictionary: unknown): string {
  const legacy = { triangles: Array.from(data.triangles), dictionary };
  if (!data.sourceGatherRefinement && !data.sourceGatherCollisionGeometry) return JSON.stringify(legacy);
  const geometry = data.sourceGatherCollisionGeometry;
  if (!data.sourceGatherRefinement || !geometry?.sourceMaterialCoordinates) {
    throw new Error('Refined assembly snapshot requires its finalized policy and actual child material geometry');
  }
  const refinement = canonical({ sourceGatherRefinement: data.sourceGatherRefinement ?? null,
    sourceGatherCollisionGeometry: geometry ? { ...geometry, sourceMaterialCoordinates: Array.from(geometry.sourceMaterialCoordinates) } : null });
  return JSON.stringify({ ...legacy, ...refinement as Record<string, unknown> });
}
