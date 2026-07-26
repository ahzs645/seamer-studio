// Body "cylinders": tapered/elliptical capsules fitted to named bone segments, used to position
// garment pieces on the body. Each cylinder's axis runs startBone -> endBone; its cross-section
// radii (a along e1, b along e2) are fitted from a set of sample mesh vertices.

import * as THREE from 'three';
import type { Cylinder } from '@seamer/avatar';
import type { PieceArrangement } from '@seamer/pattern-model';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export function normalizeSignedDeg(d: number): number {
  return (((d + 180) % 360) + 360) % 360 - 180;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface RadiusSample {
  v: number;
  r: number;
}

/** Least-squares line lifted to enclose all samples; returns radius at v=0 and v=1. */
function fitLinearEnvelope(samples: RadiusSample[]): [number, number] {
  const n = samples.length;
  if (n === 0) return [0.05, 0.05];
  let sv = 0, sr = 0, svv = 0, svr = 0;
  for (const s of samples) { sv += s.v; sr += s.r; svv += s.v * s.v; svr += s.v * s.r; }
  const denom = n * svv - sv * sv;
  let slope = 0;
  let intercept = sr / n;
  if (Math.abs(denom) > 1e-9) {
    slope = (n * svr - sv * sr) / denom;
    intercept = (sr - slope * sv) / n;
  }
  let lift = 0;
  for (const s of samples) lift = Math.max(lift, s.r - (slope * s.v + intercept));
  intercept += lift;
  return [Math.max(0, intercept), Math.max(0, slope + intercept)];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0.05;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

export class CylinderFrame {
  start: THREE.Vector3;
  end: THREE.Vector3;
  axis: THREE.Vector3;
  axisLength: number;
  e1: THREE.Vector3;
  e2: THREE.Vector3;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  uOffsetDegrees: number;
  uSign: number;

  constructor(def: Cylinder, start: THREE.Vector3, end: THREE.Vector3, vertexPos: (i: number) => THREE.Vector3) {
    this.start = start.clone();
    this.end = end.clone();
    const axis = new THREE.Vector3().subVectors(end, start);
    this.axisLength = Math.max(1e-6, axis.length());
    this.axis = axis.clone().normalize();

    // cross-section basis
    let ref = new THREE.Vector3(0, 0, 1);
    let e1 = ref.clone().sub(this.axis.clone().multiplyScalar(ref.dot(this.axis)));
    if (e1.lengthSq() < 1e-8) {
      ref = new THREE.Vector3(0, 1, 0);
      e1 = ref.clone().sub(this.axis.clone().multiplyScalar(ref.dot(this.axis)));
    }
    this.e1 = e1.normalize();
    this.e2 = new THREE.Vector3().crossVectors(this.axis, this.e1).normalize();

    // fit radii from sample vertices
    const la: RadiusSample[] = [];
    const lb: RadiusSample[] = [];
    const ra: number[] = [];
    const rb: number[] = [];
    const tmp = new THREE.Vector3();
    for (const vi of def.vertexIndices) {
      const x = vertexPos(vi);
      const w = tmp.subVectors(x, this.start).dot(this.axis);
      const v = w / this.axisLength;
      const foot = this.start.clone().addScaledVector(this.axis, w);
      const c = new THREE.Vector3().subVectors(x, foot);
      const ce1 = Math.abs(c.dot(this.e1));
      const ce2 = Math.abs(c.dot(this.e2));
      la.push({ v, r: ce1 }); lb.push({ v, r: ce2 });
      ra.push(ce1); rb.push(ce2);
    }

    if (def.tapered) {
      [this.a0, this.a1] = fitLinearEnvelope(la);
      [this.b0, this.b1] = fitLinearEnvelope(lb);
    } else {
      const a = percentile(ra, 0.95);
      const b = percentile(rb, 0.95);
      this.a0 = this.a1 = a;
      this.b0 = this.b1 = b;
    }
    if (!def.elliptical) {
      const a = Math.max(this.a0, this.b0);
      const a1 = Math.max(this.a1, this.b1);
      this.a0 = this.b0 = a;
      this.a1 = this.b1 = a1;
    }
    const pad = def.padding || 0;
    this.a0 = Math.max(0.001, this.a0 + pad);
    this.a1 = Math.max(0.001, this.a1 + pad);
    this.b0 = Math.max(0.001, this.b0 + pad);
    this.b1 = Math.max(0.001, this.b1 + pad);

    this.uOffsetDegrees = def.uOffsetDegrees || 0;
    this.uSign = def.axisReversed ? -1 : 1;
  }

  radiusA(v: number): number { return lerp(this.a0, this.a1, Math.min(1, Math.max(0, v))); }
  radiusB(v: number): number { return lerp(this.b0, this.b1, Math.min(1, Math.max(0, v))); }

  uvToWorld(uDeg: number, v: number, inflate = 0, out = new THREE.Vector3()): THREE.Vector3 {
    const a = this.radiusA(v) + inflate;
    const b = this.radiusB(v) + inflate;
    const theta = (uDeg * this.uSign + this.uOffsetDegrees) * DEG;
    out.copy(this.start).addScaledVector(this.axis, v * this.axisLength);
    out.addScaledVector(this.e1, Math.cos(theta) * a);
    out.addScaledVector(this.e2, Math.sin(theta) * b);
    return out;
  }

  worldToUv(p: THREE.Vector3): { uDeg: number; v: number } {
    const rel = new THREE.Vector3().subVectors(p, this.start);
    const w = rel.dot(this.axis);
    const v = w / this.axisLength;
    const foot = this.start.clone().addScaledVector(this.axis, w);
    const c = new THREE.Vector3().subVectors(p, foot);
    const a = Math.max(1e-6, this.radiusA(v));
    const b = Math.max(1e-6, this.radiusB(v));
    const thetaDeg = Math.atan2(c.dot(this.e2) / b, c.dot(this.e1) / a) * RAD;
    const uDeg = normalizeSignedDeg((thetaDeg - this.uOffsetDegrees) * this.uSign);
    return { uDeg, v };
  }

  /** Apply a piece arrangement's mm offsets to get an effective (u,v). */
  effectiveUv(arr: PieceArrangement): { uDeg: number; v: number } {
    const v = arr.v - (arr.vOffsetMm / 1000) / Math.max(1e-6, this.axisLength);
    const rMid = Math.max(1e-4, (this.radiusA(arr.v) + this.radiusB(arr.v)) / 2);
    const uDeg = normalizeSignedDeg(arr.uDegrees + (arr.uOffsetMm / 1000) / rMid * RAD);
    return { uDeg, v };
  }
}

/** Build all body cylinders. `bonePos(name)` and `vertexPos(index)` return world positions. */
export function buildCylinders(
  defs: Cylinder[],
  bonePos: (name: string) => THREE.Vector3 | null,
  vertexPos: (index: number) => THREE.Vector3
): Map<string, CylinderFrame> {
  const out = new Map<string, CylinderFrame>();
  for (const def of defs) {
    if (def.enabled === false) continue;
    const start = bonePos(def.startBone);
    const end = bonePos(def.endBone);
    if (!start || !end) continue;
    out.set(def.name, new CylinderFrame(def, start, end, vertexPos));
  }
  return out;
}
