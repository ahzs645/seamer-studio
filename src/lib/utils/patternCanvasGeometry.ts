import {
  indexPaths,
  indexPoints,
  mirrorHalfOutline,
  pieceMirrorAxis,
  pieceOutline,
  piecePathPolyline,
  pieceShrinkageScale,
  pieceTransform,
  reflectAcrossLine,
  type Pattern,
  type Piece,
  type Vec2
} from '@seamer/pattern-model';

type PointIndex = ReturnType<typeof indexPoints>;
type PathIndex = ReturnType<typeof indexPaths>;

/** An explicit boundary mirror line means the placed 2D copy should be shown as a full cut piece. */
export function explicitBoundaryMirrorAxis(piece: Piece, points: PointIndex) {
  if (piece.firstEdgeSymmetry || !piece.mainPaths.some((pp) => pp.isMirrorLine)) return null;
  return pieceMirrorAxis(piece, points);
}

/**
 * Expand legacy cut-on-fold pieces for the 2D canvas only. The underlying half-piece remains intact
 * for editing, saved simulation particles, and cloth topology.
 */
export function pieceDisplayOutline(
  pattern: Pattern,
  piece: Piece,
  paths: PathIndex = indexPaths(pattern),
  points: PointIndex = indexPoints(pattern),
  spacingMm = 4
): Vec2[] {
  let outline = pieceOutline(pattern, piece, paths, points, spacingMm);
  const axis = explicitBoundaryMirrorAxis(piece, points);
  if (axis) outline = mirrorHalfOutline(outline, axis.a, axis.b);
  const transform = pieceTransform(piece, points, pieceShrinkageScale(pattern, piece));
  return outline.map(transform);
}

/** Boundary strokes corresponding to a display-expanded outline, excluding its non-cut fold edge. */
export function pieceDisplayEdgePolylines(
  pattern: Pattern,
  piece: Piece,
  piecePath: Piece['mainPaths'][number],
  paths: PathIndex = indexPaths(pattern),
  points: PointIndex = indexPoints(pattern),
  spacingMm = 4
): Vec2[][] {
  const raw = piecePathPolyline(piecePath, paths, points, spacingMm);
  if (raw.length < 2) return [];
  const transform = pieceTransform(piece, points, pieceShrinkageScale(pattern, piece));
  const axis = explicitBoundaryMirrorAxis(piece, points);
  if (!axis) return [raw.map(transform)];
  if (piecePath.isMirrorLine) return [];
  return [
    raw.map(transform),
    raw.map((point) => reflectAcrossLine(point, axis.a, axis.b)).map(transform)
  ];
}
