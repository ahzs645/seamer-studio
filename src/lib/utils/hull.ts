// Cut-off boundary shapes for a set of 2D points — the three "cut-off type" options the original
// studio's 2D nesting/cutting offered (ConvexHull / ConcaveHull / BoundingBox, via the concaveman
// library). Re-implemented here dependency-free and pure, so the rebuild can compute a wrap
// boundary around nested/placed pieces for cutting without the server-backed cutting room.

import { bounds, convexHull, type Vec2 } from '@atelier/geometry';

export type Pt = Vec2;
export { convexHull };

/** Axis-aligned bounding box as a closed 5-point polygon (last === first). */
export function boundingBox(points: Pt[]): Pt[] {
	if (points.length === 0) return [];
	const { minX, minY, maxX, maxY } = bounds(points);
	return [
		{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }, { x: minX, y: minY }
	];
}

const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

const dist2 = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Do open segments p1-p2 and p3-p4 properly intersect (excluding shared endpoints)? */
function segmentsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
	const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
	return false;
}

/**
 * Concave hull by edge-digging: start from the convex hull, then repeatedly replace the longest
 * boundary edge with a detour through the nearest unused interior point when that point is closer
 * to the edge than `concavity` × edge-length and the detour introduces no self-intersection.
 * `concavity` ≥ 1; larger → closer to the convex hull. Returns a closed polygon (last === first).
 */
export function concaveHull(points: Pt[], concavity = 2, lengthThreshold = 0): Pt[] {
	const hull = convexHull(points);
	if (hull.length < 3) return hull.length ? [...hull, hull[0]] : [];
	const onHull = new Set(hull.map((p) => `${p.x},${p.y}`));
	const interior = points.filter((p) => !onHull.has(`${p.x},${p.y}`));
	const poly = hull.slice();
	let changed = true;
	let guard = points.length * 4;
	while (changed && guard-- > 0) {
		changed = false;
		// process edges longest-first
		const order = poly.map((_, i) => i).sort((a, b) => dist2(poly[b], poly[(b + 1) % poly.length]) - dist2(poly[a], poly[(a + 1) % poly.length]));
		for (const i of order) {
			const a = poly[i], b = poly[(i + 1) % poly.length];
			const edgeLen = Math.sqrt(dist2(a, b));
			if (edgeLen < lengthThreshold) continue;
			// nearest interior point to the edge midpoint
			let best = -1, bestD = Infinity;
			for (let k = 0; k < interior.length; k++) {
				const d = Math.min(dist2(interior[k], a), dist2(interior[k], b));
				if (d < bestD) { bestD = d; best = k; }
			}
			if (best < 0) continue;
			const c = interior[best];
			const decision = edgeLen / Math.sqrt(bestD);
			if (decision <= concavity) continue; // dent not deep enough
			// reject if the new edges a-c or c-b cross any existing edge
			let crosses = false;
			for (let j = 0; j < poly.length && !crosses; j++) {
				const s = poly[j], t = poly[(j + 1) % poly.length];
				if (segmentsIntersect(a, c, s, t) || segmentsIntersect(c, b, s, t)) crosses = true;
			}
			if (crosses) continue;
			poly.splice(i + 1, 0, c);
			interior.splice(best, 1);
			changed = true;
			break;
		}
	}
	return [...poly, poly[0]];
}
