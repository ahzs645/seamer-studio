// Per-vertex parametric body reconstruction.
//
// The coefficient buffer is a per-(vertex,axis) affine map: position = sum_i(coeff_i * basis_i) +
// intercept. Memory layout is [vertexInOrder][axis 0..2][value 0..17] where value 0..16 are the
// basis weights for the 17 COEFFICIENT_NAMES and value 17 is the intercept; vertexInOrder is
// symmetry.centeredIndices (written once) followed by symmetry.pairs (written to both members of
// the pair, with the X component negated for the mirror vertex). Output is in meters, +Y up,
// mirror plane X = 0.

import type { BaseModel } from './assets';

const COEFF_COUNT = 17;
const STRIDE = COEFF_COUNT + 1; // 18

/**
 * Reconstruct the rest-pose vertex positions (Float32Array length numVertices*3, meters).
 * @param coeff17 the 17 coefficient values in COEFFICIENT_NAMES order.
 */
export function reconstructVertices(
  baseModel: BaseModel,
  coefficients: Float32Array,
  coeff17: number[],
  numVertices: number
): Float32Array {
  const { centeredIndices, pairs } = baseModel.symmetry;
  const e = coeff17;
  const n = new Float32Array(numVertices * 3);
  let l = 0;

  const evalVertexAxis = (): number => {
    let d = 0;
    for (let p = 0; p < COEFF_COUNT; p++) d += e[p] * coefficients[l + p];
    d += coefficients[l + COEFF_COUNT]; // intercept
    l += STRIDE;
    return d;
  };

  for (let u = 0; u < centeredIndices.length; u++) {
    const c = centeredIndices[u];
    n[c * 3] = evalVertexAxis();
    n[c * 3 + 1] = evalVertexAxis();
    n[c * 3 + 2] = evalVertexAxis();
  }

  for (let u = 0; u < pairs.length; u++) {
    const c = pairs[u][0];
    const f2 = pairs[u][1];
    for (let d = 0; d < 3; d++) {
      const v = evalVertexAxis();
      n[c * 3 + d] = v;
      n[f2 * 3 + d] = v;
    }
    n[f2 * 3] = -n[c * 3]; // mirror X only
  }

  return n;
}

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
