import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { attachGarmentCodeBody } from '@seamer/avatar';
import { convertGarmentCodePattern } from '$lib/utils/importGarmentCode';
import { patternToSSP, sspToPattern } from '$lib/utils/ssp';
import { prepareCloth } from '@seamer/cloth-sim';
import { compatibleSourceBodyCheckpoint, capturedSourceStretchPolicy, capturedSourceAssemblyComplete, SOURCE_BODY_FIT_REVISION, GARMENT_CODE_ASSEMBLY_REVISION, GARMENT_CODE_SOURCE_STRETCH_POLICY } from './sourceBodyCheckpoint';

function sourceCheckpoint() {
  const pattern = convertGarmentCodePattern(JSON.parse(readFileSync(
    new URL('../../../static/examples/garmentcode/hoody_mean_specification.json', import.meta.url), 'utf8'
  )));
  pattern.body = attachGarmentCodeBody(pattern.body, {
    height: 176, head_l: 26.3262, waist_line: 36.8913, hips_line: 23.4837,
    shoulder_w: 36.4568, shoulder_incl: 21.6777, bust: 99.8407,
    waist: 84.3338, hips: 103.478, arm_length: 53.9697, arm_pose_angle: 45.483
  });
  pattern.pieces[0].settings3d.savedPositions = [0, 0, .5, 1, .2, 10, 0, .51, 1, .2, 0, 10, .5, 1.01, .2];
  pattern.pieces[0].settings3d.savedDrapeState = 'checkpoint';
  pattern.pieces[0].settings3d.savedSourceStretchPolicy = GARMENT_CODE_SOURCE_STRETCH_POLICY;
  pattern.pieces[0].settings3d.savedSourceAssemblyComplete = true;
  return pattern;
}

describe('source cloth checkpoint body and assembly compatibility', () => {
  it('reassembles older source checkpoints without changing the saved document or 2D geometry', () => {
    const pattern = sourceCheckpoint();
    const original = structuredClone(pattern);
    const compatible = compatibleSourceBodyCheckpoint(pattern);
    expect(compatible.pieces[0].settings3d.savedPositions).toEqual([]);
    expect(compatible.pieces[0].settings3d.savedDrapeState).toBe('checkpoint');
    expect(compatible.points).toBe(pattern.points);
    expect(compatible.seams).toBe(pattern.seams);
    expect(pattern).toEqual(original);
  });

  it('preserves current anatomical-body checkpoints through native archive reload', async () => {
    const pattern = sourceCheckpoint();
    pattern.pieces[0].settings3d.savedBodyFitRevision = SOURCE_BODY_FIT_REVISION;
    pattern.pieces[0].settings3d.savedAssemblyRevision = GARMENT_CODE_ASSEMBLY_REVISION;
    const restored = await sspToPattern(await patternToSSP(pattern));
    expect(restored.pieces[0].settings3d.savedPositions).toEqual(pattern.pieces[0].settings3d.savedPositions);
    expect(restored.pieces[0].settings3d.savedBodyFitRevision).toBe(SOURCE_BODY_FIT_REVISION);
    expect(restored.pieces[0].settings3d.savedAssemblyRevision).toBe(GARMENT_CODE_ASSEMBLY_REVISION);
    expect(restored.pieces[0].settings3d.savedSourceStretchPolicy).toBe(GARMENT_CODE_SOURCE_STRETCH_POLICY);
    expect(restored.pieces[0].settings3d.savedSourceAssemblyComplete).toBe(true);
    expect(compatibleSourceBodyCheckpoint(restored)).toBe(restored);
  });
  it('reassembles the previous body-fit revision after source calibration changes', () => {
    const pattern = sourceCheckpoint();
    pattern.pieces[0].settings3d.savedBodyFitRevision = SOURCE_BODY_FIT_REVISION - 1;
    pattern.pieces[0].settings3d.savedAssemblyRevision = GARMENT_CODE_ASSEMBLY_REVISION;
    const compatible = compatibleSourceBodyCheckpoint(pattern);
    expect(compatible.pieces[0].settings3d.savedPositions).toEqual([]);
    expect(compatible.pieces[0].settings3d.savedBodyFitRevision).toBe(SOURCE_BODY_FIT_REVISION);
    expect(pattern.pieces[0].settings3d.savedPositions).toHaveLength(15);
  });

  it('releases incompatible held targets while preserving a current explicit hold', () => {
    const pattern = sourceCheckpoint();
    pattern.pieces[0].settings3d.savedDrapeState = 'held';
    expect(compatibleSourceBodyCheckpoint(pattern).pieces[0].settings3d.savedDrapeState).toBe('checkpoint');
    expect(pattern.pieces[0].settings3d.savedDrapeState).toBe('held');
    pattern.pieces[0].settings3d.savedBodyFitRevision = SOURCE_BODY_FIT_REVISION;
    pattern.pieces[0].settings3d.savedAssemblyRevision = GARMENT_CODE_ASSEMBLY_REVISION;
    expect(compatibleSourceBodyCheckpoint(pattern)).toBe(pattern);
  });


  it.each([undefined, GARMENT_CODE_ASSEMBLY_REVISION - 1, NaN])('reassembles a current-body cache with missing or incompatible assembly revision %s', revision => {
    const pattern = sourceCheckpoint();
    pattern.pieces[0].settings3d.savedBodyFitRevision = SOURCE_BODY_FIT_REVISION;
    pattern.pieces[0].settings3d.savedAssemblyRevision = revision;
    pattern.pieces[0].settings3d.savedDrapeState = 'held';
    const original = structuredClone(pattern);
    const compatible = compatibleSourceBodyCheckpoint(pattern);
    expect(compatible.pieces[0].settings3d.savedPositions).toEqual([]);
    expect(compatible.pieces[0].settings3d.savedDrapeState).toBe('checkpoint');
    expect(compatible.pieces[0].settings3d.savedAssemblyRevision).toBe(GARMENT_CODE_ASSEMBLY_REVISION);
    expect(pattern).toEqual(original);
  });

  it.each(['partial particle', 'nonfinite coordinate'])('rejects a malformed current source cache: %s', kind => {
    const pattern = sourceCheckpoint();
    pattern.pieces[0].settings3d.savedBodyFitRevision = SOURCE_BODY_FIT_REVISION;
    pattern.pieces[0].settings3d.savedAssemblyRevision = GARMENT_CODE_ASSEMBLY_REVISION;
    if (kind === 'partial particle') pattern.pieces[0].settings3d.savedPositions.pop();
    else pattern.pieces[0].settings3d.savedPositions[2] = NaN;
    expect(compatibleSourceBodyCheckpoint(pattern).pieces[0].settings3d.savedPositions).toEqual([]);
  });

  it('does not change empty source caches just to stamp revision metadata', () => {
    const pattern = sourceCheckpoint();
    pattern.pieces[0].settings3d.savedPositions = [];
    expect(compatibleSourceBodyCheckpoint(pattern)).toBe(pattern);
  });

  it.each(['native', 'older raw import', 'edited body'])('preserves %s caches outside active source calibration', kind => {
    const pattern = sourceCheckpoint();
    if (kind === 'native') delete pattern.garmentCodeSource;
    if (kind === 'older raw import') delete pattern.body.garmentCodeBody;
    if (kind === 'edited body') pattern.body.fields.height = (pattern.body.fields.height ?? 170) + 1;
    expect(compatibleSourceBodyCheckpoint(pattern)).toBe(pattern);
  });

  it.each([undefined, 'legacy-softened-seam-stretch', 'source-authored-seam-stretch-v0'])('reassembles current-body/current-assembly source caches with missing or old rest policy %s', policy => {
    const pattern = sourceCheckpoint();
    Object.assign(pattern.pieces[0].settings3d, { savedBodyFitRevision: SOURCE_BODY_FIT_REVISION,
      savedAssemblyRevision: GARMENT_CODE_ASSEMBLY_REVISION, savedSourceStretchPolicy: policy,
      savedDrapeState: 'held', savedMeshSnapshot: { positions: 'stale-encoded-vertices', faces: 'stale-encoded-faces' } });
    const original = structuredClone(pattern);
    const compatible = compatibleSourceBodyCheckpoint(pattern);
    expect(compatible.pieces[0].settings3d.savedPositions).toEqual([]);
    expect(compatible.pieces[0].settings3d.savedMeshSnapshot).toBeUndefined();
    expect(compatible.pieces[0].settings3d.savedDrapeState).toBe('checkpoint');
    expect(compatible.pieces[0].settings3d.savedSourceStretchPolicy).toBe(GARMENT_CODE_SOURCE_STRETCH_POLICY);
    expect(compatible.points).toBe(pattern.points); expect(compatible.seams).toBe(pattern.seams);
    expect(pattern).toEqual(original);
  });

  it('preserves a native addition in a source document when only its rest marker is missing', () => {
    const pattern = sourceCheckpoint();
    const native = structuredClone(pattern.pieces[0]); native.id = 'native-added-panel';
    native.settings3d.arrangement.sourcePlacement = undefined;
    native.settings3d.savedBodyFitRevision = SOURCE_BODY_FIT_REVISION;
    native.settings3d.savedAssemblyRevision = GARMENT_CODE_ASSEMBLY_REVISION;
    native.settings3d.savedSourceStretchPolicy = undefined;
    native.settings3d.savedDrapeState = 'held';
    pattern.pieces.push(native);
    Object.assign(pattern.pieces[0].settings3d, { savedBodyFitRevision: SOURCE_BODY_FIT_REVISION, savedAssemblyRevision: GARMENT_CODE_ASSEMBLY_REVISION });
    expect(compatibleSourceBodyCheckpoint(pattern)).toBe(pattern);
    expect(pattern.pieces.at(-1)).toBe(native);
  });

  it.each(['old rest policy', 'partial assembly'])('bakes a stale held source cache (%s) from fresh arrangement with zero held-anchor weights', reason => {
    const pattern = sourceCheckpoint();
    pattern.pieces = [pattern.pieces[0]]; pattern.seams = [];
    Object.assign(pattern.pieces[0].settings3d, { savedBodyFitRevision: SOURCE_BODY_FIT_REVISION,
      savedAssemblyRevision: GARMENT_CODE_ASSEMBLY_REVISION,
      savedSourceStretchPolicy: reason === 'old rest policy' ? undefined : GARMENT_CODE_SOURCE_STRETCH_POLICY,
      savedSourceAssemblyComplete: reason !== 'partial assembly', savedDrapeState: 'held' });
    const original = structuredClone(pattern);
    const compatible = compatibleSourceBodyCheckpoint(pattern);
    const prepared = prepareCloth({ pattern: compatible, avatarVertices: new Float32Array(),
      avatarIndices: new Uint32Array(), cylinders: new Map() });
    expect(prepared).not.toBeNull();
    expect(prepared!.simData.particleCount).toBeGreaterThan(3);
    expect(prepared!.simData.sourceStretchPolicy?.policy).toBe(GARMENT_CODE_SOURCE_STRETCH_POLICY);
    expect(Array.from(prepared!.simData.anchors).filter((_, index) => index % 4 === 3).every(weight => weight === 0)).toBe(true);
    expect(pattern).toEqual(original);
  });

  it.each([undefined, false])('reassembles an incomplete source cache (%s) without changing its held document', async complete => {
    const pattern = sourceCheckpoint();
    Object.assign(pattern.pieces[0].settings3d, { savedBodyFitRevision: SOURCE_BODY_FIT_REVISION,
      savedAssemblyRevision: GARMENT_CODE_ASSEMBLY_REVISION, savedSourceAssemblyComplete: complete, savedDrapeState: 'held' });
    const original = structuredClone(pattern);
    const restored = await sspToPattern(await patternToSSP(pattern));
    expect(restored.pieces[0].settings3d.savedPositions).toEqual(pattern.pieces[0].settings3d.savedPositions);
    expect(restored.pieces[0].settings3d.savedSourceAssemblyComplete).toBe(complete);
    const compatible = compatibleSourceBodyCheckpoint(restored);
    expect(compatible.pieces[0].settings3d.savedPositions).toEqual([]);
    expect(compatible.pieces[0].settings3d.savedDrapeState).toBe('checkpoint');
    expect(compatible.pieces[0].settings3d.savedSourceAssemblyComplete).toBe(false);
    expect(pattern).toEqual(original);
  });

  it('preserves native additions with previous source assembly revisions and no completion marker', () => {
    const pattern = sourceCheckpoint();
    Object.assign(pattern.pieces[0].settings3d, { savedBodyFitRevision: SOURCE_BODY_FIT_REVISION,
      savedAssemblyRevision: GARMENT_CODE_ASSEMBLY_REVISION });
    const native = structuredClone(pattern.pieces[0]); native.id = 'native-added-panel';
    native.settings3d.arrangement.sourcePlacement = undefined;
    native.settings3d.savedAssemblyRevision = GARMENT_CODE_ASSEMBLY_REVISION - 1;
    native.settings3d.savedSourceStretchPolicy = undefined;
    native.settings3d.savedSourceAssemblyComplete = undefined;
    native.settings3d.savedDrapeState = 'held'; pattern.pieces.push(native);
    expect(compatibleSourceBodyCheckpoint(pattern)).toBe(pattern);
  });

  it('stamps completion only for newly captured source particles with live all-active evidence', () => {
    const policy = { policy: GARMENT_CODE_SOURCE_STRETCH_POLICY, sewingSolver: 'interleaved-stretch-sewing-v1' as const,
      sourcePieceIds: ['source-panel', 'mirrored-panel#M'], retainedSeamStretchEdges: 10, legacySoftenedSeamStretchEdges: 2 };
    expect(capturedSourceAssemblyComplete('source-panel', policy, true)).toBe(true);
    expect(capturedSourceAssemblyComplete('mirrored-panel', policy, false)).toBe(false);
    expect(capturedSourceAssemblyComplete('source-panel', policy, null)).toBe(false);
    expect(capturedSourceAssemblyComplete('native-panel', policy, true)).toBeUndefined();
    expect(capturedSourceAssemblyComplete('source-panel', null, true)).toBeUndefined();
  });

  it('stamps only the actual baked policy for original captured pieces, including mirror instances', () => {
    const policy = { policy: GARMENT_CODE_SOURCE_STRETCH_POLICY, sewingSolver: 'interleaved-stretch-sewing-v1' as const,
      sourcePieceIds: ['source-panel', 'mirrored-panel#M'], retainedSeamStretchEdges: 10, legacySoftenedSeamStretchEdges: 2 };
    expect(capturedSourceStretchPolicy('source-panel', policy)).toBe(policy.policy);
    expect(capturedSourceStretchPolicy('mirrored-panel', policy)).toBe(policy.policy);
    expect(capturedSourceStretchPolicy('native-panel', policy)).toBeUndefined();
    expect(capturedSourceStretchPolicy('source-panel', null)).toBeUndefined();
  });
});
