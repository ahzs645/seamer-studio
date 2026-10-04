import { expect, test } from 'vitest';
import { buildBodySurfaceBVH, type SurfaceBVH, type SurfaceMesh } from './bodySurfaceBroadphase';
import { buildSurfaceRefitPlan } from './surfaceRefitPlan';

const words = (values: Float32Array) => new Uint32Array(values.buffer, values.byteOffset, values.length);
function meshOf(count: number): SurfaceMesh {
  const positions = new Float32Array(count * 12), triangles = new Uint32Array(count * 4);
  let state = 1234567;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  for (let face = 0; face < count; face++) {
    for (let vertex = 0; vertex < 3; vertex++) {
      const offset = (face * 3 + vertex) * 4;
      positions.set([random() * 4 - 2, random() * 3 - 1.5, random() * 8 - 4, 1], offset);
      triangles[face * 4 + vertex] = face * 3 + vertex;
    }
  }
  return { positions, triangles, numTriangles: count };
}

test.each([0, 1, 8, 9, 19, 54, 257, 4097])('bit-identical finite bounds for odd/balanced topology with%d triangles', count => {
  const initial = meshOf(count), tree = buildBodySurfaceBVH(initial), original = words(tree.nodes).slice();
  const plan = buildSurfaceRefitPlan(tree), previous = initial.positions.slice(), current = initial.positions.slice();
  for (let index = 0; index < current.length; index += 4) {
    current[index] += Math.sin(index) * 1.5;
    current[index + 1] -= .8;
    previous[index + 2] += Math.cos(index) * 2;
  }
  const mesh = { ...initial, positions: current };
  expect(words(refitBottomUpReference(tree, plan, mesh, previous))).toEqual(words(refitAllSubtreeReference(tree, mesh, previous)));
  expect(words(tree.nodes)).toEqual(original);
  expect(plan.maxLeafTriangles).toBeLessThanOrEqual(8);
  const metadata = words(tree.nodes), completed = new Set<number>();
  for (let node = 0; node < tree.nodeCount; node++) if (metadata[node * 8 + 7] !== 0xffffffff) completed.add(node);
  for (const level of plan.levels) {
    expect(level.uniformOffset % 256).toBe(0);
    expect(plan.uniforms[level.uniformOffset / 4]).toBe(level.first);
    expect(plan.uniforms[level.uniformOffset / 4 + 1]).toBe(level.count);
    const parents: number[] = [];
    for (let offset = 0; offset < level.count; offset++) {
      const parent = plan.parentNodeIds[level.first + offset], left = parent + 1, right = metadata[left * 8 + 3];
      expect(completed.has(left)).toBe(true); expect(completed.has(right)).toBe(true); parents.push(parent);
    }
    parents.forEach(parent => completed.add(parent));
  }
  expect(completed.size).toBe(tree.nodeCount);
});

test('preserves signed zero and coarse swept face bounds in CPU Float32 reference', () => {
  const initial = meshOf(19);
  for (let index = 0; index < initial.positions.length; index += 4) {
    initial.positions[index] = index % 8 ? -0 : 0;
    initial.positions[index + 1] = index % 8 ? 0 : -0;
  }
  const tree = buildBodySurfaceBVH(initial), plan = buildSurfaceRefitPlan(tree), previous = initial.positions.slice();
  previous[2] = -1000; previous[6] = 1000;
  const expected = refitAllSubtreeReference(tree, initial, previous);
  expect(words(refitBottomUpReference(tree, plan, initial, previous))).toEqual(words(expected));
  expect(words(expected)[0]).toBe(0x80000000); // low X contains -0.
  expect(words(expected)[4]).toBe(0); // high X contains +0.
  expect(expected[2]).toBe(-1000); expect(expected[6]).toBe(1000);
});

test('rejects corrupted topology and honors nonzero node buffer offsets and512-byte alignment', () => {
  const tree = buildBodySurfaceBVH(meshOf(54));
  const storage = new Uint32Array(tree.nodes.length + 8); storage.set(words(tree.nodes), 8);
  const offsetTree = { ...tree, nodes: new Float32Array(storage.buffer, 32, tree.nodes.length) };
  const plan = buildSurfaceRefitPlan(offsetTree, 512);
  expect(plan.levels.every(level => level.uniformOffset % 512 === 0)).toBe(true);
  words(offsetTree.nodes)[(1 * 8) + 3] = 1;
  expect(() => buildSurfaceRefitPlan(offsetTree)).toThrow('child escape');
});

test('generic native shared-vertex panel retains exact swept bounds without source metadata', () => {
  const size = 33, positions = new Float32Array(size * size * 4), indices: number[] = [];
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
    positions.set([column * .015, row * .015, 0, 1], (row * size + column) * 4);
    if (row + 1 < size && column + 1 < size) {
      const at = row * size + column;
      indices.push(at, at + 1, at + size, 0, at + 1, at + size + 1, at + size, 0);
    }
  }
  const mesh = { positions, triangles: Uint32Array.from(indices), numTriangles: indices.length / 4 };
  const tree = buildBodySurfaceBVH(mesh), plan = buildSurfaceRefitPlan(tree), previous = positions.slice();
  for (let index = 0; index < positions.length; index += 4) {
    positions[index + 2] = Math.sin(positions[index] * 5) * .02;
    previous[index] -= .01; previous[index + 2] = Math.cos(previous[index + 1] * 5) * .02;
  }
  expect(words(refitBottomUpReference(tree, plan, mesh, previous))).toEqual(words(refitAllSubtreeReference(tree, mesh, previous)));
});


const INTERNAL = 0xffffffff;
function reduceRange(output: Float32Array, node: number, bvh: SurfaceBVH, mesh: SurfaceMesh, previous: Float32Array): void {
  const low = [1e30, 1e30, 1e30], high = [-1e30, -1e30, -1e30];
  const first = bvh.ranges[node * 4], count = bvh.ranges[node * 4 + 1];
  for (let item = 0; item < count; item++) {
    const triangle = bvh.triangleIds[first + item];
    for (let axis = 0; axis < 3; axis++) {
      const a = mesh.triangles[triangle * 4] * 4 + axis;
      const b = mesh.triangles[triangle * 4 + 1] * 4 + axis;
      const c = mesh.triangles[triangle * 4 + 2] * 4 + axis;
      // Match the original WGSL reduction grouping; all inputs already have Float32 precision.
      low[axis] = Math.min(low[axis], Math.min(Math.min(mesh.positions[a], Math.min(mesh.positions[b], mesh.positions[c])),
        Math.min(previous[a], Math.min(previous[b], previous[c]))));
      high[axis] = Math.max(high[axis], Math.max(Math.max(mesh.positions[a], Math.max(mesh.positions[b], mesh.positions[c])),
        Math.max(previous[a], Math.max(previous[b], previous[c]))));
    }
  }
  output.set(low, node * 8); output.set(high, node * 8 + 4);
}

function refitAllSubtreeReference(bvh: SurfaceBVH, mesh: SurfaceMesh, previous: Float32Array): Float32Array {
  const output = bvh.nodes.slice();
  for (let node = 0; node < bvh.nodeCount; node++) reduceRange(output, node, bvh, mesh, previous);
  return output;
}

function refitBottomUpReference(bvh: SurfaceBVH, plan: ReturnType<typeof buildSurfaceRefitPlan>, mesh: SurfaceMesh, previous: Float32Array): Float32Array {
  const output = bvh.nodes.slice();
  const words = new Uint32Array(output.buffer);
  for (let node = 0; node < bvh.nodeCount; node++) if (words[node * 8 + 7] !== INTERNAL) reduceRange(output, node, bvh, mesh, previous);
  for (const level of plan.levels) for (let item = 0; item < level.count; item++) {
    const node = plan.parentNodeIds[level.first + item], left = node + 1, right = words[left * 8 + 3];
    for (let axis = 0; axis < 3; axis++) {
      output[node * 8 + axis] = Math.min(output[left * 8 + axis], output[right * 8 + axis]);
      output[node * 8 + axis + 4] = Math.max(output[left * 8 + axis + 4], output[right * 8 + axis + 4]);
    }
  }
  return output;
}
