/// <reference types="node" />
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createSkeleton, meanCoefficients, parseCoefficients, parseIndices, parseSkinIndices, parseSkinWeights, poseVertices, reconstructVertices } from '@seamer/body-model';
import type { BaseModel, GenderModel } from '@seamer/body-model';
import { SkinnedAvatar } from './skinnedAvatar';

const asset = (name: string) => new URL(`../../../vendor/body-model/models/${name}`, import.meta.url);
const bytes = (name: string): ArrayBuffer => {
  const data = readFileSync(asset(name));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
};
const base = JSON.parse(readFileSync(asset('base_model.json'), 'utf8')) as BaseModel;
const statistics = JSON.parse(readFileSync(asset('female_model.json'), 'utf8')) as GenderModel;
const coefficients = parseCoefficients(bytes('female_coefficients.bin'));
const values = meanCoefficients(base, statistics);
const rest = reconstructVertices(base, coefficients, values);
const indices = parseIndices(bytes('indices.bin'));
const skin = { indices: parseSkinIndices(bytes('skin_indices.bin')), weights: parseSkinWeights(bytes('skin_weights.bin')) };

function avatar() {
  return new SkinnedAvatar(base, indices, skin.indices, skin.weights, rest, new THREE.MeshBasicMaterial());
}

function armAngle(body: SkinnedAvatar, side: 'Left' | 'Right') {
  const shoulder = body.boneWorldPosition(`mixamorig${side}Arm`, new THREE.Vector3())!;
  const wrist = body.boneWorldPosition(`mixamorig${side}Hand`, new THREE.Vector3())!;
  return Math.atan2(shoulder.y - wrist.y, Math.abs(shoulder.x - wrist.x)) * 180 / Math.PI;
}

describe('SkinnedAvatar optional A pose', () => {
  it('offers a symmetric source-compatible A pose without changing the initial rest pose', () => {
    const body = avatar();
    const initial = body.positions.slice();
    expect(armAngle(body, 'Left')).toBeGreaterThan(55);
    expect(body.poseNames()).toContain('A');
    body.setPose('A');
    for (const side of ['Left', 'Right'] as const) {
      expect(armAngle(body, side)).toBeGreaterThan(43);
      expect(armAngle(body, side)).toBeLessThan(48);
    }
    expect(Math.abs(armAngle(body, 'Left') - armAngle(body, 'Right'))).toBeLessThan(0.1);
    expect([...body.positions].every(Number.isFinite)).toBe(true);
    body.setPose(null);
    expect(body.positions).toEqual(initial);
    body.dispose();
    (body.mesh.material as THREE.Material).dispose();
  });

  it('preserves the existing named poses exactly and does not mutate shared model data', () => {
    const original = JSON.stringify(base.poses);
    const body = avatar();
    for (const name of ['T', 'BentArm', 'Sitting']) {
      body.setPose(name);
      const expected = new Float32Array(rest.length);
      poseVertices(createSkeleton(base, rest), rest, skin, base.poses[name], expected);
      expect(body.positions).toEqual(expected);
    }
    body.setPose('A');
    expect(JSON.stringify(base.poses)).toBe(original);
    body.dispose();
    (body.mesh.material as THREE.Material).dispose();
  });

  it('retains the opt-in A pose when body measurements rebuild the rest shape', () => {
    const body = avatar();
    body.setPose('A');
    const changed = values.slice();
    changed[base.coefficientNames.indexOf('height')] += 10;
    body.setRestVertices(reconstructVertices(base, coefficients, changed));
    for (const side of ['Left', 'Right'] as const) {
      expect(armAngle(body, side)).toBeGreaterThan(40);
      expect(armAngle(body, side)).toBeLessThan(50);
    }
    body.dispose();
    (body.mesh.material as THREE.Material).dispose();
  });
});
