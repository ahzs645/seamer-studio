import type { CollisionGuardInput, CollisionGuardOptions, CollisionGuardReport, CollisionSeamActivation } from './collisionGuard';

interface Envelope { token: string; binding: string; requestId: number; activationBinding?: string; activationRevision?: number }
export type CollisionGuardWorkerRequest = Envelope & (
  { kind: 'init'; input: CollisionGuardInput; options: CollisionGuardOptions }
  | { kind: 'trajectory'; final: Float32Array; previous: Float32Array;
    trajectory: readonly Float32Array[] | null | undefined; expectedSubSteps: number; activation?: CollisionSeamActivation }
);
export type CollisionGuardWorkerResponse = Envelope & (
  { kind: 'ready' } | { kind: 'report'; report: CollisionGuardReport } | { kind: 'error'; message: string }
);

/** SHA-256 of explicit IEEE-754 input bytes, including body, topology, seams and tolerances. */
export async function collisionGuardWorkerBinding(input: CollisionGuardInput, options: CollisionGuardOptions): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Collision verification requires Web Crypto in a secure context.');
  const arrays = [input.bodyPositions, input.bodyIndices, input.clothTriangles,
    input.seams ?? [], ...(input.seamPairsBySeam ?? []).flatMap(group => [group.pairs, group.stitchIndices ?? []]),
    new TextEncoder().encode(JSON.stringify((input.seamPairsBySeam ?? []).map(group => ({ seamId: group.seamId ?? null,
      index: group.index ?? null, stitchIndexKinds: group.stitchIndexKinds ?? null }))))];
  if (input.sourceGatherRefinementRevision !== undefined || input.sourceGatherCollisionGeometry !== undefined) {
    const geometry = input.sourceGatherCollisionGeometry;
    arrays.push(geometry?.sourceMaterialCoordinates ?? [], new TextEncoder().encode(JSON.stringify({
      declaredRevision: input.sourceGatherRefinementRevision ?? null, revision: geometry?.revision ?? null,
      refinementPolicySha256: geometry?.refinementPolicySha256 ?? null, sourceCoordinateStride: geometry?.sourceCoordinateStride ?? null,
      intervals: geometry?.intervals ?? null })));
  }
  const header = [2, input.particleCount, input.bodyPositionStride ?? 3, input.bodyTriangleStride ?? 3,
    input.clothTriangleStride ?? 4, options.checkSelfIntersections === false ? 0 : 1,
    options.epsilon ?? 1e-6, options.maxRecordedIssues ?? 64, input.seams ? 1 : 0,
    input.seamPairsBySeam?.length ?? 0, input.stitchCount ?? -1];
  const bytes = new ArrayBuffer((header.length + arrays.length + arrays.reduce((sum, array) => sum + array.length, 0)) * 8);
  const view = new DataView(bytes); let offset = 0;
  const add = (value: number) => { view.setFloat64(offset, value, true); offset += 8; };
  header.forEach(add);
  arrays.forEach(array => { add(array.length); for (let index = 0; index < array.length; index++) add(array[index]); });
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Request-specific SHA of the exact semantic mask, actual prefix and controller revision. */
export async function collisionGuardActivationBinding(activation?: CollisionSeamActivation): Promise<string | undefined> {
  if (!activation) return undefined;
  if (!globalThis.crypto?.subtle) throw new Error('Collision verification requires Web Crypto in a secure context.');
  const values = [1, activation.revision, activation.sewnUpTo, activation.activeSeams.length, ...activation.activeSeams];
  const bytes = new ArrayBuffer(values.length * 8), view = new DataView(bytes);
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
