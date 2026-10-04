import { describe, expect, it } from 'vitest';
import type { Pattern } from '@seamer/pattern-model';
import { indexPoints, pieceTransform } from '@seamer/pattern-model/utils/patternGeometry';
import { convertGarmentCodePattern } from './importGarmentCode';
import { patternToSSP, sspToPattern } from './ssp';
import { prepareCloth, type PreparedCloth } from '@seamer/cloth-sim';

const source = {
  properties: { units_in_meter: 100 },
  pattern: { panels: { front: { vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], edges: [
    { endpoints: [0, 1] }, { endpoints: [1, 2] }, { endpoints: [2, 3] }, { endpoints: [3, 0] }
  ], translation: [0, 100, 20], rotation: [0, 0, 0] } }, stitches: [] }
};

function prepare(pattern: Pattern): PreparedCloth {
  const result = prepareCloth({ pattern, avatarVertices: new Float32Array(0), avatarIndices: new Uint32Array(0), cylinders: new Map() });
  if (!result) throw new Error('Fixture must prepare a cloth mesh');
  return result;
}

function capture(pattern: Pattern, prepared: PreparedCloth) {
  const points = indexPoints(pattern);
  for (const simPiece of prepared.simData.pieces) {
    const piece = pattern.pieces.find(piece => piece.id === simPiece.pieceId)!;
    const toPlan = pieceTransform(piece, points);
    piece.settings3d.savedPositions = [];
    for (let i = 0; i < simPiece.count; i++) {
      const global = simPiece.start + i;
      const xy = toPlan({ x: prepared.simData.positions2d[global * 4] * 1000, y: prepared.simData.positions2d[global * 4 + 1] * 1000 });
      piece.settings3d.savedPositions.push(xy.x, xy.y, ...prepared.simData.positions.slice(global * 4, global * 4 + 3));
    }
  }
}
function weights(prepared: PreparedCloth) {
  return Array.from(prepared.simData.anchors).filter((_, index) => index % 4 === 3);
}

describe('saved cloth geometry is distinct from a held anchor target', () => {
  it('GarmentCode import → native archive → reload preserves source geometry and stays free to sew', async () => {
    const pattern = convertGarmentCodePattern(source);
    pattern.settings3d.globalParticleDistanceOverride = 30;
    const initial = prepare(pattern);
    capture(pattern, initial); // An SSP snapshot/export before Start captures an unassembled arrangement.
    const restored = await sspToPattern(await patternToSSP(pattern));
    expect(restored.pieces[0].settings3d.savedPositions).toEqual(pattern.pieces[0].settings3d.savedPositions);
    const resumed = prepare(restored);
    expect(resumed.simData.positions).toEqual(initial.simData.positions);
    expect(weights(resumed)).toEqual(Array(resumed.simData.particleCount).fill(0));
    expect(Array.from(resumed.simData.positions).filter((_, index) => index % 4 === 3).every(weight => weight > 0)).toBe(true);
  });

  it('explicit in-progress checkpoints remain free after manual source-placement changes', async () => {
    const pattern = convertGarmentCodePattern(source);
    const checkpoint = prepare(pattern);
    // A visibly changed in-progress garment must resume exactly there, without new hold forces.
    for (let index = 0; index < checkpoint.simData.positions.length; index += 4) checkpoint.simData.positions[index + 1] -= .025;
    capture(pattern, checkpoint);
    pattern.pieces[0].settings3d.savedDrapeState = 'checkpoint';
    pattern.pieces[0].settings3d.arrangement.sourcePlacement = undefined;
    const restored = await sspToPattern(await patternToSSP(pattern));
    expect(restored.pieces[0].settings3d.savedDrapeState).toBe('checkpoint');
    const resumed = prepare(restored);
    expect(resumed.simData.positions).toEqual(checkpoint.simData.positions);
    expect(weights(resumed).every(weight => weight === 0)).toBe(true);
  });

  it('legacy native caches retain their hold, and explicitly held caches can hold', () => {
    const native = convertGarmentCodePattern(source);
    const saved = prepare(native);
    capture(native, saved);
    native.pieces[0].settings3d.arrangement.sourcePlacement = undefined;
    // A legacy native cache predates imported-source provenance and checkpoint metadata.
    delete native.pieces[0].settings3d.savedDrapeState;
    delete native.garmentCodeSource;
    expect(weights(prepare(native)).every(weight => weight === 1)).toBe(true);
    native.pieces[0].settings3d.arrangement.sourcePlacement = patternSourcePlacement();
    native.pieces[0].settings3d.savedDrapeState = 'held';
    expect(weights(prepare(native)).every(weight => weight === 1)).toBe(true);
  });
});

function patternSourcePlacement() {
  return convertGarmentCodePattern(source).pieces[0].settings3d.arrangement.sourcePlacement;
}
