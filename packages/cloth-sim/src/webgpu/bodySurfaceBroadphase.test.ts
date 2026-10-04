import { describe, expect, it } from 'vitest';
import { buildBodySurfaceBVH, queryBodySurfaceBVH, type SurfaceMesh } from './bodySurfaceBroadphase';

function mesh(triangles: number[][][]): SurfaceMesh {
  return { positions: new Float32Array(triangles.flatMap(triangle => triangle.flatMap(point => [...point, 0]))),
    triangles: new Uint32Array(triangles.flatMap((_, i) => [i * 3, i * 3 + 1, i * 3 + 2, 0])), numTriangles: triangles.length };
}
function overlaps(source: SurfaceMesh, id: number, low: readonly number[], high: readonly number[]): boolean {
  return [0, 1, 2].every(axis => {
    const vertices = [0, 1, 2].map(corner => source.positions[source.triangles[id * 4 + corner] * 4 + axis]);
    return Math.min(...vertices) <= high[axis] && Math.max(...vertices) >= low[axis];
  });
}

describe('finite surface BVH broad phase', () => {
  it('finds a coarse triangle interior far from its centroid', () => {
    const source = mesh([[[-20, 0, -10], [20, 0, -10], [0, 0, 30]]]);
    const bvh = buildBodySurfaceBVH(source);
    expect(queryBodySurfaceBVH(bvh, [-10.1, -.01, -5.1], [-9.9, .01, -4.9])).toEqual([0]);
    expect(queryBodySurfaceBVH(bvh, [-.1, 1, -.1], [.1, 2, .1])).toEqual([]);
  });
  it('conservatively includes every overlapping finite AABB without duplicates across balanced leaves', () => {
    const source = mesh(Array.from({ length: 511 }, (_, i) => {
      const x = (i * 17 % 73) / 10, y = (i * 23 % 67) / 10, z = (i * 31 % 61) / 10;
      return [[x, y, z], [x + .31, y + .2, z - .12], [x - .14, y + .39, z + .41]];
    }));
    const bvh = buildBodySurfaceBVH(source);
    for (let i = 0; i < 100; i++) {
      const low = [i * 13 % 79 / 10, i * 19 % 71 / 10, i * 29 % 67 / 10];
      const high = low.map(value => value + .7);
      const actual = queryBodySurfaceBVH(bvh, low, high);
      expect(new Set(actual).size).toBe(actual.length);
      for (let triangle = 0; triangle < source.numTriangles; triangle++) if (overlaps(source, triangle, low, high)) expect(actual).toContain(triangle);
    }
    const all = queryBodySurfaceBVH(bvh, [-100, -100, -100], [100, 100, 100]);
    expect(all.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: source.numTriangles }, (_, i) => i));
    expect(bvh.maxDepth).toBeLessThanOrEqual(Math.ceil(Math.log2(source.numTriangles / 8)) + 1);
  });
  it('provides exact immutable subtree ranges for parallel dynamic cloth refitting', () => {
    const source = mesh(Array.from({ length: 103 }, (_, i) => [[i, i % 5, 0], [i + 1, i % 5, .1], [i, i % 5 + 1, 0]]));
    const bvh = buildBodySurfaceBVH(source);
    const integers = new Uint32Array(bvh.nodes.buffer);
    for (let node = 0; node < bvh.nodeCount; node++) {
      const escape = integers[node * 8 + 3];
      expect(escape).toBeGreaterThan(node); expect(escape).toBeLessThanOrEqual(bvh.nodeCount);
      const ids = bvh.triangleIds.subarray(bvh.ranges[node * 4], bvh.ranges[node * 4] + bvh.ranges[node * 4 + 1]);
      const contained = new Set<number>();
      for (let child = node; child < escape; child++) {
        const leaf = integers[child * 8 + 7];
        if (leaf === 0xffffffff) continue;
        const first = leaf & 0x0fffffff, count = leaf >>> 28;
        for (const id of bvh.triangleIds.subarray(first, first + count)) contained.add(id);
      }
      expect([...contained].sort((a, b) => a - b)).toEqual(Array.from(ids).sort((a, b) => a - b));
      for (const id of ids) expect(overlaps(source, id,
        Array.from(bvh.nodes.subarray(node * 8, node * 8 + 3)), Array.from(bvh.nodes.subarray(node * 8 + 4, node * 8 + 7)))).toBe(true);
    }
  });
  it('handles empty meshes and rejects invalid indices, nonfinite positions and unsupported packing', () => {
    expect(queryBodySurfaceBVH(buildBodySurfaceBVH(mesh([])), [0, 0, 0], [1, 1, 1])).toEqual([]);
    const source = mesh([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]]);
    source.triangles[0] = 100;
    expect(() => buildBodySurfaceBVH(source)).toThrow(/invalid vertex/);
    source.triangles[0] = 0; source.positions[0] = NaN;
    expect(() => buildBodySurfaceBVH(source)).toThrow(/Invalid/);
    expect(() => buildBodySurfaceBVH(mesh([]), 16)).toThrow(/leaf size/);
  });
});
