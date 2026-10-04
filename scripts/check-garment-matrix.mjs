// Fresh production drapes; stopping on motion is only a candidate, never a fit certificate.
// node scripts/check-garment-matrix.mjs --fixtures work/matrix --until-settled --frames 800
// Independent auditors default to scripts/garmentcode/qa; --audit-directory overrides their location.
// Add later exact render evidence with --audit-only RUN_DIRECTORY --render-verification FILE.
// --raw-engine is diagnostic; --raw-default-config explicitly retains the global padding.
// --graphics-profile mesa-gles uses caller-provided Vulkan ICD environment; swiftshader is default.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir, readdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import {resolveHarnessGatherApproval} from './garmentcode/qa/gatherHarnessApproval.mjs';
import { trajectorySourceHashes, trajectorySeamActivationHeader, createTrajectoryGuard, auditParticleTrajectory } from './garmentcode/qa/particle-trajectory-audit.mjs';

function packedFloat32LE(values) {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    return bytes;
}
function packedUint32LE(values) {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
    return bytes;
}
function canonicalJson(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function graphicsProfileOptions(profile = 'swiftshader') {
    if (!['swiftshader', 'mesa-gles'].includes(profile))
        throw Error('--graphics-profile must be swiftshader or mesa-gles');
    return { profile, args: profile === 'mesa-gles' ? [
        '--enable-unsafe-webgpu', '--use-vulkan=native', '--use-angle=vulkan',
        '--enable-features=Vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist',
        '--use-webgpu-adapter=opengles', '--force-webgpu-compat', '--enable-logging=stderr'
    ] : ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader'],
    environmentPolicy: 'Inherit caller environment; no ICD or driver is installed or automatically selected.',
    directMesaAdapterIdentityVerified: false };
}

// Exact observed mask words remain arrays in portable JSON, not typed-array object keys.
export function recordSourceAssemblyState(stage) {
    if (stage == null) return null;
    if (!stage.activeSeamMask || !stage.activeStitchMask)
        throw Error('Missing actual source assembly masks');
    return { ...stage, activeSeamMask: Array.from(stage.activeSeamMask),
        activeStitchMask: Array.from(stage.activeStitchMask) };
}

export function recordCollisionSeamActivation(activation) {
    return activation == null ? null : { revision: activation.revision,
        activeSeams: Array.from(activation.activeSeams), sewnUpTo: activation.sewnUpTo };
}

// Binary layout is unchanged; this JSON header binds the actual proof-used gate.
export async function bindParticleTrajectoryActivation(frozen, descriptor) {
    Object.assign(descriptor, trajectorySourceHashes(frozen));
    if (frozen.collisionSeamDictionary !== undefined)
        Object.assign(descriptor, await trajectorySeamActivationHeader(frozen, frozen.collisionSeamActivation));
    else if (frozen.sourceStaging != null || frozen.sourceAssemblyState != null)
        throw Error('Missing immutable collision seam dictionary for staged trajectory');
    return descriptor;
}

export function productionAcceptanceEligible(summary, rawRequested = false, profileRequested = false) {
    return summary.halted === false && summary.rawEngine === false && !rawRequested
        && summary.gpuProfile !== true && !profileRequested && summary.motionCandidate === true;
}

export function parseSeamIterations(value) {
    if (value === undefined) return null;
    if (!/^[0-9]+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 64)
        throw Error('--seam-iterations must be an integer between 1 and 64');
    return Number(value);
}

export function parsePhaseObservation(frame, substep, ceiling, end = substep) {
    if (frame === undefined && substep === undefined && end === undefined) return null;
    if (frame === undefined || substep === undefined || !/^[0-9]+$/.test(frame) || !/^[0-9]+$/.test(substep)
        || !Number.isSafeInteger(Number(frame)) || Number(frame) < 1 || Number(frame) > ceiling
        || !Number.isSafeInteger(Number(substep)) || Number(substep) < 1
        || end === undefined || !/^[0-9]+$/.test(end) || !Number.isSafeInteger(Number(end)) || Number(end) < Number(substep))
        throw Error('--phase-frame/--phase-substep must be positive integers inside the frame ceiling; optional --phase-substep-end must be at least the starting substep');
    return { frame: Number(frame), substep: Number(substep), endSubstep: Number(end) };
}

export function requirePhaseSelfSurface(flag, phaseObservation) {
    if (flag && !phaseObservation) throw Error('--phase-self-surface requires --phase-frame and --phase-substep');
    return flag === true;
}

export function phaseSelfSurfaceBuffers(payload, frozen, candidatesFile, correctionsFile) {
    const budget = payload.selfSurfaceCandidateBudget, triangleCount = payload.selfSurfaceTriangleCount;
    if (!Number.isSafeInteger(budget) || budget < 1 || !Number.isSafeInteger(triangleCount) || triangleCount < 1
        || triangleCount !== frozen.clothTriangles.length / 4)
        throw Error('Self-surface phase diagnostic dimensions differ from actual cloth topology');
    if (budget !== (frozen.simulationConfig?.numInternalSurfaceCollisionConstraints ?? 32))
        throw Error('Self-surface phase candidate budget differs from actual simulation configuration');
    const candidateBytes = Buffer.from(payload.selfSurfaceCandidatesBase64 ?? '', 'base64');
    const correctionBytes = Buffer.from(payload.selfSurfaceCorrectionsBase64 ?? '', 'base64');
    if (candidateBytes.length !== triangleCount * budget * 4 || correctionBytes.length !== triangleCount * 3 * 4 * 4)
        throw Error('Truncated self-surface phase diagnostic buffer');
    const common = { diagnosticOnly: true, capture: 'Actual live GPU buffer at this stage; previous gather state remains where applicable.',
        triangleCount, inputSha256: frozen.inputSha256, ...trajectorySourceHashes(frozen) };
    return { candidateBytes, correctionBytes,
        candidates: { ...common, file: candidatesFile, format: 'uint32-le', byteLength: candidateBytes.length,
            elementCount: triangleCount * budget, candidateBudget: budget, sha256: sha256(candidateBytes),
            layout: 'triangle-major candidate words; low28 bits target triangle ID+2, source owner bits28/29, target owner bits30/31; raw words unchanged' },
        corrections: { ...common, file: correctionsFile, format: 'float32-le-vec4', byteLength: correctionBytes.length,
            elementCount: triangleCount * 3 * 4, vec4Count: triangleCount * 3, sha256: sha256(correctionBytes),
            layout: 'triangle-major three own-corner vec4s; xyz accumulated correction, w raw solver value; no normalization' } };
}

// Observation-only intermediate positions; none are eligible published motion samples.
export function packCollisionPhases(observations, particleCount, substep, endSubstep = substep, includeSelfSurfaceDiagnostics = false) {
    if (!observations?.length) throw Error('Missing selected collision phase observations');
    const stages = new Set();
    return observations.map(observation => {
        const key = observation.substep + ':' + observation.stage;
        if (!Number.isInteger(observation.substep) || observation.substep < substep || observation.substep > endSubstep
            || typeof observation.stage !== 'string' || !observation.stage
            || stages.has(key) || observation.positions?.length !== particleCount * 4)
            throw Error('Invalid selected collision phase observation');
        stages.add(key);
        const bytes = new Uint8Array(observation.positions.length * 4), view = new DataView(bytes.buffer);
        for (let i = 0; i < observation.positions.length; i++) {
            if (!Number.isFinite(observation.positions[i])) throw Error('Non-finite collision phase observation');
            view.setFloat32(i * 4, observation.positions[i], true);
        }
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        const payload = { substep: observation.substep, zeroBasedSubstep: observation.substep - 1, stage: observation.stage, base64: btoa(binary) };
        if (includeSelfSurfaceDiagnostics) {
            const candidates = observation.selfSurfaceCandidates, corrections = observation.selfSurfaceCorrections;
            const budget = observation.selfSurfaceCandidateBudget, triangleCount = observation.selfSurfaceTriangleCount;
            if (!(candidates instanceof Uint32Array) || !(corrections instanceof Float32Array)
                || !Number.isSafeInteger(budget) || budget < 1 || !Number.isSafeInteger(triangleCount) || triangleCount < 1
                || candidates.length !== triangleCount * budget || corrections.length !== triangleCount * 3 * 4)
                throw Error('Missing or invalid actual typed self-surface phase buffers');
            // Preserve raw Float32 bits, including signed zero and diagnostic NaN payloads.
            const encodeWords = values => {
                const words = new Uint32Array(values.buffer, values.byteOffset, values.length);
                const bytes = new Uint8Array(words.length * 4), view = new DataView(bytes.buffer);
                for (let i = 0; i < words.length; i++) view.setUint32(i * 4, words[i], true);
                let binary = '';
                for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
                return btoa(binary);
            };
            Object.assign(payload, { selfSurfaceCandidateBudget: budget, selfSurfaceTriangleCount: triangleCount,
                selfSurfaceCandidatesBase64: encodeWords(candidates), selfSurfaceCorrectionsBase64: encodeWords(corrections) });
        }
        return payload;
    });
}

export function buildParticleTrajectoryDescriptor(frozen, payload, file) {
    const bytes = Buffer.from(payload.base64, 'base64'), subSteps = payload.subSteps, particleCount = frozen.clothPositions.length / 4;
    const sliceBytes = particleCount * 16;
    if (!Number.isInteger(frozen.frame) || frozen.frame < 1 || !Number.isInteger(subSteps) || subSteps < 1
        || subSteps !== frozen.simulationConfig?.subSteps || !Number.isInteger(particleCount) || particleCount < 1
        || bytes.length !== sliceBytes * (subSteps + 1)) throw Error('Invalid or truncated actual substep trajectory');
    const start = packedFloat32LE(payload.startPositions), end = packedFloat32LE(frozen.clothPositions);
    if (start.length !== sliceBytes || !bytes.subarray(0, sliceBytes).equals(start)
        || !bytes.subarray(bytes.length - sliceBytes).equals(end)) throw Error('Trajectory start/end differs from actual frozen particle state');
    const publishedStart = payload.publishedStartPositions ? packedFloat32LE(payload.publishedStartPositions) : null;
    const publishedStartBindingVerified = publishedStart?.length === sliceBytes && publishedStart.equals(start);
    if (!publishedStartBindingVerified && frozen.kind !== 'rejectedDiagnostic') throw Error('Actual GPU trajectory start differs from prior published particles');
    for (let offset = 0; offset < bytes.length; offset += 4) {
        if (!Number.isFinite(bytes.readFloatLE(offset))) throw Error('Non-finite actual substep trajectory');
        if ((offset / 4) % 4 === 3 && bytes.readFloatLE(offset) !== start.readFloatLE(offset % sliceBytes))
            throw Error('Actual substep trajectory changes particle inverse mass');
    }
    return { file, sha256: sha256(bytes), format: 'float32-le-vec4', byteLength: bytes.length,
        sampleCount: subSteps + 1, subSteps, particleCount, stepIndices: Array.from({ length: subSteps + 1 }, (_, i) => i),
        fromFrame: frozen.frame - 1, toFrame: frozen.frame, inputSha256: frozen.inputSha256,
        bodyPositionsSha256: sha256(packedFloat32LE(frozen.bodyPositions)),
        bodyIndicesSha256: sha256(packedUint32LE(frozen.bodyIndices)),
        clothTrianglesSha256: sha256(packedUint32LE(frozen.clothTriangles)),
        sourceFingerprintsSha256: sha256(canonicalJson(frozen.sourceFingerprints)),
        publishedStartBindingVerified, publishedStartPositionsSha256: publishedStart ? sha256(publishedStart) : null,
        startPositionsSha256: sha256(start), endPositionsSha256: sha256(end) };
}

// Copied into the isolated browser realm; actual GPU samples only, no reconstructed trajectory.
export function packCollisionTrajectory(samples, subSteps, publishedStart, diagnosticOnly = false) {
    if (!samples || samples.length !== subSteps + 1 || !samples[0]?.length) throw Error('Missing exact collision substep trajectory');
    const startMatches = publishedStart?.length === samples[0].length && samples[0].every((value, index) => Object.is(value, publishedStart[index]));
    if (!startMatches && !diagnosticOnly) {
        const failure = new Error('Actual GPU trajectory start differs from prior published particles');
        failure.candidatePositions = samples.at(-1).slice();
        failure.candidateTrajectory = samples.map(sample => sample.slice());
        throw failure;
    }
    const length = samples[0].length, bytes = new Uint8Array(samples.length * length * 4), view = new DataView(bytes.buffer);
    samples.forEach((sample, step) => {
        if (sample.length !== length) throw Error('Collision trajectory particle count changed');
        for (let i = 0; i < length; i++) view.setFloat32((step * length + i) * 4, sample[i], true);
    });
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return { base64: btoa(binary), subSteps, startPositions: Array.from(samples[0]),
        publishedStartPositions: publishedStart ? Array.from(publishedStart) : null };
}

// Freeze semantic anchors together with the actual posed mesh they reference.
export function buildBodyAnatomicalReferences(definitions, vertices, indices) {
    const references = {};
    for (const name of ['neckSideToShoulder', 'neckToWaistBack']) {
        const definition = definitions.find(d => d.name === name);
        if (!definition?.coordinates?.length) continue;
        const coordinates = definition.coordinates.map(a => ({ faceIndex: a.faceIndex, u: a.u, v: a.v, w: a.w }));
        const points = coordinates.map(a => {
            const offset = a.faceIndex * 3;
            if (!Number.isInteger(a.faceIndex) || offset < 0 || offset + 2 >= indices.length
                || ![a.u, a.v, a.w].every(Number.isFinite)) return null;
            const face = [indices[offset], indices[offset + 1], indices[offset + 2]];
            if (face.some(i => !Number.isInteger(i) || i < 0 || i * 3 + 2 >= vertices.length)) return null;
            const point = [0, 1, 2].map(axis => a.u * vertices[face[0] * 3 + axis]
                + a.v * vertices[face[1] * 3 + axis] + a.w * vertices[face[2] * 3 + axis]);
            return point.every(Number.isFinite) ? point : null;
        });
        if (points.every(point => point !== null)) references[name] = { coordinates, points };
    }
    return references;
}

// Self-contained so the exact same implementation can run in the isolated browser realm.
export function createSettlementTracker(timeStep) {
    const windows = [];
    let samples = [], baselineFrame = null, passed = 0, lastObservedFrame = null, lastObservationEligible = false;
    function observe(frame, positions, state) {
        const priorObservedFrame = lastObservedFrame;
        lastObservedFrame = frame;
        if (priorObservedFrame !== null && frame !== priorObservedFrame + 1) { samples = []; baselineFrame = null; passed = 0; }
        const eligible = (state.sourceStretchPolicy?.policy !== 'source-authored-seam-stretch-v1' || state.sourceAssemblyComplete === true)
            && state.fullySewn === true && Number.isFinite(state.maxSeamGapMm) && state.maxSeamGapMm <= 3
            && state.temporarySupportWeightsNonzero === 0 && state.fixedAnchorWeightsNonzero === 0
            && state.bodyContacts === true && state.surfaceContacts === true && state.selfContacts === true && state.selfSurfaceContacts === true
            && state.runtimeSafe === true && state.halted === false
            && positions.length > 0 && positions.length % 4 === 0
            && Array.isArray(state.gravity) && state.gravity.length === 3 && state.gravity.every((v, i) => Number.isFinite(v) && Math.abs(v - [0, -9.8, 0][i]) < 1e-8)
            && Array.from(positions).every(Number.isFinite);
        lastObservationEligible = eligible;
        if (!eligible) { samples = []; baselineFrame = null; passed = 0; return null; }
        if (samples.length && samples[0].positions.length !== positions.length) { samples = []; baselineFrame = null; passed = 0; }
        samples.push({ frame, positions: positions.slice() });
        if (baselineFrame === null) { baselineFrame = frame; return null; }
        if (frame - baselineFrame !== 8) return null;
        let maximumRmsMm = 0, maximumParticleMm = 0, endpointRmsMm = 0, endpointMaximumMm = 0, pairs = 0;
        for (let from = 0; from < samples.length; from++) for (let to = from + 1; to < samples.length; to++) {
            let squared = 0, maxSquared = 0;
            for (let i = 0; i < positions.length; i += 4) {
                let distance = 0;
                for (let a = 0; a < 3; a++) distance += (samples[to].positions[i + a] - samples[from].positions[i + a]) ** 2;
                squared += distance; maxSquared = Math.max(maxSquared, distance);
            }
            const rmsMm = 1000 * Math.sqrt(squared / (positions.length / 4)), maximumMm = 1000 * Math.sqrt(maxSquared);
            maximumRmsMm = Math.max(maximumRmsMm, rmsMm); maximumParticleMm = Math.max(maximumParticleMm, maximumMm); pairs++;
            if (from === 0 && to === samples.length - 1) { endpointRmsMm = rmsMm; endpointMaximumMm = maximumMm; }
        }
        const window = { fromFrame: baselineFrame, toFrame: frame,
            fromSeconds: baselineFrame * timeStep, toSeconds: frame * timeStep,
            intervalSeconds: (frame - baselineFrame) * timeStep, observedFrameCount: samples.length, fullyReleasedForEntireWindow: true,
            rmsDisplacementMm: maximumRmsMm, maxDisplacementMm: maximumParticleMm,
            endpointRmsDisplacementMm: endpointRmsMm, endpointMaxDisplacementMm: endpointMaximumMm,
            motionMetric: 'maximum-all-frame-pairs', comparedFramePairs: pairs,
            sampleFrames: samples.map(sample => sample.frame), ...state };
        window.passed = window.intervalSeconds + 1e-9 >= .128
            && window.rmsDisplacementMm <= 1 && window.maxDisplacementMm <= 3;
        windows.push(window);
        passed = window.passed ? passed + 1 : 0;
        samples = [samples[samples.length - 1]]; baselineFrame = frame;
        return window;
    }
    return { observe, windows, get windowStartFrame() { return baselineFrame; }, get lastObservationEligible() { return lastObservationEligible; },
        get motionCandidate() { return passed >= 2 && baselineFrame === lastObservedFrame; } };
}

export function buildRejectedDiagnostic(lastSnapshot, candidatePositions, attemptedFrame, report, attemptedState = {}) {
    const candidate = candidatePositions ? Array.from(candidatePositions) : [];
    if (!Number.isInteger(attemptedFrame) || attemptedFrame < 0 || !candidate.length || candidate.length % 4 !== 0
        || candidate.length !== lastSnapshot.clothPositions.length || !candidate.every(Number.isFinite)) return null;
    const gaps = [], count = candidate.length / 4;
    for (let i = 0; i < count; i++) for (let k = 0; k < 4; k++) {
        const j = lastSnapshot.seams[i * 4 + k];
        if (j > i && j < count) gaps.push(1000 * Math.hypot(...[0, 1, 2].map(a => candidate[i * 4 + a] - candidate[j * 4 + a])));
    }
    gaps.sort((a, b) => a - b);
    let squared = 0, maximum = 0;
    for (let i = 0; i < candidate.length; i += 4) {
        let delta = 0;
        for (let a = 0; a < 3; a++) delta += (candidate[i + a] - lastSnapshot.clothPositions[i + a]) ** 2;
        squared += delta; maximum = Math.max(maximum, delta);
    }
    return { ...lastSnapshot, ...attemptedState, kind: 'rejectedDiagnostic', rejected: true, accepted: false,
        frame: attemptedFrame, attemptedFrame, lastAcceptedFrame: lastSnapshot.accepted === false ? null : lastSnapshot.frame,
        simulatedSeconds: attemptedFrame * lastSnapshot.simulatedSecondsPerFrame, clothPositions: candidate,
        positionsFinite: true, maxSeamGapMm: gaps.at(-1) ?? 0,
        p95SeamGapMm: gaps[Math.floor(gaps.length * .95)] ?? 0,
        rmsSincePriorMm: null, candidateMotionDiagnosticOnly: true,
        rmsSinceLastAcceptedMm: 1000 * Math.sqrt(squared / count), maxDisplacementSinceLastAcceptedMm: 1000 * Math.sqrt(maximum),
        safetyReport: structuredClone(report), runtimeSafe: false, halted: true, motionCandidate: false, releaseWindows: [],
        // These are observations after a rejected attempt, not an accepted release observation.
        supportStatesObservedAfterRejection: structuredClone(attemptedState.assemblySupportStates ?? []),
        candidateSupportStateAvailable: false,
        lastAcceptedAssemblySupportStates: structuredClone(lastSnapshot.assemblySupportStates ?? []),
        assemblySupportStates: null, assemblySupportSnapshot: null, temporarySupportWeightsNonzero: null, supportStateDiagnosticOnly: true,
        lastAcceptedAssemblySupportSnapshot: structuredClone(lastSnapshot.assemblySupportSnapshot ?? null),
        supportSnapshotObservedAfterRejection: structuredClone(attemptedState.assemblySupportSnapshot ?? null),
        sourceAssemblyState: null, sourceAssemblyComplete: null, fullySewn: false, sewnUpTo: null,
        lastAcceptedSourceAssemblyState: structuredClone(lastSnapshot.sourceAssemblyState ?? null),
        lastAcceptedSourceAssemblyComplete: lastSnapshot.sourceAssemblyComplete ?? null,
        sourceAssemblyStateObservedAfterRejection: structuredClone(attemptedState.sourceAssemblyState ?? null),
        candidateSourceAssemblyState: structuredClone(attemptedState.candidateSourceAssemblyState ?? null),
        lastAcceptedCollisionSeamActivation: structuredClone(lastSnapshot.collisionSeamActivation ?? null),
        collisionSeamActivation: structuredClone(attemptedState.candidateSeamActivation ?? null),
        benchmarkPolicy: { ...lastSnapshot.benchmarkPolicy, diagnosticOnly: true } };
}

export function inferAcceptanceScope(fixture, pieceNames, openingsApplicable, groups = []) {
    const style = [fixture.request?.preset ?? '', fixture.id ?? '', ...pieceNames].join(' ').toLowerCase();
    const hasLegs = /pants?|trouser|jumpsuit|(?:^|_)js(?:_|$)/.test(style);
    const hasSkirt = /skirt|dress/.test(style);
    const hasTop = /shirt|tee|hood|torso|dress|jumpsuit/.test(style);
    const shoulderApplicable = hasTop || groups.some(g => g.kind === 'shoulder') || fixture.shoulderApplicable === true;
    const regions = new Set();
    if (hasTop) for (const name of ['neck', 'leftUnderarm', 'rightUnderarm', 'waist']) regions.add(name);
    if (hasSkirt || hasLegs) for (const name of ['waist', 'hips', 'pelvis']) regions.add(name);
    if (hasLegs) for (const name of ['crotch', 'leftThigh', 'rightThigh', 'leftCalf', 'rightCalf']) regions.add(name);
    if (openingsApplicable) for (const name of ['leftWrist', 'rightWrist', 'leftForearm', 'rightForearm']) regions.add(name);
    // Explicit fixture scope can add coverage; it cannot remove inferred mandatory regions.
    if (Array.isArray(fixture.requiredCoveredRegions)) for (const name of fixture.requiredCoveredRegions)
        if (typeof name === 'string' && name.length > 0) regions.add(name);
    return { shoulderApplicable, requiredCoveredRegions: [...regions] };
}

async function selfTest() {
    assert.deepEqual(graphicsProfileOptions().args, ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader']);
    const mesaProfile = graphicsProfileOptions('mesa-gles');
    assert.ok(mesaProfile.args.includes('--use-webgpu-adapter=opengles'));
    assert.ok(mesaProfile.args.includes('--force-webgpu-compat'));
    assert.ok(!mesaProfile.args.some(arg => /skip.validation|disable.robustness|swiftshader/.test(arg)));
    assert.equal(mesaProfile.directMesaAdapterIdentityVerified, false);
    mesaProfile.args.push('changed');
    assert.ok(!graphicsProfileOptions('mesa-gles').args.includes('changed'));
    assert.throws(() => graphicsProfileOptions('vulkan'));
    const certifying = { halted: false, rawEngine: false, motionCandidate: true };
    assert.equal(productionAcceptanceEligible(certifying), true);
    assert.equal(productionAcceptanceEligible({ ...certifying, gpuProfile: true }), false);
    assert.equal(productionAcceptanceEligible(certifying, false, true), false);
    assert.equal(productionAcceptanceEligible({ ...certifying, rawEngine: true }), false);
    assert.equal(productionAcceptanceEligible(certifying, true), false);
    assert.equal(productionAcceptanceEligible({ ...certifying, halted: undefined }), false);
    assert.equal(parseSeamIterations(undefined), null);
    for (const value of ['1', '16', '64']) assert.equal(parseSeamIterations(value), Number(value));
    for (const value of ['', '0', '65', '-1', '1.5', 'Infinity', '16junk']) assert.throws(() => parseSeamIterations(value));
    assert.equal(parsePhaseObservation(undefined, undefined, 8), null);
    assert.deepEqual(parsePhaseObservation('5', '23', 8), { frame: 5, substep: 23, endSubstep: 23 });
    assert.deepEqual(parsePhaseObservation('1', '12', 8, '18'), { frame: 1, substep: 12, endSubstep: 18 });
    assert.throws(() => parsePhaseObservation('1', '18', 8, '12'));
    assert.throws(() => parsePhaseObservation(undefined, undefined, 8, '12'));
    for (const args of [[undefined, '23', 8], ['5', undefined, 8], ['9', '23', 8], ['5', '0', 8], ['1.5', '23', 8]])
        assert.throws(() => parsePhaseObservation(...args));
    const phase = { substep: 23, stage: 'sewing', positions: new Float32Array([1, 2, 3, 0]) };
    assert.ok(Buffer.from(packCollisionPhases([phase], 1, 23)[0].base64, 'base64').equals(packedFloat32LE(phase.positions)));
    assert.throws(() => packCollisionPhases([phase, phase], 1, 23));
    assert.throws(() => packCollisionPhases([phase], 2, 23));
    assert.throws(() => packCollisionPhases([phase], 1, 22));
    assert.equal(packCollisionPhases([phase, { ...phase, substep: 24 }], 1, 23, 24).length, 2);
    assert.throws(() => packCollisionPhases([{ ...phase, substep: 25 }], 1, 23, 24));
    assert.throws(() => packCollisionPhases([{ ...phase, positions: [NaN, 2, 3, 0] }], 1, 23));
    assert.equal(requirePhaseSelfSurface(false, null), false);
    assert.throws(() => requirePhaseSelfSurface(true, null), /requires/);
    assert.equal(requirePhaseSelfSurface(true, { frame: 1, substep: 23 }), true);
    const packedCandidateWords = new Uint32Array([0, 1, 0xA0000042, 0xFFFFFFFF]);
    const correctionWords = new Uint32Array([0x80000000, 0x7FC01234, 0x3F800000, 0x3F800000, 0, 0, 0, 0, 0, 0, 0, 0]);
    const phaseWithBuffers = { ...phase, selfSurfaceCandidates: packedCandidateWords,
        selfSurfaceCorrections: new Float32Array(correctionWords.buffer), selfSurfaceCandidateBudget: 4, selfSurfaceTriangleCount: 1 };
    assert.throws(() => packCollisionPhases([phase], 1, 23, 23, true), /typed/);
    const surfacePayload = packCollisionPhases([phaseWithBuffers], 1, 23, 23, true)[0];
    assert.ok(Buffer.from(surfacePayload.selfSurfaceCandidatesBase64, 'base64').equals(packedUint32LE(packedCandidateWords)));
    assert.ok(Buffer.from(surfacePayload.selfSurfaceCorrectionsBase64, 'base64').equals(packedUint32LE(correctionWords)), 'raw signed zero and NaN payload bits are retained');
    const surfaceFrozen = { simulationConfig: { numInternalSurfaceCollisionConstraints: 4 }, clothTriangles: [0, 0, 0, 0], clothPositions: [1, 2, 3, 0], bodyPositions: [0, 0, 0], bodyIndices: [0, 0, 0], inputSha256: 'fixture', sourceFingerprints: {} };
    const surfaceFiles = phaseSelfSurfaceBuffers(surfacePayload, surfaceFrozen, 'candidates.bin', 'corrections.bin');
    assert.equal(surfaceFiles.candidates.elementCount, 4); assert.equal(surfaceFiles.corrections.vec4Count, 3);
    assert.equal(surfaceFiles.candidates.sha256, sha256(packedUint32LE(packedCandidateWords)));
    assert.equal(surfaceFiles.corrections.sha256, sha256(packedUint32LE(correctionWords)));
    assert.throws(() => phaseSelfSurfaceBuffers({ ...surfacePayload, selfSurfaceCandidatesBase64: 'AA==' }, surfaceFrozen, 'a', 'b'), /Truncated/);
    assert.throws(() => phaseSelfSurfaceBuffers({ ...surfacePayload, selfSurfaceTriangleCount: 2 }, surfaceFrozen, 'a', 'b'), /topology/);
    assert.throws(() => phaseSelfSurfaceBuffers(surfacePayload, { ...surfaceFrozen, simulationConfig: { numInternalSurfaceCollisionConstraints: 8 } }, 'a', 'b'), /budget/);
    assert.throws(() => packCollisionPhases([{ ...phaseWithBuffers, selfSurfaceCorrections: new Float32Array(4) }], 1, 23, 23, true), /typed/);
    const traceStart = new Float32Array([0, 1, 0, 1]), traceEnd = new Float32Array([.001, 1, 0, 1]);
    const traceFrozen = { frame: 3, simulationConfig: { subSteps: 1 }, clothPositions: Array.from(traceEnd), bodyPositions: [0, 1, 0],
        bodyIndices: [0, 0, 0], clothTriangles: [0, 0, 0, 0], inputSha256: 'fixture', sourceFingerprints: { b: 'two', a: 'one' } };
    const tracePayload = packCollisionTrajectory([traceStart, traceEnd], 1, traceStart);
    const traceDescriptor = buildParticleTrajectoryDescriptor(traceFrozen, tracePayload, 'trace.bin');
    assert.equal(traceDescriptor.sampleCount, 2); assert.equal(traceDescriptor.fromFrame, 2);
    assert.equal(traceDescriptor.sha256, sha256(Buffer.from(tracePayload.base64, 'base64')));
    assert.equal(traceDescriptor.sourceFingerprintsSha256, sha256(canonicalJson({ a: 'one', b: 'two' })));
    const independentSourceHashes = trajectorySourceHashes(traceFrozen);
    for (const [field, expected] of Object.entries(independentSourceHashes)) assert.equal(traceDescriptor[field], expected, 'writer hash must match independent reload auditor');
    assert.throws(() => buildParticleTrajectoryDescriptor(traceFrozen, { ...tracePayload, base64: Buffer.from(tracePayload.base64, 'base64').subarray(4).toString('base64') }, 'bad.bin'), /truncated/);
    assert.throws(() => buildParticleTrajectoryDescriptor({ ...traceFrozen, clothPositions: [1, 1, 0, 1] }, tracePayload, 'bad.bin'), /start\/end/);
    assert.throws(() => buildParticleTrajectoryDescriptor(traceFrozen, { ...tracePayload, startPositions: [1, 1, 0, 1] }, 'bad.bin'), /start\/end/);
    const actualGpuStart = new Float32Array([.0002, 1, 0, 1]);
    let mismatchedStartFailure;
    try { packCollisionTrajectory([actualGpuStart, traceEnd], 1, traceStart); }
    catch (error) { mismatchedStartFailure = error; }
    assert.match(mismatchedStartFailure?.message ?? '', /Actual GPU trajectory start/);
    assert.deepEqual(mismatchedStartFailure.candidateTrajectory[0], actualGpuStart, 'a start mismatch preserves the actual GPU sample');
    assert.deepEqual(mismatchedStartFailure.candidatePositions, traceEnd, 'a start mismatch retains exact rejected endpoint geometry');
    const mismatchedStartDiagnostic = packCollisionTrajectory(mismatchedStartFailure.candidateTrajectory, 1, traceStart, true);
    const rejectedTraceDescriptor = buildParticleTrajectoryDescriptor({ ...traceFrozen, kind: 'rejectedDiagnostic' }, mismatchedStartDiagnostic, 'diagnostic.bin');
    assert.equal(rejectedTraceDescriptor.publishedStartBindingVerified, false, 'an actual hidden seed transform stays explicitly noncertifying');
    assert.equal(Buffer.from(mismatchedStartDiagnostic.base64, 'base64').readFloatLE(0), actualGpuStart[0], 'diagnostic slot0 is never replaced with the CPU start');
    assert.throws(() => buildParticleTrajectoryDescriptor(traceFrozen, mismatchedStartDiagnostic, 'bad.bin'), /prior published/);
    assert.throws(() => packCollisionTrajectory([traceStart, traceEnd], 1), /prior published/, 'missing prior state cannot certify a GPU start');
    const negativeZero = new Float32Array([-0, 1, 0, 1]);
    assert.throws(() => packCollisionTrajectory([negativeZero, traceEnd], 1, traceStart), /prior published/, 'published start binding preserves exact Float32 sign bits');
    assert.throws(() => buildParticleTrajectoryDescriptor({ ...traceFrozen, simulationConfig: { subSteps: 40 } }, tracePayload, 'bad.bin'), /truncated/);
    const invalidMass = packCollisionTrajectory([traceStart, new Float32Array([.0005, 1, 0, 2]), traceEnd], 2, traceStart);
    assert.throws(() => buildParticleTrajectoryDescriptor({ ...traceFrozen, simulationConfig: { subSteps: 2 } }, invalidMass, 'bad.bin'), /inverse mass/);
    const nonfinite = packCollisionTrajectory([traceStart, new Float32Array([NaN, 1, 0, 1]), traceEnd], 2, traceStart);
    assert.throws(() => buildParticleTrajectoryDescriptor({ ...traceFrozen, simulationConfig: { subSteps: 2 } }, nonfinite, 'bad.bin'), /Non-finite/);
    const fortySteps = Array.from({ length: 41 }, (_, step) => {
        const positions = new Float32Array(260 * 4);
        for (let i = 0; i < positions.length; i += 4) {
            positions[i] = .5 + step * .00001 + i * .000025;
            positions[i + 1] = 1 + (i === 4 ? .001 : 0);
            positions[i + 2] = i === 8 ? .001 : 0; positions[i + 3] = 1;
        }
        return positions;
    });
    const fortyPayload = packCollisionTrajectory(fortySteps, 40, fortySteps[0]);
    const fortyDescriptor = buildParticleTrajectoryDescriptor({ ...traceFrozen, simulationConfig: { subSteps: 40 },
        clothPositions: Array.from(fortySteps[40]) }, fortyPayload, 'forty.bin');
    assert.equal(fortyDescriptor.sampleCount, 41); assert.equal(fortyDescriptor.byteLength, 41 * 260 * 16);
    assert.equal(fortyDescriptor.stepIndices.at(-1), 40);
    assert.equal(fortyDescriptor.publishedStartBindingVerified, true);
    assert.equal(Buffer.from(fortyPayload.base64, 'base64').readFloatLE(40 * 260 * 16), fortySteps[40][0], 'multi-chunk encoding keeps actual final Float32 bits');
    // Exercise the independent disk loader, including corruption and published-start binding.
    // Geometry is separately tested by the authoritative guard's trajectory regressions.
    await mkdir(resolve('work'), { recursive: true });
    const traceDirectory = await mkdtemp(join(resolve('work'), 'garment-matrix-self-test-'));
    try {
        const traceFile = join(traceDirectory, 'actual-trajectory.bin');
        const current = { ...traceFrozen, simulationConfig: { subSteps: 40 }, clothPositions: Array.from(fortySteps[40]),
            bodyPositions: [-.1,-.1,-.1,.1,-.1,-.1,.1,.1,-.1,-.1,.1,-.1,-.1,-.1,.1,.1,-.1,.1,.1,.1,.1,-.1,.1,.1],
            bodyIndices: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5],
            clothTriangles: [0,1,2,0], seams: Array(260 * 4).fill(-1), seamPairs: [] };
        current.particleTrajectory = buildParticleTrajectoryDescriptor(current, fortyPayload, traceFile);
        const prior = { ...current, frame: current.frame - 1, clothPositions: Array.from(fortySteps[0]) };
        let guardCalls = 0;
        const geometryGuard = await createTrajectoryGuard(current);
        const inspectTrajectory = geometryGuard.inspectTrajectory.bind(geometryGuard);
        geometryGuard.inspectTrajectory = (final, initial, samples, expected, activation) => {
            guardCalls++;
            assert.deepEqual(initial, fortySteps[0]); assert.deepEqual(final, fortySteps[40]);
            assert.equal(samples.length, 41); assert.equal(expected, 40);
            return inspectTrajectory(final, initial, samples, expected, activation);
        };
        const bytes = Buffer.from(fortyPayload.base64, 'base64');
        await writeFile(traceFile, bytes);
        const bound = await auditParticleTrajectory(prior, current, join(traceDirectory, 'frame-3-frozen.json'), geometryGuard);
        assert.equal(bound.passed, true); assert.equal(bound.endpointBindingVerified, true); assert.equal(guardCalls, 1);
        const incorrectStart = { ...prior, clothPositions: [...prior.clothPositions] }; incorrectStart.clothPositions[0] = .1;
        const mismatched = await auditParticleTrajectory(incorrectStart, current, join(traceDirectory, 'frame-3-frozen.json'), geometryGuard);
        assert.equal(mismatched.passed, false); assert.equal(mismatched.endpointBindingVerified, false); assert.equal(guardCalls, 1);
        await writeFile(traceFile, bytes.subarray(0, bytes.length - 4));
        const truncated = await auditParticleTrajectory(prior, current, join(traceDirectory, 'frame-3-frozen.json'), geometryGuard);
        assert.equal(truncated.passed, false); assert.match(truncated.errors.join(' '), /Truncated/); assert.equal(guardCalls, 1);
        const corrupted = Buffer.from(bytes); corrupted[20] ^= 1; await writeFile(traceFile, corrupted);
        const altered = await auditParticleTrajectory(prior, current, join(traceDirectory, 'frame-3-frozen.json'), geometryGuard);
        assert.equal(altered.passed, false); assert.match(altered.errors.join(' '), /SHA mismatch/); assert.equal(guardCalls, 1);
        // Modern source artifacts bind the real stitch dictionary and proof-used mask.
        await writeFile(traceFile, bytes);
        const activation = { revision: 7, activeSeams: [1], sewnUpTo: 1 };
        const modern = { ...current, stitchCount: 1, seamPairs: [{ seamId: 'source-seam', pairs: [0, 1] }],
            collisionSeamDictionary: { stitchCount: 1, seamPairsBySeam: [
                { seamId: 'source-seam', index: 0, pairs: [0, 1], stitchIndices: [0], stitchIndexKinds: ['reciprocal-first-stamp'] }] },
            collisionSeamActivation: activation, sourceStaging: { revision: 4, structuralSeamIds: ['source-seam'] },
            safetyReport: { seamActivation: structuredClone(activation), trajectory: { valid: true } },
            seams: [...current.seams] };
        modern.seams[0] = 1; modern.seams[4] = 0;
        modern.particleTrajectory = await bindParticleTrajectoryActivation(modern,
            buildParticleTrajectoryDescriptor(modern, fortyPayload, traceFile));
        const modernPrior = { ...modern, frame: modern.frame - 1, clothPositions: [...prior.clothPositions] };
        const actualBound = await auditParticleTrajectory(modernPrior, modern, join(traceDirectory, 'frame-3-frozen.json'));
        assert.equal(actualBound.passed, true, JSON.stringify(actualBound.errors));
        assert.equal(actualBound.seamActivationBindingVerified, true);
        const changedMask = { ...modern, collisionSeamActivation: { ...activation, activeSeams: [0] } };
        const maskMismatch = await auditParticleTrajectory(modernPrior, changedMask, join(traceDirectory, 'frame-3-frozen.json'));
        assert.equal(maskMismatch.passed, false); assert.match(maskMismatch.errors.join(' '), /activation\/hash mismatch/);
        const wrongProof = { ...modern, safetyReport: { ...modern.safetyReport,
            seamActivation: { ...activation, sewnUpTo: 0 } } };
        const proofMismatch = await auditParticleTrajectory(modernPrior, wrongProof, join(traceDirectory, 'frame-3-frozen.json'));
        assert.equal(proofMismatch.passed, false); assert.match(proofMismatch.errors.join(' '), /actual worker proof/);
        await assert.rejects(() => bindParticleTrajectoryActivation({ ...modern, collisionSeamDictionary: undefined },
            { ...modern.particleTrajectory }), /Missing immutable collision seam dictionary/);
    } finally { await rm(traceDirectory, { recursive: true, force: true }); }
    const definition = { name: 'neckSideToShoulder', coordinates: [{ faceIndex: 0, u: .25, v: .5, w: .25 }] };
    const anatomy = buildBodyAnatomicalReferences([definition], [0, 0, 0, 4, 0, 0, 0, 8, 0], [0, 1, 2]);
    assert.deepEqual(anatomy.neckSideToShoulder.points, [[2, 2, 0]], 'semantic anchors use the actual posed triangle');
    assert.deepEqual(anatomy.neckSideToShoulder.coordinates, definition.coordinates);
    assert.notEqual(anatomy.neckSideToShoulder.coordinates[0], definition.coordinates[0], 'reference definitions are copied');
    assert.deepEqual(buildBodyAnatomicalReferences([{ ...definition, coordinates: [{ ...definition.coordinates[0], faceIndex: 3 }] }],
        [0, 0, 0], [0, 0, 0]), {}, 'invalid mesh references cannot fabricate anatomical evidence');
    const p = new Float32Array([0, 0, 0, 1]);
    const observedAssembly = { allActive: false, enabledStitchCount: 1, totalStitchCount: 2,
        activeSeamMask: new Uint32Array([1, 0]), activeStitchMask: new Uint32Array([1, 0]) };
    const portableAssembly = recordSourceAssemblyState(observedAssembly);
    assert.deepEqual(JSON.parse(JSON.stringify(portableAssembly)).activeStitchMask, [1, 0]);
    portableAssembly.activeSeamMask[0] = 0;
    assert.equal(observedAssembly.activeSeamMask[0], 1, 'portable evidence cannot mutate actual mask words');
    assert.equal(recordSourceAssemblyState(null), null);
    assert.throws(() => recordSourceAssemblyState({ allActive: true }), /Missing actual/);
    const free = { fullySewn: true, maxSeamGapMm: 0, temporarySupportWeightsNonzero: 0,
        fixedAnchorWeightsNonzero: 0, bodyContacts: true, surfaceContacts: true, selfContacts: true, selfSurfaceContacts: true,
        runtimeSafe: true, halted: false, gravity: [0, -9.8, 0] };
    const tracker = createSettlementTracker(.016);
    for (let f = 0; f <= 16; f++) tracker.observe(f, p, { ...free, temporarySupportWeightsNonzero: f < 5 ? 1 : 0 });
    assert.equal(tracker.motionCandidate, false, 'supported/overlapping windows cannot pass');
    for (let f = 17; f <= 21; f++) tracker.observe(f, p, free);
    assert.equal(tracker.motionCandidate, true);
    assert.deepEqual(tracker.windows.map(w => [w.fromFrame, w.toFrame]), [[5, 13], [13, 21]]);
    tracker.observe(22, p, free);
    assert.equal(tracker.motionCandidate, false, 'partial final interval cannot reuse older settled windows');
    tracker.observe(22, p, { ...free, halted: true });
    assert.equal(tracker.motionCandidate, false, 'guard pause cannot count as convergence');
    const moving = createSettlementTracker(.016);
    for (let f = 0; f <= 16; f++) moving.observe(f, new Float32Array([f * .001, 0, 0, 1]), free);
    assert.equal(moving.motionCandidate, false, 'moving free garment cannot pass');
    const returning = createSettlementTracker(.016);
    for (let f = 0; f <= 16; f++) returning.observe(f, new Float32Array([f % 8 === 4 ? .004 : 0, 0, 0, 1]), free);
    assert.equal(returning.motionCandidate, false, 'returning oscillation cannot masquerade as zero endpoint motion');
    assert.equal(returning.windows[0].endpointRmsDisplacementMm, 0);
    assert.ok(returning.windows[0].maxDisplacementMm > 3.9);
    assert.equal(returning.windows[0].comparedFramePairs, 36);
    assert.deepEqual(returning.windows[0].sampleFrames, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const opposite = createSettlementTracker(.016), excursion = manyParticles();
    function manyParticles() { const values = new Float32Array(80); for (let i = 3; i < values.length; i += 4) values[i] = 1; return values; }
    for (let f = 0; f <= 16; f++) {
        excursion[0] = f % 8 === 2 ? -.002 : f % 8 === 6 ? .002 : 0;
        opposite.observe(f, excursion, free);
    }
    assert.equal(opposite.motionCandidate, false, 'opposite excursions below3mm from baseline still exceed3mm pairwise');
    assert.ok(opposite.windows[0].rmsDisplacementMm < 1, 'particle maximum must reject even when pairwise RMS is low');
    assert.ok(opposite.windows[0].maxDisplacementMm > 3.9);
    const oppositeRms = createSettlementTracker(.016), gentle = createSettlementTracker(.016);
    for (let f = 0; f <= 16; f++) {
        const sign = f % 8 === 2 ? -1 : f % 8 === 6 ? 1 : 0;
        oppositeRms.observe(f, new Float32Array([sign * .0006, 0, 0, 1]), free);
        gentle.observe(f, new Float32Array([sign * .0004, 0, 0, 1]), free);
    }
    assert.equal(oppositeRms.motionCandidate, false, 'sub1mm baseline excursions can exceed1mm between observed frames');
    assert.ok(oppositeRms.windows[0].maxDisplacementMm < 3);
    assert.equal(gentle.motionCandidate, true, 'small bounded oscillation remains eligible under unchanged limits');
    const maximum = createSettlementTracker(.016), many = new Float32Array(80);
    for (let i = 3; i < many.length; i += 4) many[i] = 1;
    maximum.observe(0, many, free);
    const oneMoving = many.slice(); oneMoving[0] = .004;
    for (let f = 1; f <= 8; f++) maximum.observe(f, oneMoving, free);
    assert.equal(maximum.windows[0].passed, false, 'low RMS cannot hide one particle moving more than3mm');
    const missingHalt = createSettlementTracker(.016), noHalt = { ...free }; delete noHalt.halted;
    for (let f = 0; f <= 16; f++) missingHalt.observe(f, p, noHalt);
    assert.equal(missingHalt.motionCandidate, false, 'missing halt state is not safe evidence');
    for (const bad of [{ selfSurfaceContacts: false }, { gravity: [] }, { gravity: [0, 0, 0] }, { maxSeamGapMm: 3.01 }, { fullySewn: false }, { runtimeSafe: false }, { fixedAnchorWeightsNonzero: 1 }]) {
        const t = createSettlementTracker(.016);
        for (let f = 0; f <= 16; f++) t.observe(f, p, { ...free, ...bad });
        assert.equal(t.motionCandidate, false);
    }
    assert.deepEqual(inferAcceptanceScope({ id: 'tee-short-164' }, [], false).requiredCoveredRegions,
        ['neck', 'leftUnderarm', 'rightUnderarm', 'waist']);
    assert.equal(inferAcceptanceScope({ id: 'shirt-long-176' }, [], true).requiredCoveredRegions.includes('leftWrist'), true);
    assert.deepEqual(inferAcceptanceScope({ id: 'skirt-170' }, [], false),
        { shoulderApplicable: false, requiredCoveredRegions: ['waist', 'hips', 'pelvis'] });
    assert.equal(inferAcceptanceScope({ id: 'pants-183' }, [], false).requiredCoveredRegions.includes('leftCalf'), true);
    assert.equal(inferAcceptanceScope({ id: 'dress-sleeveless-176' }, [], false).requiredCoveredRegions.includes('pelvis'), true);
    assert.equal(inferAcceptanceScope({ id: 'unknown' }, [], false).requiredCoveredRegions.length, 0);
    assert.equal(inferAcceptanceScope({ id: 'tee', shoulderApplicable: false, requiredCoveredRegions: [] }, [], false).shoulderApplicable, true);
    const acceptedSnapshot = { frame: 2, accepted: true, simulatedSecondsPerFrame: .016,
        clothPositions: [0, 0, 0, 1, .002, 0, 0, 1], seams: [1, -1, -1, -1, 0, -1, -1, -1],
        maxSeamGapMm: 2, assemblySupportStates: [{ id: 'seam', phase: 'assembling', scale: 1 }],
        assemblySupportSnapshot: { targets: [1.2, 1, 0, 0] },
        sourceAssemblyState: { allActive: false, enabledStitchCount: 1 }, sourceAssemblyComplete: false,
        collisionSeamActivation: { revision: 2, activeSeams: [1, 0], sewnUpTo: 1 },
        releaseWindows: [{ passed: true }], motionCandidate: true };
    const originalSnapshot = structuredClone(acceptedSnapshot);
    const candidate = new Float32Array([0, 0, 0, 1, .005, 0, 0, 1]);
    const diagnostic = buildRejectedDiagnostic(acceptedSnapshot, candidate, 3, { safe: false },
        { maxSeamGapMm: 0, assemblySupportStates: [{ id: 'seam', phase: 'released', scale: 0 }],
            assemblySupportSnapshot: { targets: [1.21, 0, 0, 0] },
            sourceAssemblyState: { allActive: true }, sourceAssemblyComplete: true,
            candidateSeamActivation: { revision: 3, activeSeams: [1, 1], sewnUpTo: 2 },
            candidateSourceAssemblyState: { allActive: true, enabledStitchCount: 2 } });
    assert.equal(diagnostic.frame, 3); assert.equal(diagnostic.lastAcceptedFrame, 2);
    assert.equal(diagnostic.kind, 'rejectedDiagnostic'); assert.equal(diagnostic.accepted, false);
    assert.ok(Math.abs(diagnostic.maxSeamGapMm - 5) < 1e-5, 'candidate seam geometry overrides accepted/attempt state statistics');
    assert.equal(diagnostic.runtimeSafe, false); assert.equal(diagnostic.halted, true);
    assert.equal(diagnostic.motionCandidate, false); assert.deepEqual(diagnostic.releaseWindows, []);
    assert.equal(diagnostic.assemblySupportStates, null);
    assert.equal(diagnostic.sourceAssemblyState, null); assert.equal(diagnostic.sourceAssemblyComplete, null);
    assert.equal(diagnostic.fullySewn, false); assert.equal(diagnostic.sewnUpTo, null);
    assert.deepEqual(diagnostic.lastAcceptedSourceAssemblyState, { allActive: false, enabledStitchCount: 1 });
    assert.deepEqual(diagnostic.candidateSourceAssemblyState, { allActive: true, enabledStitchCount: 2 });
    assert.deepEqual(diagnostic.collisionSeamActivation, { revision: 3, activeSeams: [1, 1], sewnUpTo: 2 });
    assert.deepEqual(diagnostic.lastAcceptedCollisionSeamActivation, { revision: 2, activeSeams: [1, 0], sewnUpTo: 1 });
    assert.equal(diagnostic.assemblySupportSnapshot, null, 'rejected geometry has no candidate controller snapshot');
    assert.deepEqual(diagnostic.lastAcceptedAssemblySupportSnapshot.targets, [1.2, 1, 0, 0]);
    assert.deepEqual(diagnostic.supportSnapshotObservedAfterRejection.targets, [1.21, 0, 0, 0]);
    diagnostic.lastAcceptedAssemblySupportSnapshot.targets[0] = 50;
    assert.equal(diagnostic.supportStatesObservedAfterRejection[0].phase, 'released');
    assert.equal(diagnostic.lastAcceptedAssemblySupportStates[0].phase, 'assembling');
    candidate[4] = 100; assert.ok(diagnostic.clothPositions[4] < .006, 'candidate is cloned');
    assert.deepEqual(acceptedSnapshot, originalSnapshot, 'last accepted snapshot is untouched');
    const seedRejection = buildRejectedDiagnostic({ ...acceptedSnapshot, frame: 0, accepted: false },
        new Float32Array(acceptedSnapshot.clothPositions), 0, { safe: false });
    assert.equal(seedRejection.lastAcceptedFrame, null); assert.equal(seedRejection.attemptedFrame, 0);
    assert.equal(buildRejectedDiagnostic(acceptedSnapshot, [NaN, 0, 0, 1], 3, {}), null);
    assert.equal(buildRejectedDiagnostic(acceptedSnapshot, new Float32Array(4), 3, {}), null);
    console.log('Harness self-test passed (released 9-sample pairwise motion windows, explicit safety state, oscillation/contact rejection, mandatory coverage and exact rejected diagnostics).');
}

const { values } = parseArgs({ options: {
    fixtures: { type: 'string' }, fixture: { type: 'string' },
    frames: { type: 'string', default: '24' }, spacing: { type: 'string', default: '40' },
    'approve-gather-provenance': {type:'boolean',default:false},
    'until-settled': { type: 'boolean', default: false }, 'raw-engine': { type: 'boolean', default: false },
    'raw-default-config': { type: 'boolean', default: false },
    'seam-iterations': { type: 'string' },
    'phase-frame': { type: 'string' }, 'phase-substep': { type: 'string' },
    'phase-substep-end': { type: 'string' }, 'gpu-profile': { type: 'boolean', default: false },
    'phase-self-surface': { type: 'boolean', default: false },
    'graphics-profile': { type: 'string', default: 'swiftshader' },
    'zero-gravity-frames': { type: 'string', default: '0' }, 'self-test': { type: 'boolean', default: false },
    'audit-directory': { type: 'string' }, 'audit-only': { type: 'string' }, 'render-verification': { type: 'string' },
    'base-url': { type: 'string', default: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4173' },
    output: { type: 'string' }, overwrite: { type: 'boolean', default: false }
} });
if (values['self-test']) { await selfTest(); process.exit(0); }
if (!values.fixtures && !values['audit-only']) throw Error('Provide --fixtures DIRECTORY containing manifest.json and generated specs');
const base = resolve(values.fixtures || values['audit-only']), maxFrames = Number(values.frames), spacing = Number(values.spacing);
const zeroGravityFrames = Number(values['zero-gravity-frames']);
const graphicsLaunch = graphicsProfileOptions(values['graphics-profile']);
graphicsLaunch.driverEnvironment = Object.fromEntries(['VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'XDG_RUNTIME_DIR']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
if (graphicsLaunch.profile === 'mesa-gles') {
    const referenceProbe = process.env.SEAMER_MESA_REFERENCE_PROBE;
    graphicsLaunch.referenceProbe = referenceProbe ? { file: resolve(referenceProbe),
        sha256: sha256(await readFile(resolve(referenceProbe))), role: 'Prior compute diagnostic; does not certify this run.' } : null;
}
const seamIterationsOverride = parseSeamIterations(values['seam-iterations']);
const phaseObservation = parsePhaseObservation(values['phase-frame'], values['phase-substep'], maxFrames, values['phase-substep-end'] ?? values['phase-substep']);
const phaseSelfSurface = requirePhaseSelfSurface(values['phase-self-surface'], phaseObservation);
if (!Number.isInteger(maxFrames) || maxFrames < 0 || !Number.isFinite(spacing) || spacing <= 0)
    throw Error('Frames must be a nonnegative integer and spacing must be positive millimetres');
if (!Number.isInteger(zeroGravityFrames) || zeroGravityFrames < 0 || zeroGravityFrames > maxFrames)
    throw Error('Zero-gravity frames must be an integer between zero and the total frames');
if (values['raw-default-config'] && !values['raw-engine']) throw Error('--raw-default-config requires explicit --raw-engine diagnostics');
if (values['until-settled'] && maxFrames < 16) throw Error('--until-settled requires a ceiling of at least 16 frames');
if (values['render-verification'] && !values.fixture && !values['audit-only']) throw Error('A render verification is checkpoint-specific; select one --fixture');
const manifest = values['audit-only'] ? { fixtures: [] } : JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
const fixtures = manifest.fixtures.filter(f => !values.fixture || f.id === values.fixture);
if (!fixtures.length && !values['audit-only']) throw Error('No matching fixture in manifest');
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const sourcePaths = [
    'scripts/check-garment-matrix.mjs', 'packages/cloth-sim/src/config.ts', 'packages/cloth-sim/src/build.ts',
    'packages/cloth-sim/src/contactConfig.ts', 'packages/cloth-sim/src/webgpu/bodySurfaceBroadphase.ts',
    'packages/cloth-sim/src/simulator.ts', 'packages/cloth-sim/src/assembly.ts', 'packages/cloth-sim/src/supportShader.ts', 'packages/cloth-sim/src/geometry/boundary.ts',
    'packages/cloth-sim/src/collisionGuard.ts', 'packages/cloth-sim/src/webgpu/engine.ts', 'packages/cloth-sim/src/webgpu/shaders.ts',
    'packages/avatar/src/avatarController.ts', 'packages/avatar/src/garmentCodeFit.ts', 'src/lib/utils/importGarmentCode.ts', 'src/lib/scene/sourceBodyCheckpoint.ts'
];
async function sourceModules(folder) {
    const found = [];
    for (const entry of await readdir(join(repositoryRoot, folder), { withFileTypes: true })) {
        const path = folder + '/' + entry.name;
        if (entry.isDirectory()) found.push(...await sourceModules(path));
        else if (/\.(ts|js|mjs|json|bin)$/.test(path) && !/\.(test|spec)\.(ts|mjs)$/.test(path)) found.push(path);
    }
    return found;
}
sourcePaths.push('src/lib/utils/sourceGatherEvidence.ts','src/lib/utils/sourceGatherPreparation.ts','src/lib/utils/sourceCollisionPreparation.ts','src/lib/utils/pinnedGatherPrograms.ts');
for (const folder of ['packages/cloth-sim/src', 'packages/avatar/src', 'vendor/body-model/src', 'vendor/body-model/models', 'scripts/garmentcode/qa'])
    sourcePaths.push(...await sourceModules(folder));
const sourceFingerprints = {};
for (const path of [...new Set(sourcePaths)].sort()) sourceFingerprints[path] = createHash('sha256').update(await readFile(join(repositoryRoot, path))).digest('hex');
const runCommand = promisify(execFile);

async function independentAudit(folder, summary) {
    const motionFrames = [...new Set((summary.releaseWindows ?? []).slice(-2).flatMap(window => window.sampleFrames ?? []))].sort((a, b) => a - b);
    const evidence = { frozen: join(folder, `frame-${summary.frame}-frozen.json`), runHalted: summary.halted,
        sewing: { fullyEnabled: summary.fullySewn }, release: { windows: summary.releaseWindows },
        freshness: summary.freshness, openingsApplicable: summary.openingsApplicable,
        waistbandApplicable: summary.waistbandApplicable, waistSupport: summary.waistSupport,
        shoulderApplicable: summary.shoulderApplicable, requiredCoveredRegions: summary.requiredCoveredRegions,
        renderVerification: values['render-verification'] ? resolve(values['render-verification']) : null,
        motionSamples: { staticSource: join(folder, 'frame-0-frozen.json'),
            samples: motionFrames.map(frame => ({ frame, file: join(folder, `frame-${frame}-frozen.json`) })) } };
    const directory = resolve(values['audit-directory'] || join(repositoryRoot, 'scripts/garmentcode/qa'));
    if (directory) {
        const run = async (script, args) => {
            const { stdout, stderr } = await runCommand(process.execPath, [join(directory, script), ...args], { maxBuffer: 64 * 1024 * 1024 });
            await writeFile(join(folder, script + '.log'), stdout + stderr);
        };
        evidence.regionGuard = join(folder, 'region-guard.json');
        await run('region-guard.mjs', [evidence.frozen, evidence.regionGuard]);
        evidence.selfContacts = join(folder, 'self-contacts.json');
        await run('inspect-all-self-contacts.mjs', [evidence.frozen, evidence.regionGuard, evidence.selfContacts]);
        if (evidence.openingsApplicable) {
            evidence.openingGuard = join(folder, 'opening-guard.json');
            await run('open-sleeve-guard.mjs', [evidence.frozen, evidence.openingGuard]);
        }
        if (evidence.shoulderApplicable) {
            evidence.shoulderGuard = join(folder, 'shoulder-guard.json');
            await run('shoulder-wear-guard.mjs', [evidence.frozen, evidence.shoulderGuard]);
        }
        evidence.motionAudit = join(folder, 'motion-window-audit.json');
        await writeFile(join(folder, 'acceptance-evidence.json'), JSON.stringify(evidence, null, 2));
        await run('evaluate-acceptance.mjs', [join(folder, 'acceptance-evidence.json'), join(folder, 'independent-acceptance.json')]);
        const independent = JSON.parse(await readFile(join(folder, 'independent-acceptance.json'), 'utf8'));
        return { accepted: productionAcceptanceEligible(summary, values['raw-engine'], values['gpu-profile']) && independent.accepted,
            independent, evidence };
    }
    await writeFile(join(folder, 'acceptance-evidence.json'), JSON.stringify(evidence, null, 2));
    return { accepted: false, evidence, missing: ['Independent body/self/opening/fitting audit (--audit-directory)', 'Source-bound rendered geometry verification'] };
}

if (values['audit-only']) {
    const folder = resolve(values['audit-only']);
    const summary = JSON.parse(await readFile(join(folder, 'acceptance.json'), 'utf8'));
    if (!summary.sourceFingerprints || !summary.releaseWindows) throw Error('Audit-only needs a current runner acceptance.json');
    const audit = await independentAudit(folder, summary);
    await writeFile(join(folder, 'acceptance.json'), JSON.stringify({ ...summary, ...audit }, null, 2));
    console.log(JSON.stringify({ fixture: summary.fixture, frame: summary.frame, accepted: audit.accepted }));
    process.exit(audit.accepted ? 0 : 1);
}
let rejected = false;
for (const fixture of fixtures) {
    const id = fixture.id;
    const folder = join(resolve(values.output || join(base, 'runs')), id + '-' + spacing + 'mm');
    if (!values.overwrite && (existsSync(join(folder, 'progress.json')) || existsSync(join(folder, 'acceptance.json'))))
        throw Error('Output already exists; use another --output directory or explicit --overwrite: ' + folder);
    await mkdir(folder, { recursive: true });
    const specificationText = await readFile(join(base, fixture.fixtureFile), 'utf8');
    const inputSha256 = createHash('sha256').update(specificationText).digest('hex');
    if (fixture.sha256 && fixture.sha256 !== inputSha256) throw Error('Fixture checksum does not match manifest: ' + id);
    const spec = JSON.parse(specificationText);
    const inputOrder = { panels: Object.keys(spec.pattern.panels), stitches: spec.pattern.stitches };
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: graphicsLaunch.args });
    const launchProvenance = { ...graphicsLaunch, chromiumVersion: browser.version() };
    const pageErrors = [];
    let summary;
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => pageErrors.push(e.message));
        await page.goto(new URL('/studio', values['base-url']).href, { waitUntil: 'domcontentloaded' });
        await page.exposeFunction('graphicsSystemInfo', async () => {
            const cdp = await browser.newBrowserCDPSession();
            try {
                const info = await cdp.send('SystemInfo.getInfo');
                return { devices: info.gpu.devices, featureStatus: info.gpu.featureStatus,
                    glRenderer: info.gpu.auxAttributes.glRenderer ?? null,
                    glImplementationParts: info.gpu.auxAttributes.glImplementationParts ?? null };
            } finally { await cdp.detach(); }
        });
        await page.exposeFunction('checkpoint', async (d, trajectoryPayload = null, phasePayload = null) => {
            const pos = d.clothPositions;
            d.pageErrors = [...pageErrors]; d.positionsFinite = pos.every(Number.isFinite);
            const stem = d.kind === 'rejectedDiagnostic' ? `rejected-attempt-${d.attemptedFrame}` : `frame-${d.frame}`;
            if (d.frame > 0 && !trajectoryPayload) {
                if (d.kind !== 'rejectedDiagnostic') throw Error('Missing actual collision trajectory for a recorded frame');
                d.particleTrajectory = null;
                d.particleTrajectoryError = 'Rejected candidate has no exact trajectory; diagnostic cannot certify its path.';
            }
            if (trajectoryPayload) {
                const trajectoryFile = join(folder, `${stem}-trajectory.bin`);
                d.particleTrajectory = buildParticleTrajectoryDescriptor(d, trajectoryPayload, trajectoryFile);
                try { await bindParticleTrajectoryActivation(d, d.particleTrajectory); }
                catch (error) {
                    if (d.kind !== 'rejectedDiagnostic') throw error;
                    // Keep exact rejected evidence even when the protocol rejected its context.
                    // Missing/broken activation remains explicit and independent replay fails closed.
                    d.particleTrajectoryError = error.message;
                    d.particleTrajectoryActivationVerified = false;
                }
                await writeFile(trajectoryFile, Buffer.from(trajectoryPayload.base64, 'base64'));
            }
            if (phasePayload) {
                d.collisionPhaseObservations = [];
                if (!trajectoryPayload || !phasePayload.length)
                    throw Error('Collision phases require complete start/final observations and the exact substep trajectory');
                const trace = Buffer.from(trajectoryPayload.base64, 'base64'), sliceBytes = pos.length * 4;
                for (let substep = phaseObservation.substep; substep <= phaseObservation.endSubstep; substep++) {
                    if (!phasePayload.some(phase => phase.substep === substep && phase.stage === 'start')
                        || !phasePayload.some(phase => phase.substep === substep && phase.stage === 'final'))
                        throw Error('Collision phase range is missing actual start/final observations');
                }
                for (const [index, phase] of phasePayload.entries()) {
                    const bytes = Buffer.from(phase.base64, 'base64');
                    if (bytes.length !== pos.length * 4) throw Error('Truncated collision phase observation');
                    if (!Number.isInteger(phase.substep) || phase.substep < 1 || phase.substep > d.simulationConfig.subSteps)
                        throw Error('Collision phase substep is outside the recorded trajectory');
                    if (phase.stage === 'start' || phase.stage === 'final') {
                        const slot = phase.substep - (phase.stage === 'start' ? 1 : 0);
                        if (!bytes.equals(trace.subarray(slot * sliceBytes, (slot + 1) * sliceBytes)))
                            throw Error('Collision phase boundary differs from exact GPU trajectory');
                    }
                    const file = join(folder, `${stem}-phase-${index}.bin`);
                    await writeFile(file, bytes);
                    const descriptor = { kind: 'collisionPhaseDiagnostic', diagnosticOnly: true,
                        observedFrame: d.frame, substep: phase.substep, zeroBasedSubstep: phase.zeroBasedSubstep, stage: phase.stage,
                        file, format: 'float32-le-vec4', byteLength: bytes.length, sha256: sha256(bytes), particleCount: pos.length / 4,
                        inputSha256: d.inputSha256, ...trajectorySourceHashes(d) };
                    if (phaseSelfSurface) {
                        const candidateFile = join(folder, `${stem}-phase-${index}-self-candidates.bin`);
                        const correctionFile = join(folder, `${stem}-phase-${index}-self-corrections.bin`);
                        const buffers = phaseSelfSurfaceBuffers(phase, d, candidateFile, correctionFile);
                        await writeFile(candidateFile, buffers.candidateBytes); await writeFile(correctionFile, buffers.correctionBytes);
                        Object.assign(descriptor, { selfSurfaceCandidates: buffers.candidates, selfSurfaceCorrections: buffers.corrections,
                            selfSurfaceCandidateBudget: phase.selfSurfaceCandidateBudget, selfSurfaceTriangleCount: phase.selfSurfaceTriangleCount });
                    }
                    d.collisionPhaseObservations.push(descriptor);
                }
            }
            await writeFile(join(folder, `${stem}-frozen.json`), JSON.stringify(d));
            const obj = [];
            for (let i = 0; i < pos.length; i += 4) obj.push('v ' + pos.slice(i, i + 3).join(' '));
            for (const piece of d.pieces) for (let i = 0; i < piece.triangles.length; i += 3)
                obj.push('f ' + piece.triangles.slice(i, i + 3).map(n => n + 1).join(' '));
            await writeFile(join(folder, `${stem}.obj`), obj.join('\n'));
            const progress = { fixture: id, frame: d.frame, kind: d.kind ?? 'checkpoint', rejected: d.rejected ?? false,
                lastAcceptedFrame: d.lastAcceptedFrame ?? null, particles: pos.length / 4,
                finite: d.positionsFinite, maxSeamGapMm: d.maxSeamGapMm, p95SeamGapMm: d.p95SeamGapMm,
                rmsSincePriorMm: d.rmsSincePriorMm, rmsSinceLastAcceptedMm: d.rmsSinceLastAcceptedMm,
                maxDisplacementSinceLastAcceptedMm: d.maxDisplacementSinceLastAcceptedMm, secondsElapsed: d.secondsElapsed,
                anchorWeightsNonzero: d.anchorWeightsNonzero, temporarySupportWeightsNonzero: d.temporarySupportWeightsNonzero,
                assemblySupportStates: d.assemblySupportStates, safetyReport: d.safetyReport, halted: d.halted,
                stepPerformance: d.stepPerformance ?? null,
                gpuStageProfile: d.gpuStageProfile ?? null,
                motionCandidate: d.motionCandidate, releaseWindows: d.releaseWindows, errors: d.errors, pageErrors: d.pageErrors };
            console.log(JSON.stringify(progress));
            await writeFile(join(folder, d.kind === 'rejectedDiagnostic' ? 'rejected-progress.json' : 'progress.json'), JSON.stringify(progress, null, 2));
            if (!d.positionsFinite) throw Error('Non-finite cloth positions at frame ' + d.frame);
            if (pageErrors.length) throw Error('Browser page error: ' + pageErrors.join('; '));
        });
        summary = await page.evaluate(async ({ spec, id, fixture, provenance, spacing, maxFrames, zeroGravityFrames,
            inputSha256, inputOrder, sourceFingerprints, graphicsLaunch, rawEngine, rawDefaultConfig, seamIterationsOverride, phaseObservation, phaseSelfSurface, gpuProfile, untilSettled, trackerSource, scopeSource, rejectedSource, anatomySource, trajectorySource, phaseSource, sourceAssemblyStateSource, approveGather, gatherApprovalSource }) => {
            const [{ AvatarController }, { convertGarmentCodePattern }, { prepareCloth, ClothSimulation },
                { SIM_CONFIG }, { applySourceContactPolicy }, { ClothEngine }, { SOURCE_BODY_FIT_REVISION, GARMENT_CODE_ASSEMBLY_REVISION }, T, { physicalSeamStitchIndices }] = await Promise.all([
                import('/packages/avatar/src/avatarController.ts'), import('/src/lib/utils/importGarmentCode.ts'),
                import('/packages/cloth-sim/src/simulator.ts'), import('/packages/cloth-sim/src/config.ts'), import('/packages/cloth-sim/src/contactConfig.ts'),
                import('/packages/cloth-sim/src/webgpu/engine.ts'), import('/src/lib/scene/sourceBodyCheckpoint.ts'),
                import('/node_modules/three/build/three.module.js'), import('/packages/cloth-sim/src/webgpu/seamGate.ts')]);
            // Controlled tooling source, not fixture/document instructions.
            const sourceConfigOptions = seamIterationsOverride === null ? {} : { explicitSeamIterations: true };
            if (seamIterationsOverride !== null) SIM_CONFIG.seamIterations = seamIterationsOverride;
            let tracker;
            const packTrajectory = (0, eval)('(' + trajectorySource + ')');
            const packPhases = (0, eval)('(' + phaseSource + ')');
            const recordAssemblyState = (0, eval)('(' + sourceAssemblyStateSource + ')');
            const pattern = convertGarmentCodePattern(spec);
            pattern.settings3d.globalParticleDistanceOverride = spacing;
            const cachedParticlesUsed = pattern.pieces.reduce((n, p) => n + (p.settings3d.savedPositions?.length ?? 0), 0);
            if (cachedParticlesUsed || pattern.settings3d.fixTop || pattern.pieces.some(p => p.settings3d.frozen))
                throw Error('Acceptance requires fresh uncached, unfrozen, unpinned panels');
            let sourceGatherScope, gatherApproval = {scope:undefined,provenance:null,trustSha256:null};
            if (approveGather && spec?.properties?.garmentcode_gather_evidence !== undefined) {
                const [{approveGeneratedGather,encodeOriginalGatherDocument},{PINNED_GATHER_PROGRAMS}] = await Promise.all([
                    import('/src/lib/utils/sourceGatherEvidence.ts'),import('/src/lib/utils/pinnedGatherPrograms.ts')]);
                gatherApproval=await (0,eval)('('+gatherApprovalSource+')')(spec,pattern,
                    {requested:true,trust:structuredClone(PINNED_GATHER_PROGRAMS)},approveGeneratedGather,encodeOriginalGatherDocument);
                sourceGatherScope=gatherApproval.scope;
            }
            const avatar = await AvatarController.create(pattern.body, new T.MeshBasicMaterial());
            const bodyAnatomicalReferences = (0, eval)('(' + anatomySource + ')')(
                avatar.measurementSegmentDefs, avatar.vertexPositions, avatar.indices);
            let prepared = prepareCloth({ pattern, avatarVertices: avatar.vertexPositions, avatarIndices: avatar.indices,
                cylinders: new Map() }, { fromArrangement: true, sourceGatherScope });
            if (!prepared) throw Error('prepare failed');
            if(prepared.simData.sourceGatherRefinement) {
                const {finalizeSourceGatherCollisionGeometry}=await import('/packages/cloth-sim/src/finalizeSourceGatherGeometry.ts');
                prepared={...prepared,simData:await finalizeSourceGatherCollisionGeometry(prepared.simData)};
            }
            const resolvedContacts = applySourceContactPolicy(SIM_CONFIG, prepared.contactPolicy ?? {
                policy: 'unchanged', reason: 'not-active-source', materialIds: [], preservedExplicitPadding: [] }, sourceConfigOptions);
            let actualConfig = rawDefaultConfig ? SIM_CONFIG : resolvedContacts.config;
            if (phaseObservation && phaseObservation.endSubstep > actualConfig.subSteps)
                throw Error('--phase-substep exceeds the actual configured substeps');
            let actualContactPolicy = rawDefaultConfig ? { policy: 'raw-global-config-diagnostic',
                reason: 'Explicit --raw-default-config bypasses source material contact resolution',
                preparedSourcePolicy: resolvedContacts.contactPolicy } : resolvedContacts.contactPolicy;
            tracker = (0, eval)('(' + trackerSource + ')')(actualConfig.timeStep);
            const data = prepared.simData, cuffEdges = {}, joints = {};
            for (const [key, run] of data.edgeRuns) {
                const [piece, path] = key.split('::'); (cuffEdges[piece] ??= {})[path] = run;
            }
            for (const name of ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
                ...['Left', 'Right'].flatMap(s => ['Arm', 'ForeArm', 'Hand', 'HandMiddle1', 'UpLeg', 'Leg', 'Foot', 'ToeBase'].map(p => s + p))]) {
                const v = avatar.bonePosition('mixamorig' + name, new T.Vector3());
                if (v) joints['mixamorig' + name] = v.toArray();
            }
            const errors = [], contacts = { body: actualConfig.handleExternalCollisions,
                surface: actualConfig.handleExternalSurfaceCollisions, self: actualConfig.handleSelfCollisions,
                selfSurface: actualConfig.handleSelfSurfaceCollisions ?? null };
            if ([contacts.body, contacts.surface, contacts.self, contacts.selfSurface].some(v => v !== true)) throw Error('All collision types must be enabled');
            const anchorWeightsNonzero = Array.from(data.anchors).filter((v, i) => i % 4 === 3 && v !== 0).length;
            if (anchorWeightsNonzero || Array.from(data.positions).some((v, i) => i % 4 === 3 && v <= 0))
                throw Error('Fresh matrix panels must have zero held-anchor weights and no fixed particles');
            const common = { id, fixture, provenance, inputSha256, inputOrder, sourceFingerprints, spacingMm: spacing,
                graphicsBackend: { ...graphicsLaunch, userAgent: navigator.userAgent, adapter: null,
                    adapterLimits: null, requestedDeviceStorageBuffers: 8, actualDeviceStorageBuffers: null, systemGpu: null },
                sourceFitRevision: SOURCE_BODY_FIT_REVISION, sourceAssemblyRevision: GARMENT_CODE_ASSEMBLY_REVISION,
                sourceFitFingerprint: sourceFingerprints['packages/avatar/src/garmentCodeFit.ts'],
                sourceBodyMetadata: pattern.body.garmentCodeBody, pattern, cuffEdges, seamPairs: data.seamPairsBySeam,
                seams: Array.from(data.seams), freshPositions: Array.from(data.positions),
                sourceArrangedPositions: Array.from(data.sourceArrangedPositions ?? data.arrangedPositions),
                arrangedPositions: Array.from(data.arrangedPositions),
                bodyPositions: Array.from(avatar.vertexPositions), bodyIndices: Array.from(avatar.indices), joints, bodyAnatomicalReferences,
                clothTriangles: Array.from(data.triangles), pieces: data.pieces.map(p => ({ pieceId: p.pieceId, start: p.start, count: p.count, triangles: p.triangles })),
                automaticPose: avatar.poseName(), anchorWeightsNonzero, contacts, assemblySupport: data.assemblySupport ? {
                    revision: data.assemblySupport.revision, activeOnStart: data.assemblySupport.activeOnStart,
                    groups: data.assemblySupport.groups, targets: Array.from(data.assemblySupport.targets),
                    initialTargets: Array.from(data.assemblySupport.targets), targetsAreInitialSeed: true } : null,
                sourceStretchPolicy: data.sourceStretchPolicy ? structuredClone(data.sourceStretchPolicy) : null,
                sourceGatherApproval: {requested:approveGather,eligible:!!data.sourceGatherRefinement,
                    provenance:gatherApproval.provenance,deploymentTrustSha256:gatherApproval.trustSha256},
                ...(data.sourceGatherRefinement ? {sourceGatherRefinementRevision:data.sourceGatherRefinement.revision,
                    sourceGatherRefinement:structuredClone(data.sourceGatherRefinement),sourceGatherCollisionGeometry:{...structuredClone(data.sourceGatherCollisionGeometry),
                        sourceMaterialCoordinates:Array.from(data.sourceGatherCollisionGeometry.sourceMaterialCoordinates)}} : {}),
                sourceStaging: data.sourceStaging ? structuredClone(data.sourceStaging) : null,
                arrangementSourceStaging: data.arrangementSourceStaging ? structuredClone(data.arrangementSourceStaging) : null,
                simulatedSecondsPerFrame: actualConfig.timeStep, simulationConfig: { ...actualConfig }, contactPolicy: actualContactPolicy,
                benchmarkPolicy: { rawEngine, rawDefaultConfig, runtimeGuardEnabled: !rawEngine && prepared.collisionSafety === true,
                    seamIterationsOverride, explicitSeamIterations: seamIterationsOverride !== null,
                    phaseObservation, phaseSelfSurface, gpuProfile, profilingDiagnosticOnly: gpuProfile,
                    collisionTrajectoryMode: 'all-gpu-start-and-corrected-substeps-v2', collisionTrajectoryFormat: 'float32-le-vec4',
                    collisionTrajectoryCapture: 'GPU before first integration and after every corrected substep',
                    initialSeedPolicy: prepared.collisionSafety === true ? 'exact-validated-source-arrangement' : 'native-initial-vertical-tilt',
                    strictSurfaceHistory: prepared.collisionSafety === true,
                    zeroGravityFrames, zeroGravitySeconds: zeroGravityFrames * actualConfig.timeStep,
                    productionDefault: !rawEngine && zeroGravityFrames === 0 && seamIterationsOverride === null && phaseObservation === null && !gpuProfile, gravityAfterward: actualConfig.gravity,
                    forceFreeze: false, cachedHold: false, allSeamsEnabledFromStart: null,
                    description: rawEngine ? 'Explicit raw-engine diagnostics; cannot certify production acceptance.' : 'Production ClothSimulation public step, runtime guard and temporary assembly support.' },
                freshness: { fromArrangement: true, cachedParticlesUsed, initialGeometryVerified: false,
                    currentBodyRevisionVerified: prepared.collisionSafety === true,
                    currentAssemblyRevisionVerified: !data.assemblySupport || data.assemblySupport.revision === GARMENT_CODE_ASSEMBLY_REVISION,
                    currentPatternSourceVerified: !!pattern.garmentCodeSource && !!inputSha256 } };
            let latest = data.positions.slice(), previous = data.positions.slice(), started = performance.now(), simulation = null, device = null;
            let gravityScale = zeroGravityFrames > 0 ? 0 : 1, halted = false, safetyReport = null, frame = 0;
            let intentionalDestroy = false, initialSafe = false, attemptedFrame = 0, lastPublishedFrame = -1;
            let lastAcceptedState = null, lastAcceptedSafetyReport = null, rejectionReport = null, rejectedDiagnostic = null;
            let lastAcceptedTrajectory = null;
            let lastAcceptedPhases = null;
            const waistGroup = data.assemblySupport?.groups.find(g => g.kind === 'waist');
            let firstReleasedWaist = null, releaseFrame = null;
            const sewnCount = data.stitchCount;
            const semanticWaistPaths = pattern.pieces.flatMap(piece => piece.mainPaths
                .filter(path => path.name === 'lower_interface')
                .map(path => ({ pieceId: piece.id, pathId: path.id, particles: data.edgeRuns.get(`${piece.id}::${path.id}`) ?? [] }))); 
            const supportStates = () => (simulation?.assemblySupportStates ?? []).map(s => ({ ...s }));
            function state(positions) {
                const performanceSample = simulation?.stepPerformance ?? simulation?.lastStepPerformance ?? null;
                const gaps = [];
                for (let i = 0; i < data.particleCount; i++) for (let k = 0; k < 4; k++) {
                    const j = data.seams[i * 4 + k];
                    if (j > i) gaps.push(1000 * Math.hypot(...[0, 1, 2].map(a => positions[i * 4 + a] - positions[j * 4 + a])));
                }
                gaps.sort((a, b) => a - b);
                const states = supportStates();
                const sourceAssemblyComplete = simulation?.sourceAssemblyComplete ?? null;
                const sourceAssemblyState = recordAssemblyState(simulation?.sourceAssemblyState ?? null);
                const proofActivation = rawEngine ? simulation?.seamActivation : simulation?.lastCollisionSeamActivation
                    ?? safetyReport?.seamActivation;
                const collisionSeamActivation = proofActivation ? { revision: proofActivation.revision,
                    activeSeams: Array.from(proofActivation.activeSeams), sewnUpTo: proofActivation.sewnUpTo } : null;
                const capturedSupport = simulation?.captureAssemblySupport() ?? null;
                const assemblySupportSnapshot = capturedSupport ? { topology: capturedSupport.topology,
                    elapsedSeconds: capturedSupport.elapsedSeconds, states: capturedSupport.states.map(s => ({ ...s })),
                    targets: Array.from(capturedSupport.targets) } : null;
                const active = new Set();
                for (const group of data.assemblySupport?.groups ?? []) {
                    const status = states.find(s => s.id === group.id);
                    if (!status || status.scale !== 0 || status.phase !== 'released') for (const particle of group.particles) active.add(particle);
                }
                return { maxSeamGapMm: gaps.at(-1) ?? 0, p95SeamGapMm: gaps[Math.floor(gaps.length * .95)] ?? 0,
                    temporarySupportWeightsNonzero: active.size, fixedAnchorWeightsNonzero: anchorWeightsNonzero,
                    assemblySupportStates: states, assemblySupportSnapshot, sourceAssemblyComplete, sourceAssemblyState,
                    sourceStretchPolicy: data.sourceStretchPolicy ? structuredClone(data.sourceStretchPolicy) : null,
                    ...(common.collisionSeamDictionary ? { collisionSeamActivation } : {}),
                    fullySewn: prepared.collisionSafety === true ? sourceAssemblyState?.allActive === true
                        && sourceAssemblyState.enabledStitchCount === data.stitchCount : sewnCount === data.stitchCount,
                    sewnUpTo: sourceAssemblyState?.enabledStitchCount ?? (prepared.collisionSafety === true ? 0 : sewnCount),
                    stitchCount: data.stitchCount,
                    bodyContacts: contacts.body, surfaceContacts: contacts.surface, selfContacts: contacts.self, selfSurfaceContacts: contacts.selfSurface,
                    gravity: actualConfig.gravity.map(v => v * gravityScale),
                    runtimeSafe: !rawEngine && safetyReport?.safe === true, halted,
                    stepPerformance: performanceSample ? { ...performanceSample } : null,
                    gpuStageProfile: gpuProfile && simulation?.gpuStageProfile ? structuredClone(simulation.gpuStageProfile) : null };
            }
            function snapshot(positions, overrides = {}) {
                let squared = 0;
                for (let i = 0; i < data.particleCount; i++) for (let a = 0; a < 3; a++) squared += (positions[i * 4 + a] - previous[i * 4 + a]) ** 2;
                common.freshness.initialGeometryVerified = initialSafe;
                const snapshot = { ...common, ...state(positions), frame, simulatedSeconds: frame * actualConfig.timeStep,
                    clothPositions: Array.from(positions), safetyReport, halted, motionCandidate: tracker.motionCandidate,
                    releaseWindows: tracker.windows, rmsSincePriorMm: 1000 * Math.sqrt(squared / data.particleCount),
                    secondsElapsed: (performance.now() - started) / 1000, errors: [...errors], ...overrides };
                return snapshot;
            }
            async function emit(positions, overrides = {}) {
                const frozen = snapshot(positions, overrides);
                await window.checkpoint(frozen, frame > 0 ? lastAcceptedTrajectory : null, lastAcceptedPhases); previous = positions.slice(); lastPublishedFrame = frame; return frozen;
            }
            try {
                if (maxFrames > 0) {
                    const adapter = await navigator.gpu.requestAdapter();
                    if (!adapter) throw Error('WebGPU adapter unavailable');
                    const adapterInfo = adapter.info;
                    common.graphicsBackend.adapter = { vendor: adapterInfo.vendor, architecture: adapterInfo.architecture,
                        device: adapterInfo.device, description: adapterInfo.description, isFallbackAdapter: adapterInfo.isFallbackAdapter,
                        features: [...adapter.features] };
                    common.graphicsBackend.adapterLimits = { maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
                        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize };
                    if (graphicsLaunch.profile === 'mesa-gles' && (adapterInfo.isFallbackAdapter !== false
                        || /swiftshader/i.test(JSON.stringify(common.graphicsBackend.adapter))))
                        throw Error('mesa-gles selected a fallback/SwiftShader adapter; refusing a mislabeled backend run.');
                    if (gpuProfile && !adapter.features.has('timestamp-query'))
                        throw Error('--gpu-profile unavailable: adapter does not support timestamp-query');
                    device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 },
                        requiredFeatures: gpuProfile ? ['timestamp-query'] : [] });
                    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
                    device.lost.then(v => { if (!intentionalDestroy) errors.push('Device lost: ' + v.reason + ' ' + v.message); });
                    common.deviceStorageBufferLimit = device.limits.maxStorageBuffersPerShaderStage;
                    common.graphicsBackend.actualDeviceStorageBuffers = device.limits.maxStorageBuffersPerShaderStage;
                    common.graphicsBackend.systemGpu = await window.graphicsSystemInfo();
                    if (graphicsLaunch.profile === 'mesa-gles' && !/mesa|llvmpipe|lavapipe/i.test(common.graphicsBackend.systemGpu.glRenderer ?? ''))
                        throw Error('mesa-gles requires an actual Mesa ANGLE renderer; caller ICD selection was not verified.');
                    simulation = rawEngine ? new ClothEngine(device, data, prepared.body, actualConfig,
                        { strictSurfaceHistory: !!prepared.collisionSafety }) : new ClothSimulation(device, prepared, sourceConfigOptions);
                    if (prepared.collisionSafety === true) {
                        if (rawEngine) {
                            const physicalIndices = physicalSeamStitchIndices(data.seams, data.seamOrder,
                                data.seamPairsBySeam, data.seamStitchRanges);
                            common.collisionSeamDictionary = { stitchCount: data.stitchCount,
                                seamPairsBySeam: data.seamPairsBySeam.map((group, index) => ({ seamId: group.seamId, index,
                                    pairs: Array.from(group.pairs), stitchIndices: Array.from(physicalIndices[index]),
                                    stitchIndexKinds: Array.from(physicalIndices[index], (_, pair) => group.pairs[pair * 2] === group.pairs[pair * 2 + 1]
                                        ? 'identity-logical' : 'reciprocal-first-stamp') })) };
                        } else common.collisionSeamDictionary = simulation.collisionSeamDictionary;
                        if (!common.collisionSeamDictionary) throw Error('Missing actual source collision seam dictionary');
                    }
                    common.benchmarkPolicy.allSeamsEnabledFromStart = prepared.collisionSafety === true
                        ? simulation.sourceAssemblyState?.allActive === true
                          && simulation.sourceAssemblyState.enabledStitchCount === data.stitchCount : true;
                    if (gpuProfile) {
                        const selectedZeroBasedSubsteps = phaseObservation
                            ? [Math.floor((phaseObservation.substep + phaseObservation.endSubstep) / 2) - 1]
                            : [...new Set([0, Math.floor(actualConfig.subSteps / 2), actualConfig.subSteps - 1])];
                        simulation.enableGPUStageProfiling({ selectedZeroBasedSubsteps });
                        common.benchmarkPolicy.gpuProfiling = { requiredFeature: 'timestamp-query', selectedZeroBasedSubsteps,
                            scope: 'Selected GPU compute-pass spans; excludes CPU encoding/readback and Worker proof' };
                    }
                    if (rawEngine) {
                        simulation.enableCollisionTrajectoryReadback();
                        // Match production's validated SOURCE seed before any physical step.
                        // Native diagnostics retain their original vertical-panel initialization.
                        if (prepared.collisionSafety === true) simulation.resetPositions(data.positions);
                    }
                    if (!rawEngine) {
                        if (simulation.simData !== data) throw Error('Fresh simulation unexpectedly replaced its prepared state');
                        actualConfig = simulation.simulationConfig; actualContactPolicy = simulation.contactPolicy;
                        common.simulationConfig = { ...actualConfig }; common.contactPolicy = actualContactPolicy;
                        common.simulatedSecondsPerFrame = actualConfig.timeStep;
                        common.benchmarkPolicy.gravityAfterward = [...actualConfig.gravity];
                        common.benchmarkPolicy.zeroGravitySeconds = zeroGravityFrames * actualConfig.timeStep;
                        Object.assign(contacts, { body: actualConfig.handleExternalCollisions,
                            surface: actualConfig.handleExternalSurfaceCollisions, self: actualConfig.handleSelfCollisions,
                            selfSurface: actualConfig.handleSelfSurfaceCollisions ?? null });
                        if ([contacts.body, contacts.surface, contacts.self, contacts.selfSurface].some(v => v !== true))
                            throw Error('Actual runtime config must enable all collision types');
                        tracker = (0, eval)('(' + trackerSource + ')')(actualConfig.timeStep);
                    }
                    simulation.setAnchorScale(0); // Constructor requests full prefix; manual setters cancel automatic staging.
                    if (zeroGravityFrames > 0) {
                        if (typeof simulation.setGravityScale !== 'function') throw Error('Gravity benchmark needs public setGravityScale; refusing a restart/reset');
                        simulation.setGravityScale(0);
                    }
                    safetyReport = simulation.safetyReport ?? null; initialSafe = safetyReport?.safe === true;
                }
                lastAcceptedState = state(data.positions); lastAcceptedSafetyReport = safetyReport;
                await emit(data.positions);
                if (maxFrames === 0) return { frame: 0, halted: false, motionCandidate: false, ...state(data.positions),
                rawEngine, graphicsBackend: common.graphicsBackend, sourceFingerprints, sourceFitRevision: common.sourceFitRevision, sourceAssemblyRevision: common.sourceAssemblyRevision,
                    freshness: common.freshness, releaseWindows: [], openingsApplicable: null, waistbandApplicable: null };
                tracker.observe(0, data.positions, state(data.positions));
                started = performance.now();
                for (let attempted = 1; attempted <= maxFrames; attempted++) {
                    attemptedFrame = attempted;
                    if (phaseObservation?.frame === attempted) simulation.enableCollisionPhaseReadback(phaseObservation.substep - 1, phaseObservation.endSubstep - 1, phaseSelfSurface);
                    if (zeroGravityFrames > 0 && attempted === zeroGravityFrames + 1) {
                        simulation.setGravityScale(1); gravityScale = 1;
                        common.gravityTransition = { afterFrame: zeroGravityFrames, velocityReset: false,
                            engineRebuilt: false, historyPreserved: true, mechanism: 'Public uniform gravity scale setter' };
                    }
                    const positions = await simulation.step();
                    lastAcceptedTrajectory = packTrajectory(simulation.collisionTrajectoryPositions, actualConfig.subSteps, latest);
                    lastAcceptedPhases = phaseObservation?.frame === attempted
                        ? packPhases(simulation.collisionPhaseObservations, data.positions.length / 4, phaseObservation.substep, phaseObservation.endSubstep, phaseSelfSurface) : null;
                    safetyReport = simulation.safetyReport ?? null;
                    if (errors.length) throw Error(errors[0]);
                    if (!Array.from(positions).every(Number.isFinite)) throw Error('Non-finite candidate at attempt ' + attempted);
                    latest = positions.slice(); frame = attempted;
                    const observedState = state(positions);
                    lastAcceptedState = structuredClone(observedState); lastAcceptedSafetyReport = safetyReport;
                    if (observedState.temporarySupportWeightsNonzero === 0 && gravityScale === 1 && releaseFrame === null) {
                        releaseFrame = frame;
                        if (waistGroup) firstReleasedWaist = waistGroup.particles.map(i => positions[i * 4 + 1]);
                    }
                    const window = tracker.observe(frame, positions, observedState);
                    if (tracker.lastObservationEligible || frame <= 3 || frame % 8 === 0 || frame === maxFrames || frame === zeroGravityFrames || phaseObservation?.frame === frame || window
                        || tracker.windowStartFrame === frame || !Array.from(positions).every(Number.isFinite)) await emit(positions);
                    if (untilSettled && tracker.motionCandidate) break;
                }
            } catch (error) {
                halted = true; errors.push(error.message); rejectionReport = error.report ?? simulation?.safetyReport ?? null;
                const lastSafe = snapshot(latest, { ...(lastAcceptedState ?? {}), kind: lastAcceptedState ? 'checkpoint' : 'unacceptedSeed',
                    accepted: !!lastAcceptedState, safetyReport: lastAcceptedSafetyReport, errors: [],
                    halted: false, runtimeSafe: lastAcceptedSafetyReport?.safe === true });
                if (lastAcceptedState && lastPublishedFrame !== frame) await window.checkpoint(lastSafe, lastAcceptedTrajectory, lastAcceptedPhases);
                const rejectedState = { ...state(latest), errors: [...errors], secondsElapsed: (performance.now() - started) / 1000 };
                if (gpuProfile && error.candidateGPUStageProfile !== undefined)
                    rejectedState.gpuStageProfile = structuredClone(error.candidateGPUStageProfile);
                if (error.candidateSourceAssemblyState !== undefined)
                    rejectedState.candidateSourceAssemblyState = recordAssemblyState(error.candidateSourceAssemblyState);
                if (error.candidateSeamActivation != null)
                    rejectedState.candidateSeamActivation = { revision: error.candidateSeamActivation.revision,
                        activeSeams: Array.from(error.candidateSeamActivation.activeSeams), sewnUpTo: error.candidateSeamActivation.sewnUpTo };
                const candidate = (0, eval)('(' + rejectedSource + ')')(lastSafe, error.candidatePositions,
                    attemptedFrame, rejectionReport, rejectedState);
                if (candidate) {
                    let candidateTrajectory = null;
                    try {
                        if (error.candidateTrajectory) candidateTrajectory = packTrajectory(error.candidateTrajectory, actualConfig.subSteps, latest, true);
                    } catch (trajectoryError) {
                        candidate.particleTrajectoryError = trajectoryError.message;
                    }
                    let candidatePhases = null;
                    if (phaseObservation?.frame === attemptedFrame && error.candidatePhases?.length)
                        candidatePhases = packPhases(error.candidatePhases, data.positions.length / 4, phaseObservation.substep, phaseObservation.endSubstep, phaseSelfSurface);
                    await window.checkpoint(candidate, candidateTrajectory, candidatePhases);
                    rejectedDiagnostic = { attemptedFrame, lastAcceptedFrame: candidate.lastAcceptedFrame,
                        frozenFile: `rejected-attempt-${attemptedFrame}-frozen.json`, kind: candidate.kind };
                }
                safetyReport = lastAcceptedSafetyReport;
            } finally {
                simulation?.dispose(); intentionalDestroy = true; device?.destroy();
            }
            const positions = latest;
            const finalState = { ...(lastAcceptedState ?? state(positions)), halted, runtimeSafe: !halted && lastAcceptedSafetyReport?.safe === true };
            const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
            const maxAbs = values => Math.max(0, ...values.map(Math.abs));
            let waistSupport = null;
            if (waistGroup) {
                const finalY = waistGroup.particles.map(i => positions[i * 4 + 1]);
                const sourceY = waistGroup.particles.map(i => data.assemblySupport.targets[i * 4]);
                const targetDrift = finalY.map((y, i) => (y - sourceY[i]) * 1000);
                const releaseDrift = firstReleasedWaist ? finalY.map((y, i) => (y - firstReleasedWaist[i]) * 1000) : null;
                waistSupport = { semanticInterfaceConfirmed: semanticWaistPaths.length > 0,
                    nativeInterfaces: semanticWaistPaths, particles: waistGroup.particles, semanticTargetYs: sourceY,
                    originalAssemblySeedYs: waistGroup.particles.map(i => (data.sourceArrangedPositions ?? data.arrangedPositions)[i * 4 + 1]),
                    preparedAssemblySeedYs: waistGroup.particles.map(i => data.arrangedPositions[i * 4 + 1]),
                    sourceTargetMeanYM: mean(sourceY), finalMeanYM: mean(finalY),
                    finalLevelFromSemanticTargetMm: mean(targetDrift), maxParticleLevelFromSemanticTargetMm: maxAbs(targetDrift),
                    firstFullyReleasedFrame: releaseFrame, firstFullyReleasedYs: firstReleasedWaist,
                    releaseLevelDriftMm: releaseDrift ? mean(releaseDrift) : null,
                    maxParticleReleaseLevelDriftMm: releaseDrift ? maxAbs(releaseDrift) : null,
                    temporarySupportWeightsNonzero: finalState.temporarySupportWeightsNonzero,
                    fixedAnchorWeightsNonzero: finalState.fixedAnchorWeightsNonzero };
            }
            // A short sleeve hem has no wrist opening requirement. Classify from the actual fresh
            // source opening location; the independent body guard still evaluates every sleeve face.
            let openingsApplicable = fixture.openingsApplicable;
            if (typeof openingsApplicable !== 'boolean') {
                openingsApplicable = false;
                const sewnPaths = new Set(pattern.seams.flatMap(s => [...s.fromPaths, ...s.toPaths].map(p => p.id)));
                for (const side of ['Left', 'Right']) {
                    const pieces = pattern.pieces.filter(p => p.name.toLowerCase().includes(side.toLowerCase()) && /sleeve|cuff/i.test(p.name));
                    const cuff = pieces.filter(p => /_cuff/i.test(p.name));
                    const runs = (cuff.length ? cuff : pieces).flatMap(p => p.mainPaths.filter(path => !sewnPaths.has(path.id))
                        .flatMap(path => data.edgeRuns.get(`${p.id}::${path.id}`) ?? []));
                    const wrist = joints['mixamorig' + side + 'Hand'], elbow = joints['mixamorig' + side + 'ForeArm'];
                    if (!runs.length || !wrist || !elbow) continue;
                    const center = [0, 1, 2].map(a => mean(runs.map(i => data.positions[i * 4 + a])));
                    const distance = Math.hypot(...center.map((v, a) => v - wrist[a]));
                    const forearmLength = Math.hypot(...wrist.map((v, a) => v - elbow[a]));
                    if (cuff.length || distance <= forearmLength * .6) openingsApplicable = true;
                }
            }
            const { shoulderApplicable, requiredCoveredRegions } = (0, eval)('(' + scopeSource + ')')(
                fixture, pattern.pieces.map(p => p.name), openingsApplicable, data.assemblySupport?.groups ?? []);
            return { frame, halted, rawEngine, rawDefaultConfig, gpuProfile, errors, attemptedFrame, rejectionReport, rejectedDiagnostic, motionCandidate: !halted && tracker.motionCandidate,
                ...finalState, releaseWindows: tracker.windows, freshness: common.freshness,
                openingsApplicable, shoulderApplicable, requiredCoveredRegions, waistbandApplicable: fixture.waistbandApplicable ?? !!waistGroup,
                waistSupport, simulationConfig: common.simulationConfig, contactPolicy: common.contactPolicy,
                graphicsBackend: common.graphicsBackend, sourceFitRevision: common.sourceFitRevision, sourceAssemblyRevision: common.sourceAssemblyRevision, sourceFingerprints, safetyReport };
        }, { spec, id, fixture, provenance: manifest.provenance, spacing, maxFrames, zeroGravityFrames,
            inputSha256, inputOrder, sourceFingerprints, graphicsLaunch: launchProvenance, rawEngine: values['raw-engine'], rawDefaultConfig: values['raw-default-config'], seamIterationsOverride, phaseObservation, phaseSelfSurface, gpuProfile: values['gpu-profile'], untilSettled: values['until-settled'], approveGather: values['approve-gather-provenance'],
            gatherApprovalSource: resolveHarnessGatherApproval.toString(),
            trackerSource: createSettlementTracker.toString(), sourceAssemblyStateSource: recordSourceAssemblyState.toString(), scopeSource: inferAcceptanceScope.toString(), rejectedSource: buildRejectedDiagnostic.toString(),
            anatomySource: buildBodyAnatomicalReferences.toString(), trajectorySource: packCollisionTrajectory.toString(), phaseSource: packCollisionPhases.toString() });
        if (pageErrors.length) throw Error('Browser page error: ' + pageErrors.join('; '));
    } catch (error) {
        rejected = true;
        await writeFile(join(folder, 'failure.json'), JSON.stringify({ fixture: id, message: error.message, pageErrors, graphicsBackend: launchProvenance }, null, 2));
        console.error(JSON.stringify({ fixture: id, failed: true, error: error.message }));
    } finally { await browser.close(); }
    if (summary) {
        let audit;
        try { audit = await independentAudit(folder, summary); }
        catch (error) { audit = { accepted: false, auditFailure: error.message }; rejected = true; }
        await writeFile(join(folder, 'acceptance.json'), JSON.stringify({ fixture: id, frameCeiling: maxFrames,
            untilSettled: values['until-settled'], ...summary, ...audit }, null, 2));
        console.log(JSON.stringify({ fixture: id, frame: summary.frame, halted: summary.halted,
            motionCandidate: summary.motionCandidate, accepted: audit.accepted }));
        if (summary.halted || (values['until-settled'] && !audit.accepted)) rejected = true;
    }
}
if (rejected) process.exitCode = 1;
