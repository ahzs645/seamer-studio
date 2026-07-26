// Rigid re-fit of a cached drape onto a new-body arrangement, matching the original's createCloth
// behaviour (Kabsch/Procrustes fit of saved positions rather than re-draping from scratch). When the
// body/measurements change, each piece's settled drape is rigidly rotated+translated so it best
// overlays where that piece now sits on the new body; the solver then absorbs the non-rigid residual.
//
// We use Horn's closed-form quaternion method (optimal rotation via the largest eigenvector of a 4x4
// symmetric matrix, found by Jacobi rotation) — no scale/shear, matching the source's rigid fit.

export interface Rigid {
  /** rotation as a 3x3 row-major matrix */ r: number[];
  /** translation */ t: [number, number, number];
}

const IDENTITY: Rigid = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/** Symmetric 4x4 eigen-decomposition via cyclic Jacobi; returns the eigenvector of the largest eigenvalue. */
function largestEigenvector4(A: number[]): number[] {
  // A is row-major 4x4 symmetric. V accumulates eigenvectors (columns).
  const a = A.slice();
  const v = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const at = (i: number, j: number) => a[i * 4 + j];
  for (let sweep = 0; sweep < 50; sweep++) {
    // largest off-diagonal magnitude
    let off = 0;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) off += at(i, j) * at(i, j);
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = at(p, q);
        if (Math.abs(apq) < 1e-18) continue;
        const app = at(p, p), aqq = at(q, q);
        const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
        const c = Math.cos(phi), s = Math.sin(phi);
        // rotate rows/cols p,q of A
        for (let k = 0; k < 4; k++) {
          const akp = a[k * 4 + p], akq = a[k * 4 + q];
          a[k * 4 + p] = c * akp - s * akq;
          a[k * 4 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p * 4 + k], aqk = a[q * 4 + k];
          a[p * 4 + k] = c * apk - s * aqk;
          a[q * 4 + k] = s * apk + c * aqk;
        }
        // accumulate eigenvectors
        for (let k = 0; k < 4; k++) {
          const vkp = v[k * 4 + p], vkq = v[k * 4 + q];
          v[k * 4 + p] = c * vkp - s * vkq;
          v[k * 4 + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  // pick column with the largest diagonal (eigenvalue)
  let best = 0, bestVal = -Infinity;
  for (let i = 0; i < 4; i++) { const d = a[i * 4 + i]; if (d > bestVal) { bestVal = d; best = i; } }
  return [v[0 * 4 + best], v[1 * 4 + best], v[2 * 4 + best], v[3 * 4 + best]];
}

/** Optimal rigid transform mapping src -> dst (1:1 correspondence, n points each, xyz triples). */
export function kabschRigid(src: Float32Array, dst: Float32Array, n: number): Rigid {
  if (n < 3) return IDENTITY;
  let scx = 0, scy = 0, scz = 0, dcx = 0, dcy = 0, dcz = 0;
  for (let i = 0; i < n; i++) {
    scx += src[i * 3]; scy += src[i * 3 + 1]; scz += src[i * 3 + 2];
    dcx += dst[i * 3]; dcy += dst[i * 3 + 1]; dcz += dst[i * 3 + 2];
  }
  scx /= n; scy /= n; scz /= n; dcx /= n; dcy /= n; dcz /= n;
  // cross-covariance M = Σ (src-c)(dst-c)^T
  let m00 = 0, m01 = 0, m02 = 0, m10 = 0, m11 = 0, m12 = 0, m20 = 0, m21 = 0, m22 = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i * 3] - scx, py = src[i * 3 + 1] - scy, pz = src[i * 3 + 2] - scz;
    const qx = dst[i * 3] - dcx, qy = dst[i * 3 + 1] - dcy, qz = dst[i * 3 + 2] - dcz;
    m00 += px * qx; m01 += px * qy; m02 += px * qz;
    m10 += py * qx; m11 += py * qy; m12 += py * qz;
    m20 += pz * qx; m21 += pz * qy; m22 += pz * qz;
  }
  // Horn's N matrix (4x4 symmetric)
  const N = [
    m00 + m11 + m22, m12 - m21, m20 - m02, m01 - m10,
    m12 - m21, m00 - m11 - m22, m01 + m10, m20 + m02,
    m20 - m02, m01 + m10, -m00 + m11 - m22, m12 + m21,
    m01 - m10, m20 + m02, m12 + m21, -m00 - m11 + m22
  ];
  const q = largestEigenvector4(N);
  let w = q[0], x = q[1], y = q[2], z = q[3];
  const norm = Math.hypot(w, x, y, z) || 1;
  w /= norm; x /= norm; y /= norm; z /= norm;
  const r = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
  ];
  const t: [number, number, number] = [
    dcx - (r[0] * scx + r[1] * scy + r[2] * scz),
    dcy - (r[3] * scx + r[4] * scy + r[5] * scz),
    dcz - (r[6] * scx + r[7] * scy + r[8] * scz)
  ];
  return { r, t };
}

export function applyRigid(tr: Rigid, x: number, y: number, z: number): [number, number, number] {
  return [
    tr.r[0] * x + tr.r[1] * y + tr.r[2] * z + tr.t[0],
    tr.r[3] * x + tr.r[4] * y + tr.r[5] * z + tr.t[1],
    tr.r[6] * x + tr.r[7] * y + tr.r[8] * z + tr.t[2]
  ];
}
