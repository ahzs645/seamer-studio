import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Cylinder } from '@seamer/avatar';
import type { Pattern, PieceArrangement } from '@seamer/pattern-model';
import { arrangeParticles, garmentCodeWorldMatrix } from './arrangement';
import { CylinderFrame } from './cylinders';
import { buildPieceCloth } from './boundary';
import { fromArrangement, prepareCloth } from '../simulator';
import pencilSkirt from '../../../../static/templates/pencil-skirt.json';

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

describe('GarmentCode source panel placement', () => {
  const offset = { x: 1600, y: -900 };
  const local = [{ x: 0, y: 0 }, { x: 120, y: 230 }, { x: -45, y: 150 }];
  const packed = local.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y }));

  function source(rotation = [0, 0, 0]): PieceArrangement {
    return {
      ...arrangement('curved'),
      sourcePlacement: {
        worldMatrix: garmentCodeWorldMatrix(rotation, [0.5, 1.3, -0.2]),
        layoutOffsetMm: offset
      }
    };
  }

  it('undoes only drafting layout packing and places panels exactly in metres', () => {
    const placed = arrangeParticles(packed, source(), cylinder());
    expect(point(placed, 0).toArray()).toEqual([Math.fround(0.5), Math.fround(1.3), Math.fround(-0.2)]);
    expect(point(placed, 1).x).toBeCloseTo(0.62, 6);
    expect(point(placed, 1).y).toBeCloseTo(1.53, 6);
    expect(point(placed, 1).z).toBe(Math.fround(-0.2));
    // No implicit 1e-5 coincident-plane perturbation is added to a source placement.
    expect(point(placed, 2).z).toBe(point(placed, 0).z);
  });

  it('matches actual upstream rotation.py and BoxMesh results for compound Maya XYZ angles', () => {
    const m = garmentCodeWorldMatrix([30, 45, 60], [0.5, 1.3, -0.2]);
    // Independent reference obtained by executing upstream euler_xyz_to_R([30,45,60]).
    const referenceColumns = [
      0.353553390593274, 0.612372435695795, -0.707106781186547,
      -0.573223304703363, 0.739198919740117, 0.353553390593274,
      0.739198919740117, 0.280330085889911, 0.612372435695795
    ];
    [0, 1, 2, 4, 5, 6, 8, 9, 10].forEach((index, reference) =>
      expect(m[index]).toBeCloseTo(referenceColumns[reference], 12)
    );
    const result = point(arrangeParticles(packed, source([30, 45, 60]), null), 1);
    expect(result.x).toBeCloseTo(0.410585046789419, 6);
    expect(result.y).toBeCloseTo(1.54350044382369, 6);
    expect(result.z).toBeCloseTo(-0.203535533905933, 6);
  });

  it.each([
    { rotation: [90, 0, 0], expected: [0.62, 1.3, 0.03] },
    { rotation: [0, 90, 0], expected: [0.5, 1.53, -0.32] },
    { rotation: [0, 0, 90], expected: [0.27, 1.42, -0.2] }
  ])('places a panel rotated around $rotation', ({ rotation, expected }) => {
    const result = point(arrangeParticles(packed, source(rotation), null), 1);
    result.toArray().forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 6));
  });

  it('prioritizes authored source placement over a cylinder or use2DPosition without flipping it', () => {
    const arr = source([12, -35, 75]);
    const placed = arrangeParticles(packed, arr, cylinder());
    arr.use2DPosition = true;
    expect(arrangeParticles(packed, arr, null, { flipNormals: true })).toEqual(placed);
  });

  it('leaves existing flat/cylinder documents unchanged and ignores legacy group matrices', () => {
    const arr = arrangement('flat');
    arr.use2DPosition = true;
    arr.matrixWorld = garmentCodeWorldMatrix([30, 45, 60], [10, 20, 30]);
    const result = arrangeParticles(local, arr, cylinder());
    expect(point(result, 1).x).toBeCloseTo(0.12, 6);
    expect(point(result, 1).y).toBeCloseTo(0.23, 6);
    expect(point(result, 1).z).toBeCloseTo(0.29998, 6);
  });

  it.each(['short', 'nan', 'projective', 'scale', 'reflection', 'offset', 'sparse', 'overflow'])(
    'falls back safely for malformed saved source placement: %s', (kind) => {
      const arr = source();
      const s = arr.sourcePlacement!;
      if (kind === 'short') s.worldMatrix.pop();
      if (kind === 'nan') s.worldMatrix[12] = NaN;
      if (kind === 'projective') s.worldMatrix[3] = 0.2;
      if (kind === 'scale') s.worldMatrix[0] = 2;
      if (kind === 'reflection') s.worldMatrix[0] = -1;
      if (kind === 'offset') s.layoutOffsetMm.y = Infinity;
      if (kind === 'sparse') delete s.worldMatrix[12];
      if (kind === 'overflow') s.worldMatrix[12] = 1e300;
      const fallback = arrangeParticles(local, arrangement('curved'), cylinder());
      expect(arrangeParticles(local, arr, cylinder())).toEqual(fallback);
    }
  );

  it('rejects invalid source rotation and translation inputs', () => {
    expect(() => garmentCodeWorldMatrix([0, 0], [0, 0, 0])).toThrow(/three finite numbers/);
    expect(() => garmentCodeWorldMatrix([0, 0, 0], [0, NaN, 0])).toThrow(/three finite numbers/);
  });

  it('retains authored positions through preparation, cached display, and arrangement reset', () => {
    const pattern = structuredClone(pencilSkirt) as unknown as Pattern;
    pattern.pieces = [pattern.pieces[0]];
    pattern.seams = [];
    pattern.settings3d.drapeMirroredPieces = false;
    pattern.settings3d.fixTop = false;
    pattern.settings3d.globalParticleDistanceOverride = 40;
    const piece = pattern.pieces[0];
    piece.settings3d.arrangement = source([30, 45, 60]);
    piece.settings3d.savedPositions = [];
    delete piece.settings3d.savedMeshSnapshot;
    const cloth = buildPieceCloth(pattern, piece, 40)!;
    expect(cloth.mesh.points.length).toBeGreaterThan(3);
    const expected = arrangeParticles(cloth.mesh.points, piece.settings3d.arrangement, null);
    // A simulated cache remains the display seed; arrange/reset must return the source transform.
    piece.settings3d.savedPositions = cloth.mesh.points.flatMap((p) => [p.x, p.y, 4, 5, 6]);
    const init = {
      pattern,
      cylinders: new Map<string, CylinderFrame>(),
      avatarVertices: new Float32Array(),
      avatarIndices: new Uint32Array()
    };
    const prepared = prepareCloth(init)!;
    expect(prepared).not.toBeNull();
    expect(prepared.simData.positions[0]).toBe(4);
    for (let i = 0; i < expected.length / 3; i++) {
      for (let axis = 0; axis < 3; axis++) {
        expect(prepared.simData.arrangedPositions[i * 4 + axis]).toBe(expected[i * 3 + axis]);
      }
    }
    const reset = fromArrangement(prepared);
    expect(reset.simData.positions).toEqual(prepared.simData.arrangedPositions);
    const fresh = prepareCloth(init, { fromArrangement: true })!;
    expect(fresh.simData.positions).toEqual(reset.simData.positions);
    expect(fresh.simData.arrangedPositions).toEqual(reset.simData.positions);
  });
});
