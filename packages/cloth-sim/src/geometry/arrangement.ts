// Initial placement of a piece's particles in 3D, before cloth simulation.
// "curved" rolls the flat 2D piece around its body cylinder (y -> axial, x -> circumferential
// arc-length). "flat" lays it tangent to the cylinder surface. Without a cylinder (or with
// use2DPosition) the piece is placed in a flat plane.

import * as THREE from 'three';
import type { PieceArrangement } from '@seamer/pattern-model';
import { CylinderFrame, normalizeSignedDeg } from './cylinders';
import type { Vec2 } from '@seamer/pattern-model/utils/patternGeometry';

const RAD = 180 / Math.PI;

/** GarmentCode's mesh generator calls rotation.py:euler_xyz_to_R: Rz * Ry * Rx.
 * Its wrapper visualizer uses a different intrinsic XYZ convention; explicit matrix construction
 * here preserves the generated dataset meshes for compound rotations as well as single axes. */
export function garmentCodeWorldMatrix(
  rotationDegrees: readonly number[],
  translationMeters: readonly number[]
): number[] {
  if ([rotationDegrees, translationMeters].some((values) =>
    values.length !== 3 || Array.from(values).some((value) => !Number.isFinite(value))
  )) throw new Error('Panel rotation and translation must each contain three finite numbers');
  const [x, y, z] = rotationDegrees.map((angle) => angle / RAD);
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  return [
    cz * cy, sz * cy, -sy, 0,
    cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx, 0,
    cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx, 0,
    ...translationMeters, 1
  ];
}

/** Saved JSON may be malformed. Require a finite, affine, proper rigid transform so corrupt
 * placement cannot introduce NaNs, projective division, or scale into the cloth's rest state. */
function validSourcePlacement(source: PieceArrangement['sourcePlacement']): boolean {
  if (!source || !Array.isArray(source.worldMatrix) || source.worldMatrix.length !== 16
    || Array.from(source.worldMatrix).some((value) => typeof value !== 'number' || !Number.isFinite(Math.fround(value)))
    || !source.layoutOffsetMm || !Number.isFinite(source.layoutOffsetMm.x)
    || !Number.isFinite(source.layoutOffsetMm.y)) return false;
  const m = source.worldMatrix;
  const close = (value: number, expected: number) => Math.abs(value - expected) < 1e-5;
  if (!close(m[3], 0) || !close(m[7], 0) || !close(m[11], 0) || !close(m[15], 1)) return false;
  const dot = (a: number, b: number) => m[a] * m[b] + m[a + 1] * m[b + 1] + m[a + 2] * m[b + 2];
  if (![0, 4, 8].every((start) => close(dot(start, start), 1))
    || !close(dot(0, 4), 0) || !close(dot(0, 8), 0) || !close(dot(4, 8), 0)) return false;
  const determinant = m[0] * (m[5] * m[10] - m[9] * m[6])
    - m[4] * (m[1] * m[10] - m[9] * m[2])
    + m[8] * (m[1] * m[6] - m[5] * m[2]);
  return close(determinant, 1);
}

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

  // Source geometry remains y-up, in millimetres. Only its drafting-layout translation is undone;
  // do not centre its bounding box, wrap a cylinder, or add the legacy coincident-plane jitter.
  if (validSourcePlacement(arr.sourcePlacement)) {
    const { worldMatrix: m, layoutOffsetMm: offset } = arr.sourcePlacement!;
    for (let i = 0; i < pts.length; i++) {
      const x = (pts[i].x - offset.x) / 1000;
      const y = (pts[i].y - offset.y) / 1000;
      out[i * 3] = m[0] * x + m[4] * y + m[12];
      out[i * 3 + 1] = m[1] * x + m[5] * y + m[13];
      out[i * 3 + 2] = m[2] * x + m[6] * y + m[14] + jit;
    }
    return out;
  }

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
