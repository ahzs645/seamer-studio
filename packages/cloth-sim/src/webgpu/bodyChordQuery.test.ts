import { describe, expect, it } from 'vitest';
import { Triangle, Vector3 } from 'three';
import { buildBodySurfaceBVH, type SurfaceMesh } from './bodySurfaceBroadphase';
import { packBodyChordBVH } from './bodyChordQuery';

function boxes(count = 1): SurfaceMesh {
  const xyz = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: Float32Array.from(Array.from({ length: count }, (_, box) =>
    xyz.flatMap((value, i) => i % 3 === 2 ? [value * .005, 0] : [value * .005 + (i % 3 === 0 ? box * .04 : 0)])).flat()),
    triangles: Uint32Array.from(Array.from({ length: count }, (_, box) =>
      indices.flatMap((id, i) => i % 3 === 2 ? [id + box * 8, 0] : [id + box * 8])).flat()), numTriangles: indices.length / 3 * count };
}

/** Independently decode the actual packed GPU bytes and traverse every admissible finite leaf.
 * The reference result below separately searches ALL actual finite body triangles. */
function closestPacked(source: SurfaceMesh, packed: Uint32Array, point: Vector3, seed = -1) {
  const floats = new Float32Array(packed.buffer, packed.byteOffset, packed.length);
  let best = Infinity, result = new Vector3(), face = -1, visited = 0;
  const consider = (id: number) => {
    const vertices = Array.from(source.triangles.subarray(id * 4, id * 4 + 3)).map(index => new Vector3().fromArray(source.positions, index * 4));
    const nearest = new Triangle(vertices[0], vertices[1], vertices[2]).closestPointToPoint(point, new Vector3());
    const distance = nearest.distanceToSquared(point);
    if (distance < best) { best = distance; result = nearest; face = id; }
  };
  if (seed >= 0) consider(seed);
  let node = 0;
  while (node < packed[0]) {
    if (++visited > packed[0]) throw new Error('Packed traversal cycle');
    const at = packed[1] + node * 8, escape = packed[at + 3], leaf = packed[at + 7];
    const bound = [0, 1, 2].reduce((sum, axis) => {
      const delta = Math.max(floats[at + axis] - point.getComponent(axis), point.getComponent(axis) - floats[at + axis + 4], 0);
      return sum + delta * delta;
    }, 0);
    if (bound > best + Math.max(1e-12, 2 * Math.sqrt(best) * 1e-6)) { node = escape; continue; }
    if (leaf === 0xffffffff) { node++; continue; }
    for (let offset = 0; offset < leaf >>> 28; offset++) consider(packed[packed[2] + (leaf & 0x0fffffff) + offset]);
    node = escape;
  }
  return { distance: Math.sqrt(best), point: result, face, visited };
}

function brute(source: SurfaceMesh, point: Vector3) {
  let best = Infinity;
  for (let id = 0; id < source.numTriangles; id++) {
    const ids = Array.from(source.triangles.subarray(id * 4, id * 4 + 3));
    const triangle = new Triangle(...ids.map(index => new Vector3().fromArray(source.positions, index * 4)) as [Vector3, Vector3, Vector3]);
    best = Math.min(best, triangle.closestPointToPoint(point, new Vector3()).distanceTo(point));
  }
  return best;
}

describe('complete finite body nearest query packing', () => {
  it('preserves finite node bounds and escape/leaf integer words, including typed-array subviews', () => {
    const source = boxes(17), bvh = buildBodySurfaceBVH(source), padded = new Float32Array(bvh.nodes.length + 16);
    const nodes = padded.subarray(8, 8 + bvh.nodes.length); nodes.set(bvh.nodes);
    const packed = packBodyChordBVH({ ...bvh, nodes }, source.numTriangles);
    expect(packed.subarray(packed[1], packed[2])).toEqual(new Uint32Array(nodes.buffer, nodes.byteOffset, nodes.length));
    expect(packed.subarray(packed[2])).toEqual(bvh.triangleIds);
    const preserved = packed.slice(); nodes.fill(0); bvh.triangleIds.fill(0);
    expect(packed).toEqual(preserved);
  });

  it('finds the third skin face rather than the chord entry/exit faces', () => {
    const source = boxes(), packed = packBodyChordBVH(buildBodySurfaceBVH(source), source.numTriangles);
    const point = new Vector3(0, .0045, 0), result = closestPacked(source, packed, point, 11);
    expect(result.distance).toBeCloseTo(.0005, 8);
    expect([8, 9]).toContain(result.face); // upper face; finite chord enters/exits left/right faces
    expect(result.distance).toBeCloseTo(brute(source, point), 12);
    const escape = result.point.clone().sub(point).normalize();
    expect(new Vector3(0, .006, 0).sub(result.point).dot(escape)).toBeGreaterThan(0);
    expect(new Vector3(0, .003, 0).sub(result.point).dot(escape)).toBeLessThan(0);
  });

  it('matches all-face brute queries across many leaves with an initially distant feasible seed', () => {
    const source = boxes(41), packed = packBodyChordBVH(buildBodySurfaceBVH(source), source.numTriangles);
    for (let i = 0; i < 64; i++) {
      const point = new Vector3((i * 17 % 41) * .04 + (i % 3 - 1) * .0048, (i % 7 - 3) * .002, (i % 5 - 2) * .003);
      const result = closestPacked(source, packed, point, source.numTriangles - 1);
      expect(result.distance).toBeCloseTo(brute(source, point), 12);
      expect(result.visited).toBeLessThanOrEqual(packed[0]);
    }
  });

  it('represents an empty body as a header and rejects a missing body tree', () => {
    const empty = { positions: new Float32Array(), triangles: new Uint32Array(), numTriangles: 0 };
    expect(packBodyChordBVH(buildBodySurfaceBVH(empty), 0)).toEqual(Uint32Array.of(0, 4, 4, 0));
    expect(() => packBodyChordBVH({ nodes: new Float32Array(), nodeCount: 0, triangleIds: Uint32Array.of(0) }, 1)).toThrow(/dimensions/);
  });

  it('rejects cyclic escape links, invalid finite bounds and truncated leaves', () => {
    const source = boxes(3), bvh = buildBodySurfaceBVH(source);
    const cycle = bvh.nodes.slice(); new Uint32Array(cycle.buffer)[3] = 0;
    expect(() => packBodyChordBVH({ ...bvh, nodes: cycle }, source.numTriangles)).toThrow(/escape/);
    const invalid = bvh.nodes.slice(); invalid[0] = NaN;
    expect(() => packBodyChordBVH({ ...bvh, nodes: invalid }, source.numTriangles)).toThrow(/bounds/);
    const truncated = bvh.nodes.slice(), words = new Uint32Array(truncated.buffer);
    const leaf = Array.from({ length: bvh.nodeCount }, (_, i) => i).find(i => words[i * 8 + 7] !== 0xffffffff)!;
    words[leaf * 8 + 7] = (8 << 28) | (bvh.triangleIds.length - 1);
    expect(() => packBodyChordBVH({ ...bvh, nodes: truncated }, source.numTriangles)).toThrow(/leaf/);
  });

  it('rejects duplicated/missing leaf coverage and invalid ordered triangle IDs', () => {
    const source = boxes(3), bvh = buildBodySurfaceBVH(source);
    const ids = bvh.triangleIds.slice(); ids[1] = ids[0];
    expect(() => packBodyChordBVH({ ...bvh, triangleIds: ids }, source.numTriangles)).toThrow(/ordered/);
    const duplicated = bvh.nodes.slice(), words = new Uint32Array(duplicated.buffer);
    const leaves = Array.from({ length: bvh.nodeCount }, (_, i) => i).filter(i => words[i * 8 + 7] !== 0xffffffff);
    words[leaves[1] * 8 + 7] = words[leaves[0] * 8 + 7];
    expect(() => packBodyChordBVH({ ...bvh, nodes: duplicated }, source.numTriangles)).toThrow(/Overlapping/);
  });
});
