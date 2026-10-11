export interface ProductionSurfaceMesh { pieceId: string; positions: number[]; uv: number[]; indices: number[]; }
type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Current-mesh UV interpolation; rejects endpoints outside the rendered cloth. */
export function measureProductionSurface(mesh: ProductionSurfaceMesh, from: Vec2, to: Vec2, method: 'chord' | 'surface-path'): number {
  const count = mesh.positions.length / 3;
  if (!Number.isInteger(count) || count < 3 || mesh.uv.length !== count * 2 || mesh.indices.length % 3 || mesh.positions.some(v => !Number.isFinite(v)) || mesh.uv.some(v => !Number.isFinite(v)) || mesh.indices.some(i => !Number.isInteger(i) || i < 0 || i >= count) || ![from.x, from.y, to.x, to.y].every(Number.isFinite)) throw new Error('Invalid current cloth mesh.');
  const vertex = (i: number): Vec3 => ({ x: mesh.positions[i * 3], y: mesh.positions[i * 3 + 1], z: mesh.positions[i * 3 + 2] });
  function endpoint(point: Vec2) {
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const ids = mesh.indices.slice(t, t + 3);
      const [a, b, c] = ids.map(i => ({ x: mesh.uv[i * 2], y: mesh.uv[i * 2 + 1] }));
      const determinant = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
      if (Math.abs(determinant) < 1e-12) continue;
      const u = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / determinant;
      const v = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / determinant;
      const w = 1 - u - v;
      if (u < -1e-7 || v < -1e-7 || w < -1e-7) continue;
      const vertices = ids.map(vertex);
      return { ids, position: { x: vertices[0].x * u + vertices[1].x * v + vertices[2].x * w, y: vertices[0].y * u + vertices[1].y * v + vertices[2].y * w, z: vertices[0].z * u + vertices[1].z * v + vertices[2].z * w } };
    }
    throw new Error('Measurement endpoint is outside the rendered piece.');
  }
  const start = endpoint(from), end = endpoint(to);
  if (method === 'chord') return distance(start.position, end.position);
  if (method !== 'surface-path') throw new Error('Unknown surface measurement method.');
  // Mesh-edge shortest path is reproducible and stays on the cloth. It approximates a geodesic
  // at the current tessellation and never presents a straight spatial chord as surface distance.
  const graph = Array.from({ length: count + 2 }, () => new Map<number, number>());
  const connect = (a: number, b: number, length: number) => { graph[a].set(b, length); graph[b].set(a, length); };
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ids = mesh.indices.slice(t, t + 3);
    for (let i = 0; i < 3; i++) connect(ids[i], ids[(i + 1) % 3], distance(vertex(ids[i]), vertex(ids[(i + 1) % 3])));
  }
  start.ids.forEach(i => connect(count, i, distance(start.position, vertex(i))));
  end.ids.forEach(i => connect(count + 1, i, distance(end.position, vertex(i))));
  if (start.ids.every(i => end.ids.includes(i))) connect(count, count + 1, distance(start.position, end.position));
  const distances = Array(count + 2).fill(Infinity) as number[]; distances[count] = 0;
  const visited = new Set<number>();
  for (;;) {
    let current = -1, best = Infinity;
    for (let i = 0; i < distances.length; i++) if (!visited.has(i) && distances[i] < best) { current = i; best = distances[i]; }
    if (current < 0) throw new Error('Measurement endpoints are on disconnected cloth surfaces.');
    if (current === count + 1) return best;
    visited.add(current);
    for (const [neighbor, length] of graph[current]) distances[neighbor] = Math.min(distances[neighbor], best + length);
  }
}
