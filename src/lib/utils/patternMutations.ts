// Cascading delete + reorder helpers — the single source of truth for structural edits to a
// Pattern. These mirror the original application's behaviour: deleting an object also removes the
// objects that can no longer exist without it (e.g. a seam whose sewn edge was deleted).
//
// All functions are pure: they take a Pattern and return a new Pattern (with hasChanged: true),
// never mutating the input. Use these from the Object browser, the 2D canvas and the Delete key
// handler so every deletion path behaves identically.

import type { Pattern } from '@seamer/pattern-model';

/** Drop every seam that references any of the given PiecePath ids on either side. */
function pruneSeams(seams: Pattern['seams'], removedPiecePathIds: Set<string>): Pattern['seams'] {
	if (removedPiecePathIds.size === 0) return seams;
	return seams.filter(
		(s) => ![...s.fromPaths, ...s.toPaths].some((r) => removedPiecePathIds.has(r.id))
	);
}

/** Delete a seam. (Nothing depends on a seam, so this is a plain removal.) */
export function deleteSeam(p: Pattern, id: string): Pattern {
	return { ...p, seams: p.seams.filter((s) => s.id !== id), hasChanged: true };
}

/** Delete a text annotation. */
export function deleteText(p: Pattern, id: string): Pattern {
	return { ...p, texts: p.texts.filter((t) => t.id !== id), hasChanged: true };
}

/**
 * Delete a piece. Cascades to any seam that sews one of this piece's edges, since that seam can no
 * longer be resolved once the piece (and its PiecePaths) are gone.
 */
export function deletePiece(p: Pattern, id: string): Pattern {
	const piece = p.pieces.find((x) => x.id === id);
	if (!piece) return p;
	const removed = new Set<string>([...piece.mainPaths, ...piece.internalPaths].map((pp) => pp.id));
	return {
		...p,
		pieces: p.pieces.filter((x) => x.id !== id),
		seams: pruneSeams(p.seams, removed),
		hasChanged: true
	};
}

/**
 * Delete a ConstrainablePath. Cascades to every PiecePath (boundary/internal edge) that drew its
 * geometry from this path, and to any seam that sewed one of those edges.
 */
export function deletePath(p: Pattern, pathId: string): Pattern {
	const removed = new Set<string>();
	const drop = (pp: { id: string; path: string }) => {
		if (pp.path === pathId) {
			removed.add(pp.id);
			return false;
		}
		return true;
	};
	const pieces = p.pieces.map((piece) => ({
		...piece,
		mainPaths: piece.mainPaths.filter(drop),
		internalPaths: piece.internalPaths.filter(drop)
	}));
	return {
		...p,
		paths: p.paths.filter((pa) => pa.id !== pathId),
		pieces,
		seams: pruneSeams(p.seams, removed),
		hasChanged: true
	};
}

/**
 * Delete a ConstrainablePoint. Cascades to: every path's pathPoints entry that used it, every
 * PiecePath whose endpoint (from/to) was this point, and any seam sewing one of those edges.
 */
export function deletePoint(p: Pattern, pointId: string): Pattern {
	const removed = new Set<string>();
	const drop = (pp: { id: string; from: string; to: string }) => {
		if (pp.from === pointId || pp.to === pointId) {
			removed.add(pp.id);
			return false;
		}
		return true;
	};
	const paths = p.paths.map((pa) => ({
		...pa,
		pathPoints: pa.pathPoints.filter((pt) => pt.id !== pointId)
	}));
	const pieces = p.pieces.map((piece) => ({
		...piece,
		mainPaths: piece.mainPaths.filter(drop),
		internalPaths: piece.internalPaths.filter(drop)
	}));
	return {
		...p,
		points: p.points.filter((pt) => pt.id !== pointId),
		paths,
		pieces,
		seams: pruneSeams(p.seams, removed),
		measurements: (p.measurements ?? []).filter((m) => m.fromPointId !== pointId && m.toPointId !== pointId && m.viaPointId !== pointId),
		hasChanged: true
	};
}

export type ReorderGroup = 'paths' | 'pieces' | 'points' | 'seams' | 'texts';

/** Move the item with id `fromId` to the position of `toId` within one top-level array. */
export function reorder(p: Pattern, group: ReorderGroup, fromId: string, toId: string): Pattern {
	if (fromId === toId) return p;
	const arr = [...(p[group] as { id: string }[])];
	const from = arr.findIndex((x) => x.id === fromId);
	const to = arr.findIndex((x) => x.id === toId);
	if (from < 0 || to < 0) return p;
	const [moved] = arr.splice(from, 1);
	arr.splice(to, 0, moved);
	return { ...p, [group]: arr, hasChanged: true } as Pattern;
}
