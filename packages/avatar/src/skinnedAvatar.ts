// The shared body model's mesh, as a three.js object.
//
// The skeleton and the skinning are @seamer/body-model's: a joint is a weighted
// combination of four mesh vertices, so the rig is re-derived whenever the body
// changes shape, and posing bakes linear-blend skinning into the geometry's
// position buffer (which is what the original renderer did, and what the cloth
// solver reads). This holds the geometry and the mesh and keeps the current
// pose; the arithmetic is not repeated here.

import * as THREE from 'three';
import { createSkeleton, jointWorldPositions, poseVertices, poseWorldMatrices } from '@seamer/body-model';
import type { BaseModel, PoseData, Skeleton } from '@seamer/body-model';
import { anchorPoint, type MeasureSegmentDef } from './bodyMeasurements3d';

/** An opt-in A pose, approximately 45 degrees below horizontal for the bundled bodies.
 * GarmentCode's neutral body seeds sleeves at 45.483 degrees; an A pose is a closer
 * starting match than our rest (~61 degrees) or T pose. This fixed interpolation is
 * approximate across body shapes and changes only the avatar, never cloth seeds. */
function makeAPose(baseModel: BaseModel, fraction = 0.239614): PoseData | null {
  const names = ['mixamorigLeftShoulder', 'mixamorigLeftArm', 'mixamorigRightShoulder', 'mixamorigRightArm'];
  const pose: PoseData = {};
  for (const name of names) {
    const rest = baseModel.bones.find(([bone]) => bone === name)?.[1].rotation;
    const target = baseModel.poses.T?.[name];
    if (!rest || !target) return null;
    const from = new THREE.Quaternion().setFromEuler(new THREE.Euler(rest[0], rest[1], rest[2], 'XYZ'));
    const to = new THREE.Quaternion().setFromEuler(new THREE.Euler(target.x, target.y, target.z, 'XYZ'));
    const rotation = new THREE.Euler().setFromQuaternion(from.slerp(to, fraction), 'XYZ');
    pose[name] = { x: rotation.x, y: rotation.y, z: rotation.z };
  }
  return pose;
}

export class SkinnedAvatar {
  readonly geometry: THREE.BufferGeometry;
  readonly mesh: THREE.Mesh;

  private baseModel: BaseModel;
  private skeleton: Skeleton;
  private skin: { indices: Uint16Array; weights: Float32Array };
  private restVertices: Float32Array;
  private currentPose: PoseData = {};
  private aPose: PoseData | null;
  private joints: Map<string, number[]>;

  constructor(
    baseModel: BaseModel,
    indices: Uint32Array,
    skinIndex: Uint16Array,
    skinWeight: Float32Array,
    restVertices: Float32Array,
    material: THREE.Material
  ) {
    this.baseModel = baseModel;
    this.aPose = baseModel.poses.A ?? makeAPose(baseModel);
    this.skin = { indices: skinIndex, weights: skinWeight };
    this.restVertices = restVertices;
    this.skeleton = createSkeleton(baseModel, restVertices);
    this.joints = jointWorldPositions(this.skeleton, this.currentPose);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(restVertices.slice(), 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    this.applyPose(); // rest pose bake

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** Names of available poses (e.g. T, BentArm, Sitting, and the opt-in A pose). */
  poseNames(): string[] {
    const names = Object.keys(this.baseModel.poses);
    return this.aPose && !names.includes('A') ? [...names, 'A'] : names;
  }

  /** Set the avatar's pose by name (instant). Unlisted bones keep their rest rotation. */
  setPose(name: string | null) {
    this.currentPose = (name === 'A' ? this.aPose : name && this.baseModel.poses[name]) || {};
    this.applyPose();
  }

  /** Match the A pose to a source angle using the actual reconstructed joints.
   * The rest-to-T range is bounded: unreachable angles use its nearest end.
   * Configuring a pose does not select it or alter cloth particle positions. */
  configureAPoseAngle(degrees: number | null): void {
    this.aPose = this.baseModel.poses.A ?? makeAPose(this.baseModel);
    if (degrees === null || !Number.isFinite(degrees) || !this.aPose) return;
    const angle = (fraction: number) => {
      const pose = makeAPose(this.baseModel, fraction);
      if (!pose) return null;
      const joints = jointWorldPositions(this.skeleton, pose);
      let total = 0;
      for (const side of ['Left', 'Right']) {
        const shoulder = joints.get(`mixamorig${side}Arm`), wrist = joints.get(`mixamorig${side}Hand`);
        if (!shoulder || !wrist) return null;
        total += Math.atan2(shoulder[1] - wrist[1], Math.abs(shoulder[0] - wrist[0])) * 180 / Math.PI;
      }
      return total / 2;
    };
    const rest = angle(0), raised = angle(1);
    if (rest === null || raised === null || rest <= raised) return;
    const target = Math.max(raised, Math.min(rest, degrees));
    let low = 0, high = 1;
    for (let iteration = 0; iteration < 18; iteration++) {
      const middle = (low + high) / 2;
      const value = angle(middle);
      if (value === null) return;
      if (value > target) low = middle; else high = middle;
    }
    this.aPose = makeAPose(this.baseModel, (low + high) / 2);
  }


  /** Calibrated source A pose: GarmentCode defines arm inclination from the
   * shoulder surface tip to the wrist. Shoulder joints sit lower than that tip.
   * Preserve collar and elbow rotations and rotate each upper arm toward the
   * anatomical source wrist, instead of assigning the source angle to joint centres. */
  configureGarmentCodeAPose(source: Record<string, number> | null): void {
    this.configureAPoseAngle(source?.arm_pose_angle ?? null);
    if (!source || !(source.arm_length > 0) || !(source.arm_pose_angle >= 0 && source.arm_pose_angle <= 90)) return;
    const definition = (this.baseModel.measurements as MeasureSegmentDef[]).find(m => m.name === 'shoulderWidth');
    const shoulders = definition?.coordinates?.map(a => anchorPoint(a, this.restVertices, this.indices));
    if (!shoulders?.length || shoulders.some(p => !p)) return;
    const joints = jointWorldPositions(this.skeleton, {}), worlds = poseWorldMatrices(this.skeleton, {});
    const pose: PoseData = {};
    for (const side of ['Left', 'Right'] as const) {
      const sign = side === 'Left' ? 1 : -1;
      const tip = shoulders.reduce((a, b) => sign * a![0] > sign * b![0] ? a : b)!;
      const name = `mixamorig${side}Arm`, index = this.skeleton.indexOf.get(name);
      const shoulder = joints.get(name), wrist = joints.get(`mixamorig${side}Hand`);
      if (index === undefined || !shoulder || !wrist) return;
      const angle = source.arm_pose_angle * Math.PI / 180, length = source.arm_length / 100;
      const target = new THREE.Vector3(tip[0] + sign * Math.cos(angle) * length, tip[1] - Math.sin(angle) * length, wrist[2]);
      const centre = new THREE.Vector3(...shoulder);
      const current = new THREE.Vector3(...wrist).sub(centre).normalize();
      const desired = target.sub(centre).normalize();
      const correction = new THREE.Quaternion().setFromUnitVectors(current, desired);
      const world = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(worlds[index]));
      const parent = this.skeleton.bones[index].parent;
      const parentRotation = parent < 0 ? new THREE.Quaternion() :
        new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(worlds[parent]));
      const local = parentRotation.invert().multiply(correction.multiply(world));
      const rotation = new THREE.Euler().setFromQuaternion(local, 'XYZ');
      pose[name] = { x: rotation.x, y: rotation.y, z: rotation.z };
    }
    // Candidate pose uses native surface endpoints, not joint centres. The
    // source inclination is measured against the full horizontal XZ plane.
    const armDef = (this.baseModel.measurements as MeasureSegmentDef[]).find(m => m.name === 'armLength');
    const shoulderDef = (this.baseModel.measurements as MeasureSegmentDef[]).find(m => m.name === 'neckSideToShoulder');
    const rightWrist = armDef?.coordinates?.[2], rightTip = shoulderDef?.coordinates?.[1];
    if (rightWrist && rightTip) {
      const indexed = (a: NonNullable<MeasureSegmentDef['coordinates']>[number]) => this.indices[a.faceIndex * 3 + (a.u === 1 ? 0 : a.v === 1 ? 1 : 2)];
      const mirror = (id: number) => {
        const pair = (this.baseModel.symmetry as { pairs: number[][] }).pairs.find(p => p.includes(id));
        if (!pair) throw new Error('Missing native surface anchor symmetry.');
        return pair[0] === id ? pair[1] : pair[0];
      };
      const leftTip = mirror(indexed(rightTip)), leftWrist = mirror(indexed(rightWrist));
      const sampled = new Float32Array(this.restVertices.length);
      for (let iteration = 0; iteration < 8; iteration++) {
        poseVertices(this.skeleton, this.restVertices, this.skin, pose, sampled);
        const worldMatrices = poseWorldMatrices(this.skeleton, pose);
        let maximumError = 0;
        for (const side of ['Left', 'Right'] as const) {
          const tip = side === 'Right' ? anchorPoint(rightTip, sampled, this.indices)! : Array.from(sampled.subarray(leftTip * 3, leftTip * 3 + 3));
          const wrist = side === 'Right' ? anchorPoint(rightWrist, sampled, this.indices)! : Array.from(sampled.subarray(leftWrist * 3, leftWrist * 3 + 3));
          const actual = Math.atan2(tip[1] - wrist[1], Math.hypot(wrist[0] - tip[0], wrist[2] - tip[2]));
          const error = source.arm_pose_angle * Math.PI / 180 - actual;
          maximumError = Math.max(maximumError, Math.abs(error));
          const name = `mixamorig${side}Arm`, index = this.skeleton.indexOf.get(name)!;
          const correction = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (side === 'Left' ? -1 : 1) * error);
          const world = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(worldMatrices[index]));
          const parent = this.skeleton.bones[index].parent;
          const parentRotation = parent < 0 ? new THREE.Quaternion() : new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(worldMatrices[parent]));
          const local = parentRotation.invert().multiply(correction.multiply(world));
          const rotation = new THREE.Euler().setFromQuaternion(local, 'XYZ');
          pose[name] = { x: rotation.x, y: rotation.y, z: rotation.z };
        }
        if (maximumError < 1e-7) break;
      }
    }
    this.aPose = pose;
  }

  /** Update the rest shape (body changed), re-derive the skeleton and re-apply the current pose. */
  setRestVertices(restVertices: Float32Array) {
    this.restVertices = restVertices;
    this.skeleton = createSkeleton(this.baseModel, restVertices);
    this.applyPose();
  }

  private applyPose() {
    const attribute = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    let out = attribute.array as Float32Array;
    if (out.length !== this.restVertices.length) {
      out = new Float32Array(this.restVertices.length);
      this.geometry.setAttribute('position', new THREE.BufferAttribute(out, 3));
    }
    poseVertices(this.skeleton, this.restVertices, this.skin, this.currentPose, out);
    this.joints = jointWorldPositions(this.skeleton, this.currentPose);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }

  /** Current (posed) vertex positions, meters. */
  get positions(): Float32Array {
    return (this.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  }

  /** Triangle index buffer. */
  get indices(): Uint32Array {
    return this.geometry.getIndex()!.array as Uint32Array;
  }

  /** World position of a named bone in the current pose (for cylinder construction). */
  boneWorldPosition(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    const joint = this.joints.get(name);
    if (!joint) return null;
    return out.set(joint[0], joint[1], joint[2]);
  }

  dispose() {
    this.geometry.dispose();
  }
}
