import type { Pattern, Piece } from '@seamer/pattern-model';
import { isActiveMeasuredGarmentCodeSource } from './contactConfig';

/** Saved source geometry must explicitly identify this authored-cut rest policy. */
export const GARMENT_CODE_SOURCE_STRETCH_POLICY = 'source-authored-seam-stretch-v1' as const;

/** Same source/body and imported-panel provenance used by baked fabric constraints.
 * Names, cache state and material/contact options do not determine cut provenance.
 * Native additions to an imported document have no finite SourcePlacement marker.
 */
export function sourceStretchPolicyApplies(pattern: Pattern, piece: Piece): boolean {
  if (!isActiveMeasuredGarmentCodeSource(pattern)) return false;
  const placement = piece.settings3d?.arrangement?.sourcePlacement;
  return !!placement && Array.isArray(placement.worldMatrix) && placement.worldMatrix.length === 16
    && placement.worldMatrix.every(Number.isFinite)
    && Number.isFinite(placement.layoutOffsetMm?.x) && Number.isFinite(placement.layoutOffsetMm?.y);
}
