import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Cylinder } from '@seamer/avatar';
import { CylinderFrame } from './cylinders';

describe('source-compatible cylinder fitting', () => {
  it('clamps samples outside the finite bone segment before fitting its taper', () => {
    const definition: Cylinder = {
      id: 'leg',
      name: 'Leg',
      startBone: 'hip',
      endBone: 'knee',
      vertexIndices: [0, 1, 2],
      padding: 0,
      uOffsetDegrees: 0,
      tapered: true,
      elliptical: true,
      axisReversed: false,
      enabled: true
    };
    // Axial v values are -1, 0 and 1. SeamScape clamps the first sample to v=0, producing
    // the lifted enclosing line a(v) = 0.3 - 0.1v. An unbounded regression produces 0.2 - 0.1v.
    const samples = [
      new THREE.Vector3(0, -1, 0.3),
      new THREE.Vector3(0, 0, 0.1),
      new THREE.Vector3(0, 1, 0.1)
    ];
    const frame = new CylinderFrame(
      definition,
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 1, 0),
      (index) => samples[index]
    );

    expect(frame.a0).toBeCloseTo(0.3, 6);
    expect(frame.a1).toBeCloseTo(0.2, 6);
  });
});
