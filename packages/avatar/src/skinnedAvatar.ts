// The shared body model's mesh, as a three.js object.
//
// The skeleton and the skinning are @seamer/body-model's: a joint is a weighted
// combination of four mesh vertices, so the rig is re-derived whenever the body
// changes shape, and posing bakes linear-blend skinning into the geometry's
// position buffer (which is what the original renderer did, and what the cloth
// solver reads). This holds the geometry and the mesh and keeps the current
// pose; the arithmetic is not repeated here.

import * as THREE from 'three';
import { createSkeleton, jointWorldPositions, poseVertices } from '@seamer/body-model';
import type { BaseModel, PoseData, Skeleton } from '@seamer/body-model';

export class SkinnedAvatar {
  readonly geometry: THREE.BufferGeometry;
  readonly mesh: THREE.Mesh;

  private baseModel: BaseModel;
  private skeleton: Skeleton;
  private skin: { indices: Uint16Array; weights: Float32Array };
  private restVertices: Float32Array;
  private currentPose: PoseData = {};
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

  /** Names of available poses (e.g. T, BentArm, Sitting). */
  poseNames(): string[] {
    return Object.keys(this.baseModel.poses);
  }

  /** Set the avatar's pose by name (instant). Unlisted bones keep their rest rotation. */
  setPose(name: string | null) {
    this.currentPose = (name && this.baseModel.poses[name]) || {};
    this.applyPose();
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
