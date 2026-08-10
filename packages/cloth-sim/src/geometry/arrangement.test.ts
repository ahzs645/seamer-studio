import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Cylinder } from '@seamer/avatar';
import type { PieceArrangement } from '@seamer/pattern-model';
import { arrangeParticles } from './arrangement';
import { CylinderFrame } from './cylinders';

const cylinderDefinition: Cylinder = {
  id: 'test-cylinder',
  name: 'Torso',
  startBone: 'top',
  endBone: 'bottom',
  vertexIndices: [0, 1, 2, 3],
  padding: 0,
  uOffsetDegrees: 0,
  tapered: false,
  elliptical: false,
  axisReversed: false,
  enabled: true
};

function cylinder(): CylinderFrame {
  const samples = [
    new THREE.Vector3(-0.1, 0.5, 0),
    new THREE.Vector3(0.1, 0.5, 0),
    new THREE.Vector3(0, 0.5, -0.1),
    new THREE.Vector3(0, 0.5, 0.1)
  ];
  return new CylinderFrame(
    cylinderDefinition,
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 0),
    (index) => samples[index]
  );
}

function arrangement(mode: 'flat' | 'curved'): PieceArrangement {
  return {
    matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    position: [0, 0, 0],
    mode,
    cylinderName: 'Torso',
    uDegrees: 0,
    v: 0.5,
    uOffsetMm: 0,
    vOffsetMm: 0,
    radialOffsetMm: 0,
    use2DPosition: false,
    positionChanged: false
  };
}

function point(values: Float32Array, index: number): THREE.Vector3 {
  return new THREE.Vector3(values[index * 3], values[index * 3 + 1], values[index * 3 + 2]);
}

describe('source-compatible cylinder arrangement winding', () => {
  it('wraps ordinary and flip-normal curved pieces in opposite source directions', () => {
    const frame = cylinder();
    const points = [{ x: -50, y: 0 }, { x: 50, y: 0 }];
    const ordinary = arrangeParticles(points, arrangement('curved'), frame, { flipNormals: false });
    const flipped = arrangeParticles(points, arrangement('curved'), frame, { flipNormals: true });

    // SeamScape: u = base + (flipNormals ? +1 : -1) * uSign * arc/radius.
    expect(frame.worldToUv(point(ordinary, 0)).uDeg).toBeGreaterThan(0);
    expect(frame.worldToUv(point(ordinary, 1)).uDeg).toBeLessThan(0);
    expect(frame.worldToUv(point(flipped, 0)).uDeg).toBeLessThan(0);
    expect(frame.worldToUv(point(flipped, 1)).uDeg).toBeGreaterThan(0);
  });

  it('uses the source outside offset for flat pieces', () => {
    const frame = cylinder();
    const origin = frame.uvToWorld(0, 0.5);
    const uMinus = frame.uvToWorld(-0.35, 0.5);
    const uPlus = frame.uvToWorld(0.35, 0.5);
    const tangent = uPlus.clone().sub(uMinus).normalize().multiplyScalar(frame.uSign);
    const axis = frame.axis.clone().multiplyScalar(-1);
    const sourceNormal = new THREE.Vector3().crossVectors(tangent, axis).normalize().multiplyScalar(-1);
    const ordinary = point(arrangeParticles([{ x: 0, y: 0 }], arrangement('flat'), frame, { flipNormals: false }), 0);
    const flipped = point(arrangeParticles([{ x: 0, y: 0 }], arrangement('flat'), frame, { flipNormals: true }), 0);

    expect(ordinary.clone().sub(origin).dot(sourceNormal)).toBeCloseTo(0.003, 6);
    expect(flipped.clone().sub(origin).dot(sourceNormal)).toBeCloseTo(-0.003, 6);
  });
});
