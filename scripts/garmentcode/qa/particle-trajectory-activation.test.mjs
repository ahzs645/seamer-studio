import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { auditParticleTrajectory, createTrajectoryGuard, trajectoryNumericBytes, trajectorySourceHashes,
    trajectorySeamActivationHeader, TRAJECTORY_FORMAT } from './particle-trajectory-audit.mjs';
import { readFrozenSample } from './frozen-sample.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(frame = 0, mask = 1, prefix = 4) {
    const seam = { seamId: 'actual-source-join', index: 0, pairs: [0, 3, 1, 4] };
    return { frame, inputSha256: 'a'.repeat(64), sourceFingerprints: { test: 'b'.repeat(64) },
        simulationConfig: { subSteps: 40 }, stitchCount: 4, seamPairs: [seam], seams: Array(24).fill(-1),
        bodyPositions: [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1],
        bodyIndices: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
        clothTriangles: [0,1,2,0,3,4,5,0],
        clothPositions: [[2,0,0],[2,.1,0],[2.1,0,0],[2,0,.001],[2,.1,-.001],[2.1,.05,.02]].flatMap(p => [...p.map(Math.fround),1]),
        collisionSeamDictionary: { stitchCount: 4, seamPairsBySeam: [{ ...seam, stitchIndices: [3, 1] }] },
        collisionSeamActivation: { revision: 7, activeSeams: [mask], sewnUpTo: prefix },
        sourceStaging: { revision: 1, structuralSeamIndices: [0], attachmentSeamIndices: [] },
        sourceStretchPolicy: { policy: 'source-authored-seam-stretch-v1', retainedSeamStretchEdges: 1 } };
}

async function attach(directory, previous, current) {
    const samples = Array.from({ length: 41 }, () => Float32Array.from(current.clothPositions));
    const bytes = Buffer.concat(samples.map(sample => trajectoryNumericBytes(sample)));
    const file = join(directory, 'actual41.bin');
    await writeFile(file, bytes);
    const activation = { ...current.collisionSeamActivation, activeSeams: Uint32Array.from(current.collisionSeamActivation.activeSeams) };
    current.safetyReport = (await createTrajectoryGuard(current)).inspectTrajectory(samples[40], samples[0], samples, 40, activation);
    current.particleTrajectory = { file, sha256: hash(bytes), format: TRAJECTORY_FORMAT, byteLength: bytes.length,
        sampleCount: 41, subSteps: 40, particleCount: 6, stepIndices: Array.from({ length: 41 }, (_, i) => i),
        fromFrame: previous.frame, toFrame: current.frame, inputSha256: current.inputSha256,
        ...trajectorySourceHashes(current), ...await trajectorySeamActivationHeader(current, current.collisionSeamActivation),
        startPositionsSha256: hash(trajectoryNumericBytes(samples[0])), endPositionsSha256: hash(trajectoryNumericBytes(samples[40])) };
}

async function withTrace(run, mask = 1, prefix = 4) {
    const directory = await mkdtemp(join(tmpdir(), 'seam-activation-replay-'));
    try {
        const previous = fixture(), current = fixture(1, mask, prefix);
        await attach(directory, previous, current);
        return await run({ previous, current, directory, file: join(directory, 'frame1.json') });
    } finally { await rm(directory, { recursive: true, force: true }); }
}

test('exact all41 replay exempts only the actually active locally closed finite seam', async () => {
    await withTrace(async ({ previous, current, file }) => {
        const report = await auditParticleTrajectory(previous, current, file);
        assert.equal(report.passed, true, JSON.stringify(report.errors));
        assert.equal(report.seamActivationBindingVerified, true);
        assert.equal(report.geometry.selfCrossingPairCount, 0);
        assert.equal(report.geometry.trajectory.inspectedSubsteps, 40);
    });
    await withTrace(async ({ previous, current, file }) => {
        // Rolled-back public state is deliberately different from the attempted proof.
        current.sourceAssemblyState = { allActive: true, activeSeamMask: [1] };
        current.runtimeSafe = false; current.diagnosticOnly = true;
        const report = await auditParticleTrajectory(previous, current, file);
        assert.equal(report.errors.length, 0);
        assert.equal(report.passed, false);
        assert.equal(report.geometry.selfCrossingPairCount, 41);
        assert.deepEqual(report.geometry.seamActivation, { revision: 7, activeSeams: [0], sewnUpTo: 4 });
    }, 0);
});

test('partial prefixes use reciprocal first-stamp indices rather than pair ordinals', async () => {
    for (const prefix of [2, 3]) await withTrace(async ({ previous, current, file }) => {
        const report = await auditParticleTrajectory(previous, current, file);
        assert.equal(report.errors.length, 0);
        assert.equal(report.geometry.selfCrossingPairCount, 41);
        assert.equal(report.passed, false);
    }, 1, prefix);
});

test('header builder snapshots mask and dictionary before its asynchronous digest', async () => {
    const frozen = fixture(), activation = { revision: 7, activeSeams: new Uint32Array([1]), sewnUpTo: 4 };
    const expected = await trajectorySeamActivationHeader(frozen, activation);
    const pending = trajectorySeamActivationHeader(frozen, activation);
    activation.activeSeams[0] = 0; activation.revision = 8;
    frozen.collisionSeamDictionary.seamPairsBySeam[0].stitchIndices[0] = 0;
    assert.deepEqual(await pending, expected);
});

for (const [name, mutate] of [
    ['header mask', current => { current.particleTrajectory.seamActivation.activeSeams[0] = 0; }],
    ['header revision', current => { current.particleTrajectory.seamActivation.revision++; }],
    ['header prefix', current => { current.particleTrajectory.seamActivation.sewnUpTo = 2; }],
    ['activation digest', current => { current.particleTrajectory.seamActivationSha256 = '0'.repeat(64); }],
    ['worker used mask', current => { current.safetyReport.seamActivation.activeSeams[0] = 0; }],
    ['missing used activation', current => { delete current.collisionSeamActivation; }],
    ['missing dictionary', current => { delete current.collisionSeamDictionary; }],
    ['changed first-stamp topology', current => { current.collisionSeamDictionary.seamPairsBySeam[0].stitchIndices[0] = 0; }],
    ['changed dictionary ID', current => { current.collisionSeamDictionary.seamPairsBySeam[0].seamId = 'wrong'; }],
    ['changed dictionary order', current => { current.collisionSeamDictionary.seamPairsBySeam[0].index = 1; }],
    ['changed structural plan', current => { current.sourceStaging.structuralSeamIndices = []; }]
]) test('activated trajectory fails closed for ' + name, async () => withTrace(async ({ previous, current, file }) => {
    mutate(current);
    const report = await auditParticleTrajectory(previous, current, file);
    assert.equal(report.passed, false);
    assert(report.errors.length > 0);
}));

test('a rewritten current plan/header cannot hide a changed immutable previous-frame policy', async () => withTrace(async ({ previous, current, file }) => {
    current.sourceStretchPolicy.retainedSeamStretchEdges++;
    Object.assign(current.particleTrajectory, trajectorySourceHashes(current), await trajectorySeamActivationHeader(current, current.collisionSeamActivation));
    const report = await auditParticleTrajectory(previous, current, file);
    assert.equal(report.passed, false);
    assert.match(report.errors[0], /Consecutive trajectory source changed/);
}));

test('a reused body/topology guard cannot silently classify a different authoritative stitch dictionary', async () => withTrace(async ({ previous, current, file }) => {
    const guard = await createTrajectoryGuard(previous);
    for (const sample of [previous, current]) sample.collisionSeamDictionary.seamPairsBySeam[0].stitchIndices[0] = 0;
    Object.assign(current.particleTrajectory, trajectorySourceHashes(current), await trajectorySeamActivationHeader(current, current.collisionSeamActivation));
    const report = await auditParticleTrajectory(previous, current, file, guard);
    assert.equal(report.passed, false);
    assert.match(report.errors[0], /Reused trajectory guard body\/topology binding changed/);
}));

test('invalid JSON mask values cannot wrap into a valid Uint32 mask during hashing', async () => {
    for (const value of [2, -1, .5, 4294967297, null]) {
        const frozen = fixture();
        await assert.rejects(trajectorySeamActivationHeader(frozen, { revision: 7, activeSeams: [value], sewnUpTo: 4 }), /Invalid proof-used/);
    }
});

test('identity logical stitches are explicit and hash-bound rather than mislabeled reciprocal GPU links', async () => {
    const frozen = fixture();
    frozen.seamPairs[0].pairs = [0, 0, 1, 4];
    const group = frozen.collisionSeamDictionary.seamPairsBySeam[0];
    group.pairs = frozen.seamPairs[0].pairs.slice();
    await assert.rejects(trajectorySeamActivationHeader(frozen, frozen.collisionSeamActivation), /Identity seam pairs require/);
    group.stitchIndexKinds = ['identity-logical', 'reciprocal-first-stamp'];
    const correct = await trajectorySeamActivationHeader(frozen, frozen.collisionSeamActivation);
    assert.match(correct.seamTopologySha256, /^[a-f0-9]{64}$/);
    group.stitchIndexKinds[0] = 'reciprocal-first-stamp';
    await assert.rejects(trajectorySeamActivationHeader(frozen, frozen.collisionSeamActivation), /stitch index provenance/);
    group.stitchIndexKinds = ['identity-logical', 'identity-logical'];
    await assert.rejects(trajectorySeamActivationHeader(frozen, frozen.collisionSeamActivation), /stitch index provenance/);
    const ordinary = fixture();
    const before = await trajectorySeamActivationHeader(ordinary, ordinary.collisionSeamActivation);
    ordinary.collisionSeamDictionary.seamPairsBySeam[0].stitchIndexKinds = ['reciprocal-first-stamp', 'reciprocal-first-stamp'];
    const after = await trajectorySeamActivationHeader(ordinary, ordinary.collisionSeamActivation);
    assert.notEqual(before.seamTopologySha256, after.seamTopologySha256);
    assert.equal(before.seamActivationSha256, after.seamActivationSha256);
});

test('transport-failure diagnostics can retain exact buffers without becoming an accepted proof', async () => withTrace(async ({ previous, current, file }) => {
    current.diagnosticOnly = true; current.runtimeSafe = false;
    current.safetyReport = { trajectory: { valid: false } };
    const report = await auditParticleTrajectory(previous, current, file);
    assert.equal(report.errors.length, 0);
    assert.equal(report.binaryVerified, true);
    assert.equal(report.geometry.safe, true);
    assert.equal(report.passed, false);
}));

test('compact samples inherit only immutable dictionary/plan/policy, never the source activation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'compact-seam-context-'));
    try {
        const source = fixture(), file = join(directory, 'compact.json');
        await writeFile(join(directory, 'initial.json'), JSON.stringify(source));
        await writeFile(file, JSON.stringify({ staticSource: 'initial.json', frame: 1 }));
        const sample = await readFrozenSample(file);
        assert.deepEqual(sample.collisionSeamDictionary, source.collisionSeamDictionary);
        assert.equal(sample.stitchCount, source.stitchCount);
        assert.deepEqual(sample.sourceStaging, source.sourceStaging);
        assert.equal(sample.collisionSeamActivation, undefined);
        await writeFile(file, JSON.stringify({ staticSource: 'initial.json', frame: 1, collisionSeamDictionary: { ...source.collisionSeamDictionary, stitchCount: 5 } }));
        await assert.rejects(readFrozenSample(file), /immutable collisionSeamDictionary/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
