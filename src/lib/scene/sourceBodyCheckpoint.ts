import type { Pattern } from '@seamer/pattern-model';
import { activeGarmentCodeBody } from '@seamer/avatar';
import { GARMENT_CODE_ASSEMBLY_REVISION, GARMENT_CODE_SOURCE_STRETCH_POLICY, sourceStretchPolicyApplies, type SimData } from '@seamer/cloth-sim';
export { GARMENT_CODE_ASSEMBLY_REVISION, GARMENT_CODE_SOURCE_STRETCH_POLICY };

// Revision 5 measures the actual posed source surface/geodesic dimensions; body4 drapes must reassemble.
export const SOURCE_BODY_FIT_REVISION = 5;

/** Only newly captured geometry receives the policy that was actually baked for its piece. */
export function capturedSourceStretchPolicy(pieceId: string, policy: SimData['sourceStretchPolicy'] | null): string | undefined {
  return policy?.sourcePieceIds.some(id => id === pieceId || id === `${pieceId}#M`) ? policy.policy : undefined;
}

/** Source cache reuse needs actual accepted closed/released/free geometry, beyond an all-active
 * mask. The live simulation supplies this eligibility; absent proof never becomes true. */
export function capturedSourceAssemblyComplete(pieceId: string, policy: SimData['sourceStretchPolicy'] | null,
  complete: boolean | null): boolean | undefined {
  return capturedSourceStretchPolicy(pieceId, policy) ? complete === true : undefined;
}

/** Keep the original saved document intact, but do not seed a new body with incompatible cloth.
 * The next simulation/export writes a checkpoint for the current body fit and sewing assembly. */
export function compatibleSourceBodyCheckpoint(pattern: Pattern): Pattern {
  if (!pattern.garmentCodeSource || !activeGarmentCodeBody(pattern.body)) return pattern;
  let changed = false;
  const pieces = pattern.pieces.map(piece => {
    const saved = piece.settings3d.savedPositions;
    if (!saved.length) return piece;
    const validCache = Array.isArray(saved) && saved.length % 5 === 0 && saved.every(Number.isFinite);
    const originalSourcePiece = sourceStretchPolicyApplies(pattern, piece);
    const currentSourceAssembly = !originalSourcePiece || (
      piece.settings3d.savedAssemblyRevision === GARMENT_CODE_ASSEMBLY_REVISION
      && piece.settings3d.savedSourceStretchPolicy === GARMENT_CODE_SOURCE_STRETCH_POLICY
      && piece.settings3d.savedSourceAssemblyComplete === true);
    if (validCache && piece.settings3d.savedBodyFitRevision === SOURCE_BODY_FIT_REVISION
      && currentSourceAssembly) return piece;
    changed = true;
    return { ...piece, settings3d: { ...piece.settings3d, savedPositions: [], savedMeshSnapshot: undefined,
      savedDrapeState: 'checkpoint' as const, savedBodyFitRevision: SOURCE_BODY_FIT_REVISION,
      ...(originalSourcePiece ? { savedAssemblyRevision: GARMENT_CODE_ASSEMBLY_REVISION,
        savedSourceStretchPolicy: GARMENT_CODE_SOURCE_STRETCH_POLICY, savedSourceAssemblyComplete: false } : {}) } };
  });
  return changed ? { ...pattern, pieces } : pattern;
}
