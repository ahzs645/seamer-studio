// Generic element operations addressed by element id, independent of element kind.
//
// The original exposes element.bringToFront / sendToBack / moveToLayer / rename / delete that work
// on "any resolvable element". The rebuild had these only ad-hoc per type (pieces reorder via array
// order; paths/pieces move to layers from the canvas menu). These helpers unify them: draw order is
// the array order of `paths` and `pieces` (later = drawn on top), so bring-to-front = move to the
// end of its array, send-to-back = move to the start.

import type { Pattern } from '@seamer/pattern-model';
import { deletePoint, deletePath, deletePiece, deleteSeam, deleteText } from '$lib/utils/patternMutations';

export type ElementKind = 'point' | 'path' | 'piece' | 'seam' | 'text';

/** Classify an element id by which top-level array owns it. */
export function elementKind(p: Pattern, id: string): ElementKind | null {
  if (p.points.some((x) => x.id === id)) return 'point';
  if (p.paths.some((x) => x.id === id)) return 'path';
  if (p.pieces.some((x) => x.id === id)) return 'piece';
  if (p.seams.some((x) => x.id === id)) return 'seam';
  if (p.texts.some((x) => x.id === id)) return 'text';
  return null;
}

function reorderArray<T extends { id: string }>(arr: T[], id: string, to: 'front' | 'back'): T[] {
  const item = arr.find((x) => x.id === id);
  if (!item) return arr;
  const rest = arr.filter((x) => x.id !== id);
  return to === 'front' ? [...rest, item] : [item, ...rest];
}

/** Move a path or piece to the front (drawn last/on top) or back of its draw order. */
export function elementSetOrder(p: Pattern, id: string, to: 'front' | 'back'): Pattern {
  const kind = elementKind(p, id);
  if (kind === 'piece') return { ...p, pieces: reorderArray(p.pieces, id, to), hasChanged: true };
  if (kind === 'path') return { ...p, paths: reorderArray(p.paths, id, to), hasChanged: true };
  return p; // points/seams/texts have no meaningful draw order
}

export const elementBringToFront = (p: Pattern, id: string) => elementSetOrder(p, id, 'front');
export const elementSendToBack = (p: Pattern, id: string) => elementSetOrder(p, id, 'back');

/** Rename any nameable element. */
export function elementRename(p: Pattern, id: string, name: string): Pattern {
  const kind = elementKind(p, id);
  switch (kind) {
    case 'point':
      return { ...p, points: p.points.map((x) => (x.id === id ? { ...x, name } : x)), hasChanged: true };
    case 'path':
      return { ...p, paths: p.paths.map((x) => (x.id === id ? { ...x, name } : x)), hasChanged: true };
    case 'piece':
      return { ...p, pieces: p.pieces.map((x) => (x.id === id ? { ...x, name } : x)), hasChanged: true };
    case 'seam':
      return { ...p, seams: p.seams.map((x) => (x.id === id ? { ...x, name } : x)), hasChanged: true };
    default:
      return p;
  }
}

/** Assign any layer-addressable element (point / path / piece / text) to a layer. */
export function elementMoveToLayer(p: Pattern, id: string, layerId: string): Pattern {
  const kind = elementKind(p, id);
  switch (kind) {
    case 'point':
      return { ...p, points: p.points.map((x) => (x.id === id ? { ...x, layerId } : x)), hasChanged: true };
    case 'path':
      return { ...p, paths: p.paths.map((x) => (x.id === id ? { ...x, layerId } : x)), hasChanged: true };
    case 'piece':
      return { ...p, pieces: p.pieces.map((x) => (x.id === id ? { ...x, layerId } : x)), hasChanged: true };
    case 'text':
      return { ...p, texts: p.texts.map((x) => (x.id === id ? { ...x, layerId } : x)), hasChanged: true };
    default:
      return p;
  }
}

/** Delete any single element by id, cascading via the shared mutators. */
export function elementDelete(p: Pattern, id: string): Pattern {
  switch (elementKind(p, id)) {
    case 'point': return deletePoint(p, id);
    case 'path': return deletePath(p, id);
    case 'piece': return deletePiece(p, id);
    case 'seam': return deleteSeam(p, id);
    case 'text': return deleteText(p, id);
    default: return p;
  }
}
