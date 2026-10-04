import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindFrozenPrepared, decodeFrozenRenderRequest, frozenSha256, verifyFrozenModulePins, FROZEN_SOURCE_PIN_REQUIREMENTS, FROZEN_BODY_PIN_REQUIREMENTS, frozenReadOnlyAutomation } from './frozenAppRender';
import { bindingFixture } from './frozenAppRender.fixture';
afterEach(() => vi.restoreAllMocks());

describe('sealed frozen render binding', () => {
  it('binds exact buffers and source identity without changing the prepared seed or document', async () => {
    const f = await bindingFixture(), before = structuredClone(f.pattern), seed = f.prepared.simData.positions.slice();
    const bound = await bindFrozenPrepared(f.evidence, f.actual);
    expect(bound.positions).toEqual(seed); expect(bound.positions).not.toBe(f.prepared.simData.positions);
    bound.positions[0] = 99;
    expect(f.prepared.simData.positions).toEqual(seed); expect(f.pattern).toEqual(before);
  });
  it.each(['body XYZ','body topology','cloth topology','materials','body-fit','assembly','source cut','lossless document','mass','activation','unsafe'])(
    'rejects changed %s before publication', async change => {
      const f = await bindingFixture();
      if (change === 'body XYZ') f.evidence.bodyPositions[0] += .01;
      if (change === 'body topology') f.evidence.bodyIndices[0] = 1;
      if (change === 'cloth topology') f.evidence.clothTriangles[0] = 1;
      if (change === 'materials') f.evidence.pattern.materials = [{ thickness: .1 } as (typeof f.pattern.materials)[number]];
      if (change === 'body-fit') f.evidence.sourceFitRevision--;
      if (change === 'assembly') f.evidence.sourceAssemblyRevision--;
      if (change === 'source cut') f.evidence.pattern.garmentCodeSource!.gatherProvenance!.sourceCutSha256 = 'b'.repeat(64);
      if (change === 'lossless document') f.evidence.pattern.garmentCodeSource!.gatherSourceDocument!.value = ['s','changed'];
      if (change === 'mass') f.evidence.clothPositions[3] = 0;
      if (change === 'activation') f.evidence.collisionSeamActivation = { revision: 0, sewnUpTo: 1, activeSeams: [] };
      if (change === 'unsafe') f.evidence.safetyReport.safe = false;
      await expect(bindFrozenPrepared(f.evidence, f.actual)).rejects.toThrow();
    });
  it.each([...FROZEN_SOURCE_PIN_REQUIREMENTS, ...FROZEN_BODY_PIN_REQUIREMENTS])(
    'rejects omitted required source/body module %s', async path => {
      const { evidence } = await bindingFixture(), sha = await frozenSha256(new TextEncoder().encode('actual pinned bytes'));
      evidence.sourceFingerprints = Object.fromEntries(FROZEN_SOURCE_PIN_REQUIREMENTS.map(path => [path, sha]));
      evidence.bodySourceFingerprints = Object.fromEntries(FROZEN_BODY_PIN_REQUIREMENTS.map(path => [path, sha]));
      evidence.sourceFitFingerprint = sha;
      delete evidence.sourceFingerprints[path]; delete evidence.bodySourceFingerprints[path];
      await expect(verifyFrozenModulePins(evidence, async () => 'actual pinned bytes')).rejects.toThrow('Missing required');
    });
  it('checks exact geodesic attribution paths without permitting arbitrary text paths', async () => {
    const { evidence } = await bindingFixture(), bytes = 'actual pinned attribution';
    const sha = await frozenSha256(new TextEncoder().encode(bytes));
    evidence.sourceFingerprints = Object.fromEntries(FROZEN_SOURCE_PIN_REQUIREMENTS.map(path => [path, sha]));
    evidence.bodySourceFingerprints = Object.fromEntries(FROZEN_BODY_PIN_REQUIREMENTS.map(path => [path, sha]));
    evidence.sourceFitFingerprint = sha;
    for (const path of ['packages/avatar/src/surfaceGeodesic.LICENSE', 'packages/avatar/src/surfaceGeodesic.NOTICE']) evidence.bodySourceFingerprints[path] = sha;
    await verifyFrozenModulePins(evidence, async () => bytes);
    await expect(verifyFrozenModulePins(evidence, async path => path.endsWith('.NOTICE') ? bytes + 'changed' : bytes)).rejects.toThrow('pin differs');
    evidence.bodySourceFingerprints['packages/avatar/src/arbitrary.NOTICE'] = sha;
    await expect(verifyFrozenModulePins(evidence, async () => bytes)).rejects.toThrow('Invalid');
  });
  it('seals both request strings before a delayed digest and never parses later caller mutations', async () => {
    const { evidence } = await bindingFixture(), snapshotJson = JSON.stringify(evidence);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshotJson));
    const snapshotSha256 = await frozenSha256(new TextEncoder().encode(snapshotJson));
    let release!: (value: ArrayBuffer) => void;
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { release = resolve; }));
    const request = { snapshotJson, snapshotSha256 }, pending = decodeFrozenRenderRequest(request);
    request.snapshotJson = JSON.stringify({ ...evidence, frame: 999 }); request.snapshotSha256 = 'f'.repeat(64);
    release(digest);
    expect((await pending).frame).toBe(2);
  });
  it('binds genuine unrefined source fields without inventing gathering approval', async () => {
    const f = await bindingFixture();
    for (const source of [f.pattern.garmentCodeSource!, f.evidence.pattern.garmentCodeSource!]) {
      delete source.gatherProvenance; delete source.gatherSourceDocument;
      source.properties = { sourceVersion: 'original-unrefined-unit-control' };
    }
    expect((await bindFrozenPrepared(f.evidence, f.actual)).positions).toEqual(f.prepared.simData.positions);
    expect(f.pattern.garmentCodeSource!.gatherProvenance).toBeUndefined();
    f.evidence.pattern.garmentCodeSource!.properties.sourceVersion = 'tampered';
    await expect(bindFrozenPrepared(f.evidence, f.actual)).rejects.toThrow('original source properties');
    f.evidence.pattern.garmentCodeSource!.properties.sourceVersion = 'original-unrefined-unit-control';
    f.evidence.pattern.garmentCodeSource!.panelNames = ['different-cut'];
    await expect(bindFrozenPrepared(f.evidence, f.actual)).rejects.toThrow('cut identity');
  });
  it('never treats unsupported native preparation as a source observation', async () => {
    const f = await bindingFixture(); f.prepared.collisionSafety = false;
    await expect(bindFrozenPrepared(f.evidence, f.actual)).rejects.toThrow('active source preparation');
  });
  it.each(['provenance', 'lossless-document'])( 'rejects refined geometry with missing existing %s', async missing => {
    const f = await bindingFixture();
    f.evidence.sourceGatherRefinement = { revision: 'source-free-gather-boundary-v1' };
    if (missing === 'provenance') delete f.evidence.pattern.garmentCodeSource!.gatherProvenance;
    else delete f.evidence.pattern.garmentCodeSource!.gatherSourceDocument;
    await expect(bindFrozenPrepared(f.evidence, f.actual)).rejects.toThrow('existing approved lossless');
  });
  it('verifies original JSON bytes and rejects changed or malformed snapshots', async () => {
    const { evidence } = await bindingFixture(); const snapshotJson = JSON.stringify(evidence);
    const snapshotSha256 = await frozenSha256(new TextEncoder().encode(snapshotJson));
    expect((await decodeFrozenRenderRequest({ snapshotJson, snapshotSha256 })).frame).toBe(2);
    await expect(decodeFrozenRenderRequest({ snapshotJson: snapshotJson + ' ', snapshotSha256 })).rejects.toThrow('digest');
  });
  it('requires real module pins, refuses traversal and checks bytes rather than declared version strings', async () => {
    const { evidence } = await bindingFixture(); const bytes = 'immutable actual source';
    const sha = await frozenSha256(new TextEncoder().encode(bytes));
    evidence.sourceFingerprints = Object.fromEntries(FROZEN_SOURCE_PIN_REQUIREMENTS.map(path => [path,sha]));
    evidence.bodySourceFingerprints = Object.fromEntries(FROZEN_BODY_PIN_REQUIREMENTS.map(path => [path,sha])); evidence.sourceFitFingerprint = sha;
    await verifyFrozenModulePins(evidence, async () => bytes);
    await expect(verifyFrozenModulePins(evidence, async () => bytes + 'changed')).rejects.toThrow('pin differs');
    evidence.sourceFingerprints['scripts/../secret.ts'] = sha;
    await expect(verifyFrozenModulePins(evidence, async () => bytes)).rejects.toThrow('Invalid');
  });
});

describe('body4 immutable source-refined CPU fixture (never body5 fit evidence)', () => {
  it('binds the unchanged real body/topology/refinement/material buffers and independently verifies finite safety', async () => {
    const { readFileSync } = await import('node:fs');
    const { gunzipSync } = await import('node:zlib');
    const { createHash } = await import('node:crypto');
    const { ClothCollisionGuard, packBodyMesh } = await import('@seamer/cloth-sim');
    const { sourceCollisionPreparation } = await import('../utils/sourceCollisionPreparation');
    const bytes = gunzipSync(readFileSync(new URL('../../../packages/cloth-sim/src/__fixtures__/cpu-source-gather-skirt.json.gz', import.meta.url)));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('d1ee9369922638d29b3df4d68f170d11f8d3d3f77890cf1e3b2490cfefc65b52');
    const actual = JSON.parse(bytes.toString('utf8')), f = await bindingFixture();
    // Fixture is explicitly initial assembly, not fit or generator approval evidence.
    Object.assign(f.prepared, { body: packBodyMesh(Float32Array.from(actual.bodyPositions), Uint32Array.from(actual.bodyIndices)) });
    Object.assign(f.prepared.simData, { positions: Float32Array.from(actual.clothPositions), particleCount: actual.particleCount,
      triangles: Uint32Array.from(actual.clothTriangles), seams: Int32Array.from(actual.seams), seamOrder: Int32Array.from(actual.seamOrder),
      seamPairsBySeam: actual.seamPairs, stitchCount: actual.stitchCount, sourceStaging: actual.sourceStaging,
      sourceGatherRefinement: actual.sourceGatherRefinement, sourceGatherCollisionGeometry: { ...actual.sourceGatherCollisionGeometry,
        sourceMaterialCoordinates: Float32Array.from(actual.sourceGatherCollisionGeometry.sourceMaterialCoordinates) } });
    const context = sourceCollisionPreparation(f.prepared);
    const activation = context.initialActivation;
    const guard = new ClothCollisionGuard({ bodyPositions: Float32Array.from(actual.bodyPositions), bodyIndices: Uint32Array.from(actual.bodyIndices),
      clothTriangles: f.prepared.simData.triangles, particleCount: actual.particleCount, seams: f.prepared.simData.seams,
      sourceGatherRefinementRevision: actual.sourceGatherRefinement.revision,
      sourceGatherCollisionGeometry: f.prepared.simData.sourceGatherCollisionGeometry as ConstructorParameters<typeof ClothCollisionGuard>[0]['sourceGatherCollisionGeometry'], ...context.dictionary });
    const report = guard.inspect(f.prepared.simData.positions, undefined, activation);
    expect(report.safe).toBe(true);
    Object.assign(f.evidence, { bodyPositions: actual.bodyPositions, bodyIndices: actual.bodyIndices, clothPositions: actual.clothPositions,
      clothTriangles: actual.clothTriangles, seams: actual.seams, sourceGatherRefinement: actual.sourceGatherRefinement,
      sourceGatherCollisionGeometry: actual.sourceGatherCollisionGeometry, collisionSeamDictionary: context.dictionary,
      collisionSeamActivation: { ...activation, activeSeams: Array.from(activation.activeSeams) }, safetyReport: report });
    f.actual.bodyPositions = Float32Array.from(actual.bodyPositions); f.actual.bodyIndices = Uint32Array.from(actual.bodyIndices);
    expect((await bindFrozenPrepared(f.evidence, f.actual)).positions).toEqual(f.prepared.simData.positions);
    f.evidence.sourceGatherCollisionGeometry = { ...actual.sourceGatherCollisionGeometry, refinementPolicySha256: 'f'.repeat(64) };
    await expect(bindFrozenPrepared(f.evidence, f.actual)).rejects.toThrow('collision geometry');
  });
});


describe('diagnostic automation read-only surface', () => {
  it('keeps actual readers and blocks command, preview transaction, undo and redo mutation without changing the original API', () => {
    let edits = 0;
    const api = { getPattern: () => ({ original: true }), execute: () => ++edits, preview: () => ++edits,
      beginTransaction: () => ++edits, undo: () => ++edits, redo: () => ++edits };
    const readonly = frozenReadOnlyAutomation(api);
    expect(readonly.getPattern()).toEqual({ original: true });
    for (const operation of ['execute', 'preview', 'beginTransaction', 'undo', 'redo'] as const) expect(() => readonly[operation]()).toThrow('read-only');
    expect(edits).toBe(0); api.execute(); expect(edits).toBe(1);
  });
  it('returns lossless defensive nested document/cache readers, including reactive proxies and signed zero', () => {
    const document = { meta: { revision: 1 }, content: { pieces: [{ settings3d: { savedSourceAssemblyComplete: false } }],
      source: { signed: -0, raw: { value: ['n', '8000000000000000'] } }, typed: new Float32Array([-0, 2]) } };
    const original = structuredClone(document), api = { getPattern: () => new Proxy(document.content, {}),
      getContent: () => document.content, getDoc: () => document, getSelection: () => ({ pieceIds: ['original'] }) };
    const readonly = frozenReadOnlyAutomation(api);
    for (const reader of [readonly.getPattern, readonly.getContent]) {
      const copy = reader(); expect(Object.is(copy.source.signed, -0)).toBe(true);expect(Object.is(copy.typed[0], -0)).toBe(true);
      copy.pieces[0].settings3d.savedSourceAssemblyComplete = true;copy.source.raw.value[1] = 'lost';copy.typed[1] = 99;
    }
    const doc = readonly.getDoc();doc.meta.revision = 9;doc.content.pieces[0].settings3d.savedSourceAssemblyComplete = true;
    const selection = readonly.getSelection();selection.pieceIds[0] = 'changed';
    expect(api.getSelection().pieceIds).toEqual(['original']);expect(document).toEqual(original);
    api.getContent().pieces[0].settings3d.savedSourceAssemblyComplete = true;
    expect(document.content.pieces[0].settings3d.savedSourceAssemblyComplete).toBe(true);
  });

});
