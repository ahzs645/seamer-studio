import { readFile, writeFile } from 'node:fs/promises';
import * as T from 'three';
const f = JSON.parse(await readFile(process.argv[2], 'utf8')), r = JSON.parse(await readFile(process.argv[3], 'utf8')), V = i => new T.Vector3().fromArray(f.clothPositions, i * 4), out = [];
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
for (const row of r.rows.filter(r => r.classification === 'paired-seam contact before closure')) {
    const faceIds = row.faces.map(i => f.clothTriangles.slice(i * 4, i * 4 + 3)), rings = faceIds.map(ids => new Set(ids.flatMap(i => [...neighbors.get(i)]))), paired = (a, b) => (rings[0].has(a) && rings[1].has(b)) || (rings[0].has(b) && rings[1].has(a));
    const seams = [];
    for (const adjacent of row.adjacentSeams.filter(s => s.allIntersectionEndpointsWithinSeamNeighborhood)) {
        const seam = f.seamPairs.find(s => s.seamId === adjacent.seamId), points = [];
        for (const pp of row.intersectionEndpoints) {
            const at = new T.Vector3(...pp);
            let best = null;
            for (let i = 2; i < seam.pairs.length; i += 2) {
                if (!paired(seam.pairs[i - 2], seam.pairs[i - 1]) && !paired(seam.pairs[i], seam.pairs[i + 1]))
                    continue;
                const a0 = V(seam.pairs[i - 2]), b0 = V(seam.pairs[i - 1]), a1 = V(seam.pairs[i]), b1 = V(seam.pairs[i + 1]), m0 = a0.clone().add(b0).multiplyScalar(.5), m1 = a1.clone().add(b1).multiplyScalar(.5), line = new T.Line3(m0, m1), t = line.closestPointToPointParameter(at, true), aa = a0.clone().lerp(a1, t), bb = b0.clone().lerp(b1, t), distance = Math.max(at.distanceTo(aa), at.distanceTo(bb)) * 1000;
                if (!best || distance < best.maxDistanceToCorrespondingSideMm)
                    best = { segment: i / 2 - 1, t, maxDistanceToCorrespondingSideMm: distance, correspondingLocalGapMm: aa.distanceTo(bb) * 1000 };
            }
            points.push(best);
        }
        seams.push({ seamId: seam.seamId, wholeSeamGapMm: adjacent.maxSeamGapMm, points, allCorrespondingLocalEndpointsWithin5Mm: points.every(p => p && p.maxDistanceToCorrespondingSideMm <= 5), allCorrespondingLocalGapsWithin3Mm: points.every(p => p && p.correspondingLocalGapMm <= 3) });
    }
    out.push({ faces: row.faces, pieces: row.pieces, seams, locallyClosed: seams.some(s => s.allCorrespondingLocalEndpointsWithin5Mm && s.allCorrespondingLocalGapsWithin3Mm) });
}
const summary = { fixture: process.argv[2], unclosedWholeSeamContacts: out.length, locallyClosed: out.filter(x => x.locallyClosed).length, locallyNotClosed: out.filter(x => !x.locallyClosed).length, rows: out, finalAcceptanceUnchanged: 'Whole garment sewing closure≤3mm remains mandatory; this diagnostic only distinguishes temporal local joining contact from remote penetrations.' };
await writeFile(process.argv[4], JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, rows: undefined }));
