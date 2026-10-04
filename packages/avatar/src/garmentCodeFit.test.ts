/// <reference types="node" />
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { parseCoefficients, parseIndices, parseSkinIndices, parseSkinWeights, reconstructVertices } from '@seamer/body-model';
import type { BaseModel, GenderModel } from '@seamer/body-model';
import type { Body } from '@seamer/pattern-model';
import { activeGarmentCodeBody, attachGarmentCodeBody, fitGarmentCodeAvatar, measureGarmentCodeTorsoGirths, measureGarmentCodeUpperThighGirths, validateGarmentCodeBody } from './garmentCodeFit';
import { anchorPoint, type MeasureSegmentDef } from './bodyMeasurements3d';
import { solveBodyCoefficients } from './measurements';
import { AvatarController } from './avatarController';
import { fitSourceSurfaceDimensions, measureSourceSurfaceDimensions } from './sourceSurfaceDimensions';
// These are CPU geometry controls. Production source fitting requires its module worker;
// actual worker equivalence, failure and stale-generation controls are tested separately.
const createCpuAvatar = (value: Body, material: THREE.Material) =>
  AvatarController.create(value, material, { sourceFitMode: 'synchronous' });

vi.mock('./assets', () => ({
  loadAvatarAssets: async () => assets,
  loadGenderAssets: async () => ({ gender: 'female', model: statistics, coefficients })
}));

const asset = (name: string) => new URL(`../../../vendor/body-model/models/${name}`, import.meta.url);
const bytes = (name: string): ArrayBuffer => {
  const data = readFileSync(asset(name));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
};
const base = JSON.parse(readFileSync(asset('base_model.json'), 'utf8')) as BaseModel;
const statistics = JSON.parse(readFileSync(asset('female_model.json'), 'utf8')) as GenderModel;
const coefficients = parseCoefficients(bytes('female_coefficients.bin'));
const indices = parseIndices(bytes('indices.bin'));
const skinIndices = parseSkinIndices(bytes('skin_indices.bin'));
const skinWeights = parseSkinWeights(bytes('skin_weights.bin'));
const assets = { baseModel: base, indices, skinIndices, skinWeights, numVertices: skinWeights.length / 4, numTriangles: indices.length / 3 };
// Resolved neutral dimensions used by the pinned real GarmentCode generator.
const measurements = { height: 171.99, head_l: 26.3262, waist_line: 36.8913, hips_line: 23.4837,
  shoulder_w: 36.4568, shoulder_incl: 21.6777, arm_pose_angle: 45.483, bust: 99.8407,
  waist: 84.3338, hips: 103.478, arm_length: 53.9697, bust_line: 25.6947, vert_bust_line: 21.1388 };
const body: Body = { gender: 'female', unitType: 'metric', bodyColor: '#b58a6a', fields: {
  age: 35, weight: 150 * 0.453592, height: measurements.height, chestGirth: measurements.bust,
  waistGirth: measurements.waist, hipGirth: measurements.hips, armLength: measurements.arm_length
} };
const fittedBody = attachGarmentCodeBody(body, measurements);
const coefficientsFor = (value: Body) => solveBodyCoefficients(statistics, value).coeff;
const rest = reconstructVertices(base, coefficients, coefficientsFor(body));
const anchors = (vertices: Float32Array, name: string) => {
  const def = (base.measurements as MeasureSegmentDef[]).find(m => m.name === name)!;
  return def.coordinates!.map(a => anchorPoint(a, vertices, indices)!);
};
const averageY = (points: number[][]) => points.reduce((sum, p) => sum + p[1], 0) / points.length;
const rangeY = (vertices: Float32Array) => {
  let min = Infinity, max = -Infinity;
  for (let i = 1; i < vertices.length; i += 3) { min = Math.min(min, vertices[i]); max = Math.max(max, vertices[i]); }
  return { min, max };
};
const maximumDifference = (a: Float32Array, b: Float32Array) => {
  let maximum = 0;
  for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
  return maximum;
};

describe('GarmentCode dimensional avatar calibration', () => {
  it('corrects actual mesh height, ground, anatomical levels and shoulder width', () => {
    const initialRange = rangeY(rest);
    expect(initialRange.max - initialRange.min).toBeLessThan(1.68);
    const fitted = fitGarmentCodeAvatar(rest, indices, base, fittedBody);
    expect(fitted).not.toBe(rest);
    const actual = rangeY(fitted);
    expect(actual.min).toBeCloseTo(0, 6);
    expect(actual.max).toBeCloseTo(measurements.height / 100, 6);
    const neck = (measurements.height - measurements.head_l) / 100;
    const waist = neck - measurements.waist_line / 100;
    expect(Math.abs(averageY(anchors(fitted, 'neckGirth')) - neck)).toBeLessThan(0.004);
    expect(Math.abs(averageY(anchors(fitted, 'waistGirth')) - waist)).toBeLessThan(0.002);
    expect(averageY(anchors(fitted, 'hipGirth'))).toBeCloseTo(waist - measurements.hips_line / 100, 6);
    const shoulders = anchors(fitted, 'shoulderWidth').sort((a, b) => a[0] - b[0]);
    const tips = [shoulders[0], shoulders.at(-1)!];
    expect(tips[1][0] - tips[0][0]).toBeCloseTo(measurements.shoulder_w / 100, 6);
    const neckSide = anchors(fitted, 'neckSideToShoulder')[0], shoulder = tips[0];
    const inclination = Math.atan2(neckSide[1] - shoulder[1], Math.hypot(neckSide[0] - shoulder[0], neckSide[2] - shoulder[2])) * 180 / Math.PI;
    expect(inclination).toBeCloseTo(measurements.shoulder_incl, 3);
    expect([...fitted].every(Number.isFinite)).toBe(true);
    const girths = measureGarmentCodeTorsoGirths(fitted, indices, base);
    for (const name of ['bust', 'waist', 'hips'] as const) expect(Math.abs(girths[name] - measurements[name])).toBeLessThan(0.5);
  });

  it('leaves native geometry untouched and invalidates calibration when avatar inputs change', () => {
    expect(fitGarmentCodeAvatar(rest, indices, base, body)).toBe(rest);
    for (const edited of [
      { ...fittedBody, fields: { ...fittedBody.fields, height: 180 } },
      { ...fittedBody, gender: 'male' }, { ...fittedBody, unitType: 'imperial' },
      { ...fittedBody, fields: { ...fittedBody.fields, weight: 75 } }
    ]) {
      expect(activeGarmentCodeBody(edited)).toBeNull();
      expect(fitGarmentCodeAvatar(rest, indices, base, edited)).toBe(rest);
    }
    expect(activeGarmentCodeBody({ ...fittedBody, bodyColor: '#000000' })).not.toBeNull();
  });

  it('signs field order independently and rejects malformed or impossible source metadata', () => {
    const reordered = { ...fittedBody, fields: Object.fromEntries(Object.entries(fittedBody.fields).reverse()) };
    expect(activeGarmentCodeBody(reordered)).toEqual(measurements);
    for (const invalid of [null, [], {}, { ...measurements, height: Number.NaN },
      { ...measurements, hips_line: 200 }, { ...measurements, shoulder_incl: 91 }, { ...measurements, arm_pose_angle: 100 }]) {
      expect(() => validateGarmentCodeBody(invalid)).toThrow(/GarmentCode/);
    }
  });

  it('accepts legal zero/extreme shoulder inclinations without collapsing the avatar', () => {
    for (const shoulder_incl of [0, 80, 90]) {
      const candidate = attachGarmentCodeBody(body, { ...measurements, shoulder_incl });
      const fitted = fitGarmentCodeAvatar(rest, indices, base, candidate);
      expect(rangeY(fitted).max).toBeCloseTo(measurements.height / 100, 6);
      expect(rangeY(fitted).min).toBeCloseTo(0, 6);
      expect([...fitted].every(Number.isFinite)).toBe(true);
    }
  });

  it.each([{ height: 176, bust: 101, waist: 88 }, { height: 183, bust: 99.8407, waist: 92 }])(
    'fits taller generated source dimensions $height cm', overrides => {
      const source = { ...measurements, ...overrides };
      const mapped = { ...body, fields: { ...body.fields, height: source.height, chestGirth: source.bust, waistGirth: source.waist } };
      const original = reconstructVertices(base, coefficients, coefficientsFor(mapped));
      const fitted = fitGarmentCodeAvatar(original, indices, base, attachGarmentCodeBody(mapped, source));
      expect(rangeY(fitted).max).toBeCloseTo(source.height / 100, 6);
      expect(rangeY(fitted).min).toBeCloseTo(0, 6);
      const girths = measureGarmentCodeTorsoGirths(fitted, indices, base);
      for (const name of ['bust', 'waist', 'hips'] as const) expect(Math.abs(girths[name] - source[name])).toBeLessThan(0.5);
    }
  );
});

describe('anatomical source shoulder inclination', () => {
  it('uses the lateral neck surface and does not treat back-neck trace length as diameter', () => {
    const fitted = fitGarmentCodeAvatar(rest, indices, base, fittedBody);
    for (const neck_w of [1, 18.9328, 30]) {
      expect(fitGarmentCodeAvatar(rest, indices, base, attachGarmentCodeBody(body, { ...measurements, neck_w }))).toEqual(fitted);
    }
    const oldDraftOriginY = (measurements.height - measurements.head_l) / 100 -
      Math.tan(measurements.shoulder_incl * Math.PI / 180) * measurements.shoulder_w / 200;
    const tip = anchors(fitted, 'shoulderWidth').find(p => p[0] < 0)!;
    expect(tip[1] - oldDraftOriginY).toBeGreaterThan(0.025);
    // Factual surface landmarks from pinned source mean_all.obj, matching these
    // neutral measurements. Native topology is approximate; these are not joints.
    expect(Math.abs(tip[0] - (-0.18493223))).toBeLessThan(0.005);
    expect(Math.abs(tip[1] - 1.41655614)).toBeLessThan(0.005);
  });

  it('retains the prior profile if the anatomical neck-side anchor is unavailable', () => {
    const missing = { ...base, measurements: (base.measurements as MeasureSegmentDef[]).filter(m => m.name !== 'neckSideToShoulder') };
    const fitted = fitGarmentCodeAvatar(rest, indices, missing, fittedBody);
    const tip = anchors(fitted, 'shoulderWidth').find(p => p[0] < 0)!;
    const fallbackY = (measurements.height - measurements.head_l) / 100 -
      Math.tan(measurements.shoulder_incl * Math.PI / 180) * measurements.shoulder_w / 200;
    expect(tip[1]).toBeCloseTo(fallbackY, 6);
    expect(rangeY(fitted).max).toBeCloseTo(measurements.height / 100, 6);
  });

  it.each([
    { height: 164 }, { height: 170 }, { height: 171.99 }, { height: 176 },
    { height: 183, waist: 92, hips: 110 }, { height: 176, bust: 101, waist: 88, hips: 106 }
  ])('keeps the calibrated mesh finite, unfolded and measured for %j', overrides => {
    const source = { ...measurements, crotch_hip_diff: 8.81363, leg_circ: 62, ...overrides };
    const mapped = { ...body, fields: { ...body.fields, height: source.height, chestGirth: source.bust,
      waistGirth: source.waist, hipGirth: source.hips } };
    const native = reconstructVertices(base, coefficients, coefficientsFor(mapped));
    const withoutOrigin = { ...base, measurements: (base.measurements as MeasureSegmentDef[]).filter(m => m.name !== 'neckSideToShoulder') };
    const signed = attachGarmentCodeBody(mapped, source, source.height === 183 ? 'apart' : 'straight');
    const before = fitGarmentCodeAvatar(native, indices, withoutOrigin, signed);
    const fitted = fitGarmentCodeAvatar(native, indices, base, signed);
    expect([...fitted].every(Number.isFinite)).toBe(true);
    expect(rangeY(fitted).min).toBeCloseTo(0, 6); expect(rangeY(fitted).max).toBeCloseTo(source.height / 100, 6);
    expect(averageY(anchors(fitted, 'crotchHeight'))).toBeCloseTo((source.height - source.head_l - source.waist_line - source.hips_line - source.crotch_hip_diff) / 100, 6);
    const actual = measureGarmentCodeTorsoGirths(fitted, indices, base);
    for (const name of ['bust', 'waist', 'hips'] as const) expect(Math.abs(actual[name] - source[name])).toBeLessThan(0.5);
    const normal = (points: Float32Array, at: number) => {
      const [a, b, c] = [indices[at], indices[at + 1], indices[at + 2]].map(i => i * 3);
      return new THREE.Vector3(points[b] - points[a], points[b + 1] - points[a + 1], points[b + 2] - points[a + 2])
        .cross(new THREE.Vector3(points[c] - points[a], points[c + 1] - points[a + 1], points[c + 2] - points[a + 2]));
    };
    for (let at = 0; at < indices.length; at += 3) {
      const prior = normal(before, at), after = normal(fitted, at);
      expect(after.length()).toBeGreaterThan(1e-12);
      expect(prior.dot(after)).toBeGreaterThan(0);
    }
  });
});

describe('source lower-body calibration', () => {
  const depth = 8.81363;
  it.each([164, 176, 183])('aligns source crotch at height %i without changing torso or arms', height => {
    const source = { ...measurements, height, crotch_hip_diff: depth };
    const mapped = { ...body, fields: { ...body.fields, height } };
    const native = reconstructVertices(base, coefficients, coefficientsFor(mapped));
    const baseline = fitGarmentCodeAvatar(native, indices, base, attachGarmentCodeBody(mapped, { ...measurements, height }));
    const fitted = fitGarmentCodeAvatar(native, indices, base, attachGarmentCodeBody(mapped, source));
    const target = (height - source.head_l - source.waist_line - source.hips_line - depth) / 100;
    expect(averageY(anchors(fitted, 'crotchHeight'))).toBeCloseTo(target, 6);
    expect(rangeY(fitted)).toEqual(rangeY(baseline));
    const armVertices = new Set(['left_arm', 'left_lower_arm', 'right_arm', 'right_lower_arm'].flatMap(part =>
      base.bodyParts[part].flatMap(face => [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]])));
    const hipY = averageY(anchors(baseline, 'hipGirth'));
    for (let at = 0; at < fitted.length; at += 3) {
      if (baseline[at + 1] >= hipY || armVertices.has(at / 3)) {
        for (let axis = 0; axis < 3; axis++) expect(Math.abs(fitted[at + axis] - baseline[at + axis])).toBeLessThan(0.00005);
      }
    }
    for (const name of ['hipGirth', 'waistGirth', 'neckGirth', 'shoulderWidth']) {
      expect(Math.abs(averageY(anchors(fitted, name)) - averageY(anchors(baseline, name)))).toBeLessThan(0.00005);
    }
    const girths = measureGarmentCodeTorsoGirths(fitted, indices, base);
    for (const name of ['bust', 'waist', 'hips'] as const) expect(Math.abs(girths[name] - source[name])).toBeLessThan(0.5);
  });

  it('preserves the existing profile for absent, impossible or unavailable crotch targets', () => {
    const baseline = fitGarmentCodeAvatar(rest, indices, base, fittedBody);
    for (const crotch_hip_diff of [0, 0.1, 400]) {
      const sourceBody = attachGarmentCodeBody(body, { ...measurements, crotch_hip_diff });
      expect(fitGarmentCodeAvatar(rest, indices, base, sourceBody)).toEqual(baseline);
    }
    const missing = { ...base, measurements: (base.measurements as MeasureSegmentDef[]).filter(m => m.name !== 'crotchHeight') };
    expect(fitGarmentCodeAvatar(rest, indices, missing, attachGarmentCodeBody(body, { ...measurements, crotch_hip_diff: depth }))).toEqual(baseline);
  });

  it('uses explicit apart metadata to align pants stance and upper-thigh girth', () => {
    const source = { ...measurements, height: 183, hips: 110, waist: 92, crotch_hip_diff: depth, leg_circ: 62 };
    const mapped = { ...body, fields: { ...body.fields, height: source.height, hipGirth: source.hips, waistGirth: source.waist } };
    const native = reconstructVertices(base, coefficients, coefficientsFor(mapped));
    const signed = attachGarmentCodeBody(mapped, source);
    const straight = fitGarmentCodeAvatar(native, indices, base, signed);
    const apart = fitGarmentCodeAvatar(native, indices, base, attachGarmentCodeBody(mapped, source, 'apart'));
    expect(signed.garmentCodeBody!.legPose).toBe('straight');
    const older = { ...signed, garmentCodeBody: { ...signed.garmentCodeBody!, legPose: undefined } };
    expect(fitGarmentCodeAvatar(native, indices, base, older)).toEqual(straight);
    expect(rangeY(apart)).toEqual(rangeY(straight));
    expect(measureGarmentCodeUpperThighGirths(apart, indices, base).every(n => Math.abs(n - source.leg_circ) < 0.5)).toBe(true);
    const hipY = averageY(anchors(straight, 'hipGirth'));
    const feet = new Set(['left_foot', 'right_foot'].flatMap(part => base.bodyParts[part]
      .flatMap(face => [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]])));
    const arms = new Set(['left_arm', 'left_lower_arm', 'right_arm', 'right_lower_arm'].flatMap(part =>
      base.bodyParts[part].flatMap(face => [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]])));
    let minimumFootShift = Infinity;
    for (let at = 0; at < apart.length; at += 3) {
      expect(apart[at + 1]).toBe(straight[at + 1]);
      if (straight[at + 1] >= hipY || arms.has(at / 3)) {
        expect(apart[at]).toBe(straight[at]); expect(apart[at + 2]).toBe(straight[at + 2]);
      }
      if (feet.has(at / 3)) minimumFootShift = Math.min(minimumFootShift, Math.abs(apart[at]) - Math.abs(straight[at]));
    }
    expect(minimumFootShift).toBeGreaterThan(0.04);
    expect(minimumFootShift).toBeLessThan(0.08);
    const normal = (vertices: Float32Array, at: number) => {
      const a = indices[at] * 3, b = indices[at + 1] * 3, c = indices[at + 2] * 3;
      return new THREE.Vector3(vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2])
        .cross(new THREE.Vector3(vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1], vertices[c + 2] - vertices[a + 2]));
    };
    for (let at = 0; at < indices.length; at += 3) {
      const before = normal(straight, at), after = normal(apart, at);
      expect(after.length()).toBeGreaterThan(1e-12);
      expect(before.dot(after) / (before.length() * after.length())).toBeGreaterThan(0.9);
    }
    const stale = { ...attachGarmentCodeBody(mapped, source, 'apart'), fields: { ...mapped.fields, height: 180 } };
    expect(fitGarmentCodeAvatar(native, indices, base, stale)).toBe(native);
    expect(() => attachGarmentCodeBody(mapped, source, 'invalid' as 'apart')).toThrow(/leg pose/);
    const { leg_circ: omitted, ...withoutGirth } = source;
    expect(omitted).toBe(62);
    const poseOnly = fitGarmentCodeAvatar(native, indices, base, attachGarmentCodeBody(mapped, withoutGirth, 'apart'));
    for (const leg_circ of [20, 100, 400]) {
      const unsupported = attachGarmentCodeBody(mapped, { ...source, leg_circ }, 'apart');
      expect(fitGarmentCodeAvatar(native, indices, base, unsupported)).toEqual(poseOnly);
    }
  });
});

describe('calibrated source pose in AvatarController', () => {
  it.each([
    ['native', undefined], ['source', undefined],
    ['native', null], ['source', null], ['native', 'A'], ['source', 'A']
  ] as const)('copies %s pose selection %s to a detached replacement without confusing default and chosen poses', async (origin, choice) => {
    const material = new THREE.MeshBasicMaterial();
    const initialBody = origin === 'native' ? body : fittedBody;
    const replacementBody = origin === 'native' ? fittedBody : body;
    const previous = await createCpuAvatar(initialBody, material);
    if (choice !== undefined) previous.setPose(choice);
    const before = previous.vertexPositions.slice();
    const candidate = await createCpuAvatar(replacementBody, material);
    const reference = await createCpuAvatar(replacementBody, material);
    if (choice !== undefined) reference.setPose(choice);
    candidate.copyPoseSelectionFrom(previous);
    expect(candidate.poseName()).toBe(choice === undefined ? origin === 'native' ? 'A' : null : choice);
    expect(maximumDifference(candidate.vertexPositions, reference.vertexPositions)).toBeLessThan(1e-6);
    expect(previous.vertexPositions).toEqual(before);
    // A later body reconstruction must retain the transferred choice/default distinction.
    await candidate.setBody(initialBody);
    const expected = await createCpuAvatar(initialBody, material);
    if (choice !== undefined) expected.setPose(choice);
    expect(candidate.poseName()).toBe(expected.poseName());
    expect(maximumDifference(candidate.vertexPositions, expected.vertexPositions)).toBeLessThan(1e-6);
    for (const controller of [previous, candidate, reference, expected]) controller.dispose();
    material.dispose();
  }, 15_000);

  it('matches upstream posed skin measurements and preserves explicit pose choices', async () => {
    const material = new THREE.MeshBasicMaterial();
    const controller = await createCpuAvatar(fittedBody, material);
    expect(controller.poseName()).toBe('A');
    const actual = measureSourceSurfaceDimensions(controller.vertexPositions, indices, base);
    // Upstream shoulder_w is Euclidean skin-landmark distance and arm_length is
    // the triangulated surface geodesic, not the shoulder-to-hand-joint chord.
    expect(Math.abs(actual.shoulderWidthM - measurements.shoulder_w / 100)).toBeLessThan(0.0001);
    for (const arm of actual.arms) {
      expect(Math.abs(arm.surfaceLengthM - measurements.arm_length / 100)).toBeLessThan(0.0001);
      expect(Math.abs(arm.inclinationDegrees - measurements.arm_pose_angle)).toBeLessThan(0.00002);
      expect(arm.surfaceLengthM).toBeGreaterThan(arm.chordLengthM);
      expect(arm.edgeGraphUpperBoundM).toBeGreaterThanOrEqual(arm.surfaceLengthM);
    }
    expect(rangeY(controller.vertexPositions).max).toBeCloseTo(measurements.height / 100, 5);
    const girths = measureGarmentCodeTorsoGirths(controller.vertexPositions, indices, base);
    for (const name of ['bust', 'waist', 'hips'] as const) expect(Math.abs(girths[name] - measurements[name])).toBeLessThan(0.1);
    controller.setPose('T');
    await controller.setBody(fittedBody);
    expect(controller.poseName()).toBe('T');
    controller.dispose(); material.dispose();
  });

  it.each([53.9697, 60])('fits source arm length %s cm independently on both sides and preserves distal hand shape', async arm_length => {
    const source = { ...measurements, height: 176, arm_length };
    const mapped = { ...body, fields: { ...body.fields, height: source.height } };
    const fitted = attachGarmentCodeBody(mapped, source);
    const original = reconstructVertices(base, coefficients, coefficientsFor(mapped));
    const withoutArms = fitGarmentCodeAvatar(original, indices, base, attachGarmentCodeBody(mapped, { ...source, arm_length: 0 }));
    const withArms = fitGarmentCodeAvatar(original, indices, base, fitted);
    const { createSkeleton, jointWorldPositions } = await import('@seamer/body-model');
    const joints = jointWorldPositions(createSkeleton(base, withoutArms), {});
    for (const side of ['Left', 'Right']) {
      const shoulder = joints.get(`mixamorig${side}Arm`)!;
      const wrist = joints.get(`mixamorig${side}Hand`)!;
      const axis = wrist.map((n, i) => n - shoulder[i]);
      const span = Math.hypot(...axis), direction = axis.map(n => n / span);
      const handDeltas: number[][] = [];
      for (let at = 0; at < withoutArms.length; at += 3) {
        const distance = direction.reduce((sum, n, i) => sum + (withoutArms[at + i] - shoulder[i]) * n, 0);
        if (distance > span + 0.04 && Math.hypot(...direction.map((n, i) => withoutArms[at + i] - shoulder[i] - n * distance)) < 0.1) {
          handDeltas.push([0, 1, 2].map(i => withArms[at + i] - withoutArms[at + i]));
        }
      }
      expect(handDeltas.length).toBeGreaterThan(100);
      for (const delta of handDeltas) for (let i = 0; i < 3; i++) expect(Math.abs(delta[i] - handDeltas[0][i])).toBeLessThan(0.00001);
    }
    const material = new THREE.MeshBasicMaterial();
    const controller = await createCpuAvatar(fitted, material);
    const actual = measureSourceSurfaceDimensions(controller.vertexPositions, indices, base);
    expect(Math.abs(actual.shoulderWidthM - source.shoulder_w / 100)).toBeLessThan(0.0001);
    for (const arm of actual.arms) {
      expect(Math.abs(arm.surfaceLengthM - source.arm_length / 100)).toBeLessThan(0.0001);
      expect(Math.abs(arm.inclinationDegrees - source.arm_pose_angle)).toBeLessThan(0.00002);
    }
    expect(rangeY(controller.vertexPositions).min).toBeCloseTo(0, 6);
    expect(rangeY(controller.vertexPositions).max).toBeCloseTo(1.76, 6);
    // Exercise the final surface fit, including its shoulder-width/torso feedback.
    // Use the same signed body coefficients as the controller, then compare actual
    // distal arm-part vertices in rest pose. Pairwise differences remove translation.
    const signedNative = reconstructVertices(base, coefficients, coefficientsFor(fitted));
    const preliminary = fitGarmentCodeAvatar(signedNative, indices, base, fitted);
    const finalRest = fitSourceSurfaceDimensions(preliminary, indices, skinIndices, skinWeights, base, source);
    controller.setPose(null);
    expect(maximumDifference(controller.vertexPositions, finalRest)).toBeLessThan(1e-6);
    const preliminaryJoints = jointWorldPositions(createSkeleton(base, preliminary), {});
    for (const side of ['Left', 'Right']) {
      const armParts = [`${side.toLowerCase()}_arm`, `${side.toLowerCase()}_lower_arm`];
      const armVertices = new Set(armParts.flatMap(part => base.bodyParts[part]
        .flatMap(face => [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]])));
      const shoulder = preliminaryJoints.get(`mixamorig${side}Arm`)!;
      const wrist = preliminaryJoints.get(`mixamorig${side}Hand`)!;
      const axis = wrist.map((n, i) => n - shoulder[i]);
      const span = Math.hypot(...axis), direction = axis.map(n => n / span);
      const distal = Array.from(armVertices).filter(vertex => {
        const relative = [0, 1, 2].map(i => preliminary[vertex * 3 + i] - shoulder[i]);
        const distance = direction.reduce((sum, n, i) => sum + relative[i] * n, 0);
        return distance > span + 0.1 && Math.hypot(...relative.map((n, i) => n - direction[i] * distance)) < 0.1;
      });
      // Distal fingers are part of the actual arm sets, beyond the capped axial
      // correction region; none should enter the non-arm torso-width branch.
      expect(distal.length).toBeGreaterThan(100);
      const reference = distal[0];
      for (const vertex of distal) for (let i = 0; i < 3; i++) {
        const before = preliminary[vertex * 3 + i] - preliminary[reference * 3 + i];
        const after = finalRest[vertex * 3 + i] - finalRest[reference * 3 + i];
        expect(Math.abs(after - before)).toBeLessThan(0.00001);
      }
    }
    controller.dispose(); material.dispose();
  });

  it('keeps native avatars in rest pose and does not apply stale metadata to later body edits', async () => {
    const material = new THREE.MeshBasicMaterial();
    const controller = await createCpuAvatar(body, material);
    expect(controller.poseName()).toBeNull();
    expect(maximumDifference(controller.vertexPositions, rest)).toBeLessThan(1e-6);
    await controller.setBody(fittedBody);
    expect(controller.poseName()).toBe('A');
    const edited = { ...fittedBody, fields: { ...fittedBody.fields, height: 180 } };
    await controller.setBody(edited);
    expect(controller.poseName()).toBeNull();
    const expected = reconstructVertices(base, coefficients, coefficientsFor(edited));
    expect(maximumDifference(controller.vertexPositions, expected)).toBeLessThan(1e-6);
    controller.dispose(); material.dispose();
  });
});
