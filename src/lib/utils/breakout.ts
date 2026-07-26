// Piece "breakout" — explode a piece's resolved geometry into standalone construction paths,
// faithful to the original studio's piece.breakout (Dg1PbtmY.js). The original fits Bézier
// curves to each polyline; this rebuild emits decimated polyline `line` paths (editable,
// independent of the piece) placed at the piece's plan location. Modes select which layers of
// geometry are exploded:
//   all            → cut line + stitch (seam) outline + internal lines
//   seams          → stitch (seam) outline
//   cut            → cut line (seam-allowance polygon)
//   internal       → internal lines (darts / fold lines)
//   seamsInternal  → stitch outline + internal lines

import type { Pattern, ConstrainablePoint, ConstrainablePath } from '@seamer/pattern-model';
import {
	indexPaths,
	indexPoints,
	pieceWorldOutline,
	pieceWorldInternalPolylines,
	pieceAllowancePolygon,
	type Vec2
} from '@seamer/pattern-model';

export type BreakoutMode = 'all' | 'seams' | 'cut' | 'internal' | 'seamsInternal';

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;

/** Drop near-collinear interior vertices so an exploded polyline stays light + editable. */
function simplify(poly: Vec2[], tolMm = 1.5): Vec2[] {
	if (poly.length <= 2) return poly;
	const out: Vec2[] = [poly[0]];
	for (let i = 1; i < poly.length - 1; i++) {
		const a = out[out.length - 1], b = poly[i], c = poly[i + 1];
		const abx = b.x - a.x, aby = b.y - a.y, acx = c.x - a.x, acy = c.y - a.y;
		const cross = Math.abs(abx * acy - aby * acx);
		const len = Math.hypot(acx, acy) || 1;
		if (cross / len > tolMm) out.push(b); // b deviates from a→c by more than tol
	}
	out.push(poly[poly.length - 1]);
	return out;
}

export function breakoutPiece(pattern: Pattern, pieceId: string, mode: BreakoutMode = 'all'): Pattern | null {
	const piece = pattern.pieces.find((pc) => pc.id === pieceId);
	if (!piece) return null;
	const paths = indexPaths(pattern);
	const points = indexPoints(pattern);
	const layerId = pattern.currentLayerId;

	const polylines: { poly: Vec2[]; closed: boolean }[] = [];
	const wantStitch = mode === 'all' || mode === 'seams' || mode === 'seamsInternal';
	const wantCut = mode === 'all' || mode === 'cut';
	const wantInternal = mode === 'all' || mode === 'internal' || mode === 'seamsInternal';

	if (wantStitch) {
		const outline = pieceWorldOutline(pattern, piece, paths, points);
		if (outline.length >= 3) polylines.push({ poly: simplify(outline), closed: true });
	}
	if (wantCut) {
		const base = piece.seamAllowance ?? pattern.seamAllowance ?? 0;
		const signed = (piece.seamAllowanceInside ? -1 : 1) * base;
		const cut = pieceAllowancePolygon(pattern, piece, signed, paths, points);
		if (cut.length >= 3) polylines.push({ poly: simplify(cut), closed: true });
	}
	if (wantInternal) {
		for (const poly of pieceWorldInternalPolylines(pattern, piece, paths, points)) {
			if (poly.length >= 2) polylines.push({ poly: simplify(poly), closed: false });
		}
	}
	if (polylines.length === 0) return null;

	const newPoints: ConstrainablePoint[] = [];
	const newPaths: ConstrainablePath[] = [];
	let n = 0;
	for (const { poly, closed } of polylines) {
		// for a closed loop the sampler repeats the first vertex at the end — drop it, the path
		// is closed by referencing the first point id again.
		const verts = closed && poly.length > 1 && Math.hypot(poly[0].x - poly[poly.length - 1].x, poly[0].y - poly[poly.length - 1].y) < 0.5
			? poly.slice(0, -1)
			: poly;
		const ids = verts.map((v) => {
			const id = uid('ConstrainablePoint');
			newPoints.push({ id, name: `B${++n}`, x: v.x, y: v.y, layerId });
			return id;
		});
		const seq = closed ? [...ids, ids[0]] : ids;
		newPaths.push({
			id: uid('ConstrainablePath'),
			name: `${piece.name} breakout`,
			layerId,
			pathType: 'line',
			pathPoints: seq.map((id) => ({ id })),
			version: 1
		});
	}

	return {
		...pattern,
		points: [...pattern.points, ...newPoints],
		paths: [...pattern.paths, ...newPaths],
		hasChanged: true
	};
}
