// Skeleton construction, linear-blend skinning and posing for the parametric avatar.
//
// Each bone's joint world position is a regression over 4 mesh vertices (Σ weights·vertex), so the
// skeleton is re-derived whenever the body shape changes. Skinning is baked on the CPU into the
// geometry position buffer (matching the original renderer, which overwrites the displayed mesh
// positions). Poses are absolute XYZ-euler rotations applied to a subset of bones.

import * as THREE from 'three';
import type { BaseModel, BoneData, PoseData } from './assets';

const _v = new THREE.Vector3();
const _skin = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();
const _pos = new THREE.Vector3();

export class SkinnedAvatar {
  readonly geometry: THREE.BufferGeometry;
  readonly mesh: THREE.Mesh;

  private baseModel: BaseModel;
  private boneData = new Map<string, BoneData>();
  private bones = new Map<string, THREE.Bone>();
  private rootBones: THREE.Bone[] = [];
  private boneOrder: string[] = [];
  private boneInverses: THREE.Matrix4[] = [];
  private boneIndexByName = new Map<string, number>();

  private skinIndex: Uint16Array;
  private skinWeight: Float32Array;
  private restVertices: Float32Array;
  private numVertices: number;
  private currentPose: PoseData = {};

  constructor(
    baseModel: BaseModel,
    indices: Uint32Array,
    skinIndex: Uint16Array,
    skinWeight: Float32Array,
    restVertices: Float32Array,
    material: THREE.Material
  ) {
    this.baseModel = baseModel;
    this.skinIndex = skinIndex;
    this.skinWeight = skinWeight;
    this.restVertices = restVertices;
    this.numVertices = restVertices.length / 3;
    for (const [name, data] of baseModel.bones) this.boneData.set(name, data);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(restVertices.slice(), 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    this.buildSkeleton();
    this.inferBones();
    this.applyPose(); // rest pose bake
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** Names of available poses (e.g. T, BentArm, Sitting). */
  poseNames(): string[] {
    return Object.keys(this.baseModel.poses);
  }

  private buildSkeleton() {
    this.bones.clear();
    this.rootBones = [];
    this.boneOrder = [];
    this.boneIndexByName.clear();

    for (const [name, data] of this.baseModel.bones) {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2], 'XYZ');
      this.bones.set(name, bone);
      this.boneIndexByName.set(name, this.boneOrder.length);
      this.boneOrder.push(name);
    }
    for (const [name, data] of this.baseModel.bones) {
      const bone = this.bones.get(name)!;
      if (data.parent && this.bones.has(data.parent)) {
        this.bones.get(data.parent)!.add(bone);
      } else {
        this.rootBones.push(bone);
      }
    }
  }

  /** World-space joint position from the bone's 4-vertex regression. */
  private jointWorldPos(data: BoneData, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    for (let k = 0; k < data.indices.length; k++) {
      const vi = data.indices[k];
      const w = data.weights[k];
      out.x += w * this.restVertices[vi * 3];
      out.y += w * this.restVertices[vi * 3 + 1];
      out.z += w * this.restVertices[vi * 3 + 2];
    }
    return out;
  }

  /** Re-derive bone local positions from the current rest vertices, then capture bind inverses. */
  private inferBones() {
    for (const bone of this.rootBones) this.placeBoneRecursively(bone);
    // Capture bind-pose inverses in bone order.
    this.boneInverses = this.boneOrder.map((name) => {
      const b = this.bones.get(name)!;
      b.updateWorldMatrix(true, false);
      return b.matrixWorld.clone().invert();
    });
  }

  private placeBoneRecursively(bone: THREE.Bone) {
    const data = this.boneData.get(bone.name)!;
    bone.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2], 'XYZ');
    const world = this.jointWorldPos(data, _v.clone());
    const parent = bone.parent;
    if (parent && (parent as THREE.Bone).isBone) {
      parent.updateWorldMatrix(true, false);
      bone.position.copy(parent.worldToLocal(world.clone()));
    } else {
      bone.position.copy(world);
    }
    bone.scale.set(1, 1, 1);
    bone.updateMatrixWorld(true);
    for (const child of bone.children) {
      if ((child as THREE.Bone).isBone) this.placeBoneRecursively(child as THREE.Bone);
    }
  }

  /** Set the avatar's pose by name (instant). Unlisted bones keep their rest rotation. */
  setPose(name: string | null) {
    const pose = (name && this.baseModel.poses[name]) || {};
    this.currentPose = pose;
    this.applyPose();
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }

  /** Apply current bone rotations and bake linear-blend skinning into the geometry positions. */
  private applyPose() {
    // Set rotations: rest default, overridden by the current pose for listed bones.
    for (const [name, bone] of this.bones) {
      const rest = this.boneData.get(name)!.rotation;
      const p = this.currentPose[name];
      if (p) bone.rotation.set(p.x, p.y, p.z, 'XYZ');
      else bone.rotation.set(rest[0], rest[1], rest[2], 'XYZ');
    }
    for (const bone of this.rootBones) bone.updateMatrixWorld(true);

    // Precompute skinMatrix = boneMatrixWorld * boneInverse for each bone.
    const skinMats: THREE.Matrix4[] = this.boneOrder.map((name, i) => {
      const b = this.bones.get(name)!;
      return b.matrixWorld.clone().multiply(this.boneInverses[i]);
    });

    const out = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const rest = this.restVertices;
    const si = this.skinIndex;
    const sw = this.skinWeight;
    const arr = out.array as Float32Array;

    for (let v = 0; v < this.numVertices; v++) {
      _skin.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      let total = 0;
      for (let b = 0; b < 4; b++) {
        const w = sw[v * 4 + b];
        if (w === 0) continue;
        const m = skinMats[si[v * 4 + b]];
        if (!m) continue;
        addScaledMatrix(_skin, m, w, _tmp);
        total += w;
      }
      if (total === 0) {
        arr[v * 3] = rest[v * 3];
        arr[v * 3 + 1] = rest[v * 3 + 1];
        arr[v * 3 + 2] = rest[v * 3 + 2];
        continue;
      }
      _pos.set(rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]).applyMatrix4(_skin);
      arr[v * 3] = _pos.x;
      arr[v * 3 + 1] = _pos.y;
      arr[v * 3 + 2] = _pos.z;
    }
    out.needsUpdate = true;
  }

  /** Update the rest shape (body changed), re-derive the skeleton and re-apply the current pose. */
  setRestVertices(restVertices: Float32Array) {
    this.restVertices = restVertices;
    this.numVertices = restVertices.length / 3;
    this.inferBones();
    this.applyPose();
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

  /** World position of a named bone (for cylinder construction). */
  boneWorldPosition(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    const b = this.bones.get(name);
    if (!b) return null;
    b.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(b.matrixWorld);
  }

  dispose() {
    this.geometry.dispose();
  }
}

/** dst += m * scalar (component-wise on the 16 matrix elements). */
function addScaledMatrix(dst: THREE.Matrix4, m: THREE.Matrix4, s: number, _scratch: THREE.Matrix4) {
  const d = dst.elements;
  const e = m.elements;
  for (let i = 0; i < 16; i++) d[i] += e[i] * s;
}
