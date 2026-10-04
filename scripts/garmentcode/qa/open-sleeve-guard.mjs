import { readFrozenSample } from './frozen-sample.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import * as T from 'three';
const file = process.argv[2];
const data = await readFrozenSample(file);
const out = process.argv[3];
const xyz = data.clothPositions, body = data.bodyPositions;
const V = (a, i, stride = 3) => new T.Vector3(...a.slice(i * stride, i * stride + 3));
const dot = (p, center, axis) => p.clone().sub(center).dot(axis);
const ray = new T.Ray(), hit = new T.Vector3(), delta = new T.Vector3();
function segmentCross(a, b, tri) {
    delta.subVectors(b, a);
    const l = delta.length();
    if (l < 1e-9)
        return false;
    ray.set(a, delta.normalize());
    return !!ray.intersectTriangle(tri.a, tri.b, tri.c, false, hit) && hit.distanceTo(a) > 1e-6 && hit.distanceTo(a) < l - 1e-6;
}
function triCrossPoints(a, b) {
    const points = [];
    for (const [t, other] of [[a, b], [b, a]])
        for (const [x, y] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]])
            if (segmentCross(x, y, other)) {
                const p = hit.clone();
                if (!points.some(q => q.distanceTo(p) < 1e-7))
                    points.push(p);
            }
    return points;
}
function contains(point, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if (((a[1] > point[1]) !== (b[1] > point[1])) && (point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]))
            inside = !inside;
    }
    return inside;
}
const report = { fixture: file, particleCount: xyz.length / 4, sides: {}, seams: [] };
for (const seam of data.seamPairs) {
    const gaps = [];
    for (let i = 0; i < seam.pairs.length; i += 2)
        gaps.push(V(xyz, seam.pairs[i], 4).distanceTo(V(xyz, seam.pairs[i + 1], 4)) * 1000);
    report.seams.push({ seamId: seam.seamId, maxGapMm: Math.max(...gaps), meanGapMm: gaps.reduce((a, b) => a + b, 0) / gaps.length });
}
for (const side of ['Left', 'Right']) {
    const wrist = new T.Vector3(...data.joints['mixamorig' + side + 'Hand']), elbow = new T.Vector3(...data.joints['mixamorig' + side + 'ForeArm']), finger = new T.Vector3(...data.joints['mixamorig' + side + 'HandMiddle1']);
    const axis = finger.clone().sub(wrist).normalize(), u = new T.Vector3(0, 0, 1).cross(axis).normalize(), v = axis.clone().cross(u).normalize();
    const sewnPaths = new Set(data.pattern.seams.flatMap(s => [...s.fromPaths, ...s.toPaths].map(p => p.id)));
    const sidePieces = data.pieces.filter(p => data.pattern.pieces.find(x => x.id === p.pieceId).name.toLowerCase().includes(side.toLowerCase()));
    const nativeName = p => data.pattern.pieces.find(x => x.id === p.pieceId).name.toLowerCase();
    const sourceCuffs = sidePieces.filter(p => nativeName(p).includes('cuff'));
    const cuffPieces = sourceCuffs.length ? sourceCuffs : sidePieces.filter(p => nativeName(p).includes('sleeve'));
    const openIndices = [], openRuns = [];
    for (const p of cuffPieces) {
        const native = data.pattern.pieces.find(x => x.id === p.pieceId);
        for (const path of native.mainPaths.filter(p => !sewnPaths.has(p.id))) {
            const run = data.cuffEdges[p.pieceId][path.id];
            openRuns.push(run);
            openIndices.push(...run);
        }
    }
    if (!openIndices.length)
        throw Error('Open sleeve edge not found for ' + side);
    const hemJoins = [];
    for (const seam of data.seamPairs)
        for (let i = 0; i < seam.pairs.length; i += 2) {
            const a = seam.pairs[i], b = seam.pairs[i + 1];
            if (openIndices.includes(a) || openIndices.includes(b))
                hemJoins.push({ seamId: seam.seamId, particles: [a, b], gapMm: V(xyz, a, 4).distanceTo(V(xyz, b, 4)) * 1000 });
        }
    const open = openIndices.map(i => V(xyz, i, 4));
    const center = open.reduce((sum, p) => sum.add(p), new T.Vector3()).multiplyScalar(1 / open.length);
    const polygon = open.map(p => [dot(p, center, u), dot(p, center, v)]).sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    const bodyTris = [], bodyCut = [];
    for (let i = 0; i < data.bodyIndices.length; i += 3) {
        const points = data.bodyIndices.slice(i, i + 3).map(n => V(body, n));
        const near = points.some(p => dot(p, wrist, axis) > -.11 && dot(p, wrist, axis) < .19 && p.clone().sub(wrist).addScaledVector(axis, -dot(p, wrist, axis)).length() < .11);
        if (near)
            bodyTris.push({ index: i / 3, triangle: new T.Triangle(...points) });
        for (let k = 0; k < 3; k++) {
            const a = points[k], b = points[(k + 1) % 3], da = dot(a, center, axis), db = dot(b, center, axis);
            if (da * db < 0) {
                const p = a.clone().lerp(b, da / (da - db));
                if (p.distanceTo(center) < .14)
                    bodyCut.push(p);
            }
        }
    }
    const crossing = [];
    for (let i = 0; i < data.clothTriangles.length; i += 4) {
        const ids = data.clothTriangles.slice(i, i + 3), points = ids.map(n => V(xyz, n, 4));
        if (!points.some(p => dot(p, wrist, axis) > -.11 && dot(p, wrist, axis) < .19 && p.clone().sub(wrist).addScaledVector(axis, -dot(p, wrist, axis)).length() < .11))
            continue;
        const triangle = new T.Triangle(...points);
        const crossingPoints = [];
        const crossed = bodyTris.filter(b => { const intersections = triCrossPoints(triangle, b.triangle); crossingPoints.push(...intersections); return intersections.length > 0; });
        if (crossed.length) {
            const piece = data.pieces.find(p => ids[0] >= p.start && ids[0] < p.start + p.count);
            crossing.push({ clothFace: i / 4, pieceName: data.pattern.pieces.find(p => p.id === piece.pieceId).name, bodyFaces: crossed.map(x => x.index), intersectionAxialRangeFromWristMm: [Math.min(...crossingPoints.map(p => dot(p, wrist, axis))) * 1000, Math.max(...crossingPoints.map(p => dot(p, wrist, axis))) * 1000] });
        }
    }
    const perimeter = poly => poly.reduce((sum, p, i) => sum + Math.hypot(p[0] - poly[(i + 1) % poly.length][0], p[1] - poly[(i + 1) % poly.length][1]), 0) * 1000;
    const cutUnique = [...new Map(bodyCut.map(p => { const q = [dot(p, center, u), dot(p, center, v)]; return [q.map(x => Math.round(x * 1e8)).join(','), q]; })).values()];
    const cutCenter = cutUnique.reduce((a, p) => [a[0] + p[0] / cutUnique.length, a[1] + p[1] / cutUnique.length], [0, 0]);
    cutUnique.sort((a, b) => Math.atan2(a[1] - cutCenter[1], a[0] - cutCenter[0]) - Math.atan2(b[1] - cutCenter[1], b[0] - cutCenter[0]));
    const runLength = positions => openRuns.reduce((sum, run) => sum + run.slice(1).reduce((a, id, i) => a + V(positions, id, 4).distanceTo(V(positions, run[i], 4)) * 1000, 0), 0);
    const outside = bodyCut.filter(p => !contains([dot(p, center, u), dot(p, center, v)], polygon));
    const clearances = bodyCut.map(p => {
        const q = [dot(p, center, u), dot(p, center, v)];
        let nearest = Infinity;
        for (let i = 0; i < polygon.length; i++) {
            const a = polygon[i], b = polygon[(i + 1) % polygon.length], dx = b[0] - a[0], dy = b[1] - a[1], den = dx * dx + dy * dy, t = den ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / den)) : 0;
            nearest = Math.min(nearest, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy));
        }
        return nearest * (contains(q, polygon) ? 1 : -1) * 1000;
    });
    report.sides[side] = { openingKind: sourceCuffs.length ? 'cuff' : 'sleeve hem', openingParticleCount: openIndices.length, restUnsewnHemLengthMm: runLength(data.freshPositions), finalUnsewnHemLengthMm: runLength(xyz), projectedFinalOpeningPerimeterMm: perimeter(polygon), bodySectionPerimeterMm: cutUnique.length ? perimeter(cutUnique) : null, hemJoins, maxHemJoinGapMm: Math.max(0, ...hemJoins.map(j => j.gapMm)), wrist: wrist.toArray(), cuffOpeningCenter: center.toArray(), centerFromWristMm: center.distanceTo(wrist) * 1000, longitudinalCenterFromWristMm: dot(center, wrist, axis) * 1000, radialCenterOffsetMm: center.clone().sub(wrist).addScaledVector(axis, -dot(center, wrist, axis)).length() * 1000, openingPlanaritySpreadMm: (Math.max(...open.map(p => dot(p, center, axis))) - Math.min(...open.map(p => dot(p, center, axis)))) * 1000, openingMinRadiusMm: Math.min(...open.map(p => Math.hypot(dot(p, center, u), dot(p, center, v)))) * 1000, bodyCutPointCount: bodyCut.length, bodyCutPointsOutsideOpening: outside.length, minimumProjectedOpeningClearanceMm: clearances.length ? Math.min(...clearances) : null, wristForearmIntersectingClothFaces: crossing.length, handIntersectingClothFaces: crossing.filter(c => c.intersectionAxialRangeFromWristMm[1] >= 0).length, crossing };
}
report.cleanHandEmergence = ['Left', 'Right'].every(side => !!report.sides[side]) && Object.values(report.sides).every(s => s.bodyCutPointCount > 0 && s.bodyCutPointsOutsideOpening === 0 && s.handIntersectingClothFaces === 0) && Object.values(report.sides).every(s => s.maxHemJoinGapMm <= 3);
report.cleanWristEmergence = ['Left', 'Right'].every(side => !!report.sides[side]) && Object.values(report.sides).every(s => s.bodyCutPointCount > 0 && s.bodyCutPointsOutsideOpening === 0 && s.wristForearmIntersectingClothFaces === 0) && Object.values(report.sides).every(s => s.maxHemJoinGapMm <= 3);
report.limitations = ['Opening containment projects a potentially nonplanar cuff edge onto a plane perpendicular to the posed hand axis; use planarity spread and screenshots to interpret.', 'Cloth/body facet intersection is bidirectional segment versus triangle. Entirely coplanar surface overlap and self-collision are not certified.'];
await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
