// Initial placement of a piece's particles in 3D, before cloth simulation.
// "curved" rolls the flat 2D piece around its body cylinder (y -> axial, x -> circumferential
// arc-length). "flat" lays it tangent to the cylinder surface. Without a cylinder (or with
// use2DPosition) the piece is placed in a flat plane.

import * as THREE from 'three';
import type { PieceArrangement } from '@seamer/pattern-model';
import { CylinderFrame, normalizeSignedDeg } from './cylinders';
import type { Vec2 } from '@seamer/pattern-model/utils/patternGeometry';

const RAD = 180 / Math.PI;

export interface ArrangeOptions {
  flipNormals?: boolean;
  /** deterministic jitter seed offset to break exact coincidences */
  jitter?: number;
}

function bboxCenter(pts: Vec2[]): Vec2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Returns Float32Array of length pts.length*3 (meters) — the initial 3D positions.
 */
export function arrangeParticles(
  pts: Vec2[],
  arr: PieceArrangement,
  frame: CylinderFrame | null,
  opts: ArrangeOptions = {}
): Float32Array {
  const out = new Float32Array(pts.length * 3);
  const jit = opts.jitter ?? 0;

  if (arr.use2DPosition || !frame || !arr.cylinderName) {
    const z = arr.use2DPosition ? 0.3 : 0;
    for (let i = 0; i < pts.length; i++) {
      out[i * 3] = pts[i].x / 1000;
      out[i * 3 + 1] = pts[i].y / 1000;
      out[i * 3 + 2] = z + ((i % 7) - 3) * 1e-5 + jit;
    }
    return out;
  }

  const center = bboxCenter(pts);
  const eff = frame.effectiveUv(arr);
  const radial = (arr.radialOffsetMm || 0) / 1000;
  const w = new THREE.Vector3();

  if (arr.mode === 'flat') {
    // tangent frame at (u,v)
    const origin = frame.uvToWorld(eff.uDeg, eff.v, radial, new THREE.Vector3());
    const uPlus = frame.uvToWorld(eff.uDeg + 0.35, eff.v, radial, new THREE.Vector3());
    const tangent = new THREE.Vector3().subVectors(uPlus, origin).normalize().multiplyScalar(frame.uSign);
    const axis = frame.axis.clone().multiplyScalar(-1);
    const normal = new THREE.Vector3().crossVectors(tangent, axis).normalize();
    // SeamScape's resolveFlatFrameDirections keeps the cross-product normal for flipped pieces
    // and negates it for ordinary pieces. This is intentionally the inverse of the rendered face
    // normal: the 3 mm placement offset keeps the fabric on the cylinder's outside before the
    // triangle winding/flip flag is applied.
    if (!opts.flipNormals) normal.multiplyScalar(-1);
    for (let i = 0; i < pts.length; i++) {
      const p = (pts[i].x - center.x) / 1000;
      const m = (pts[i].y - center.y) / 1000;
      w.copy(origin).addScaledVector(tangent, p).addScaledVector(axis, m).addScaledVector(normal, 0.003);
      out[i * 3] = w.x; out[i * 3 + 1] = w.y; out[i * 3 + 2] = w.z;
    }
    return out;
  }

  // curved: roll the piece around the cylinder
  // The source reverses the circumferential direction for an ordinary (front-facing) piece and
  // uses the cylinder direction for a flipNormals piece. Using +uSign for both put the two sides of
  // a front/back pair on opposite body quadrants; their seam constraints then pulled straight
  // through the avatar (most visibly the knotted waistband in Simple Pants in 3D).
  const circumferentialSign = (opts.flipNormals ? 1 : -1) * frame.uSign;
  for (let i = 0; i < pts.length; i++) {
    const p = (pts[i].x - center.x) / 1000; // meters, tangential
    const m = (pts[i].y - center.y) / 1000; // meters, axial
    const v2 = eff.v - m / frame.axisLength;
    const rMid = Math.max(1e-4, (frame.radiusA(v2) + frame.radiusB(v2)) / 2);
    const u2 = normalizeSignedDeg(eff.uDeg + circumferentialSign * (p / rMid) * RAD);
    frame.uvToWorld(u2, v2, radial, w);
    out[i * 3] = w.x; out[i * 3 + 1] = w.y; out[i * 3 + 2] = w.z;
  }
  return out;
}
