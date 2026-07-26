// Cylinder-coordinate re-fit of a cached drape onto a changed body. Instead of re-settling the cloth
// with physics (which our approximate solver splays), we deform the cached drape COHERENTLY with the
// body: decompose each particle into its (u, v, radial-standoff) on the OLD body's cylinder, then
// re-project those same coordinates onto the NEW body's cylinder. Preserves the drape's shape relative
// to the body — tracks size/pose changes with no settling and therefore no splay/curl.

import * as THREE from 'three';
import type { CylinderFrame } from './geometry/cylinders';

export interface RefitPiece {
  pieceId: string;
  start: number;
  count: number;
}

/** Decompose p on `frame` into (uDeg, v) + radial standoff (distance beyond the cylinder surface). */
function decompose(frame: CylinderFrame, p: THREE.Vector3): { uDeg: number; v: number; radial: number } {
  const { uDeg, v } = frame.worldToUv(p);
  const foot = frame.start.clone().addScaledVector(frame.axis, v * frame.axisLength);
  const surface = frame.uvToWorld(uDeg, v, 0, new THREE.Vector3());
  const particleR = p.distanceTo(foot);
  const surfaceR = surface.distanceTo(foot);
  return { uDeg, v, radial: particleR - surfaceR };
}

/** Re-project (uDeg, v, radial) onto `frame`'s surface, offset outward by the standoff. */
function recompose(frame: CylinderFrame, uDeg: number, v: number, radial: number, out: THREE.Vector3): void {
  const foot = frame.start.clone().addScaledVector(frame.axis, v * frame.axisLength);
  const surface = frame.uvToWorld(uDeg, v, 0, new THREE.Vector3());
  const outward = surface.clone().sub(foot);
  const len = outward.length();
  if (len > 1e-6) outward.multiplyScalar(1 / len); else outward.copy(frame.e1);
  out.copy(surface).addScaledVector(outward, radial);
}

/**
 * Re-fit a cached drape (stride-4 positions) from oldCyl to newCyl, per piece. Particles of pieces
 * whose cylinder is missing on either side are passed through unchanged. Returns a new array.
 */
export function cylinderRefit(
  positions: Float32Array,
  pieces: RefitPiece[],
  cylinderNameOf: (pieceId: string) => string | null,
  oldCyl: Map<string, CylinderFrame>,
  newCyl: Map<string, CylinderFrame>
): Float32Array {
  const out = positions.slice();
  const p = new THREE.Vector3();
  const w = new THREE.Vector3();
  for (const piece of pieces) {
    const name = cylinderNameOf(piece.pieceId);
    const oldF = name ? oldCyl.get(name) : undefined;
    const newF = name ? newCyl.get(name) : undefined;
    if (!oldF || !newF) continue; // no cylinder correspondence -> leave this piece as-is
    for (let i = 0; i < piece.count; i++) {
      const g = piece.start + i;
      p.set(positions[g * 4], positions[g * 4 + 1], positions[g * 4 + 2]);
      const d = decompose(oldF, p);
      recompose(newF, d.uDeg, d.v, d.radial, w);
      out[g * 4] = w.x; out[g * 4 + 1] = w.y; out[g * 4 + 2] = w.z; // .w (invMass) preserved by slice()
    }
  }
  return out;
}
