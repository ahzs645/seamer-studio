import { describe, expect, it } from 'vitest';
import { Triangle, Vector3 } from 'three';
import { BODY_CONTACT_FEATURE_ORDER, buildBodyContactFeatureNormals } from './bodyContactFeatures';

const cubePositions = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
const cubeIndices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
function mesh(xyz = cubePositions, indices = cubeIndices) {
  return { positions: Float32Array.from(xyz.flatMap((value, index) => index % 3 === 2 ? [value, 0] : [value])),
    triangles: Uint32Array.from(indices.flatMap((value, index) => index % 3 === 2 ? [value, 0] : [value])), numTriangles: indices.length / 3 };
}
const normal = (output: Float32Array, triangle: number, feature: number) => new Vector3().fromArray(output, (triangle * 6 + feature) * 4);
function expectVector(actual: Vector3, expected: number[]) {
  expected.forEach((value, axis) => expect(actual.getComponent(axis)).toBeCloseTo(value, 6));
}
function prism(polygon: number[][], capTriangles: number[]) {
  const xyz = [-1, 1].flatMap(z => polygon.flatMap(([x, y]) => [x, y, z])), count = polygon.length;
  const indices: number[] = [];
  for (let at = 0; at < capTriangles.length; at += 3) {
    const [a, b, c] = capTriangles.slice(at, at + 3);
    indices.push(a, c, b, a + count, b + count, c + count);
  }
  for (let at = 0; at < count; at++) {
    const next = (at + 1) % count;
    indices.push(at, next, next + count, at, next + count, at + count);
  }
  return mesh(xyz, indices);
}
// Match the GPU's feature selector, but search every actual finite face as an independent
// CPU reference. The sign is meaningful only at this globally nearest feature.
function signedNearest(body: ReturnType<typeof mesh>, point: Vector3) {
  const features = buildBodyContactFeatureNormals(body);
  let best = Infinity, selected = { signed: 0, bary: new Vector3(), normal: new Vector3(), faceNormal: new Vector3() };
  for (let at = 0; at < body.numTriangles; at++) {
    const ids = Array.from(body.triangles.slice(at * 4, at * 4 + 3));
    const triangle = new Triangle(...ids.map(id => new Vector3().fromArray(body.positions, id * 4)) as [Vector3, Vector3, Vector3]);
    const nearest = triangle.closestPointToPoint(point, new Vector3()), distance = nearest.distanceToSquared(point);
    if (distance >= best) continue;
    best = distance;
    const bary = triangle.getBarycoord(nearest, new Vector3())!, eps = 1e-5, faceNormal = triangle.getNormal(new Vector3());
    const slot = bary.y <= eps && bary.z <= eps ? 3 : bary.x <= eps && bary.z <= eps ? 4
      : bary.x <= eps && bary.y <= eps ? 5 : bary.z <= eps ? 0 : bary.x <= eps ? 1 : bary.y <= eps ? 2 : 6;
    const selectedNormal = slot === 6 ? faceNormal : normal(features, at, slot);
    selected = { signed: point.clone().sub(nearest).dot(selectedNormal), bary, normal: selectedNormal, faceNormal };
  }
  return selected;
}

describe('finite body contact feature pseudonormals', () => {
  it('uses the documented six vec4 layout and outward convex edge/corner normals without mutating geometry', () => {
    const input = mesh(), before = { positions: input.positions.slice(), triangles: input.triangles.slice() };
    const output = buildBodyContactFeatureNormals(input);
    expect(BODY_CONTACT_FEATURE_ORDER).toEqual(['edge01', 'edge12', 'edge20', 'vertex0', 'vertex1', 'vertex2']);
    expect(output.length).toBe(input.numTriangles * 24);
    expectVector(normal(output, 0, 0), [0, 0, -1]); // coplanar diagonal
    expectVector(normal(output, 0, 1), [Math.SQRT1_2, 0, -Math.SQRT1_2]);
    expectVector(normal(output, 0, 2), [0, -Math.SQRT1_2, -Math.SQRT1_2]);
    expectVector(normal(output, 0, 3), [-1 / Math.sqrt(3), -1 / Math.sqrt(3), -1 / Math.sqrt(3)]);
    expect(output.every((value, index) => index % 4 !== 3 || value === 0)).toBe(true);
    expect(input.positions).toEqual(before.positions); expect(input.triangles).toEqual(before.triangles);
  });

  it('weights vertex angles rather than triangle counts when a planar face diagonal changes', () => {
    const original = buildBodyContactFeatureNormals(mesh());
    const alternate = buildBodyContactFeatureNormals(mesh(cubePositions, [0, 3, 1, 1, 3, 2, ...cubeIndices.slice(6)]));
    expectVector(normal(alternate, 0, 3), normal(original, 0, 3).toArray());
  });

  it('welds separately indexed coordinate-identical UV seams into the same finite features', () => {
    const xyz = cubeIndices.flatMap(id => cubePositions.slice(id * 3, id * 3 + 3));
    const duplicated = mesh(xyz, cubeIndices.map((_, index) => index));
    expect(buildBodyContactFeatureNormals(duplicated)).toEqual(buildBodyContactFeatureNormals(mesh()));
  });

  it('classifies a sharp convex edge exterior despite a negative incident face plane', () => {
    const body = prism([[0, 0], [1, -.1], [1, .1]], [0, 1, 2]);
    const outside = signedNearest(body, new Vector3(-.0001, .0005, 0));
    expect(outside.faceNormal.dot(new Vector3(-.0001, .0005, 0))).toBeLessThan(0);
    expectVector(outside.normal, [-1, 0, 0]);
    expect(outside.signed).toBeGreaterThan(0);
    const corner = signedNearest(body, new Vector3(-.0001, .0005, -1.0004));
    expect(corner.signed).toBeGreaterThan(0); expect(corner.normal.length()).toBeCloseTo(1, 6);
  });

  it('distinguishes a concave-edge interior from the exterior notch using actual nearest features', () => {
    const body = prism([[-1, -1], [1, -1], [1, 0], [0, 0], [0, 1], [-1, 1]], [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]);
    const inside = signedNearest(body, new Vector3(-.0004, -.0004, 0));
    expectVector(inside.normal, [Math.SQRT1_2, Math.SQRT1_2, 0]);
    expect(inside.signed).toBeLessThan(0);
    const outside = signedNearest(body, new Vector3(.0004, .0004, 0));
    expect(outside.signed).toBeGreaterThan(0);
  });

  it('returns zero for boundary, degenerate, inconsistently wound and nonmanifold features', () => {
    expect(buildBodyContactFeatureNormals(mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2])).every(value => value === 0)).toBe(true);
    const reversed = buildBodyContactFeatureNormals(mesh(cubePositions, [0, 1, 2, ...cubeIndices.slice(3)]));
    for (let slot = 0; slot < 6; slot++) expect(normal(reversed, 0, slot).length()).toBe(0);
    const duplicate = buildBodyContactFeatureNormals(mesh(cubePositions, [...cubeIndices, 0, 2, 1]));
    for (let slot = 0; slot < 6; slot++) expect(normal(duplicate, 0, slot).length()).toBe(0);
    const degenerate = buildBodyContactFeatureNormals(mesh(cubePositions, [...cubeIndices, 0, 0, 1]));
    for (let slot = 0; slot < 6; slot++) expect(normal(degenerate, 12, slot).length()).toBe(0);
  });

  it('does not infer one corner normal for disconnected closed fans touching at a welded point', () => {
    const other = cubePositions.map(value => value + 2), indices = [...cubeIndices, ...cubeIndices.map(id => id + 8)];
    const body = mesh([...cubePositions, ...other], indices), output = buildBodyContactFeatureNormals(body);
    for (let at = 0; at < body.numTriangles; at++) for (let corner = 0; corner < 3; corner++) {
      const id = body.triangles[at * 4 + corner];
      if (id === 6 || id === 8) expect(normal(output, at, corner + 3).length()).toBe(0);
    }
    expect(normal(output, 0, 3).length()).toBeCloseTo(1, 6);
  });

  it('rejects malformed buffers rather than manufacturing a containment normal', () => {
    expect(() => buildBodyContactFeatureNormals({ ...mesh(), numTriangles: -1 })).toThrow();
    const invalid = mesh(); invalid.triangles[0] = 999;
    expect(() => buildBodyContactFeatureNormals(invalid)).toThrow();
    const nonfinite = mesh(); nonfinite.positions[0] = NaN;
    expect(() => buildBodyContactFeatureNormals(nonfinite)).toThrow();
  });
});
