import { PerspectiveCamera, Vector3 } from 'three';

/** CPU evidence calculation only. Count every vertex before creating test assertions. */
export function inspectProjection(points: readonly number[][], actual: {
  camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
  canvas: { width: number; height: number };
}) {
  const camera = new PerspectiveCamera(actual.camera.fov, actual.canvas.width / actual.canvas.height, .01, 100);
  camera.position.fromArray(actual.camera.position); camera.lookAt(new Vector3(...actual.camera.target)); camera.updateMatrixWorld();
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  let nonFiniteVertices = 0, depthViolations = 0;
  const vector = new Vector3();
  for (const point of points) {
    const p = vector.set(point[0], point[1], point[2]).project(camera);
    if (![p.x, p.y, p.z].every(Number.isFinite)) { nonFiniteVertices++; continue; }
    if (!(p.z > -1 && p.z < 1)) depthViolations++;
    const x = (p.x + 1) * actual.canvas.width / 2, y = (1 - p.y) * actual.canvas.height / 2;
    bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x); bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
  }
  return { bounds, vertexCount: points.length, nonFiniteVertices, depthViolations };
}
