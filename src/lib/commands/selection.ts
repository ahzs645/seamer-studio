// Selection batch transforms — move / rotate / scale / mirror a group of selected elements.
//
// The rebuild had marquee selection but only single-element edits; the original exposes
// selection.move/rotate/scale/mirror/moveToLayer/delete that act on the whole selection at once.
// These are the pure mutators behind those commands.
//
// Model: the movable atoms are *free* ConstrainablePoints (no parametric constraint — their x/y is
// authoritative) and Piece placements (position + rotation). Constrained points follow their
// formulas and are intentionally left untouched, exactly like dragging a single constrained point
// is a no-op. A transform is applied as an affine map about the selection centroid (mm space).

import type { Pattern, ConstrainablePoint } from '@seamer/pattern-model';
import { deletePoint, deletePath, deletePiece, deleteSeam, deleteText } from '$lib/utils/patternMutations';

export interface Selection {
  pointIds?: Iterable<string>;
  pathIds?: Iterable<string>;
  pieceIds?: Iterable<string>;
  seamIds?: Iterable<string>;
  textIds?: Iterable<string>;
}

type Vec = { x: number; y: number };

const DEG = Math.PI / 180;

/** The set of ConstrainablePoint ids in scope of a selection: explicitly selected points plus the
 *  anchor points of selected paths and the boundary points of selected pieces. */
export function selectionPointIds(p: Pattern, sel: Selection): Set<string> {
  const ids = new Set<string>(sel.pointIds ? [...sel.pointIds] : []);
  const pathSet = new Set(sel.pathIds ? [...sel.pathIds] : []);
  if (pathSet.size) {
    for (const path of p.paths) {
      if (!pathSet.has(path.id)) continue;
      for (const pp of path.pathPoints) ids.add(pp.id);
    }
  }
  const pieceSet = new Set(sel.pieceIds ? [...sel.pieceIds] : []);
  if (pieceSet.size) {
    const pathById = new Map(p.paths.map((pa) => [pa.id, pa] as const));
    for (const piece of p.pieces) {
      if (!pieceSet.has(piece.id)) continue;
      for (const pp of [...(piece.mainPaths ?? []), ...(piece.internalPaths ?? [])]) {
        ids.add(pp.from);
        ids.add(pp.to);
        const path = pathById.get(pp.path);
        if (path) for (const a of path.pathPoints) ids.add(a.id);
      }
    }
  }
  return ids;
}

/** Only points whose x/y we may rewrite directly (no constraint, or a plain fixed point). */
function movablePoints(p: Pattern, ids: Set<string>): ConstrainablePoint[] {
  return p.points.filter((pt) => ids.has(pt.id) && !pt.constraint);
}

/** Centroid of the movable points plus selected piece positions — the transform origin. */
function selectionCentroid(p: Pattern, sel: Selection, movable: ConstrainablePoint[]): Vec {
  const xs: number[] = movable.map((pt) => pt.x);
  const ys: number[] = movable.map((pt) => pt.y);
  const pieceSet = new Set(sel.pieceIds ? [...sel.pieceIds] : []);
  for (const piece of p.pieces) {
    if (!pieceSet.has(piece.id)) continue;
    xs.push(piece.position.x);
    ys.push(piece.position.y);
  }
  if (xs.length === 0) return { x: 0, y: 0 };
  return { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length };
}

function applyAffine(
  p: Pattern,
  sel: Selection,
  mapPoint: (v: Vec) => Vec,
  mapPiece: (pieceRotation: number) => number,
  togglePieceMirror?: 'X' | 'Y'
): Pattern {
  const ids = selectionPointIds(p, sel);
  const movable = new Set(movablePoints(p, ids).map((pt) => pt.id));
  if (movable.size === 0 && !(sel.pieceIds && [...sel.pieceIds].length)) return p;
  const points = p.points.map((pt) => (movable.has(pt.id) ? { ...pt, ...mapPoint(pt) } : pt));
  const pieceSet = new Set(sel.pieceIds ? [...sel.pieceIds] : []);
  const pieces = p.pieces.map((piece) => {
    if (!pieceSet.has(piece.id)) return piece;
    const position = mapPoint(piece.position);
    const next = { ...piece, position, rotation: mapPiece(piece.rotation) };
    if (togglePieceMirror === 'X') next.mirrorX = !piece.mirrorX;
    if (togglePieceMirror === 'Y') next.mirrorY = !piece.mirrorY;
    return next;
  });
  return { ...p, points, pieces, hasChanged: true };
}

/** Translate the selection by (dx, dy) mm. */
export function selectionMove(p: Pattern, sel: Selection, dx: number, dy: number): Pattern {
  if (dx === 0 && dy === 0) return p;
  return applyAffine(p, sel, (v) => ({ x: v.x + dx, y: v.y + dy }), (r) => r);
}

/** Rotate the selection by `degrees` about its centroid (CCW positive). */
export function selectionRotate(p: Pattern, sel: Selection, degrees: number, about?: Vec): Pattern {
  if (degrees % 360 === 0) return p;
  const movable = movablePoints(p, selectionPointIds(p, sel));
  const c = about ?? selectionCentroid(p, sel, movable);
  const a = degrees * DEG;
  const cos = Math.cos(a), sin = Math.sin(a);
  const rot = (v: Vec): Vec => {
    const ox = v.x - c.x, oy = v.y - c.y;
    return { x: c.x + ox * cos - oy * sin, y: c.y + ox * sin + oy * cos };
  };
  return applyAffine(p, sel, rot, (r) => r + degrees);
}

/** Scale the selection by `fx`,`fy` about its centroid (uniform when fy omitted). */
export function selectionScale(p: Pattern, sel: Selection, fx: number, fy = fx, about?: Vec): Pattern {
  if (fx === 1 && fy === 1) return p;
  const movable = movablePoints(p, selectionPointIds(p, sel));
  const c = about ?? selectionCentroid(p, sel, movable);
  const scale = (v: Vec): Vec => ({ x: c.x + (v.x - c.x) * fx, y: c.y + (v.y - c.y) * fy });
  return applyAffine(p, sel, scale, (r) => r);
}

/** Mirror the selection across its centroid on the x or y axis. */
export function selectionMirror(p: Pattern, sel: Selection, axis: 'x' | 'y', about?: Vec): Pattern {
  const movable = movablePoints(p, selectionPointIds(p, sel));
  const c = about ?? selectionCentroid(p, sel, movable);
  // mirror "on the x axis" flips the y coordinate (reflection across the horizontal axis), matching
  // the source's selection.mirror semantics.
  const flip = (v: Vec): Vec => (axis === 'x' ? { x: v.x, y: 2 * c.y - v.y } : { x: 2 * c.x - v.x, y: v.y });
  return applyAffine(p, sel, flip, (r) => -r, axis === 'x' ? 'Y' : 'X');
}

/** Reassign every element in the selection to a layer. */
export function selectionMoveToLayer(p: Pattern, sel: Selection, layerId: string): Pattern {
  const pointSet = new Set(sel.pointIds ? [...sel.pointIds] : []);
  const pathSet = new Set(sel.pathIds ? [...sel.pathIds] : []);
  const pieceSet = new Set(sel.pieceIds ? [...sel.pieceIds] : []);
  return {
    ...p,
    points: p.points.map((pt) => (pointSet.has(pt.id) ? { ...pt, layerId } : pt)),
    paths: p.paths.map((pa) => (pathSet.has(pa.id) ? { ...pa, layerId } : pa)),
    pieces: p.pieces.map((pc) => (pieceSet.has(pc.id) ? { ...pc, layerId } : pc)),
    hasChanged: true
  };
}

/** Delete every element in the selection, cascading through the shared mutators. */
export function selectionDelete(p: Pattern, sel: Selection): Pattern {
  let next = p;
  for (const id of sel.seamIds ?? []) next = deleteSeam(next, id);
  for (const id of sel.textIds ?? []) next = deleteText(next, id);
  for (const id of sel.pieceIds ?? []) next = deletePiece(next, id);
  for (const id of sel.pathIds ?? []) next = deletePath(next, id);
  for (const id of sel.pointIds ?? []) next = deletePoint(next, id);
  return next;
}
