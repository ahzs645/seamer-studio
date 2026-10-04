import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { SimData } from './build';
import type { CollisionSeamActivation } from './collisionGuard';

const engineRecords = vi.hoisted(() => [] as { mask: CollisionSeamActivation | null; writes: number; structural: boolean }[]);
vi.mock('./collisionGuardWorker', () => ({ CollisionGuardWorker: class { readonly ready = Promise.resolve(); dispose() {} } }));
vi.mock('./webgpu/engine', () => ({ ClothEngine: class {
  private readonly record = { mask: null as CollisionSeamActivation | null, writes: 0, structural: false };
  readonly collisionTrajectoryPositions = [];
  constructor() { engineRecords.push(this.record); }
  enableCollisionTrajectoryReadback() {}
  resetPositions() {}
  setSeamActivation(activation: CollisionSeamActivation) {
    this.record.mask = { ...activation, activeSeams: activation.activeSeams.slice() }; this.record.writes++;
  }
  setSourceStructuralStagingEnabled(value: boolean) { this.record.structural = value; this.record.writes++; }
  dispose() {}
} }));

import { ClothSimulation, packBodyMesh, type PreparedCloth } from './simulator';
import { sourceAssemblyTopologyIdentity } from './sourceAssemblyTopology';
import { finalizeSourceGatherCollisionGeometry } from './finalizeSourceGatherGeometry';

function actualPrepared(): PreparedCloth {
  // Genuine source-derived, collision-clear initial assembly geometry, never fit evidence.
  // Verify the immutable uncompressed bytes before constructing actual typed geometry.
  const bytes = gunzipSync(readFileSync(new URL('./__fixtures__/cpu-source-gather-skirt.json.gz', import.meta.url)));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('d1ee9369922638d29b3df4d68f170d11f8d3d3f77890cf1e3b2490cfefc65b52');
  const f = JSON.parse(bytes.toString('utf8'));
  return { body: packBodyMesh(Float32Array.from(f.bodyPositions), Uint32Array.from(f.bodyIndices)), collisionSafety: true,
    simData: { positions: Float32Array.from(f.clothPositions), arrangedPositions: Float32Array.from(f.clothPositions),
      anchors: new Float32Array(f.clothPositions.length), particleCount: f.particleCount,
      triangles: Uint32Array.from(f.clothTriangles), seams: Int32Array.from(f.seams), seamOrder: Int32Array.from(f.seamOrder),
      seamPairsBySeam: f.seamPairs, stitchCount: f.stitchCount, sourceStaging: f.sourceStaging,
      sourceGatherRefinement: f.sourceGatherRefinement,
      sourceGatherCollisionGeometry: { ...f.sourceGatherCollisionGeometry,
        sourceMaterialCoordinates: Float32Array.from(f.sourceGatherCollisionGeometry.sourceMaterialCoordinates) }
    } as unknown as SimData };
}

describe('actual refined assembly snapshot restore identity', () => {
  it('keeps the legacy topology identity byte identical', () => {
    const prepared = actualPrepared(), dictionary = { seams: [2, 4], stamp: 3 };
    const data = { triangles: prepared.simData.triangles };
    expect(sourceAssemblyTopologyIdentity(data, dictionary)).toBe(JSON.stringify({ triangles: Array.from(data.triangles), dictionary }));
  });

  it('rejects partial refinement before creating an engine or changing a support gate', () => {
    for (const missing of ['policy', 'material-coordinates']) {
      const prepared = actualPrepared(), engineCount = engineRecords.length;
      if (missing === 'policy') prepared.simData.sourceGatherRefinement = undefined;
      else prepared.simData.sourceGatherCollisionGeometry!.sourceMaterialCoordinates = undefined;
      expect(() => new ClothSimulation({} as GPUDevice, prepared)).toThrow('finalized policy and actual child material geometry');
      expect(engineRecords.length).toBe(engineCount);
    }
  });

  it('accepts exact same finalized actual data and preserves canonical policy equivalence', () => {
    const prepared = actualPrepared(), sim = new ClothSimulation({} as GPUDevice, prepared);
    expect(sim.safetyReport?.safe).toBe(true);
    const snapshot = sim.captureSourceAssembly();
    expect(snapshot).not.toBeNull();
    const other = actualPrepared();
    other.simData.sourceGatherRefinement = Object.fromEntries(Object.entries(other.simData.sourceGatherRefinement!).reverse()) as SimData['sourceGatherRefinement'];
    const current = new ClothSimulation({} as GPUDevice, other);
    expect(() => current.restoreSourceAssembly(snapshot)).not.toThrow();
    expect(current.captureSourceAssembly()).toEqual(snapshot);
    sim.dispose(); current.dispose();
  });

  for (const variant of ['numerical-policy', 'actual-material-path'] as const) {
    it('rejects same IDs/stitches with another valid ' + variant + ' before controller/engine/support-gate mutation', async () => {
      const prepared = actualPrepared(), sim = new ClothSimulation({} as GPUDevice, prepared), snapshot = sim.captureSourceAssembly();
      const changed = actualPrepared();
      if (variant === 'numerical-policy') {
        changed.simData.sourceGatherRefinement!.approvedEvidence.sourceIdentitySha256 = 'f'.repeat(64);
        delete changed.simData.sourceGatherCollisionGeometry!.refinementPolicySha256;
        changed.simData = await finalizeSourceGatherCollisionGeometry(changed.simData);
      } else {
        const coordinates = changed.simData.sourceGatherCollisionGeometry!.sourceMaterialCoordinates!;
        // A new material origin for every source piece preserves ownership, all actual child
        // incidence, midpoint derivation and world geometry. It is a different immutable map.
        for (let index = 0; index < coordinates.length; index += 4) coordinates[index] += .01;
      }
      expect(changed.simData.triangles).toEqual(prepared.simData.triangles);
      expect(changed.simData.seams).toEqual(prepared.simData.seams);
      const current = new ClothSimulation({} as GPUDevice, changed);
      expect(current.safetyReport?.safe, 'this tests stale restoration, not a physically invalid initial mesh').toBe(true);
      const before = current.captureSourceAssembly(), record = engineRecords.at(-1)!;
      const gate = structuredClone(record);
      expect(() => current.restoreSourceAssembly(snapshot)).toThrow('snapshot topology changed');
      expect(current.captureSourceAssembly()).toEqual(before);
      expect(record).toEqual(gate);
      sim.dispose(); current.dispose();
    });
  }
});
