import * as THREE from 'three';
import type { BaseModel } from '@seamer/body-model';
import { createSkeleton, jointWorldPositions } from '@seamer/body-model';
import { SkinnedAvatar } from './skinnedAvatar';
import { triangleSurfaceGeodesic } from './surfaceGeodesic';
import { measureGarmentCodeTorsoGirths, refitSourcePosedTorsoGirths } from './garmentCodeFit';
import { anchorPoint, type MeasureSegmentDef } from './bodyMeasurements3d';

/** Source dimensions measured on native FBX anchor proxies with the pinned
 * triangulated pmp geodesic method. These are not identical SMPL landmarks. */
export function surfaceAnchorVertices(model: BaseModel, indices: Uint32Array) {
  const definitions = model.measurements as MeasureSegmentDef[];
  const vertex = (name: string, ordinal: number) => {
    const a = definitions.find(m => m.name === name)?.coordinates?.[ordinal];
    if (!a || Math.max(a.u, a.v, a.w) !== 1) throw new Error('Source surface calibration requires an exact indexed native anchor.');
    return indices[a.faceIndex * 3 + (a.u === 1 ? 0 : a.v === 1 ? 1 : 2)];
  };
  const rightTip = vertex('neckSideToShoulder', 1), rightWrist = vertex('armLength', 2);
  const pairs = (model.symmetry as { pairs: number[][] }).pairs;
  const mirror = (id: number) => { const pair = pairs.find(p => p.includes(id)); if (!pair) throw new Error('Missing surface anchor symmetry.'); return pair[0] === id ? pair[1] : pair[0]; };
  return [{ side: 'Left', tip: mirror(rightTip), wrist: mirror(rightWrist) }, { side: 'Right', tip: rightTip, wrist: rightWrist }];
}

/** Positive shortest edge path gives a reproducible upper bound for the mesh's
 * continuous surface geodesic. Preserve original topology; no skin shortcut. */
export function indexedSurfaceDistance(vertices: Float32Array, indices: Uint32Array, start: number, end: number): number {
  const count = vertices.length / 3;
  if (!Number.isInteger(count) || start < 0 || end < 0 || start >= count || end >= count) throw new Error('Invalid surface path anchors.');
  const links: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  for (let i = 0; i < indices.length; i += 3) for (let e = 0; e < 3; e++) {
    const a = indices[i + e], b = indices[i + (e + 1) % 3];
    if (a >= count || b >= count) throw new Error('Invalid surface topology.');
    const length = Math.hypot(...[0, 1, 2].map(k => vertices[a * 3 + k] - vertices[b * 3 + k]));
    if (!Number.isFinite(length)) throw new Error('Non-finite surface path.');
    links[a].set(b, length); links[b].set(a, length);
  }
  const distance = new Float64Array(count).fill(Infinity); distance[start] = 0;
  const heap: [number, number][] = [[0, start]];
  const push = (value: [number, number]) => { let i = heap.length; heap.push(value); while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= value[0]) break; heap[i] = heap[p]; i = p; } heap[i] = value; };
  const pop = () => { const first = heap[0], last = heap.pop()!; if (heap.length) { let i = 0; while (true) { const l = i * 2 + 1; if (l >= heap.length) break; const r = l + 1, c = r < heap.length && heap[r][0] < heap[l][0] ? r : l; if (heap[c][0] >= last[0]) break; heap[i] = heap[c]; i = c; } heap[i] = last; } return first; };
  while (heap.length) { const [length, a] = pop(); if (length !== distance[a]) continue; if (a === end) return length; for (const [b, w] of links[a]) if (length + w < distance[b]) { distance[b] = length + w; push([length + w, b]); } }
  throw new Error('Source surface anchors are disconnected.');
}

export function measureSourceSurfaceDimensions(vertices: Float32Array, indices: Uint32Array, model: BaseModel) {
  const defs = model.measurements as MeasureSegmentDef[];
  const shoulders = defs.find(m => m.name === 'shoulderWidth')!.coordinates!.map(a => anchorPoint(a, vertices, indices)!);
  const left = shoulders.reduce((a, b) => a[0] > b[0] ? a : b), right = shoulders.reduce((a, b) => a[0] < b[0] ? a : b);
  const arms = surfaceAnchorVertices(model, indices).map(a => { const tip = Array.from(vertices.subarray(a.tip * 3, a.tip * 3 + 3)), wrist = Array.from(vertices.subarray(a.wrist * 3, a.wrist * 3 + 3)); return { ...a, surfaceLengthM: triangleSurfaceGeodesic(vertices, indices, a.tip, a.wrist), edgeGraphUpperBoundM: indexedSurfaceDistance(vertices, indices, a.tip, a.wrist), chordLengthM: Math.hypot(...tip.map((v, k) => v - wrist[k])), inclinationDegrees: Math.atan2(tip[1] - wrist[1], Math.hypot(tip[0] - wrist[0], tip[2] - wrist[2])) * 180 / Math.PI }; });
  return { shoulderWidthM: Math.hypot(...left.map((n, k) => n - right[k])), arms };
}

export function fitSourceSurfaceDimensions(vertices: Float32Array, indices: Uint32Array, skinIndices: Uint16Array, skinWeights: Float32Array, model: BaseModel, source: Record<string, number>): Float32Array {
  if (!(source.arm_length > 0 && source.shoulder_w > 0 && source.arm_pose_angle >= 0 && source.arm_pose_angle <= 90)) return vertices;
  const fitted = vertices.slice(), material = new THREE.MeshBasicMaterial();
  const waistY = (source.height - source.head_l - source.waist_line) / 100;
  const armSets = ['left', 'right'].map(side => new Set([...(model.bodyParts[`${side}_arm`] ?? []), ...(model.bodyParts[`${side}_lower_arm`] ?? [])].flatMap(face => [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]])));
  for (let iteration = 0; iteration < 18; iteration++) {
    const preview = new SkinnedAvatar(model, indices, skinIndices, skinWeights, fitted, material);
    preview.configureGarmentCodeAPose(source); preview.setPose('A');
    const measured = measureSourceSurfaceDimensions(preview.positions, indices, model);
    const posedTorso = measureGarmentCodeTorsoGirths(preview.positions, indices, model); preview.dispose();
    const widthFactor = source.shoulder_w / 100 / measured.shoulderWidthM;
    const ratios = measured.arms.map(a => source.arm_length / 100 / a.surfaceLengthM);
    if (['bust', 'waist', 'hips'].every(k => Math.abs(posedTorso[k] - source[k]) < .1) && Math.abs(measured.shoulderWidthM - source.shoulder_w / 100) < .0001 && ratios.every((r, i) => Math.abs(measured.arms[i].surfaceLengthM * (r - 1)) < .0001)) { material.dispose(); return fitted; }
    if (widthFactor < .9 || widthFactor > 1.1 || ratios.some(r => r < .85 || r > 1.15)) throw new Error('Source surface calibration exceeds the supported incremental range.');
    const skeleton = createSkeleton(model, fitted), joints = jointWorldPositions(skeleton, {});
    const defs = model.measurements as MeasureSegmentDef[];
    const shoulderPoints = defs.find(m => m.name === 'shoulderWidth')!.coordinates!.map(a => anchorPoint(a, fitted, indices)!);
    const shoulderY = shoulderPoints.reduce((s, p) => s + p[1], 0) / shoulderPoints.length;
    const neckAnchor = defs.find(m => m.name === 'neckSideToShoulder')?.coordinates?.[0];
    const neckY = neckAnchor ? anchorPoint(neckAnchor, fitted, indices)?.[1] : undefined;
    if (neckY === undefined || !(neckY > shoulderY)) throw new Error('Source shoulder calibration requires a neck anchor above the shoulder.');
    for (let at = 0; at < fitted.length; at += 3) {
      const side = armSets.findIndex(set => set.has(at / 3));
      if (side >= 0) { const joint = joints.get(`mixamorig${side === 0 ? 'Left' : 'Right'}Arm`)!; fitted[at] += (widthFactor - 1) * joint[0]; }
      else { const y = fitted[at + 1], weight = y <= shoulderY
        ? Math.max(0, Math.min(1, (y - waistY) / (shoulderY - waistY)))
        : Math.max(0, Math.min(1, (neckY - y) / (neckY - shoulderY)));
        fitted[at] *= 1 + (widthFactor - 1) * weight; }
    }
    refitSourcePosedTorsoGirths(fitted, indices, model, source, posedTorso);
    const movedJoints = jointWorldPositions(createSkeleton(model, fitted), {});
    for (let side = 0; side < 2; side++) {
      const name = side === 0 ? 'Left' : 'Right', shoulder = movedJoints.get(`mixamorig${name}Arm`)!, wrist = movedJoints.get(`mixamorig${name}Hand`)!;
      const axis = wrist.map((x, k) => x - shoulder[k]), span = Math.hypot(...axis), direction = axis.map(x => x / span);
      for (const vertex of armSets[side]) { const at = vertex * 3, axial = Math.max(0, Math.min(span + .05, direction.reduce((s, n, k) => s + n * (fitted[at + k] - shoulder[k]), 0))); const delta = (ratios[side] - 1) * axial; for (let k = 0; k < 3; k++) fitted[at + k] += direction[k] * delta; }
    }
  }
  material.dispose(); throw new Error('Source surface dimensions did not converge within eighteen iterations.');
}
