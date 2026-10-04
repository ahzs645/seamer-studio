import { readFrozenSample } from './frozen-sample.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import * as T from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import {finiteRayHit,countFiniteRayHits} from './body-parity.mjs';
const file = process.argv[2], out = process.argv[3], previousFile = process.argv[4];
if (!file || !out)
    throw Error('Usage: region-guard.mjs frozen.json report.json [previous-frozen.json]');
const f = await readFrozenSample(file), p = f.clothPositions;
const V = (array, i, stride = 3) => new T.Vector3().fromArray(array, i * stride);
const bodyTree = new Octree(), clothTree = new Octree(), bodyTriangles = [], clothTriangles = [], clothId = new WeakMap();
for (let i = 0; i < f.bodyIndices.length; i += 3) {
    const t = new T.Triangle(...f.bodyIndices.slice(i, i + 3).map(j => V(f.bodyPositions, j)));
    bodyTriangles.push(t);
    bodyTree.addTriangle(t);
}
bodyTree.build();
for (let i = 0; i < f.clothTriangles.length; i += 4) {
    const ids = f.clothTriangles.slice(i, i + 3), t = new T.Triangle(...ids.map(j => V(p, j, 4)));
    clothTriangles.push({ t, ids });
    clothId.set(t, i / 4);
    clothTree.addTriangle(t);
}
clothTree.build();
const measurements = f.pattern.body.garmentCodeBody?.measurementsCm ?? {};
const height = measurements.height / 100;
const neck = (measurements.height - measurements.head_l) / 100, waist = neck - measurements.waist_line / 100, hips = waist - measurements.hips_line / 100, crotch = hips - measurements.crotch_hip_diff / 100;
const joints = f.joints ?? {}, arm = side => joints['mixamorig' + side + 'Arm'];
const zones = { neck: { available: Number.isFinite(neck), center: [0, neck, 0], extent: [.14, .07, .14] }, waist: { available: Number.isFinite(waist), center: [0, waist, 0], extent: [.28, .06, .20] }, hips: { available: Number.isFinite(hips), center: [0, hips, 0], extent: [.29, .075, .23] }, crotch: { available: Number.isFinite(crotch), center: [0, crotch, 0], extent: [.12, .075, .18] } };
for (const side of ['Left', 'Right']) {
    const a = arm(side);
    zones[side.toLowerCase() + 'Underarm'] = { available: !!a, center: a ? [a[0], a[1] - .045, a[2]] : null, extent: [.09, .09, .105] };
}
for (const side of ['Left', 'Right']) {
    const wrist = joints['mixamorig' + side + 'Hand'], elbow = joints['mixamorig' + side + 'ForeArm'];
    zones[side.toLowerCase() + 'Wrist'] = { available: !!wrist, center: wrist ?? null, extent: [.085, .085, .085] };
    zones[side.toLowerCase() + 'Forearm'] = { available: !!wrist && !!elbow, center: wrist && elbow ? wrist.map((n, k) => (n + elbow[k]) / 2) : null, extent: wrist && elbow ? wrist.map((n, k) => Math.abs(n - elbow[k]) / 2 + .07) : [0, 0, 0] };
}
for (const side of ['Left', 'Right'])
    for (const [name, a, b] of [['Thigh', 'UpLeg', 'Leg'], ['Calf', 'Leg', 'Foot']]) {
        const start = joints['mixamorig' + side + a], end = joints['mixamorig' + side + b];
        zones[side.toLowerCase() + name] = { available: !!start && !!end, center: start && end ? start.map((n, k) => (n + end[k]) / 2) : null, extent: start && end ? start.map((n, k) => Math.abs(n - end[k]) / 2 + (name === 'Thigh' ? .10 : .075)) : [0, 0, 0] };
    }
zones.pelvis = { available: Number.isFinite(waist) && Number.isFinite(hips), center: Number.isFinite(waist) && Number.isFinite(hips) ? [0, (waist + hips) / 2, 0] : null, extent: [.30, Number.isFinite(waist) && Number.isFinite(hips) ? Math.abs(waist - hips) / 2 + .04 : 0, .24] };
const inZone = (point, z) => z.available && point.toArray().every((n, k) => Math.abs(n - z.center[k]) <= z.extent[k]);
const regions = Object.fromEntries(Object.entries(zones).map(([name, z]) => [name, { ...z, coveredClothFaces: 0, intersectingClothFaces: 0, insideParticles: 0 }]));
for (const { t } of clothTriangles)
    for (const region of Object.values(regions))
        if (region.available && new T.Box3().setFromPoints([t.a, t.b, t.c]).intersectsBox(new T.Box3(new T.Vector3(...region.center.map((n, k) => n - region.extent[k])), new T.Vector3(...region.center.map((n, k) => n + region.extent[k])))))
            region.coveredClothFaces++;
const ray = new T.Ray(), hit = new T.Vector3(), delta = new T.Vector3(), point = new T.Vector3();
const directions = [[1, .173, .291], [-.123, 1, .347], [.277, -.193, 1]].map(a => new T.Vector3(...a).normalize());
const inside = [], bodyCrossings = [], selfCandidates = [];
let disagreements = 0;
function cross(a, b, t) {
    delta.subVectors(b, a);
    const length = delta.length();
    if (length < 1e-8)
        return null;
    ray.set(a, delta.normalize());
    if (ray.intersectTriangle(t.a, t.b, t.c, false, hit) && hit.distanceTo(a) > 1e-6 && hit.distanceTo(a) < length - 1e-6)
        return hit.clone();
    return null;
}
function crossPair(a, b) { return cross(a.a, a.b, b) || cross(a.b, a.c, b) || cross(a.c, a.a, b) || cross(b.a, b.b, a) || cross(b.b, b.c, a) || cross(b.c, b.a, a); }
for (let i = 0; i < p.length; i += 4) {
    point.fromArray(p, i);
    let votes = 0;
    for (const dir of directions) {
        ray.set(point, dir);
        const candidates = [], rayHits = [];
        bodyTree.getRayTriangles(ray, candidates);
        for (const t of candidates)
            if (ray.intersectTriangle(t.a, t.b, t.c, false, hit)) {
                const d = point.distanceTo(hit);
                if (d > 1e-6) rayHits.push(finiteRayHit(t,ray,hit));
            }
        votes += countFiniteRayHits(rayHits) % 2;
    }
    if (votes === 1 || votes === 2)
        disagreements++;
    if (votes >= 2) {
        const candidates = [];
        bodyTree.getSphereTriangles(new T.Sphere(point, .2), candidates);
        let depth = Infinity;
        for (const t of candidates) {
            t.closestPointToPoint(point, hit);
            depth = Math.min(depth, point.distanceTo(hit));
        }
        inside.push({ particle: i / 4, depthMm: depth * 1000, position: point.toArray() });
        for (const region of Object.values(regions))
            if (inZone(point, region))
                region.insideParticles++;
    }
}
for (let i = 0; i < clothTriangles.length; i++) {
    const { t, ids } = clothTriangles[i], center = t.getMidpoint(new T.Vector3()), radius = Math.max(...[t.a, t.b, t.c].map(p => p.distanceTo(center))) + 1e-5;
    const candidates = [];
    bodyTree.getSphereTriangles(new T.Sphere(center, radius), candidates);
    const contacts = [];
    for (const b of candidates) {
        const at = crossPair(t, b);
        if (at)
            contacts.push(at);
    }
    if (contacts.length) {
        const piece = f.pieces.find(pc => ids[0] >= pc.start && ids[0] < pc.start + pc.count), names = [];
        for (const [name, region] of Object.entries(regions))
            if (contacts.some(p => inZone(p, region))) {
                region.intersectingClothFaces++;
                names.push(name);
            }
        bodyCrossings.push({ clothFace: i, pieceId: piece?.pieceId, pieceName: f.pattern.pieces.find(p => p.id === piece?.pieceId)?.name, regions: names, contactPoints: contacts.map(p => p.toArray()) });
    }
    const near = [];
    clothTree.getSphereTriangles(new T.Sphere(center, radius), near);
    for (const b of near) {
        const j = clothId.get(b);
        if (j <= i || clothTriangles[j].ids.some(v => ids.includes(v)))
            continue;
        const at = crossPair(t, b);
        if (at)
            selfCandidates.push({ faces: [i, j], position: at.toArray() });
    }
}
const seamSegments = [];
for (const seam of f.seamPairs) {
    const mids = [];
    for (let i = 0; i < seam.pairs.length; i += 2)
        mids.push(V(p, seam.pairs[i], 4).add(V(p, seam.pairs[i + 1], 4)).multiplyScalar(.5));
    for (let i = 1; i < mids.length; i++)
        seamSegments.push(new T.Line3(mids[i - 1], mids[i]));
}
for (const candidate of selfCandidates) {
    const at = new T.Vector3(...candidate.position);
    let distance = Infinity;
    for (const segment of seamSegments) {
        segment.closestPointToPoint(at, true, hit);
        distance = Math.min(distance, at.distanceTo(hit));
    }
    candidate.nearestSeamDistanceMm = distance * 1000;
    candidate.within10mmOfSewnEdge = distance <= .01;
}
const seams = f.seamPairs.map(s => {
    const gaps = [];
    for (let i = 0; i < s.pairs.length; i += 2)
        gaps.push(V(p, s.pairs[i], 4).distanceTo(V(p, s.pairs[i + 1], 4)) * 1000);
    const native = f.pattern.seams.find(x => x.id === s.seamId);
    return { seamId: s.seamId, name: native?.name, pairCount: gaps.length, maxGapMm: Math.max(0, ...gaps), meanGapMm: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0 };
});
let trajectory = null;
if (previousFile) {
    const old = JSON.parse(await readFile(previousFile, 'utf8'));
    if (old.clothPositions.length !== p.length)
        throw Error('Trajectory topology count changed');
    let sum = 0, max = 0;
    for (let i = 0; i < p.length; i += 4) {
        const d = Math.hypot(...[0, 1, 2].map(k => p[i + k] - old.clothPositions[i + k])) * 1000;
        sum += d * d;
        max = Math.max(max, d);
    }
    trajectory = { fromFrame: old.frame, toFrame: f.frame, intervalSeconds: (f.frame - old.frame) * (f.simulatedSecondsPerFrame ?? .016), rmsDisplacementMm: Math.sqrt(sum / (p.length / 4)), maxDisplacementMm: max, convergenceCertified: false };
}
const waistbandIds = new Set(f.pattern.pieces.filter(piece => /waistband|^wb_/i.test(piece.name)).map(piece => piece.id));
const bandPieces = f.pieces.filter(piece => waistbandIds.has(piece.pieceId));
let waistband = null;
if (bandPieces.length && f.freshPositions) {
    const indices = bandPieces.flatMap(piece => Array.from({ length: piece.count }, (_, i) => piece.start + i)), freshMax = Math.max(...indices.map(i => f.freshPositions[i * 4 + 1])), upper = indices.filter(i => f.freshPositions[i * 4 + 1] >= freshMax - .002), initialMean = upper.reduce((sum, i) => sum + f.freshPositions[i * 4 + 1], 0) / upper.length, finalMean = upper.reduce((sum, i) => sum + p[i * 4 + 1], 0) / upper.length;
    waistband = { pieces: bandPieces.map(piece => f.pattern.pieces.find(p => p.id === piece.pieceId)?.name), upperEdgeParticleCount: upper.length, initialUpperEdgeMeanYM: initialMean, finalUpperEdgeMeanYM: finalMean, upperEdgeMeanDropMm: (initialMean - finalMean) * 1000, upperEdgeYSpreadMm: (Math.max(...upper.map(i => p[i * 4 + 1])) - Math.min(...upper.map(i => p[i * 4 + 1]))) * 1000, initialUpperEdgeFromSourceWaistMm: Number.isFinite(waist) ? (initialMean - waist) * 1000 : null, finalUpperEdgeFromSourceWaistMm: Number.isFinite(waist) ? (finalMean - waist) * 1000 : null, holdingAnchorsRequested: typeof f.anchorWeightsNonzero === 'number' ? f.anchorWeightsNonzero > 0 : null, nonzeroAnchorWeights: f.anchorWeightsNonzero ?? null, supportCertified: false };
}
const bodyEdges = new Map();
for (let i = 0; i < f.bodyIndices.length; i += 3)
    for (let k = 0; k < 3; k++) {
        const a = f.bodyIndices[i + k], b = f.bodyIndices[i + (k + 1) % 3], key = [a, b].sort((a, b) => a - b).join(',');
        bodyEdges.set(key, (bodyEdges.get(key) || 0) + 1);
    }
const ys = f.bodyPositions.filter((_, i) => i % 3 === 1);
for (const region of Object.values(regions))
    region.status = !region.available ? 'unavailable' : region.coveredClothFaces === 0 ? 'not covered' : region.intersectingClothFaces || region.insideParticles ? 'intersections present' : 'no body intersections detected';
const report = { fixture: file, provenance: f.provenance ?? null, inputSha256: f.inputSha256 ?? null, frame: f.frame, simulatedSeconds: f.simulatedSeconds ?? f.frame * (f.simulatedSecondsPerFrame ?? .016), particleCount: p.length / 4, clothTriangleCount: clothTriangles.length, meshSpacingMm: f.pattern.settings3d.globalParticleDistanceOverride, sourcePose: f.automaticPose, sourceBodyMeasurementsCm: measurements, bodyHeightCm: (Math.max(...ys) - Math.min(...ys)) * 100, bodyGroundMm: Math.min(...ys) * 1000, heightErrorMm: Number.isFinite(height) ? (Math.max(...ys) - Math.min(...ys) - height) * 1000 : null, positionsFinite: p.every(Number.isFinite), bodyBoundaryEdges: [...bodyEdges.values()].filter(n => n === 1).length, bodyNonmanifoldEdges: [...bodyEdges.values()].filter(n => n > 2).length, insideParticleCount: inside.length, maxInsideDepthMm: Math.max(0, ...inside.map(p => p.depthMm)), parityDisagreements: disagreements, intersectingClothFaces: bodyCrossings.length, selfCrossingCandidateCount: selfCandidates.length, selfCrossingWithin10mmOfSewnEdge: selfCandidates.filter(c => c.within10mmOfSewnEdge).length, selfCrossingAwayFromSewnEdge: selfCandidates.filter(c => !c.within10mmOfSewnEdge).length, maxSeamGapMm: Math.max(0, ...seams.map(s => s.maxGapMm)), regions, seams, waistband, trajectory, bodyCrossings, insideParticles: inside, selfCrossingCandidates: selfCandidates, fitCertified: false, limitations: ['Region coverage is cloth face AABB overlap with source measurement/joint regions; it does not certify anatomical panel assignment.', 'Three-ray parity and finite bidirectional segment/triangle tests detect interior vertices and surface crossings, but coplanar overlaps and contact thickness are not certified.', 'Self-crossing candidates exclude shared-vertex triangle pairs; sewn neighboring-panel contact needs review before interpreting each candidate as a failure.', 'Finite collision-free geometry at an interim frame does not establish convergence or sewing closure.'] };
await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, bodyCrossings: undefined, insideParticles: undefined, selfCrossingCandidates: undefined, sourceBodyMeasurementsCm: undefined, seams: undefined }));
