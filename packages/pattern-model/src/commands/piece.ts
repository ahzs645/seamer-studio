// Piece-building operations that attach EXISTING draft geometry to a dynamic piece — the missing
// counterpart to drawing new geometry. Mirrors the source's addBoundaryPath / addInternalPath tools.

import type { Pattern, PiecePath } from '../pattern';

/** Add an existing draft path to a piece as a boundary (main) or internal edge. The path's first and
 *  last anchor points become the edge endpoints. No-op if the piece/path don't exist, or the path is
 *  already attached to that piece. `makeId` generates the new PiecePath id. */
export function pieceAddPath(
  pattern: Pattern,
  pieceId: string,
  pathId: string,
  kind: 'main' | 'internal',
  makeId: (prefix: string) => string
): Pattern {
  const piece = pattern.pieces.find((p) => p.id === pieceId);
  const path = pattern.paths.find((p) => p.id === pathId);
  if (!piece || !path) return pattern;
  const anchors = path.pathPoints;
  if (anchors.length < 2) return pattern;
  const from = anchors[0].id, to = anchors[anchors.length - 1].id;
  const already = [...piece.mainPaths, ...piece.internalPaths].some((pp) => pp.path === pathId);
  if (already) return pattern;

  const pp: PiecePath = {
    id: makeId('PiecePath'),
    name: path.name || (kind === 'internal' ? 'Internal' : 'Edge'),
    path: pathId,
    from,
    to,
    reversed: false,
    notches: [],
    ...(kind === 'internal' ? { foldAngle: 0 } : {})
  };

  const pieces = pattern.pieces.map((p) =>
    p.id !== pieceId ? p : kind === 'internal'
      ? { ...p, internalPaths: [...p.internalPaths, pp] }
      : { ...p, mainPaths: [...p.mainPaths, pp] }
  );
  return { ...pattern, pieces, hasChanged: true };
}
