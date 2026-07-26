// Point/path topology edits — split, merge, disconnect, release, and line/curve-point
// conversions. These are faithful ports of the original studio's context-menu operations
// (Dg1PbtmY.js: splitCurveAtPoint / splitLineAtPoint / mergeCurvesAtPoint / mergeLinesAtPoint /
// convertToCurvePoint / convertToSlidingPoint / disconnectPaths, and replaceSplitPathInPieces),
// re-expressed for this rebuild's id-referenced, immutable data model.
//
// Every operation is pure: it takes a Pattern and returns a NEW Pattern with hasChanged:true,
// or null when the operation does not apply to the given point. The predicates mirror the
// originals (canBeConverted / canSplitCurve / …) and gate the context-menu items.

import type { Pattern, ConstrainablePath, ConstrainablePoint, PathPoint, BezierHandle, PiecePath, Piece } from '@seamer/pattern-model';

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;

// ---- small model helpers ---------------------------------------------------

function anchorIndex(path: ConstrainablePath, pointId: string): number {
	return path.pathPoints.findIndex((pp) => pp.id === pointId);
}
function isAnchor(path: ConstrainablePath, pointId: string): boolean {
	return path.pathPoints.some((pp) => pp.id === pointId);
}
function isSlidingOn(path: ConstrainablePath, pointId: string): boolean {
	return !!path.slidingPoints?.some((sp) => sp.id === pointId);
}
function isInteriorAnchor(path: ConstrainablePath, pointId: string): boolean {
	const i = anchorIndex(path, pointId);
	return i > 0 && i < path.pathPoints.length - 1;
}
/** Paths on which the point participates as an anchor. */
function anchorPaths(p: Pattern, pointId: string): ConstrainablePath[] {
	return p.paths.filter((pa) => isAnchor(pa, pointId));
}
/** Paths on which the point participates either as an anchor or as a sliding point. */
function pathsAtPoint(p: Pattern, pointId: string): ConstrainablePath[] {
	return p.paths.filter((pa) => isAnchor(pa, pointId) || isSlidingOn(pa, pointId));
}
function coordOf(p: Pattern, pointId: string): { x: number; y: number } | null {
	const pt = p.points.find((q) => q.id === pointId);
	return pt ? { x: pt.x, y: pt.y } : null;
}
function flatHandle(v1: { x: number; y: number }, v2: { x: number; y: number }): BezierHandle {
	return { v1, v2, sameLength: true, sameAngle: true, lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' } };
}
function bumpVersion(path: ConstrainablePath): ConstrainablePath {
	return { ...path, version: (path.version ?? 1) + 1 };
}

/**
 * Apply a Bézier point's mirror constraints when one of its two tangent handles is moved to `newV`
 * (anchor-relative). Ports the original's handle mirror settings (`sameLength` / `sameAngle`):
 * - both: the opposite handle becomes the exact negation (full point-symmetric handle).
 * - sameAngle only: the opposite handle keeps its own length but points the opposite direction.
 * - sameLength only: the opposite handle keeps its direction but matches the new length.
 * - neither: the opposite handle is left untouched.
 * Returns a NEW handle (preserving lengthFormula/angleFormula and the flags).
 */
export function applyHandleConstraint(h: BezierHandle, which: 'v1' | 'v2', newV: { x: number; y: number }): BezierHandle {
	const otherKey = which === 'v1' ? 'v2' : 'v1';
	const other = otherKey === 'v1' ? h.v1 : h.v2;
	const nl = Math.hypot(newV.x, newV.y);
	let mirrored = { x: other.x, y: other.y };
	if (h.sameAngle && h.sameLength) {
		mirrored = { x: -newV.x, y: -newV.y };
	} else if (h.sameAngle) {
		const ol = Math.hypot(other.x, other.y);
		if (nl > 1e-9) mirrored = { x: (-newV.x / nl) * ol, y: (-newV.y / nl) * ol };
	} else if (h.sameLength) {
		const ol = Math.hypot(other.x, other.y);
		if (ol > 1e-9) mirrored = { x: (other.x / ol) * nl, y: (other.y / ol) * nl };
	}
	const set = { x: newV.x, y: newV.y };
	return { ...h, v1: which === 'v1' ? set : mirrored, v2: which === 'v2' ? set : mirrored };
}

// ---- predicates (context-menu visibility) ----------------------------------

/** Point is a sliding point on a curve path → can be promoted to a curve anchor. */
export function canConvertToCurvePoint(p: Pattern, pointId: string): boolean {
	return pathsAtPoint(p, pointId).some((pa) => pa.pathType === 'curve' && isSlidingOn(pa, pointId));
}
/** Point is an interior anchor of a curve path → can be demoted to a sliding point. */
export function canConvertToSlidingPoint(p: Pattern, pointId: string): boolean {
	return p.paths.some((pa) => pa.pathType === 'curve' && isInteriorAnchor(pa, pointId));
}
/** Point is a sliding point on any path. */
export function isSlidingPointAnywhere(p: Pattern, pointId: string): boolean {
	return p.paths.some((pa) => isSlidingOn(pa, pointId));
}
/** Point is used as an anchor by more than one path (a join). */
export function canDisconnectPaths(p: Pattern, pointId: string): boolean {
	return anchorPaths(p, pointId).length > 1;
}
/** Point is an interior anchor of a curve path. */
export function canSplitCurve(p: Pattern, pointId: string): boolean {
	return p.paths.some((pa) => pa.pathType === 'curve' && isInteriorAnchor(pa, pointId));
}
/** Point is a sliding point on, or an interior anchor of, a line path. */
export function canSplitLine(p: Pattern, pointId: string): boolean {
	return p.paths.some((pa) => pa.pathType === 'line' && (isSlidingOn(pa, pointId) || isInteriorAnchor(pa, pointId)));
}
/** Point is a shared anchor of more than one curve path. */
export function canMergeCurves(p: Pattern, pointId: string): boolean {
	return anchorPaths(p, pointId).filter((pa) => pa.pathType === 'curve').length > 1;
}
/** Point is a shared anchor of more than one line path. */
export function canMergeLines(p: Pattern, pointId: string): boolean {
	return anchorPaths(p, pointId).filter((pa) => pa.pathType === 'line').length > 1;
}
/** Paths from which a sliding point can be released, for the per-path submenu. */
export function slidingHostPaths(p: Pattern, pointId: string): ConstrainablePath[] {
	return p.paths.filter((pa) => isSlidingOn(pa, pointId));
}
/** Paths a joined anchor point can be disconnected from, for the per-path submenu. */
export function disconnectHostPaths(p: Pattern, pointId: string): ConstrainablePath[] {
	return anchorPaths(p, pointId);
}

// ---- piece-edge reassignment after a split --------------------------------
// Faithful port of replaceSplitPathInPieces. After path `oldId` was cut at `splitPointId`
// into `oldId` (points up to the split) and `newId` (points from the split on), every piece
// edge that referenced `oldId` is reassigned to whichever sub-path now carries its span — or
// split into two edges when it straddles the cut.

function reassignSplitEdges(
	pieces: Piece[],
	oldId: string,
	oldPts: Set<string>,
	newId: string,
	newPts: Set<string>,
	splitPointId: string
): Piece[] {
	const side = (pid: string): 'old' | 'new' | null => {
		if (pid === splitPointId) return null;
		const inOld = oldPts.has(pid);
		const inNew = newPts.has(pid);
		if (inOld && !inNew) return 'old';
		if (inNew && !inOld) return 'new';
		if (inOld) return 'old';
		if (inNew) return 'new';
		return null;
	};
	const fix = (list: PiecePath[]): PiecePath[] => {
		const out: PiecePath[] = [];
		for (const pp of list) {
			if (pp.path !== oldId) { out.push(pp); continue; }
			const from = pp.from, to = pp.to;
			const sFrom = side(from), sTo = side(to);
			const fromIsSplit = from === splitPointId, toIsSplit = to === splitPointId;
			if (fromIsSplit && !toIsSplit) {
				out.push(sTo ? { ...pp, path: sTo === 'old' ? oldId : newId } : pp);
				continue;
			}
			if (toIsSplit && !fromIsSplit) {
				out.push(sFrom ? { ...pp, path: sFrom === 'old' ? oldId : newId } : pp);
				continue;
			}
			if (!sFrom || !sTo) { out.push(pp); continue; }
			if (sFrom === sTo) {
				out.push({ ...pp, path: sFrom === 'old' ? oldId : newId });
				continue;
			}
			// straddles the cut: split into [from→split] and [split→to]
			const a: PiecePath = { ...pp, path: sFrom === 'old' ? oldId : newId, from, to: splitPointId };
			const b: PiecePath = { ...pp, id: uid('PiecePath'), path: sFrom === 'old' ? newId : oldId, from: splitPointId, to };
			out.push(a, b);
		}
		return out;
	};
	return pieces.map((pc) => ({ ...pc, mainPaths: fix(pc.mainPaths), internalPaths: fix(pc.internalPaths) }));
}

/** Repoint piece edges that named `oldId` to `newId` (used after a merge). */
function replacePathInPieces(pieces: Piece[], oldId: string, newId: string): Piece[] {
	const fix = (list: PiecePath[]) => list.map((pp) => (pp.path === oldId ? { ...pp, path: newId } : pp));
	return pieces.map((pc) => ({ ...pc, mainPaths: fix(pc.mainPaths), internalPaths: fix(pc.internalPaths) }));
}

// ---- split -----------------------------------------------------------------

/** Split a path at an interior anchor `s`: keep points[0..s] on the original, move points[s..end]
 *  to a new path of the same type (sharing the anchor at the cut). Bézier handle on the cut point
 *  is preserved on both sides. Reassigns piece edges. */
function splitAt(p: Pattern, path: ConstrainablePath, pointId: string): Pattern | null {
	const s = anchorIndex(path, pointId);
	if (s <= 0 || s >= path.pathPoints.length - 1) return null;
	const head = path.pathPoints.slice(0, s + 1);
	const tail = path.pathPoints.slice(s); // begins with the shared cut point
	const oldPath: ConstrainablePath = bumpVersion({ ...path, pathPoints: head });
	const newPath: ConstrainablePath = {
		...path,
		id: uid('ConstrainablePath'),
		name: path.name ? `${path.name}_split` : '',
		pathPoints: tail.map((pp) => ({ ...pp })),
		version: 1
	};
	const paths = p.paths.map((pa) => (pa.id === path.id ? oldPath : pa)).concat(newPath);
	const oldPts = new Set(head.map((pp) => pp.id));
	const newPts = new Set(tail.map((pp) => pp.id));
	const pieces = reassignSplitEdges(p.pieces, path.id, oldPts, newPath.id, newPts, pointId);
	return { ...p, paths, pieces, hasChanged: true };
}

export function splitCurveAtPoint(p: Pattern, pointId: string): Pattern | null {
	const path = p.paths.find((pa) => pa.pathType === 'curve' && isInteriorAnchor(pa, pointId));
	return path ? splitAt(p, path, pointId) : null;
}

export function splitLineAtPoint(p: Pattern, pointId: string): Pattern | null {
	// interior anchor → straightforward split
	const anchorPath = p.paths.find((pa) => pa.pathType === 'line' && isInteriorAnchor(pa, pointId));
	if (anchorPath) return splitAt(p, anchorPath, pointId);
	// sliding point on a line → promote it to a shared endpoint anchor first, then split there
	const slidePath = p.paths.find((pa) => pa.pathType === 'line' && isSlidingOn(pa, pointId));
	if (!slidePath) return null;
	const promoted = insertSlidingAsAnchor(p, slidePath, pointId);
	if (!promoted) return null;
	const path2 = promoted.paths.find((pa) => pa.id === slidePath.id);
	return path2 ? splitAt(promoted, path2, pointId) : null;
}

// ---- merge -----------------------------------------------------------------

/** Merge the first two same-type paths that share `pointId` as an anchor into one path. */
function mergeAt(p: Pattern, pathType: 'line' | 'curve', pointId: string): Pattern | null {
	const cands = anchorPaths(p, pointId).filter((pa) => pa.pathType === pathType);
	if (cands.length < 2) return null;
	let a = cands[0];
	let b = cands[1];
	const ends = (pa: ConstrainablePath) => ({ first: pa.pathPoints[0]?.id, last: pa.pathPoints[pa.pathPoints.length - 1]?.id });
	let ea = ends(a), eb = ends(b);
	// orient so a.last === b.first (chain a → b through the shared point)
	const reverse = (pa: ConstrainablePath): ConstrainablePath => ({
		...pa,
		pathPoints: pa.pathPoints.slice().reverse().map((pp) => (pp.handle ? { ...pp, handle: { ...pp.handle, v1: pp.handle.v2, v2: pp.handle.v1 } } : pp))
	});
	if (eb.last === ea.last || eb.first === ea.first) { b = reverse(b); eb = ends(b); }
	if (ea.first === eb.last) { const t = a; a = b; b = t; const te = ea; ea = eb; eb = te; }
	if (ea.last !== eb.first) return null; // not actually adjacent at this point
	const merged: ConstrainablePath = bumpVersion({
		...a,
		pathPoints: [...a.pathPoints, ...b.pathPoints.slice(1).map((pp) => ({ ...pp }))],
		slidingPoints: [...(a.slidingPoints ?? []), ...(b.slidingPoints ?? [])]
	});
	const paths = p.paths.filter((pa) => pa.id !== b.id).map((pa) => (pa.id === a.id ? merged : pa));
	const pieces = replacePathInPieces(p.pieces, b.id, a.id);
	// drop seams referencing edges on the now-deleted path's piece refs? edges were repointed, keep seams.
	return { ...p, paths, pieces, hasChanged: true };
}

export function mergeCurvesAtPoint(p: Pattern, pointId: string): Pattern | null {
	return mergeAt(p, 'curve', pointId);
}
export function mergeLinesAtPoint(p: Pattern, pointId: string): Pattern | null {
	return mergeAt(p, 'line', pointId);
}

// ---- disconnect ------------------------------------------------------------

/** Split a joined anchor point so the named path (or, by default, the second sharer) gets its own
 *  fresh point at the same coordinates. Piece edges on that path that named the point follow it. */
export function disconnectPaths(p: Pattern, pointId: string, pathId?: string): Pattern | null {
	const hosts = anchorPaths(p, pointId);
	if (hosts.length < 2) return null;
	const target = pathId ? hosts.find((h) => h.id === pathId) : hosts[1];
	if (!target) return null;
	const coord = coordOf(p, pointId);
	if (!coord) return null;
	const src = p.points.find((q) => q.id === pointId)!;
	const fresh: ConstrainablePoint = { id: uid('ConstrainablePoint'), name: src.name, x: coord.x, y: coord.y, layerId: src.layerId };
	const paths = p.paths.map((pa) =>
		pa.id === target.id
			? bumpVersion({ ...pa, pathPoints: pa.pathPoints.map((pp) => (pp.id === pointId ? { ...pp, id: fresh.id } : pp)) })
			: pa
	);
	const repoint = (list: PiecePath[]) =>
		list.map((pp) => (pp.path === target.id ? { ...pp, from: pp.from === pointId ? fresh.id : pp.from, to: pp.to === pointId ? fresh.id : pp.to } : pp));
	const pieces = p.pieces.map((pc) => ({ ...pc, mainPaths: repoint(pc.mainPaths), internalPaths: repoint(pc.internalPaths) }));
	return { ...p, points: [...p.points, fresh], paths, pieces, hasChanged: true };
}

// ---- release sliding point -------------------------------------------------

/** Release a sliding point from the named path, or from every host path when no path is given.
 *  The point stays in the pattern as a free construction point. */
export function releaseSlidingPoint(p: Pattern, pointId: string, pathId?: string): Pattern | null {
	const hosts = slidingHostPaths(p, pointId);
	if (hosts.length === 0) return null;
	const targets = new Set(pathId ? [pathId] : hosts.map((h) => h.id));
	const paths = p.paths.map((pa) =>
		targets.has(pa.id) && isSlidingOn(pa, pointId)
			? bumpVersion({ ...pa, slidingPoints: (pa.slidingPoints ?? []).filter((sp) => sp.id !== pointId) })
			: pa
	);
	return { ...p, paths, hasChanged: true };
}

// ---- line ↔ curve point conversions ---------------------------------------

/** Project a sliding point onto the anchor polyline and return the index of the anchor it follows
 *  (insert the new anchor immediately after this index) plus the local segment direction. */
function locateOnAnchors(p: Pattern, path: ConstrainablePath, pointId: string): { afterIndex: number; dir: { x: number; y: number } } | null {
	const pt = coordOf(p, pointId);
	if (!pt) return null;
	const anchors = path.pathPoints.map((pp) => coordOf(p, pp.id)).filter((c): c is { x: number; y: number } => !!c);
	if (anchors.length < 2) return null;
	let best = 0, bestD = Infinity, bestDir = { x: 1, y: 0 };
	for (let i = 1; i < anchors.length; i++) {
		const a = anchors[i - 1], b = anchors[i];
		const dx = b.x - a.x, dy = b.y - a.y;
		const l2 = dx * dx + dy * dy || 1;
		let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2;
		t = Math.max(0, Math.min(1, t));
		const px = a.x + t * dx, py = a.y + t * dy;
		const d = Math.hypot(pt.x - px, pt.y - py);
		if (d < bestD) { bestD = d; best = i - 1; const len = Math.hypot(dx, dy) || 1; bestDir = { x: dx / len, y: dy / len }; }
	}
	return { afterIndex: best, dir: bestDir };
}

/** Promote a sliding point on `path` into an anchor at its natural place along the polyline. */
function insertSlidingAsAnchor(p: Pattern, path: ConstrainablePath, pointId: string, withHandle = false): Pattern | null {
	const loc = locateOnAnchors(p, path, pointId);
	if (!loc) return null;
	const pp: PathPoint = { id: pointId };
	if (withHandle) {
		// tangent scaled like the original: length / (numPoints * 4), approximated per segment
		const k = 12; // mm — modest handle so the curve point is visibly editable
		pp.handle = flatHandle({ x: -loc.dir.x * k, y: -loc.dir.y * k }, { x: loc.dir.x * k, y: loc.dir.y * k });
	}
	const pathPoints = path.pathPoints.slice();
	pathPoints.splice(loc.afterIndex + 1, 0, pp);
	const updated = bumpVersion({ ...path, pathPoints, slidingPoints: (path.slidingPoints ?? []).filter((sp) => sp.id !== pointId) });
	const paths = p.paths.map((pa) => (pa.id === path.id ? updated : pa));
	return { ...p, paths, hasChanged: true };
}

/** Convert a sliding point on a curve into a real curve anchor (with a tangent handle). */
export function convertToCurvePoint(p: Pattern, pointId: string): Pattern | null {
	const path = p.paths.find((pa) => pa.pathType === 'curve' && isSlidingOn(pa, pointId));
	if (!path) return null;
	return insertSlidingAsAnchor(p, path, pointId, true);
}

/** Convert an interior curve anchor into a sliding point on that curve. */
export function convertToSlidingPoint(p: Pattern, pointId: string): Pattern | null {
	const path = p.paths.find((pa) => pa.pathType === 'curve' && isInteriorAnchor(pa, pointId));
	if (!path) return null;
	const updated = bumpVersion({
		...path,
		pathPoints: path.pathPoints.filter((pp) => pp.id !== pointId),
		slidingPoints: [...(path.slidingPoints ?? []), { id: pointId, positionType: 'along' as const }]
	});
	const paths = p.paths.map((pa) => (pa.id === path.id ? updated : pa));
	return { ...p, paths, hasChanged: true };
}
