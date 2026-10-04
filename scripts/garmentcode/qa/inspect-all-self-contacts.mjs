import { readFrozenSample } from './frozen-sample.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import * as T from 'three';
const f = await readFrozenSample(process.argv[2]), r = JSON.parse(await readFile(process.argv[3], 'utf8')), p = f.clothPositions;
const V = i => new T.Vector3().fromArray(p, i * 4), owner = i => f.pieces.find(x => i >= x.start && i < x.start + x.count)?.pieceId, name = id => f.pattern.pieces.find(x => x.id === id)?.name;
const neighbors = new Map();
for (let i = 0; i < f.clothTriangles.length; i += 4) {
    const ids = f.clothTriangles.slice(i, i + 3);
    for (const a of ids) {
        if (!neighbors.has(a))
            neighbors.set(a, new Set());
        for (const b of ids)
            neighbors.get(a).add(b);
    }
}
const ray = new T.Ray(), hit = new T.Vector3(), delta = new T.Vector3();
function crosses(a, b, t) {
    delta.subVectors(b, a);
    const length = delta.length();
    if (length < 1e-8)
        return null;
    ray.set(a, delta.normalize());
    if (ray.intersectTriangle(t.a, t.b, t.c, false, hit) && hit.distanceTo(a) > 1e-6 && hit.distanceTo(a) < length - 1e-6)
        return hit.clone();
    return null;
}
const seamToleranceMm = 5, closureToleranceMm = 3;
const rows = [];
for (const c of r.selfCrossingCandidates) {
    const ids = c.faces.map(i => f.clothTriangles.slice(i * 4, i * 4 + 3)), owners = ids.map(a => owner(a[0])), tris = ids.map(a => new T.Triangle(...a.map(V))), normals = tris.map(t => t.getNormal(new T.Vector3()));
    const points = [];
    for (let j = 0; j < 2; j++)
        for (const [a, b] of [[tris[j].a, tris[j].b], [tris[j].b, tris[j].c], [tris[j].c, tris[j].a]]) {
            const q = crosses(a, b, tris[1 - j]);
            if (q && !points.some(x => x.distanceTo(q) < 1e-7))
                points.push(q);
        }
    const adjacent = [];
    for (const s of f.seamPairs) {
        const matching = s.pairs.some((a, i) => i % 2 === 0 && ((owner(a) === owners[0] && owner(s.pairs[i + 1]) === owners[1]) || (owner(a) === owners[1] && owner(s.pairs[i + 1]) === owners[0])));
        if (!matching)
            continue;
        let gap = 0, direct = false, oneHop = false;
        const sides = [[], []], n = ids.map(a => new Set(a.flatMap(x => [...(neighbors.get(x) || [])])));
        for (let i = 0; i < s.pairs.length; i += 2) {
            const a = s.pairs[i], b = s.pairs[i + 1];
            sides[0].push(V(a));
            sides[1].push(V(b));
            gap = Math.max(gap, V(a).distanceTo(V(b)) * 1000);
            direct ||= (ids[0].includes(a) && ids[1].includes(b)) || (ids[0].includes(b) && ids[1].includes(a));
            oneHop ||= (n[0].has(a) && n[1].has(b)) || (n[0].has(b) && n[1].has(a));
        }
        const distances = points.map(at => sides.map(side => {
            let min = Infinity;
            for (let i = 1; i < side.length; i++) {
                new T.Line3(side[i - 1], side[i]).closestPointToPoint(at, true, hit);
                min = Math.min(min, at.distanceTo(hit) * 1000);
            }
            return min;
        }));
        const maxBothSideDistanceMm = Math.max(...distances.flat());
        adjacent.push({ seamId: s.seamId, maxSeamGapMm: gap, directSeamPairedTriangle: direct, oneRingSeamPairedTriangle: oneHop, maxBothSideDistanceMm, allIntersectionEndpointsWithinSeamNeighborhood: oneHop && maxBothSideDistanceMm <= seamToleranceMm, closedWithinTolerance: gap <= closureToleranceMm });
    }
    const near = adjacent.some(s => s.allIntersectionEndpointsWithinSeamNeighborhood), closed = adjacent.some(s => s.allIntersectionEndpointsWithinSeamNeighborhood && s.closedWithinTolerance);
    rows.push({ ...c, pieces: owners.map(name), intersectionEndpoints: points.map(p => p.toArray()), normalDot: normals[0].dot(normals[1]), adjacentSeams: adjacent, classification: closed ? 'closed paired-seam contact' : near ? 'paired-seam contact before closure' : 'cloth-face penetration outside paired-seam contact neighborhood' });
}
const summary = { fixture: process.argv[2], seamNeighborhoodMm: seamToleranceMm, seamClosureMm: closureToleranceMm, totalIntersections: rows.length, closedPairedSeamContacts: rows.filter(r => r.classification === 'closed paired-seam contact').length, unclosedPairedSeamContacts: rows.filter(r => r.classification === 'paired-seam contact before closure').length, nonadjacentPenetrations: rows.filter(r => r.classification === 'cloth-face penetration outside paired-seam contact neighborhood').length, rows, limitations: ['A closed paired-seam contact classification requires one-ring source sewing topology and every finite intersection endpoint within5mm of BOTH actual seam sides, whose whole seam gap is≤3mm.', 'Only finite noncoplanar facet intersections in the upstream independent screen are inspected; coplanar overlap requires separate tests.', 'No candidate is exempted solely because its panel owners join elsewhere or it is near an unrelated seam.'] };
await writeFile(process.argv[4], JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, rows: undefined }));
