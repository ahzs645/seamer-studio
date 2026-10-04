import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { physicalSeamStitchIndices } from '../../../packages/cloth-sim/src/webgpu/seamGate.ts';
import { trajectorySourceHashes, trajectorySeamActivationHeader } from './particle-trajectory-audit.mjs';

const REVISION = 'source-free-gather-boundary-v1';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const jsonCopy = value => {
    if (ArrayBuffer.isView(value)) return Array.from(value);
    if (Array.isArray(value)) return value.map(jsonCopy);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonCopy(item)]));
    return value;
};
const same = (a, b) => JSON.stringify(canonical(jsonCopy(a))) === JSON.stringify(canonical(jsonCopy(b)));
const hasRefinement = data => data?.sourceGatherRefinement !== undefined || data?.sourceGatherCollisionGeometry !== undefined;

let finalizerPromise;
async function runtimeFinalizer() {
    // Node's type stripping does not infer the extension on the runtime finalizer's one value
    // import. Resolve only that exact import; other application/module resolution is untouched.
    if (!finalizerPromise) finalizerPromise = (async () => {
        const finalizerURL = new URL('../../../packages/cloth-sim/src/finalizeSourceGatherGeometry.ts', import.meta.url);
        const hook = registerHooks({ resolve(specifier, context, next) {
            return specifier === './collisionGuard' && context.parentURL === finalizerURL.href
                ? next('./collisionGuard.ts', context) : next(specifier, context);
        } });
        try { return (await import(finalizerURL.href)).finalizeSourceGatherCollisionGeometry; }
        finally { hook.deregister(); }
    })();
    return finalizerPromise;
}

/** Finalize a captured preparation with the ACTUAL runtime numerical-policy finalizer.
 * Refined data is cloned synchronously before module loading or digest awaits. Native data
 * retains identity. This proves provenance only; callers still require the geometry guard. */
export async function finalizePreparedRefinement(prepared) {
    if (!prepared?.simData) throw Error('Missing prepared simulation data');
    if (!hasRefinement(prepared.simData)) return prepared;
    const captured = structuredClone(prepared);
    const finalize = await runtimeFinalizer();
    captured.simData = await finalize(captured.simData);
    sourceRefinementSnapshot(captured);
    return captured;
}

/** JSON-safe copies of the actual finalized policy and child geometry. No document marker,
 * fixture assertion, or independently guessed hash can stand in for these numerical values. */
export function sourceRefinementSnapshot(prepared) {
    const data = prepared?.simData;
    if (!hasRefinement(data)) return {};
    const policy = jsonCopy(data.sourceGatherRefinement), geometry = jsonCopy(data.sourceGatherCollisionGeometry);
    if (!policy || !geometry || policy.revision !== REVISION || geometry.revision !== REVISION
        || geometry.sourceCoordinateStride !== 4 || !Array.isArray(geometry.sourceMaterialCoordinates)
        || !geometry.sourceMaterialCoordinates.length || geometry.sourceMaterialCoordinates.length % 4
        || !geometry.sourceMaterialCoordinates.every(Number.isFinite)
        || !Array.isArray(geometry.intervals) || !/^[a-f0-9]{64}$/.test(geometry.refinementPolicySha256 ?? '')
        || sha(policy) !== geometry.refinementPolicySha256) {
        throw Error('Refined artifact requires its finalized actual policy and child geometry');
    }
    return { sourceGatherRefinementRevision: REVISION, sourceGatherRefinement: policy, sourceGatherCollisionGeometry: geometry };
}

/** Capture a frozen artifact and trajectory header BEFORE any async binding work.
 * Pass the rejected attempt's gate or the published frame's LAST ACCEPTED gate explicitly.
 * A caller must not pass a planned-next controller state. No trajectory/fit is accepted here. */
export async function trajectoryRefinementArtifactHeader(prepared, frozen, proofUsedActivation) {
    const refinement = sourceRefinementSnapshot(prepared);
    const captured = jsonCopy(frozen);
    for (const key of ['sourceGatherRefinementRevision', 'sourceGatherRefinement', 'sourceGatherCollisionGeometry']) {
        if (captured[key] !== undefined && !same(captured[key], refinement[key])) {
            throw Error('Frozen artifact belongs to a different captured refinement');
        }
    }
    Object.assign(captured, refinement);
    // Fail before hashing if a caller accidentally combines another prepared mesh and policy.
    const triangles = prepared?.simData?.triangles;
    if (triangles !== undefined && !same(triangles, captured.clothTriangles)) throw Error('Frozen cloth topology differs from its preparation');
    const data = prepared?.simData;
    if (Object.keys(refinement).length) {
        const body = prepared.body;
        if (!body?.positions || !body.triangles || body.positions.length % 4
            || body.triangles.length !== body.numTriangles * 4) throw Error('Refined artifact requires its actual packed prepared body');
        const unpack = values => Array.from(values).filter((_, index) => index % 4 !== 3);
        if (!same(unpack(body.positions), captured.bodyPositions) || !same(unpack(body.triangles), captured.bodyIndices)) {
            throw Error('Frozen body differs from the actual posed preparation');
        }
        if (!data.seams || !data.seamOrder || !Array.isArray(data.seamPairsBySeam)) {
            throw Error('Refined artifact requires its actual prepared seam links and first-stamped orders');
        }
        const indices = physicalSeamStitchIndices(data.seams, data.seamOrder, data.seamPairsBySeam, data.seamStitchRanges);
        const dictionary = { stitchCount: data.stitchCount, seamPairsBySeam: data.seamPairsBySeam.map((group, index) => ({
            seamId: group.seamId, index, pairs: Array.from(group.pairs), stitchIndices: Array.from(indices[index]),
            stitchIndexKinds: Array.from(indices[index], (_, pair) => group.pairs[pair * 2] === group.pairs[pair * 2 + 1]
                ? 'identity-logical' : 'reciprocal-first-stamp') })) };
        if (!same(data.seams, captured.seams) || !same(dictionary, captured.collisionSeamDictionary)) {
            throw Error('Frozen collision seam dictionary differs from actual prepared first-stamped links');
        }
    }
    const activation = proofUsedActivation === undefined ? undefined : jsonCopy(proofUsedActivation);
    if (captured.collisionSeamDictionary !== undefined) {
        if (!activation) throw Error('Activated artifact requires the actual proof-used seam activation');
        if (captured.collisionSeamActivation !== undefined && !same(captured.collisionSeamActivation, activation)) {
            throw Error('Frozen artifact seam activation differs from the actual proof-used gate');
        }
        captured.collisionSeamActivation = activation;
        if (captured.safetyReport?.seamActivation !== undefined && !same(captured.safetyReport.seamActivation, activation)) {
            throw Error('Safety report seam activation differs from the artifact proof-used gate');
        }
    } else if (activation !== undefined || Object.keys(refinement).length) {
        throw Error('Refined or activated artifact requires its authoritative collision seam dictionary');
    }
    const sourceHashes = trajectorySourceHashes(captured);
    const seamHeader = activation === undefined ? {} : await trajectorySeamActivationHeader(captured, activation);
    return { frozen: captured, header: { ...sourceHashes, ...seamHeader } };
}
