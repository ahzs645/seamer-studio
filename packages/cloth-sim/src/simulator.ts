// Orchestrates the cloth simulation. prepare() does all GPU-free work (triangulate + arrange +
// assemble sim data + body mesh packing) so the avatar and arranged panels render even without
// WebGPU; the live XPBD drape (ClothSimulation) is created on demand once a GPU device is available.

import type { Pattern } from '@seamer/pattern-model';
import {
  indexPoints,
  pieceTransform
} from '@seamer/pattern-model/utils/patternGeometry';
import type { CylinderFrame } from './geometry/cylinders';
import { buildPieceCloth, buildSavedCloth, reuseSavedDrape, reuseSavedSurface, computeSeamEdgeIntervals } from './geometry/boundary';
import { arrangeParticles } from './geometry/arrangement';
import { buildSimData, type SimData, type ArrangedPiece } from './build';
import { ClothEngine, type BodyMesh } from './webgpu/engine';
import { SIM_CONFIG } from './config';
import { kabschRigid, applyRigid } from './refit';

export interface PreparedCloth {
  simData: SimData;
  body: BodyMesh;
}

/**
 * Use the source-parity cylinder arrangement for a first live drape while leaving the prepared
 * saved-drape positions available to the static renderer. Saved positions are a display/reuse seed
 * sampled onto rebuilt topology; they need not satisfy that topology's XPBD rest lengths. The
 * arrangement is built from the same topology and is therefore the stable live-solver seed.
 */
export function fromArrangement(prepared: PreparedCloth): PreparedCloth {
  const positions = prepared.simData.arrangedPositions.slice();
  const anchors = new Float32Array(positions.length);
  for (let index = 0; index < positions.length; index += 4) {
    anchors[index] = positions[index];
    anchors[index + 1] = positions[index + 1];
    anchors[index + 2] = positions[index + 2];
    // A first drape is free-running, exactly like prepareCloth({ fromArrangement: true }).
    anchors[index + 3] = 0;
  }
  return {
    body: prepared.body,
    simData: {
      ...prepared.simData,
      positions,
      anchors
    }
  };
}

/** Pack the avatar mesh into the engine's vec4 layout (positions x,y,z,0; triangles i0,i1,i2,0).
 *  The body broad-phase itself (a triangle spatial hash) is built on the GPU, like the original. */
export function packBodyMesh(vertexPositions: Float32Array, indices: Uint32Array): BodyMesh {
  const numVerts = vertexPositions.length / 3;
  const numTris = indices.length / 3;
  const positions = new Float32Array(numVerts * 4);
  for (let i = 0; i < numVerts; i++) {
    positions[i * 4] = vertexPositions[i * 3];
    positions[i * 4 + 1] = vertexPositions[i * 3 + 1];
    positions[i * 4 + 2] = vertexPositions[i * 3 + 2];
  }
  const triangles = new Uint32Array(numTris * 4);
  for (let t = 0; t < numTris; t++) {
    triangles[t * 4] = indices[t * 3];
    triangles[t * 4 + 1] = indices[t * 3 + 1];
    triangles[t * 4 + 2] = indices[t * 3 + 2];
  }
  return { positions, triangles, numTriangles: numTris };
}

export interface PrepareInit {
  pattern: Pattern;
  avatarVertices: Float32Array; // posed, meters
  avatarIndices: Uint32Array;
  cylinders: Map<string, CylinderFrame>;
}


/** GPU-free: triangulate + arrange every dynamic piece, assemble sim data + body collision grid.
 *  Topology always comes from the live pattern (so explicit seams attach via edgeParticles) and a
 *  cached drape only seeds particle positions, like the source. `fromArrangement` forces the
 *  source's literal first-drape pipeline: ignore the cached drape and seed from the cylinder
 *  arrangement, so the solver drapes live. `changedPieces` is kept for API compatibility (edits
 *  now flow through the same reuse path as unedited pieces). */
export function prepareCloth(
  init: PrepareInit,
  opts: { fromArrangement?: boolean; changedPieces?: Set<string> } = {}
): PreparedCloth | null {
  const { pattern, cylinders } = init;
  const arranged: ArrangedPiece[] = [];
  const points = indexPoints(pattern);
  // Seam-matched sub-segmentation: both sides of every seam resample to equal interval counts so
  // the sim links particles 1:1 (the original's boundary slicing at seam-range boundaries).
  const edgeIntervals = computeSeamEdgeIntervals(pattern);
  for (const piece of pattern.pieces) {
    if (piece.type !== 'dynamic' || piece.settings3d.enable3d === false) continue;

    // Production pipeline: topology ALWAYS comes from the live pattern (buildPieceCloth, whose
    // per-PiecePath edgeParticles let explicit seams attach), and a cached drape only seeds particle
    // POSITIONS via the source's 3-way reuse below. Building topology from the saved blob instead
    // (buildSavedCloth) leaves edgeParticles empty — seams can't link such pieces, and a free-running
    // garment falls apart (it only held together via the anchor hold + proximity sewing).
    const pdOverride = pattern.settings3d.globalParticleDistanceOverride;
    const cloth = buildPieceCloth(pattern, piece, pdOverride && pdOverride > 0 ? pdOverride : undefined, edgeIntervals);
    if (!cloth || cloth.mesh.points.length < 3) {
      // Fallback for degenerate 2D path data: rebuild from the saved blob (no edgeParticles —
      // the proximity-sewing pass covers these).
      const savedCloth = opts.fromArrangement ? null : buildSavedCloth(piece);
      if (savedCloth) {
        const arranged3d = arrangeParticles(savedCloth.cloth.mesh.points, piece.settings3d.arrangement, cylinders.get(piece.settings3d.arrangement.cylinderName) ?? null, {
          flipNormals: piece.settings3d.flipNormals
        });
        arranged.push({ cloth: savedCloth.cloth, positions3d: savedCloth.positions3d, frozen: piece.settings3d.frozen, fromSaved: true, boundaryLocal: savedCloth.boundaryParticles, arranged3d });
      }
      continue;
    }
    const arranged3d = arrangeParticles(cloth.mesh.points, piece.settings3d.arrangement, cylinders.get(piece.settings3d.arrangement.cylinderName) ?? null, {
      flipNormals: piece.settings3d.flipNormals
    });

    // Current Seamer caches key by placed-plan coordinates. SeamScape v0.0.1 instead stored a
    // piece-local indexed 2D surface and restored onto newly-triangulated topology by barycentric
    // projection. Keep those paths separate: treating the legacy surface as nearest-neighbour data
    // is what caused torn/bridged panels in converted projects.
    const toPlan = pieceTransform(piece, points);
    const reusePoints = cloth.mesh.points.map(toPlan);
    let reuse: { positions3d: Float32Array } | null = null;
    if (!opts.fromArrangement && piece.settings3d.savedMeshSnapshot?.coordinateSpace === 'piece-local') {
      const radians = -((piece.rotation ?? 0) * Math.PI) / 180;
      const cos = Math.cos(radians), sin = Math.sin(radians);
      const originX = piece.position?.x ?? 0, originY = piece.position?.y ?? 0;
      const localPoints = reusePoints.map((point) => {
        const dx = point.x - originX, dy = point.y - originY;
        let x = dx * cos - dy * sin;
        let y = dx * sin + dy * cos;
        if (piece.mirrorX) x = -x;
        if (piece.mirrorY) y = -y;
        return { x, y };
      });
      const surface = reuseSavedSurface(localPoints, piece.settings3d.savedPositions, piece.settings3d.savedMeshSnapshot);
      if (surface && surface.safeCoverage >= 0.5) reuse = surface;
    } else if (!opts.fromArrangement) {
      reuse = reuseSavedDrape(reusePoints, piece.settings3d.savedPositions, cloth.particleDistanceMm)
        // Compatibility with drapes saved by earlier studio builds, which wrote drafting coordinates.
        ?? reuseSavedDrape(cloth.mesh.points, piece.settings3d.savedPositions, cloth.particleDistanceMm);
    }
    if (reuse) {
      arranged.push({
        cloth,
        positions3d: reuse.positions3d,
        arranged3d,
        frozen: piece.settings3d.frozen,
        fromSaved: true,
        boundaryLocal: cloth.mesh.boundary
      });
      continue;
    }

    // Never-draped (or the edit changed the shape too much to reuse / fromArrangement): seed from the
    // cylinder arrangement and simulate.
    arranged.push({ cloth, positions3d: arranged3d, frozen: piece.settings3d.frozen, fromSaved: false });
  }
  if (arranged.length === 0) return null;
  // Saved-drape cloths carry no edgeParticles (boundary.ts builds them with an empty map), so
  // explicit seam links can't attach to them — proximity sewing is what keeps those garments
  // connected. Enable it exactly in that case; fresh arrangements keep explicit-seams-only
  // (source parity).
  const proximitySeams = arranged.some((a) => a.cloth.edgeParticles.size === 0);
  const simData = buildSimData(pattern, arranged, { proximitySeams });
  // fixTop (debug): pin each piece's topmost particles in place (invMass 0) while simulating
  if (pattern.settings3d.fixTop) {
    for (const sp of simData.pieces) {
      let maxY = -Infinity;
      for (let i = 0; i < sp.count; i++) maxY = Math.max(maxY, simData.positions[(sp.start + i) * 4 + 1]);
      for (let i = 0; i < sp.count; i++) {
        const g = sp.start + i;
        if (simData.positions[g * 4 + 1] >= maxY - 0.02) {
          simData.positions[g * 4 + 3] = 0;
          simData.arrangedPositions[g * 4 + 3] = 0;
        }
      }
    }
  }
  const body = packBodyMesh(init.avatarVertices, init.avatarIndices);
  return { simData, body };
}

export class ClothSimulation {
  readonly simData: SimData;
  private engine: ClothEngine;
  private latest: Float32Array;

  constructor(device: GPUDevice, prepared: PreparedCloth) {
    this.simData = prepared.simData;
    this.engine = new ClothEngine(device, prepared.simData, prepared.body, SIM_CONFIG);
    this.latest = prepared.simData.positions.slice();
  }

  /** Advance one frame; returns the global vec4 position buffer (x,y,z,invMass per particle). */
  async step(): Promise<Float32Array> {
    const out = await this.engine.step();
    if (out.length === this.latest.length) this.latest = out;
    return this.latest;
  }

  get positions(): Float32Array {
    return this.latest;
  }

  /** 1 = hold the cached drape; 0 = release so it re-drapes (e.g. on a changed body). */
  setAnchorScale(scale: number) {
    this.engine.setAnchorScale(scale);
  }

  /** Toggle self-collision at runtime (off during a body-change re-drape to avoid curling). */
  setSelfCollision(enabled: boolean) {
    this.engine.setSelfCollisionEnabled(enabled);
  }

  /** Re-point the anchor targets at the latest settled positions and softly hold them. Used after a
   *  body-change re-drape so the garment gently holds the NEW clean drape (not a rigid freeze). */
  reanchorToSettled(scale = 0.25) {
    this.engine.setAnchors(this.latest);
    this.engine.setAnchorScale(scale);
  }

  /** Rigidly re-fit the cached drape onto the NEW-body arrangement (per-piece Kabsch), matching the
   *  original's createCloth re-fit of saved positions. Each piece's settled drape is rotated+translated
   *  so it best overlays where that piece now sits on the changed body, preserving the drape's shape;
   *  the solver then settles the non-rigid residual. Re-seeds both positions and anchors to the fit. */
  refitToArrangement(scale = 0.25) {
    const sd = this.simData;
    const out = sd.positions.slice();
    for (const piece of sd.pieces) {
      const n = piece.count;
      if (n < 3) continue;
      const cached = new Float32Array(n * 3); // current drape (old body)
      const arranged = new Float32Array(n * 3); // arrangement on the new body
      for (let i = 0; i < n; i++) {
        const g = piece.start + i;
        cached[i * 3] = sd.positions[g * 4]; cached[i * 3 + 1] = sd.positions[g * 4 + 1]; cached[i * 3 + 2] = sd.positions[g * 4 + 2];
        arranged[i * 3] = sd.arrangedPositions[g * 4]; arranged[i * 3 + 1] = sd.arrangedPositions[g * 4 + 1]; arranged[i * 3 + 2] = sd.arrangedPositions[g * 4 + 2];
      }
      const tr = kabschRigid(cached, arranged, n);
      for (let i = 0; i < n; i++) {
        const g = piece.start + i;
        const [x, y, z] = applyRigid(tr, cached[i * 3], cached[i * 3 + 1], cached[i * 3 + 2]);
        out[g * 4] = x; out[g * 4 + 1] = y; out[g * 4 + 2] = z; // .w (invMass) preserved from slice()
      }
    }
    this.engine.resetPositions(out);
    this.engine.setAnchors(out);
    this.engine.setAnchorScale(scale);
    this.latest = out;
  }

  /** Interactive grab: pull global particle `index` (and same-piece neighbours) toward world `pos`. */
  setGrab(grabbing: boolean, index: number, pos: [number, number, number]) {
    this.engine.setGrab(grabbing, index, pos);
  }

  /** Re-seed to the cached/settled drape. */
  resetToSaved() {
    this.engine.resetPositions(this.simData.positions);
    this.latest = this.simData.positions.slice();
  }

  /** Re-seed to the flat-on-body arrangement (pre-drape). */
  resetToArranged() {
    this.engine.resetPositions(this.simData.arrangedPositions);
    this.latest = this.simData.arrangedPositions.slice();
  }

  /** Re-seed to an arbitrary global stride-4 position array (e.g. a user arrangement). */
  resetTo(positions: Float32Array) {
    this.engine.resetPositions(positions);
    this.latest = positions.slice();
  }

  /** Seed to `positions`, anchor to them, and softly hold (used after a coherent re-fit so the new
   *  positions become the held target without a physics re-settle). */
  seedAndHold(positions: Float32Array, scale = 0.25) {
    this.engine.resetPositions(positions);
    this.engine.setAnchors(positions);
    this.engine.setAnchorScale(scale);
    this.latest = positions.slice();
  }

  rebuildBodyGrid(avatarVertices: Float32Array, avatarIndices: Uint32Array) {
    this.engine.updateBodyMesh(packBodyMesh(avatarVertices, avatarIndices));
  }

  dispose() {
    this.engine.dispose();
  }
}
