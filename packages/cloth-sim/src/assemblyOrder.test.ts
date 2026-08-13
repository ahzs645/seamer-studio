import { describe, expect, it } from 'vitest';
import type { ConstrainablePath, ConstrainablePoint, Pattern, Piece } from '@seamer/pattern-model';
import { createEmptyPattern } from '@seamer/pattern-model';
import { buildPieceCloth, computeSeamEdgeIntervals } from './geometry/boundary';
import { arrangeParticles } from './geometry/arrangement';
import { buildSimData, type ArrangedPiece } from './build';

/** A stack of `count` squares, each sewn to the one below it. Seam k joins square k to square k+1. */
function stack(count: number): Pattern {
  const pattern = createEmptyPattern();
  const points: ConstrainablePoint[] = [];
  const paths: ConstrainablePath[] = [];
  const pieces: Piece[] = [];
  let n = 0;
  const pt = (x: number, y: number) => {
    const id = `P${n++}`;
    points.push({ id, name: id, x, y });
    return id;
  };

  for (let i = 0; i < count; i++) {
    const y0 = i * 100;
    const corners = [pt(0, y0), pt(100, y0), pt(100, y0 + 100), pt(0, y0 + 100)];
    const mainPaths = corners.map((from, edge) => {
      const to = corners[(edge + 1) % 4];
      const pathId = `Path${i}_${edge}`;
      paths.push({ id: pathId, name: pathId, pathType: 'line', pathPoints: [{ id: from }, { id: to }], basePoint: from, version: 1 });
      return { id: `PP${i}_${edge}`, name: pathId, path: pathId, from, to, reversed: false, notches: [] };
    });
    pieces.push({
      id: `Piece${i}`, name: `Piece ${i}`, type: 'dynamic', materialId: pattern.materials[0]?.id ?? 'm',
      origin: { id: `O${i}`, name: '', x: 0, y: 0 }, originPoint: corners[0],
      position: { x: 0, y: y0 }, rotation: 0, grainVector: { id: `G${i}`, name: '', x: 0, y: 1 },
      text: null, rightPieces: 1, leftPieces: 0, mirrorLeftPiecesAxis: 'X',
      mirrorX: false, mirrorY: false, seamAllowanceInside: false, mainPaths, internalPaths: [],
      settings3d: {
        arrangement: {
          mode: 'flat', cylinderName: '', uDegrees: 0, v: 0.5, uOffsetMm: 0, vOffsetMm: 0,
          radialOffsetMm: 0, use2DPosition: true, positionChanged: false,
          matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], position: [0, 0, 0]
        },
        enable3d: true, frozen: false, flipNormals: false,
        filterExternalCollisionsByClothNormal: false, collisionLayer: 0,
        particleDistance: 10, savedPositions: []
      }
    } as Piece);
  }

  pattern.points = points;
  pattern.paths = paths;
  pattern.pieces = pieces;
  pattern.seams = Array.from({ length: count - 1 }, (_, i) => ({
    id: `Seam${i}`,
    name: `join ${i}`,
    fromPaths: [{ id: `PP${i}_2`, mirrored: false, reversed: true }],
    toPaths: [{ id: `PP${i + 1}_0`, mirrored: false, reversed: false }]
  }));
  return pattern;
}

function build(pattern: Pattern) {
  const intervals = computeSeamEdgeIntervals(pattern);
  const arranged: ArrangedPiece[] = pattern.pieces.map((piece) => {
    const cloth = buildPieceCloth(pattern, piece, undefined, intervals)!;
    return {
      cloth,
      positions3d: arrangeParticles(cloth.mesh.points, piece.settings3d.arrangement, null, {}),
      frozen: false,
      fromSaved: false
    };
  });
  return buildSimData(pattern, arranged);
}

const rangeIds = (sim: ReturnType<typeof build>) => sim.seamStitchRanges.map((r) => r.seamId);

describe('stitch ordering', () => {
  it('falls back to pattern.seams order when no assembly is defined', () => {
    const sim = build(stack(4));
    expect(rangeIds(sim)).toEqual(['Seam0', 'Seam1', 'Seam2']);
    expect(sim.assemblySteps).toHaveLength(1);
    expect(sim.assemblySteps[0].start).toBe(0);
    expect(sim.assemblySteps[0].end).toBe(sim.stitchCount);
  });

  it('follows the assembly rather than the seam array', () => {
    const pattern = stack(4);
    pattern.assembly = {
      steps: [
        { id: 'last', label: 'Last first', seamIds: ['Seam2'] },
        { id: 'first', label: 'Then the first', seamIds: ['Seam0'] }
        // Seam1 deliberately unnamed
      ]
    };
    const sim = build(pattern);
    expect(rangeIds(sim)).toEqual(['Seam2', 'Seam0', 'Seam1']);
    expect(sim.assemblySteps.map((s) => s.id)).toEqual(['last', 'first', 'assembly-remaining']);

    // ranges tile the whole stitch range with no gaps or overlaps
    let cursor = 0;
    for (const range of sim.seamStitchRanges) {
      expect(range.start).toBe(cursor);
      expect(range.end).toBeGreaterThan(range.start);
      cursor = range.end;
    }
    expect(cursor).toBe(sim.stitchCount);
  });

  it('gives every link of a seam a stitch index inside that seam"s range', () => {
    const pattern = stack(3);
    pattern.assembly = { steps: [{ id: 's', label: 'Second', seamIds: ['Seam1'] }] };
    const sim = build(pattern);
    const range = sim.seamStitchRanges.find((r) => r.seamId === 'Seam1')!;
    const pairs = sim.seamPairsBySeam.find((s) => s.seamId === 'Seam1')!.pairs;

    for (let k = 0; k + 1 < pairs.length; k += 2) {
      const [a, b] = [pairs[k], pairs[k + 1]];
      let slot = -1;
      for (let j = 0; j < 4; j++) if (sim.seams[a * 4 + j] === b) slot = j;
      expect(slot).toBeGreaterThanOrEqual(0);
      const order = sim.seamOrder[a * 4 + slot];
      expect(order).toBeGreaterThanOrEqual(range.start);
      expect(order).toBeLessThan(range.end);
    }
  });

  it('stamps both directions of every link', () => {
    const sim = build(stack(3));
    for (let p = 0; p < sim.particleCount; p++) {
      for (let j = 0; j < 4; j++) {
        const partner = sim.seams[p * 4 + j];
        if (partner < 0) continue;
        const forward = sim.seamOrder[p * 4 + j];
        let back = -2;
        for (let k = 0; k < 4; k++) if (sim.seams[partner * 4 + k] === p) back = sim.seamOrder[partner * 4 + k];
        expect(back).toBe(forward);
      }
    }
  });

  it('leaves an unsewn pattern with a zero-length timeline', () => {
    const pattern = stack(2);
    pattern.seams = [];
    const sim = build(pattern);
    expect(sim.stitchCount).toBe(0);
    expect(sim.assemblySteps).toEqual([]);
    // nothing is gated, so the ungated default cannot change behaviour
    expect([...sim.seamOrder].every((v) => v === -1)).toBe(true);
  });
});
