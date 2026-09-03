// The per-vertex parametric reconstruction lives in @seamer/body-model, which is
// where both this and knitterer read it from. Re-exported here so callers that
// already import from @seamer/avatar do not have to change.

export { reconstructVertices, coefficientCount, coefficientsFrom, meanCoefficients } from '@seamer/body-model';

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  height: number;
}

export function boundingBox(verts: Float32Array): BoundingBox {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = verts[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max, height: max[1] - min[1] };
}
