import { readFile, writeFile } from 'node:fs/promises';
import * as T from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
const f = JSON.parse(await readFile(process.argv[2], 'utf8')), r = JSON.parse(await readFile(process.argv[3], 'utf8'));
const V = (a, i, s = 3) => new T.Vector3().fromArray(a, i * s), body = new Octree(), bodyIds = new WeakMap();
for (let k = 0; k < f.bodyIndices.length; k += 3) {
    const t = new T.Triangle(...f.bodyIndices.slice(k, k + 3).map(i => V(f.bodyPositions, i)));
    body.addTriangle(t);
    bodyIds.set(t, k / 3);
}
body.build();
const ray = new T.Ray(), hit = new T.Vector3(), n = new T.Vector3(), closest = new T.Vector3();
const edges = [[0, 1], [1, 2], [2, 0]];
function featureCuts(points, target, kind) { const out = []; for (const [a, b] of edges) {
    const delta = points[b].clone().sub(points[a]), length = delta.length();
    if (length < 1e-9)
        continue;
    ray.set(points[a], delta.normalize());
    if (ray.intersectTriangle(target.a, target.b, target.c, false, hit)) {
        const t = hit.distanceTo(points[a]) / length;
        if (t > 1e-6 / length && t < 1 - 1e-6 / length)
            out.push({ kind, edge: [a, b], parameter: t, position: hit.toArray() });
    }
} return out; }
const rows = [];
for (const crossing of r.bodyCrossings) {
    const face = crossing.clothFace, ids = f.clothTriangles.slice(face * 4, face * 4 + 3), points = ids.map(i => V(f.clothPositions, i, 4)), tri = new T.Triangle(...points), center = tri.getMidpoint(new T.Vector3()), radius = Math.max(...points.map(p => p.distanceTo(center))) + 1e-5, candidates = [];
    body.getSphereTriangles(new T.Sphere(center, radius), candidates);
    const contacts = [];
    for (const b of candidates) {
        const cuts = [...featureCuts(points, b, 'cloth-edge versus body-face'), ...featureCuts([b.a, b.b, b.c], tri, 'body-edge versus cloth-face')];
        if (!cuts.length)
            continue;
        const bn = b.getNormal(new T.Vector3()), cn = tri.getNormal(new T.Vector3()), bodyPlane = new T.Plane().setFromNormalAndCoplanarPoint(bn, b.a), clothPlane = new T.Plane().setFromNormalAndCoplanarPoint(cn, tri.a);
        contacts.push({ bodyFace: bodyIds.get(b), bodyVertexIds: f.bodyIndices.slice(bodyIds.get(b) * 3, bodyIds.get(b) * 3 + 3), normalDot: bn.dot(cn), clothVertexDepthsSignedMm: points.map(p => bodyPlane.distanceToPoint(p) * 1000), bodyVertexDepthsSignedMm: [b.a, b.b, b.c].map(p => clothPlane.distanceToPoint(p) * 1000), bodyVerticesProjectedInsideCloth: [b.a, b.b, b.c].map(p => { clothPlane.projectPoint(p, closest); return tri.containsPoint(closest); }), clothVerticesProjectedInsideBody: points.map(p => { bodyPlane.projectPoint(p, closest); return b.containsPoint(closest); }), cuts });
    }
    rows.push({ face, clothIds: ids, piece: crossing.pieceName, regions: crossing.regions, clothVertices: points.map(p => p.toArray()), edgeLengthsMm: edges.map(([a, b]) => points[a].distanceTo(points[b]) * 1000), closestBodySurfaceDistanceMm: points.map(p => { const near = []; body.getSphereTriangles(new T.Sphere(p, .10), near); return Math.min(...near.map(t => { t.closestPointToPoint(p, closest); return p.distanceTo(closest) * 1000; })); }), contacts });
}
const report = { fixture: process.argv[2], bodyCrossingClothFaces: rows.length, rows };
await writeFile(process.argv[4], JSON.stringify(report, null, 2));
console.log(JSON.stringify({ fixture: report.fixture, facets: rows.length, pieces: [...new Set(rows.map(r => r.piece))], regions: [...new Set(rows.flatMap(r => r.regions))], featureCounts: Object.fromEntries(['cloth-edge versus body-face', 'body-edge versus cloth-face'].map(k => [k, rows.reduce((n, r) => n + r.contacts.reduce((a, c) => a + c.cuts.filter(f => f.kind === k).length, 0), 0)])) }));
