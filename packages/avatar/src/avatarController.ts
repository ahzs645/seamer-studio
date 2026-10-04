// High-level avatar: loads assets, solves shape coefficients from body measurements, reconstructs
// the mesh, and manages the skinned/posed THREE mesh. Used by the 3D scene.

import * as THREE from 'three';
import type { Body } from '@seamer/pattern-model';
import { loadAvatarAssets, loadGenderAssets, type AvatarAssets, type Cylinder, type ArrangementPointDef } from './assets';
import { solveBodyCoefficients } from './measurements';
import { reconstructVertices } from './avatar';
import { SkinnedAvatar } from './skinnedAvatar';
import { snapshotAvatarBody } from './bodySnapshot';
import { fitSourceInWorker, type SourceFitMode, type SourceFitWorkerFactory } from './sourceFitWorker';
import { activeGarmentCodeBody, fitGarmentCodeAvatar } from './garmentCodeFit';

export class AvatarController {
  private assets: AvatarAssets;
  private sourceFitOptions: { sourceFitMode?: SourceFitMode; sourceFitWorkerFactory?: SourceFitWorkerFactory };
  private bodyGeneration = 0;
  private disposed = false;
  private sourceFitAbort: AbortController | null = null;
  private material: THREE.Material;
  private skinned: SkinnedAvatar | null = null;
  // The reference Studio opens in the avatar's neutral/rest pose. Named poses are opt-in controls;
  // defaulting to T made imported saved garments appear to target a different body silhouette.
  private pose: string | null = null;
  private poseWasChosen = false;
  private appliedPose: string | null = null;
  private automaticPose: string | null = null;
  private gender = 'female';

  private constructor(assets: AvatarAssets, material: THREE.Material, options: { sourceFitMode?: SourceFitMode; sourceFitWorkerFactory?: SourceFitWorkerFactory } = {}) {
    this.assets = assets;
    this.sourceFitOptions = { ...options };
    this.material = material;
  }

  static async create(body: Body, material: THREE.Material, options: { sourceFitMode?: SourceFitMode; sourceFitWorkerFactory?: SourceFitWorkerFactory } = {}): Promise<AvatarController> {
    body = snapshotAvatarBody(body);
    const assets = await loadAvatarAssets();
    const c = new AvatarController(assets, material, options);
    try { await c.setBody(body); } catch (error) { c.dispose(); throw error; }
    return c;
  }

  get mesh(): THREE.Mesh | null {
    return this.skinned?.mesh ?? null;
  }

  poseNames(): string[] {
    return this.skinned?.poseNames() ?? [];
  }

  /** Recompute the avatar from body measurements + gender. 'neutral' (the original's third option)
   *  blends the male and female statistical models 50/50: both share the base topology, so the
   *  per-gender reconstructions average vertex-for-vertex. */
  async setBody(body: Body): Promise<void> {
    if (this.disposed) throw new Error('Avatar is disposed.');
    const generation = ++this.bodyGeneration;
    this.sourceFitAbort?.abort();
    body = snapshotAvatarBody(body);
    const gender = body.gender === 'male' ? 'male' : body.gender === 'neutral' ? 'neutral' : 'female';
    const current = () => !this.disposed && generation === this.bodyGeneration;
    let verts: Float32Array;
    if (gender === 'neutral') {
      const [fem, mal] = await Promise.all([loadGenderAssets('female'), loadGenderAssets('male')]);
      const reconstruct = (g: typeof fem) => {
        const { coeff } = solveBodyCoefficients(g.model, body);
        return reconstructVertices(this.assets.baseModel, g.coefficients, coeff, this.assets.numVertices);
      };
      const vf = reconstruct(fem);
      const vm = reconstruct(mal);
      verts = vf;
      for (let i = 0; i < verts.length; i++) verts[i] = (vf[i] + vm[i]) / 2;
    } else {
      const genderAssets = await loadGenderAssets(gender);
      const { coeff } = solveBodyCoefficients(genderAssets.model, body);
      verts = reconstructVertices(
        this.assets.baseModel,
        genderAssets.coefficients,
        coeff,
        this.assets.numVertices
      );
    }
    if (!current()) return;
    const surfaceSource = activeGarmentCodeBody(body);
    if (surfaceSource) {
      const abort = new AbortController(); this.sourceFitAbort = abort;
      try { verts = await fitSourceInWorker({ vertices: verts, indices: this.assets.indices,
        skinIndices: this.assets.skinIndices, skinWeights: this.assets.skinWeights, model: this.assets.baseModel, body },
        { mode: this.sourceFitOptions.sourceFitMode, factory: this.sourceFitOptions.sourceFitWorkerFactory, signal: abort.signal }); }
      catch (error) { if (!current()) return; throw error; }
      finally { if (this.sourceFitAbort === abort) this.sourceFitAbort = null; }
    } else verts = fitGarmentCodeAvatar(verts, this.assets.indices, this.assets.baseModel, body);
    if (!current()) return;
    this.gender = gender;
    if (!this.skinned) {
      this.skinned = new SkinnedAvatar(
        this.assets.baseModel,
        this.assets.indices,
        this.assets.skinIndices,
        this.assets.skinWeights,
        verts,
        this.material
      );
    } else {
      this.skinned.setRestVertices(verts);
    }
    const sourceBody = activeGarmentCodeBody(body);
    this.skinned.configureGarmentCodeAPose(sourceBody);
    this.automaticPose = sourceBody ? 'A' : null;
    this.appliedPose = this.poseWasChosen ? this.pose : this.automaticPose;
    this.skinned.setPose(this.appliedPose);
  }

  setPose(name: string | null): void {
    this.poseWasChosen = true;
    this.pose = name;
    this.appliedPose = name;
    this.skinned?.setPose(name);
  }

  poseName(): string | null { return this.appliedPose; }

  /** Transfer user intent to an off-scene replacement, retaining its own automatic body pose. */
  copyPoseSelectionFrom(other: AvatarController): void {
    this.pose = other.pose;
    this.poseWasChosen = other.poseWasChosen;
    this.appliedPose = this.poseWasChosen ? this.pose : this.automaticPose;
    this.skinned?.setPose(this.appliedPose);
  }

  get skinnedAvatar(): SkinnedAvatar | null {
    return this.skinned;
  }

  get vertexPositions(): Float32Array {
    return this.skinned?.positions ?? new Float32Array(0);
  }

  get indices(): Uint32Array {
    return this.skinned?.indices ?? new Uint32Array(0);
  }

  get cylinderDefs(): Cylinder[] {
    return this.assets.baseModel.cylinders;
  }

  get arrangementPointDefs(): ArrangementPointDef[] {
    return this.assets.baseModel.arrangementPoints ?? [];
  }

  bonePosition(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    return this.skinned?.boneWorldPosition(name, out) ?? null;
  }

  /** Raw measurement definitions from the base model (anchors, types, planes) for on-mesh segments. */
  get measurementSegmentDefs(): import('./bodyMeasurements3d').MeasureSegmentDef[] {
    return this.assets.baseModel.measurements as import('./bodyMeasurements3d').MeasureSegmentDef[];
  }

  /** Per-measurement camera framing from the base model (drives the zoom-to-measurement fly-to). */
  measurementCamera(name: string): { position: [number, number, number]; target: [number, number, number]; fov: number } | null {
    const defs = this.assets.baseModel.measurements as { name?: string; cameraSettings?: { position?: number[]; target?: number[]; fov?: number } }[];
    const cs = defs.find((m) => m?.name === name)?.cameraSettings;
    if (!cs?.position || !cs.target || cs.position.length < 3 || cs.target.length < 3) return null;
    return {
      position: [cs.position[0], cs.position[1], cs.position[2]],
      target: [cs.target[0], cs.target[1], cs.target[2]],
      fov: cs.fov ?? 54
    };
  }

  setMaterial(material: THREE.Material): void {
    this.material = material;
    if (this.skinned) this.skinned.mesh.material = material;
  }

  dispose(): void {
    this.disposed = true; ++this.bodyGeneration; this.sourceFitAbort?.abort(); this.sourceFitAbort = null;
    this.skinned?.dispose();
  }
}
