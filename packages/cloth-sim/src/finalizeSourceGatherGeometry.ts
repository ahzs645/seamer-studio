import type { SimData } from './build';
import { SOURCE_GATHER_COLLISION_GEOMETRY_REVISION } from './collisionGuard';

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key =>
    [key, canonical((value as Record<string, unknown>)[key])])) : value;
const freeze = (value: unknown): void => {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
};

/** Async preparation boundary, BEFORE source guard/worker/engine creation. Leaves the input
 * untouched; snapshots before the digest await. No geometry is accepted by this hash alone. */
export async function finalizeSourceGatherCollisionGeometry(simData: SimData): Promise<SimData> {
  if (!simData.sourceGatherRefinement && !simData.sourceGatherCollisionGeometry) return simData;
  const policy = structuredClone(simData.sourceGatherRefinement), geometry = structuredClone(simData.sourceGatherCollisionGeometry);
  if (!policy || !geometry || policy.revision !== SOURCE_GATHER_COLLISION_GEOMETRY_REVISION
    || geometry.revision !== policy.revision || !geometry.sourceMaterialCoordinates || geometry.sourceCoordinateStride !== 4) {
    throw new Error('Refined cloth requires its captured source policy and actual child geometry before simulation.');
  }
  // Bind the raw source and numerical policy, not an asserted identifier from a fixture.
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(policy)));
  if (!globalThis.crypto?.subtle) throw new Error('Refined cloth provenance requires Web Crypto in a secure context.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (geometry.refinementPolicySha256 !== undefined && geometry.refinementPolicySha256 !== sha256) {
    throw new Error('Refined cloth policy does not match its captured numerical geometry provenance.');
  }
  geometry.refinementPolicySha256 = sha256;
  freeze(policy); freeze(geometry);
  return { ...simData, sourceGatherRefinement: policy, sourceGatherCollisionGeometry: geometry };
}
