/** Feature order consumed by the finite nearest-body-point GPU query. */
export const BODY_CONTACT_FEATURE_ORDER = ['edge01', 'edge12', 'edge20', 'vertex0', 'vertex1', 'vertex2'] as const;
const WELD_METERS = 1e-7;
type Vec3 = [number, number, number];
interface Vertex { faces: Set<number>; edges: Set<string>; sum: Vec3; invalid: boolean }
interface Edge { ends: [number, number]; faces: { index: number; direction: number }[]; normal?: Vec3 }
interface Face { vertices: [number, number, number]; normal: Vec3 | null; edges: string[] }

function unit(vector: Vec3): Vec3 | undefined {
  const length = Math.hypot(...vector);
  return length > 1e-12 ? vector.map(component => component / length) as Vec3 : undefined;
}

/**
 * Six vec4 normals per triangle: edge01, edge12, edge20, vertex0, vertex1, vertex2.
 * The w lanes are zero. Input positions/triangles use the engine's vec4 layout.
 *
 * Requires outward, consistently wound body faces. Edges sum their two adjacent unit
 * face normals; vertices sum unit face normals weighted by the incident corner angle.
 * Coincident UV-seam vertices weld by the SAME round(x / 1e-7) geometric key as the
 * collision guard's default closed-body check. Input coordinates/topology are unchanged.
 * Open, nonmanifold, inconsistent, disconnected vertex fans and numerically degenerate
 * or cancelling features produce zero normals; zero is uncertainty, never interior proof.
 */
export function buildBodyContactFeatureNormals(mesh: {
  positions: Float32Array; triangles: Uint32Array; numTriangles: number;
}): Float32Array {
  const { positions, triangles, numTriangles } = mesh;
  if (positions.length % 4 || triangles.length % 4 || !Number.isInteger(numTriangles)
    || numTriangles < 0 || numTriangles > triangles.length / 4) throw new Error('Invalid body feature mesh layout');
  const vertices: Vertex[] = [], welded = new Uint32Array(positions.length / 4), keys = new Map<string, number>();
  for (let index = 0; index < welded.length; index++) {
    const point = [positions[index * 4], positions[index * 4 + 1], positions[index * 4 + 2]];
    if (!point.every(Number.isFinite)) throw new Error('Nonfinite body feature position');
    const key = point.map(component => Math.round(component / WELD_METERS)).join(',');
    let id = keys.get(key);
    if (id === undefined) {
      id = vertices.length; keys.set(key, id);
      vertices.push({ faces: new Set(), edges: new Set(), sum: [0, 0, 0], invalid: false });
    }
    welded[index] = id;
  }
  const edges = new Map<string, Edge>(), faces: Face[] = [];
  for (let index = 0; index < numTriangles; index++) {
    const source = [triangles[index * 4], triangles[index * 4 + 1], triangles[index * 4 + 2]];
    if (source.some(id => id >= welded.length)) throw new Error('Invalid body feature triangle index');
    const ids = source.map(id => welded[id]) as [number, number, number];
    const points = source.map(id => [positions[id * 4], positions[id * 4 + 1], positions[id * 4 + 2]] as Vec3);
    const ab = points[1].map((value, axis) => value - points[0][axis]) as Vec3;
    const ac = points[2].map((value, axis) => value - points[0][axis]) as Vec3;
    const cross: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const area = Math.hypot(...cross);
    const normal = new Set(ids).size === 3 && area > 1e-20 ? cross.map(value => value / area) as Vec3 : null;
    const face: Face = { vertices: ids, normal, edges: [] }; faces.push(face);
    for (let corner = 0; corner < 3; corner++) {
      const first = ids[corner], second = ids[(corner + 1) % 3], low = Math.min(first, second), high = Math.max(first, second);
      const key = `${low},${high}`;
      let edge = edges.get(key);
      if (!edge) { edge = { ends: [low, high], faces: [] }; edges.set(key, edge); }
      edge.faces.push({ index, direction: first === second ? 0 : first === low ? 1 : -1 });
      face.edges.push(key);
      vertices[first].faces.add(index); vertices[first].edges.add(key); vertices[second].edges.add(key);
      if (!normal) { vertices[first].invalid = true; continue; }
      const left = points[(corner + 1) % 3].map((value, axis) => value - points[corner][axis]);
      const right = points[(corner + 2) % 3].map((value, axis) => value - points[corner][axis]);
      const angle = Math.atan2(area, left.reduce((sum, value, axis) => sum + value * right[axis], 0));
      for (let axis = 0; axis < 3; axis++) vertices[first].sum[axis] += angle * normal[axis];
    }
  }
  for (const edge of edges.values()) {
    if (edge.faces.length !== 2 || edge.faces[0].direction + edge.faces[1].direction !== 0
      || !edge.faces[0].direction) continue;
    const left = faces[edge.faces[0].index].normal, right = faces[edge.faces[1].index].normal;
    if (left && right) edge.normal = unit(left.map((component, axis) => component + right[axis]) as Vec3);
  }
  const vertexNormals = vertices.map(vertex => {
    if (vertex.invalid || vertex.faces.size < 3 || [...vertex.edges].some(key => !edges.get(key)!.normal)) return undefined;
    // A coordinate weld can join disjoint closed surfaces at one point. Such separate
    // fans do not define one vertex pseudonormal even when every edge is manifold.
    const visited = new Set<number>(), pending = [vertex.faces.values().next().value!];
    while (pending.length) {
      const face = pending.pop()!;
      if (visited.has(face)) continue;
      visited.add(face);
      for (const key of faces[face].edges) {
        if (!vertex.edges.has(key)) continue;
        for (const adjacent of edges.get(key)!.faces) if (!visited.has(adjacent.index)) pending.push(adjacent.index);
      }
    }
    return visited.size === vertex.faces.size ? unit(vertex.sum) : undefined;
  });
  const result = new Float32Array(numTriangles * 6 * 4);
  faces.forEach((face, triangle) => {
    if (!face.normal) return;
    const normals = [...face.edges.map(key => edges.get(key)!.normal), ...face.vertices.map(id => vertexNormals[id])];
    normals.forEach((normal, slot) => { if (normal) result.set(normal, (triangle * 6 + slot) * 4); });
  });
  return result;
}
