import { readFrozenSample } from './frozen-sample.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export const SHOULDER_LIMITS = Object.freeze({ surfaceClearanceMm: 10, heightLossMm: 10, anatomicalSpanMarginMm: 10 });
const point = (array, i) => array.slice(i * 4, i * 4 + 3);
function semanticShoulder(piece, id) {
    const paths = piece.mainPaths ?? [], i = paths.findIndex(p => p.id === id);
    if (i < 0 || paths.length < 3)
        return false;
    const adjacent = [paths[(i + paths.length - 1) % paths.length].name, paths[(i + 1) % paths.length].name];
    return adjacent.some(n => /collar|neck/i.test(n ?? '')) && adjacent.some(n => /armhole/i.test(n ?? ''));
}
/** Actual shoulder crest at a fixed X inside the source shoulder seam's front/back span.
 * Restrict Y to the anatomical shoulder cap; never substitute an arbitrary closest body face. */
function capAtX(f, x, minZ, maxZ, neck, preferredZ) {
    let cap = null;
    for (let t = 0; t < f.bodyIndices.length; t += 3) {
        const tri = f.bodyIndices.slice(t, t + 3).map(i => f.bodyPositions.slice(i * 3, i * 3 + 3)), section = [];
        for (let e = 0; e < 3; e++) {
            const a = tri[e], b = tri[(e + 1) % 3];
            if (Math.abs(a[0] - x) < 1e-8)
                section.push(a);
            if ((a[0] < x && b[0] > x) || (b[0] < x && a[0] > x)) {
                const u = (x - a[0]) / (b[0] - a[0]);
                section.push(a.map((v, k) => v + u * (b[k] - v)));
            }
        }
        if (section.length >= 2)
            for (const z of [minZ, maxZ]) {
                const [a, b] = section;
                if ((a[2] < z && b[2] > z) || (b[2] < z && a[2] > z)) {
                    const u = (z - a[2]) / (b[2] - a[2]);
                    section.push(a.map((v, k) => v + u * (b[k] - v)));
                }
            }
        if (section.length >= 2 && Math.abs(section[0][1] - section[1][1]) < 1e-9 && Math.abs(section[0][2] - section[1][2]) > 1e-9) {
            const [a, b] = section, z = Math.max(Math.max(minZ, Math.min(a[2], b[2])), Math.min(Math.min(maxZ, Math.max(a[2], b[2])), preferredZ));
            const u = (z - a[2]) / (b[2] - a[2]);
            section.push(a.map((v, k) => v + u * (b[k] - v)));
        }
        for (const p of section)
            if (p[2] >= minZ && p[2] <= maxZ && p[1] >= neck - .2 && p[1] <= neck && (!cap || p[1] > cap.position[1] + 1e-9 || (Math.abs(p[1] - cap.position[1]) <= 1e-9 && Math.abs(p[2] - preferredZ) < Math.abs(cap.position[2] - preferredZ))))
                cap = { position: p, bodyFace: t / 3 };
    }
    return cap;
}
function verifyAnatomicalReference(f, name) {
    const reference = f.bodyAnatomicalReferences?.[name];
    if (!reference || !Array.isArray(reference.coordinates) || reference.coordinates.length < 2 || !Array.isArray(reference.points) || reference.points.length !== reference.coordinates.length) return null;
    const points = [];
    for (let i = 0; i < reference.coordinates.length; i++) {
        const a = reference.coordinates[i], point = reference.points[i];
        if (!a || !Number.isInteger(a.faceIndex) || a.faceIndex < 0 || a.faceIndex * 3 + 2 >= f.bodyIndices.length || ![a.u,a.v,a.w].every(v=>Number.isFinite(v)&&v>=0&&v<=1) || Math.abs(a.u+a.v+a.w-1)>1e-8 || !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) return null;
        const ids = f.bodyIndices.slice(a.faceIndex*3,a.faceIndex*3+3);
        const actual = [0,1,2].map(k=>ids.reduce((sum,id,j)=>sum+[a.u,a.v,a.w][j]*f.bodyPositions[id*3+k],0));
        if (!actual.every(Number.isFinite) || Math.hypot(...actual.map((v,k)=>v-point[k])) > 1e-8) return null;
        points.push(actual);
    }
    return { coordinates:reference.coordinates, points };
}
export function auditShoulderWear(f, fixture = null) {
    const m = f.pattern?.body?.garmentCodeBody?.measurementsCm;
    const shoulderReference = verifyAnatomicalReference(f,'neckSideToShoulder'), napeReference = verifyAnatomicalReference(f,'neckToWaistBack');
    const neckSide = shoulderReference?.points[0], tip = shoulderReference?.points[1], nape = napeReference?.points[0];
    const anatomicalReferencesVerified = !!neckSide && !!tip && !!nape && Math.abs(neckSide[0]) < Math.abs(tip[0]) && nape[1] >= tip[1];
    const neck = anatomicalReferencesVerified ? nape[1] : NaN;
    const anatomicalSpan = anatomicalReferencesVerified ? { minAbsoluteXM:Math.max(0,Math.abs(neckSide[0])-.01), maxAbsoluteXM:Math.min(Math.abs(tip[0])+.01,m?.shoulder_w/200+.01), capTopYM:nape[1], capBottomYM:nape[1]-.2 } : null;
    const owners = new Map((f.pattern?.pieces ?? []).flatMap(p => p.mainPaths.map(path => [path.id, p])));
    const semantics = (f.pattern?.seams ?? []).filter(s => [...s.fromPaths, ...s.toPaths].some(r => semanticShoulder(owners.get(r.id) ?? {}, r.id)));
    const rows = [], groups = [], source = f.sourceArrangedPositions;
    for (const seam of semantics) {
        const group = f.assemblySupport?.groups?.find(g => g.kind === 'shoulder' && g.id === seam.id);
        const exact = f.seamPairs?.find(s => s.seamId === seam.id)?.pairs;
        const bound = group && exact && JSON.stringify(group.seamPairs) === JSON.stringify(exact);
        const pairs = exact ?? [];
        const sourceXs = source ? pairs.filter((_, i) => i % 2 === 0).map((a, i) => (source[a * 4] + source[pairs[i * 2 + 1] * 4]) / 2) : [];
        const side = sourceXs.length && sourceXs.every(x => x > 0) ? 'left' : sourceXs.length && sourceXs.every(x => x < 0) ? 'right' : null;
        groups.push({ id: seam.id, side, semanticGroupVerified: !!bound, pairCount: pairs.length / 2 });
        for (let i = 0; i < pairs.length; i += 2) {
            const a = point(f.clothPositions, pairs[i]), b = point(f.clothPositions, pairs[i + 1]), at = a.map((v, k) => (v + b[k]) / 2);
            const sa = source ? point(source, pairs[i]) : null, sb = source ? point(source, pairs[i + 1]) : null;
            const sameAnatomicalSide = side === 'left' ? a[0] > 0 && b[0] > 0 : side === 'right' ? a[0] < 0 && b[0] < 0 : false;
            // Flat source placement is an assembly seed. The native anatomy and semantic
            // source side bound the final worn position; seed-X drift is diagnostic only.
            const sourceSpanVerified = !!sa && Number.isFinite(neck) && sameAnatomicalSide && anatomicalReferencesVerified && Math.abs(at[0]) >= anatomicalSpan.minAbsoluteXM && Math.abs(at[0]) <= anatomicalSpan.maxAbsoluteXM;
            const cap = sourceSpanVerified ? capAtX(f, at[0], Math.min(sa[2], sb[2]) - .005, Math.max(sa[2], sb[2]) + .005, neck, at[2]) : null;
            const clearance = cap ? Math.hypot(...at.map((v, k) => v - cap.position[k])) * 1000 : null;
            const loss = cap ? (cap.position[1] - at[1]) * 1000 : null;
            rows.push({ seamId: seam.id, side, particles: [pairs[i], pairs[i + 1]], position: at, sourceSpanVerified, sameAnatomicalSide, sourceSeedXDriftMm: sa && sb ? (at[0]-(sa[0]+sb[0])/2)*1000 : null, shoulderCap: cap, surfaceClearanceMm: clearance, heightLossMm: loss,
                worn: !!bound && !!cap && clearance <= SHOULDER_LIMITS.surfaceClearanceMm && loss <= SHOULDER_LIMITS.heightLossMm });
        }
    }
    const bilateral = ['left', 'right'].every(side => groups.some(g => g.side === side && g.semanticGroupVerified && g.pairCount > 0));
    return { fixture, anatomicalReferencesVerified, anatomicalReferences:{shoulder:shoulderReference,nape:napeReference}, anatomicalSpan, sourceNapeTargetYM:m ? (m.height-m.head_l)/100 : null, limits: SHOULDER_LIMITS, semanticShoulderCount: semantics.length, groups, bilateralSemanticCoverage: bilateral, allShoulderPairsWorn: bilateral && rows.length > 0 && rows.every(r => r.worn), rows,
        method: 'Source neck/armhole-adjacent stitch groups bound to actual paired topology and original left/right side. At each final paired midpoint X, intersect actual body triangles with the vertical X plane within the original source front/back span. Choose the shoulder crest only between verified actual native nape level and 200mm below it; require actual neck-side/shoulder-tip X span and both paired endpoints on their anatomical side, crest proximity and height loss <=10mm. Flat source seed-X movement is diagnostic, not a worn-location constraint. No nearest-whole-body fallback.',
        limitRationale: '10mm bounds the initial assembly 8mm skin clearance plus source 0.5mm fabric thickness and small discretization allowance; larger offsets or slipping below the crest are not accepted.',
        equilibriumCertified: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const f = await readFrozenSample(process.argv[2]), report = auditShoulderWear(f, process.argv[2]);
    await writeFile(process.argv[3], JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ fixture: report.fixture, bilateralSemanticCoverage: report.bilateralSemanticCoverage, allShoulderPairsWorn: report.allShoulderPairsWorn, pairs: report.rows.length, failed: report.rows.filter(r => !r.worn).length }));
}
