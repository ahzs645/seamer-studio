import { hasConstraints, pieceShrinkageScale, redraft, syncLinkedPaths, type Pattern } from '@seamer/pattern-model';
import { syncLinkedMirrorPlacements } from './linkedMirror';

/** Appearance, production, viewport and cached drape edits do not redraft solved geometry. */
export function draftingFingerprint(pattern: Pattern): string {
  return JSON.stringify({ points: pattern.points, paths: pattern.paths, variables: pattern.variables, body: pattern.body, grading: pattern.gradingProfile,
    pieces: pattern.pieces.map(piece => {
      const { id, origin, originPoint, position, rotation, mirrorX, mirrorY, firstEdgeSymmetry, firstEdgeSymmetryAffine, mainPaths, internalPaths, linkedMirror, grainVector, markers, piecePoints, useMaterialScaling } = piece;
      return { id, origin, originPoint, position, rotation, mirrorX, mirrorY, firstEdgeSymmetry, firstEdgeSymmetryAffine, mainPaths, internalPaths, linkedMirror, grainVector, markers, piecePoints, useMaterialScaling, compensation: pieceShrinkageScale(pattern, piece) };
    }) });
}

/** Canonical commands keep persistent mirrors current within the same undo transaction. */
export function synchronizeLinkedDraft(previous: Pattern, next: Pattern): Pattern {
  if (!next.pieces.some(piece => piece.linkedMirror) || draftingFingerprint(previous) === draftingFingerprint(next)) return next;
  return syncLinkedMirrorPlacements(syncLinkedPaths(hasConstraints(next) ? redraft(next) : next));
}
