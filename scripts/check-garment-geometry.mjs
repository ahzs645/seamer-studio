// CPU body-contact screen for frozen geometry written by check-garment-matrix.mjs.
// It reports interim geometry; even --require-clear does not certify a settled garment.
import { readFile, writeFile } from 'node:fs/promises';
import * as T from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
if (!process.argv[2] || !process.argv[3])
    throw Error('Usage: node scripts/check-garment-geometry.mjs frozen.json report.json [--require-clear]');
const frozen = JSON.parse(await readFile(process.argv[2], 'utf8')), pos = frozen.clothPositions;
if (!Array.isArray(pos) || pos.length % 4 || !pos.every(Number.isFinite))
    throw Error('Cloth positions must be finite stride-4 values');
const particleCount = pos.length / 4;
const validParticle = value => Number.isInteger(value) && value >= 0 && value < particleCount;
if (frozen.seams !== undefined && !Array.isArray(frozen.seams))
    throw Error('Seams must be an array');
if (!Array.isArray(frozen.seams)) {
    if (!Array.isArray(frozen.seamPairs)) throw Error('Missing seam pairs for seam reconstruction');
    frozen.seams = new Array(pos.length).fill(-1);
    for (const s of frozen.seamPairs) {
        if (!Array.isArray(s.pairs) || s.pairs.length % 2 || !s.pairs.every(validParticle))
            throw Error('Seam pair references a missing particle');
        for (let k = 0; k < s.pairs.length; k += 2) {
            const a = s.pairs[k], b = s.pairs[k + 1];
            for (const [x, y] of [[a, b], [b, a]]) {
                let at = x * 4;
                while (at < x * 4 + 4 && frozen.seams[at] >= 0)
                    at++;
                if (at < x * 4 + 4)
                    frozen.seams[at] = y;
            }
        }
    }
}
if (frozen.seams.length !== pos.length || !frozen.seams.every(value => value === -1 || validParticle(value)))
    throw Error('Seams must contain four valid particle references or -1 per particle');
if (!Array.isArray(frozen.bodyPositions) || frozen.bodyPositions.length % 3 || !frozen.bodyPositions.every(Number.isFinite))
    throw Error('Body positions must be finite stride-3 values');
for (const [indices, stride, count] of [[frozen.bodyIndices, 3, frozen.bodyPositions.length / 3], [frozen.clothTriangles, 4, pos.length / 4]]) {
    if (!Array.isArray(indices) || indices.length % stride)
        throw Error('Invalid triangle array');
    for (let i = 0; i < indices.length; i++)
        if (i % stride < 3 && (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= count))
            throw Error('Triangle references a missing vertex');
}
const geometry = new T.BufferGeometry();
geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(frozen.bodyPositions), 3));
geometry.setIndex(frozen.bodyIndices);
const tree = new Octree().fromGraphNode(new T.Mesh(geometry));
const point = new T.Vector3(), hit = new T.Vector3(), ray = new T.Ray(), directions = [[1, .173, .291], [-.123, 1, .347], [.277, -.193, 1]].map(v => new T.Vector3(...v).normalize());
const insideParticles = [];
let rayDisagreements = 0;
for (let i = 0; i < pos.length; i += 4) {
    point.fromArray(pos, i);
    let votes = 0;
    for (const direction of directions) {
        ray.set(point, direction);
        const tris = [], hits = [];
        tree.getRayTriangles(ray, tris);
        for (const triangle of tris) {
            if (ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) {
                const d = point.distanceTo(hit);
                if (d > 1e-6 && !hits.some(v => Math.abs(v - d) < 1e-5))
                    hits.push(d);
            }
        }
        votes += hits.length % 2;
    }
    if (votes === 1 || votes === 2)
        rayDisagreements++;
    if (votes >= 2) {
        const tris = [];
        tree.getSphereTriangles(new T.Sphere(point, .15), tris);
        let closest = Infinity;
        for (const triangle of tris) {
            triangle.closestPointToPoint(point, hit);
            closest = Math.min(closest, point.distanceTo(hit));
        }
        insideParticles.push({ index: i / 4, depthMm: closest * 1000, position: point.toArray() });
    }
}
const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), center = new T.Vector3(), delta = new T.Vector3(), at = new T.Vector3(), clothTriangle = new T.Triangle();
function segmentCross(start, stop, triangle) { delta.subVectors(stop, start); const length = delta.length(); if (length < 1e-8)
    return false; ray.set(start, delta.normalize()); const cross = ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, at); return !!cross && at.distanceTo(start) > 1e-6 && at.distanceTo(start) < length - 1e-6; }
const crossingTriangles = [];
for (let i = 0; i < frozen.clothTriangles.length; i += 4) {
    const indices = frozen.clothTriangles.slice(i, i + 3);
    a.fromArray(pos, indices[0] * 4);
    b.fromArray(pos, indices[1] * 4);
    c.fromArray(pos, indices[2] * 4);
    center.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const radius = Math.max(center.distanceTo(a), center.distanceTo(b), center.distanceTo(c)) + 1e-5;
    const tris = [];
    tree.getSphereTriangles(new T.Sphere(center, radius), tris);
    clothTriangle.set(a, b, c);
    if (tris.some(t => segmentCross(a, b, t) || segmentCross(b, c, t) || segmentCross(c, a, t) || segmentCross(t.a, t.b, clothTriangle) || segmentCross(t.b, t.c, clothTriangle) || segmentCross(t.c, t.a, clothTriangle)))
        crossingTriangles.push({ index: i / 4, vertices: indices, pieceId: frozen.pieces.find(p => indices[0] >= p.start && indices[0] < p.start + p.count)?.pieceId });
}
const gap = (i, j) => 1000 * Math.hypot(...[0, 1, 2].map(axis => pos[i * 4 + axis] - pos[j * 4 + axis]));
let worst = { gapMm: 0, particles: [] };
for (let i = 0; i < pos.length / 4; i++) {
    for (let k = 0; k < 4; k++) {
        const j = frozen.seams[i * 4 + k];
        if (j >= 0 && gap(i, j) > worst.gapMm)
            worst = { gapMm: gap(i, j), particles: [i, j] };
    }
}
const edges = new Map();
for (let i = 0; i < frozen.bodyIndices.length; i += 3)
    for (let k = 0; k < 3; k++) {
        const x = frozen.bodyIndices[i + k], y = frozen.bodyIndices[i + (k + 1) % 3], edge = x < y ? x + ',' + y : y + ',' + x;
        edges.set(edge, (edges.get(edge) || 0) + 1);
    }
const report = { fixture: frozen.id, spacingMm: frozen.spacingMm, simulatedSeconds: frozen.simulatedSeconds, particleCount: pos.length / 4, clothTriangleCount: frozen.clothTriangles.length / 4, contacts: frozen.contacts, anchorWeightsNonzero: frozen.anchorWeightsNonzero, deviceStorageBufferLimit: frozen.deviceStorageBufferLimit, frame: frozen.frame, sourcePose: frozen.automaticPose, positionsFinite: pos.every(Number.isFinite), fitCertified: false, limitations: ['Three-ray parity assumes a closed body and may disagree near its surface.', 'Finite bidirectional segment/triangle crossings exclude coplanar overlaps and do not verify contact thickness.', 'This global body guard does not inspect cloth self-intersections, anatomical coverage, opening containment, sewing completion or convergence.'], insideParticleCount: insideParticles.length, maxInsideDepthMm: Math.max(0, ...insideParticles.map(p => p.depthMm)), rayDisagreements, bodyBoundaryEdges: [...edges.values()].filter(n => n === 1).length, bodyNonmanifoldEdges: [...edges.values()].filter(n => n > 2).length, intersectingClothTriangleCount: crossingTriangles.length, crossingTriangles, insideParticles, worstSeam: worst };
await writeFile(process.argv[3], JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, insideParticles: undefined, crossingTriangles: undefined }));
if (process.argv.includes('--require-clear') && (report.insideParticleCount || report.intersectingClothTriangleCount || report.rayDisagreements || report.bodyBoundaryEdges || report.bodyNonmanifoldEdges))
    process.exitCode = 1;
