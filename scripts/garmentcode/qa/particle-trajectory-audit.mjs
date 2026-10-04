import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const TRAJECTORY_FORMAT = 'float32-le-vec4';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const guardBindings = new WeakMap();
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function seamDictionary(frozen) {
    const dictionary = frozen.collisionSeamDictionary;
    if (dictionary === undefined) return undefined;
    if (!dictionary || !Number.isSafeInteger(dictionary.stitchCount) || dictionary.stitchCount < 0
        || dictionary.stitchCount !== frozen.stitchCount || !Array.isArray(dictionary.seamPairsBySeam)
        || !Array.isArray(frozen.seamPairs) || dictionary.seamPairsBySeam.length !== frozen.seamPairs.length) throw Error('Invalid immutable collision seam dictionary');
    const names = new Set(), particleCount = frozen.clothPositions.length / 4;
    const seamPairsBySeam = dictionary.seamPairsBySeam.map((group, index) => {
        const original = frozen.seamPairs[index];
        if (!group || typeof group.seamId !== 'string' || !group.seamId || names.has(group.seamId)
            || group.index !== index || !Array.isArray(group.pairs) || group.pairs.length % 2
            || !group.pairs.every(id => Number.isSafeInteger(id) && id >= 0 && id < particleCount)
            || !Array.isArray(group.stitchIndices) || group.stitchIndices.length !== group.pairs.length / 2
            || !group.stitchIndices.every(stitch => Number.isSafeInteger(stitch) && stitch >= 0 && stitch < dictionary.stitchCount)
            || group.seamId !== original?.seamId || !same(group.pairs, original.pairs)) throw Error('Invalid authoritative collision seam stitch dictionary');
        names.add(group.seamId);
        if (group.stitchIndexKinds !== undefined && (!Array.isArray(group.stitchIndexKinds)
            || group.stitchIndexKinds.length !== group.stitchIndices.length
            || group.stitchIndexKinds.some((kind, pair) => kind !== (group.pairs[pair * 2] === group.pairs[pair * 2 + 1]
                ? 'identity-logical' : 'reciprocal-first-stamp')))) throw Error('Invalid collision seam stitch index provenance');
        if (group.stitchIndexKinds === undefined && group.pairs.some((particle, at) => at % 2 === 0 && particle === group.pairs[at + 1]))
            throw Error('Identity seam pairs require explicit logical stitch provenance');
        return { seamId: group.seamId, index, pairs: group.pairs.slice(), stitchIndices: group.stitchIndices.slice(),
            ...(group.stitchIndexKinds !== undefined ? { stitchIndexKinds: group.stitchIndexKinds.slice() } : {}) };
    });
    return { stitchCount: dictionary.stitchCount, seamPairsBySeam };
}

function normalizeActivation(activation, dictionary) {
    if (!activation || !Number.isSafeInteger(activation.revision) || activation.revision < 0
        || !Number.isSafeInteger(activation.sewnUpTo) || activation.sewnUpTo < 0 || activation.sewnUpTo > dictionary.stitchCount
        || !(Array.isArray(activation.activeSeams) || activation.activeSeams instanceof Uint32Array)
        || activation.activeSeams.length !== dictionary.seamPairsBySeam.length
        || !Array.from(activation.activeSeams).every(value => value === 0 || value === 1)) throw Error('Invalid proof-used collision seam activation');
    return { revision: activation.revision, activeSeams: Array.from(activation.activeSeams), sewnUpTo: activation.sewnUpTo };
}

/** Immutable actual solver seam dictionary; legacy artifacts have no activation protocol. */
export function trajectorySeamTopologyHash(frozen) {
    const dictionary = seamDictionary(frozen);
    return dictionary && hash(Buffer.from(JSON.stringify(canonical(dictionary))));
}

function sourceAssemblyPolicyHash(frozen) {
    return hash(Buffer.from(JSON.stringify(canonical({ sourceStaging: frozen.sourceStaging ?? null,
        arrangementSourceStaging: frozen.arrangementSourceStaging ?? null, sourceStretchPolicy: frozen.sourceStretchPolicy ?? null }))));
}

/** Canonical immutable actual child paths and original material coordinates; legacy hashes stay unchanged. */
export function trajectoryRefinementGeometryHash(frozen) {
    if (frozen.sourceGatherRefinementRevision === undefined && frozen.sourceGatherCollisionGeometry === undefined) return undefined;
    const geometry = frozen.sourceGatherCollisionGeometry;
    if (frozen.sourceGatherRefinementRevision !== 'source-free-gather-boundary-v1' || !geometry
        || geometry.revision !== frozen.sourceGatherRefinementRevision) throw Error('Missing or mismatched actual refined seam geometry');
    if (frozen.sourceGatherRefinement !== undefined && hash(Buffer.from(JSON.stringify(canonical(frozen.sourceGatherRefinement))))
        !== geometry.refinementPolicySha256) throw Error('Captured refined numerical policy hash mismatch');
    return hash(Buffer.from(JSON.stringify(canonical({ declaredRevision: frozen.sourceGatherRefinementRevision,
        revision: geometry.revision, refinementPolicySha256: geometry.refinementPolicySha256,
        sourceCoordinateStride: geometry.sourceCoordinateStride,
        sourceMaterialCoordinates: Array.from(geometry.sourceMaterialCoordinates), intervals: geometry.intervals }))));
}

/** Used by both artifact writers and replay. This is the attempted gate, never the next/rolled-back stage. */
export async function trajectorySeamActivationHeader(frozen, activation) {
    const dictionary = seamDictionary(frozen);
    if (!dictionary) throw Error('Proof-used seam activation requires an immutable collision seam dictionary');
    // Snapshot before the asynchronous digest so a caller cannot change the bound mask.
    const seamActivation = normalizeActivation(activation, dictionary);
    const { collisionGuardActivationBinding } = await import('../../../packages/cloth-sim/src/collisionGuardWorkerProtocol.ts');
    const seamActivationSha256 = await collisionGuardActivationBinding({ ...seamActivation, activeSeams: Uint32Array.from(seamActivation.activeSeams) });
    return { seamTopologySha256: hash(Buffer.from(JSON.stringify(canonical(dictionary)))),
        sourceAssemblyPolicySha256: sourceAssemblyPolicyHash(frozen), seamActivation, seamActivationSha256,
        ...(trajectoryRefinementGeometryHash(frozen) ? { sourceGatherCollisionGeometrySha256: trajectoryRefinementGeometryHash(frozen) } : {}) };
}

function requiresActivation(frozen) {
    return frozen.collisionSeamDictionary !== undefined || frozen.collisionSeamActivation !== undefined
        || frozen.safetyReport?.seamActivation !== undefined || frozen.particleTrajectory?.seamActivation !== undefined
        || frozen.particleTrajectory?.seamActivationSha256 !== undefined || frozen.particleTrajectory?.seamTopologySha256 !== undefined
        || frozen.particleTrajectory?.sourceAssemblyPolicySha256 !== undefined || frozen.sourceStaging != null
        || frozen.arrangementSourceStaging != null || frozen.sourceAssemblyState != null
        || frozen.seamPairs?.some(group => group.stitchIndices !== undefined);
}

const guardBinding = frozen => hash(Buffer.from(JSON.stringify(canonical({ ...trajectorySourceHashes(frozen),
    seams: frozen.seams, seamPairs: frozen.seamPairs, particleCount: frozen.clothPositions.length / 4 }))));
export function trajectoryNumericBytes(values, integer = false) {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value,index) => { if(integer) bytes.writeUInt32LE(value,index*4); else bytes.writeFloatLE(value,index*4); });
    return bytes;
}
export function trajectorySourceHashes(frozen) {
    const seamTopologySha256 = trajectorySeamTopologyHash(frozen);
    const refinementHash = trajectoryRefinementGeometryHash(frozen);
    return { bodyPositionsSha256:hash(trajectoryNumericBytes(frozen.bodyPositions)),
        bodyIndicesSha256:hash(trajectoryNumericBytes(frozen.bodyIndices,true)),
        clothTrianglesSha256:hash(trajectoryNumericBytes(frozen.clothTriangles,true)),
        sourceFingerprintsSha256:hash(Buffer.from(JSON.stringify(canonical(frozen.sourceFingerprints)))),
        ...(refinementHash ? { sourceGatherCollisionGeometrySha256: refinementHash } : {}),
        ...(seamTopologySha256 ? { seamTopologySha256, sourceAssemblyPolicySha256: sourceAssemblyPolicyHash(frozen) } : {}) };
}
export async function createTrajectoryGuard(frozen) {
    // Node >=22.18 strips types in this pure CPU module; the GPU contact solver is not imported.
    const { ClothCollisionGuard } = await import('../../../packages/cloth-sim/src/collisionGuard.ts');
    const dictionary = seamDictionary(frozen);
    if (requiresActivation(frozen) && !dictionary) throw Error('Missing immutable collision seam dictionary for activated trajectory');
    const guard = new ClothCollisionGuard({bodyPositions:frozen.bodyPositions,bodyIndices:frozen.bodyIndices,
        clothTriangles:frozen.clothTriangles,particleCount:frozen.clothPositions.length/4,
        seams:frozen.seams,seamPairsBySeam:dictionary?.seamPairsBySeam ?? frozen.seamPairs,
        ...(dictionary ? { stitchCount: dictionary.stitchCount } : {}),
        ...(frozen.sourceGatherRefinementRevision !== undefined || frozen.sourceGatherCollisionGeometry !== undefined ? {
            sourceGatherRefinementRevision: frozen.sourceGatherRefinementRevision,
            sourceGatherCollisionGeometry: frozen.sourceGatherCollisionGeometry } : {}) });
    guardBindings.set(guard, guardBinding(frozen));
    return guard;
}
export async function auditParticleTrajectory(previous,current,currentFile,guard) {
    const result={fromFrame:previous.frame,toFrame:current.frame,passed:false,binaryVerified:false,sourceBindingVerified:false,endpointBindingVerified:false,errors:[]};
    try {
        const d=current.particleTrajectory,subSteps=current.simulationConfig?.subSteps,particleCount=current.clothPositions?.length/4;
        if(!d || !Number.isInteger(subSteps) || subSteps<1 || !Number.isInteger(particleCount) || particleCount<1) throw Error('Missing exact particle trajectory or simulation dimensions');
        if(d.format!==TRAJECTORY_FORMAT || d.subSteps!==subSteps || d.sampleCount!==subSteps+1 || d.particleCount!==particleCount || d.fromFrame!==previous.frame || d.toFrame!==current.frame || current.frame!==previous.frame+1) throw Error('Trajectory header dimensions/frame mismatch');
        if(!Array.isArray(d.stepIndices) || d.stepIndices.length!==subSteps+1 || d.stepIndices.some((step,index)=>step!==index)) throw Error('Missing or skipped trajectory substep');
        const source=trajectorySourceHashes(current);
        if(!current.inputSha256 || d.inputSha256!==current.inputSha256 || Object.entries(source).some(([key,value])=>d[key]!==value)) throw Error('Trajectory body/topology/source hash mismatch');
        const priorSource=trajectorySourceHashes(previous);
        if(previous.inputSha256!==current.inputSha256 || Object.entries(source).some(([key,value])=>priorSource[key]!==value)) throw Error('Consecutive trajectory source changed');
        result.sourceBindingVerified=true;
        let activation;
        if (requiresActivation(previous) || requiresActivation(current)) {
            if (!previous.collisionSeamDictionary || !current.collisionSeamDictionary) throw Error('Missing immutable collision seam dictionary for activated trajectory');
            const header = await trajectorySeamActivationHeader(current, current.collisionSeamActivation);
            if (!same(d.seamActivation, header.seamActivation) || d.seamActivationSha256 !== header.seamActivationSha256
                || d.seamTopologySha256 !== header.seamTopologySha256) throw Error('Trajectory proof-used seam activation/hash mismatch');
            if (current.safetyReport?.seamActivation !== undefined
                && !same(current.safetyReport.seamActivation, header.seamActivation)) throw Error('Trajectory seam activation differs from the actual worker proof');
            if (current.safetyReport?.seamActivation === undefined && !(current.diagnosticOnly === true
                && current.runtimeSafe === false && current.safetyReport?.trajectory?.valid === false)) throw Error('Missing actual worker seam activation evidence');
            activation = { ...header.seamActivation, activeSeams: Uint32Array.from(header.seamActivation.activeSeams) };
            result.seamActivationBindingVerified = true;
            result.seamActivation = header.seamActivation;
            result.seamActivationSha256 = header.seamActivationSha256;
            result.seamTopologySha256 = header.seamTopologySha256;
        }
        const length=(subSteps+1)*particleCount*4*4;
        if(d.byteLength!==length || typeof d.file!=='string' || !d.file || !/^[a-f0-9]{64}$/.test(d.sha256??'')) throw Error('Invalid trajectory byte layout/hash header');
        const file=resolve(dirname(currentFile),d.file),info=await stat(file);
        if(!info.isFile() || info.size!==length) throw Error('Truncated or extra trajectory bytes');
        const bytes=await readFile(file);
        if(hash(bytes)!==d.sha256) throw Error('Trajectory binary SHA mismatch');
        const block=particleCount*4, samples=[];
        for(let step=0;step<=subSteps;step++) {
            const positions=new Float32Array(block);
            for(let i=0;i<block;i++) positions[i]=bytes.readFloatLE((step*block+i)*4);
            if(!positions.every(Number.isFinite)) throw Error('Nonfinite trajectory sample');
            for(let i=3;i<block;i+=4) if(positions[i]!==previous.clothPositions[i] || positions[i]!==current.clothPositions[i]) throw Error('Trajectory inverse mass changed');
            samples.push(positions);
        }
        result.binaryVerified=true;result.file=file;result.sha256=d.sha256;result.sampleCount=samples.length;
        const first=trajectoryNumericBytes(samples[0]),last=trajectoryNumericBytes(samples.at(-1));
        if(hash(first)!==d.startPositionsSha256 || hash(last)!==d.endPositionsSha256 || !samples[0].every((value,index)=>value===previous.clothPositions[index]) || !samples.at(-1).every((value,index)=>value===current.clothPositions[index])) throw Error('Trajectory exact published endpoint mismatch');
        result.endpointBindingVerified=true;
        if (guardBindings.has(guard) && guardBindings.get(guard) !== guardBinding(current)) throw Error('Reused trajectory guard body/topology binding changed');
        const cpu=guardBindings.has(guard) ? guard : await createTrajectoryGuard(current);
        result.geometry=cpu.inspectTrajectory(samples.at(-1),samples[0],samples,subSteps,activation);
        result.passed=result.geometry.safe===true && result.geometry.trajectory?.valid===true && result.geometry.trajectory.inspectedSubsteps===subSteps
            && (!activation || current.safetyReport?.trajectory?.valid === true);
    } catch(error) { result.errors.push(error.message); }
    return result;
}
