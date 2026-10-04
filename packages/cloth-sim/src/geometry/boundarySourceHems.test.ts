/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertGarmentCodePattern } from '../../../../src/lib/utils/importGarmentCode';
import type { PieceCloth } from './boundary';
import { buildPieceCloth, computeSeamEdgeIntervals } from './boundary';

// Narrow synthetic arm panels use the real generator's neutral wrist opening
// dimension. Generic panel names deliberately require semantic labels/placement.
function narrowSleeves(cuffed = false) {
  const width = 9.47657060961834;
  const panels: Record<string, unknown> = {};
  const stitches: unknown[] = [];
  for (const [side, sign] of [['Left', 1], ['Right', -1]] as const) {
    for (const [half, z] of [['f', 17.5], ['b', -12.5]] as const) {
      const name = `${side}${half}`;
      panels[name] = { label: 'arm', vertices: [[0, 0], [-sign * 53.9697, 0], [-sign * 53.9697, -width], [0, -width]],
        edges: [0, 1, 2, 3].map(i => ({ endpoints: [i, (i + 1) % 4] })),
        translation: [sign * 60.059318028470074, 107.34945843217531, z], rotation: [0, 0, -sign * 45.483] };
      if (cuffed) {
        const cuff = `sl_${side.toLowerCase()}_cuff_${half}`;
        panels[cuff] = { label: 'arm', vertices: [[0, 0], [-sign * width, 0], [-sign * width, 5.39697], [0, 5.39697]],
          edges: [0, 1, 2, 3].map(i => ({ endpoints: [i, (i + 1) % 4] })),
          translation: [sign * 61.48983977812628, 105.96678776455357, z], rotation: [0, 0, sign * 44.517] };
        stitches.push([{ panel: name, edge: 3 }, { panel: cuff, edge: 2 }]);
      }
    }
    stitches.push([{ panel: `${side}f`, edge: 0 }, { panel: `${side}b`, edge: 0 }]);
    stitches.push([{ panel: `${side}f`, edge: 2 }, { panel: `${side}b`, edge: 2 }]);
  }
  const pattern = convertGarmentCodePattern({ properties: { units_in_meter: 100,
    garmentcode_body: { height: 176, head_l: 26.3262, waist_line: 36.8913, hips_line: 23.4837,
      shoulder_w: 36.4568, shoulder_incl: 21.6777, arm_pose_angle: 45.483 } }, pattern: { panels, stitches } });
  pattern.settings3d.globalParticleDistanceOverride = 40;
  for (const piece of pattern.pieces) piece.settings3d.particleDistance = 40;
  return pattern;
}
function runLength(cloth: PieceCloth, path: string) {
  const run = cloth.edgeParticles.get(path)!;
  let length = 0;
  for (let i = 1; i < run.length; i++) {
    const a = cloth.mesh.points[run[i - 1]], b = cloth.mesh.points[run[i]];
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}
function assertSpacing(cloth: PieceCloth, path: string, maximum = 10) {
  const run = cloth.edgeParticles.get(path)!;
  for (let i = 1; i < run.length; i++) {
    const a = cloth.mesh.points[run[i - 1]], b = cloth.mesh.points[run[i]];
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(maximum + 1e-8);
  }
}

describe('source sleeve opening boundary refinement', () => {
  it('refines four-segment wrist openings without changing cuts, material or source placement', () => {
    const pattern = narrowSleeves(), original = structuredClone(pattern);
    const intervals = computeSeamEdgeIntervals(pattern);
    const totals: Record<string, number> = { Left: 0, Right: 0 };
    for (const piece of pattern.pieces) {
      const cloth = buildPieceCloth(pattern, piece, 40, intervals)!;
      const hem = piece.mainPaths[3].id;
      expect(cloth.edgeParticles.get(hem)).toHaveLength(11);
      assertSpacing(cloth, hem);
      totals[piece.name.startsWith('Left') ? 'Left' : 'Right'] += runLength(cloth, hem);
      expect(cloth.particleDistanceMm).toBe(40);
      expect(cloth.mesh.boundary.every(i => i >= 0)).toBe(true);
    }
    expect(totals.Left).toBeCloseTo(189.5314121923668, 7);
    expect(totals.Right).toBeCloseTo(totals.Left, 8);
    expect(pattern).toEqual(original);
  });

  it('propagates sleeve refinement to paired cuff attachments while retaining directed seam records', () => {
    const pattern = narrowSleeves(true), original = structuredClone(pattern);
    const intervals = computeSeamEdgeIntervals(pattern);
    const cloth = new Map(pattern.pieces.map(piece => [piece.id, buildPieceCloth(pattern, piece, 40, intervals)!]));
    for (const seam of pattern.seams) {
      const runs = [...seam.fromPaths, ...seam.toPaths].map(ref => {
        const owner = pattern.pieces.find(piece => piece.mainPaths.some(path => path.id === ref.id))!;
        return cloth.get(owner.id)!.edgeParticles.get(ref.id)!;
      });
      expect(runs[0].length).toBe(runs[1].length);
      if (pattern.pieces.some(piece => piece.name.includes('_cuff_') && piece.mainPaths.some(path => path.id === seam.toPaths[0].id))) {
        expect(runs[0]).toHaveLength(11);
      }
    }
    for (const piece of pattern.pieces.filter(p => p.name.includes('_cuff_'))) {
      assertSpacing(cloth.get(piece.id)!, piece.mainPaths[0].id);
      expect(cloth.get(piece.id)!.edgeParticles.get(piece.mainPaths[0].id)).toHaveLength(11);
    }
    expect(pattern).toEqual(original);
  });

  it('leaves native arm labels and similarly named panels at their original density', () => {
    const pattern = narrowSleeves(); delete pattern.garmentCodeSource;
    const intervals = computeSeamEdgeIntervals(pattern);
    for (const piece of pattern.pieces) {
      expect(intervals.has(piece.mainPaths[3].id)).toBe(false);
      const cloth = buildPieceCloth(pattern, piece, 40, intervals)!;
      expect(cloth.edgeParticles.get(piece.mainPaths[3].id)).toHaveLength(3);
    }
  });

  it('honors finer requested global density', () => {
    const pattern = narrowSleeves(); pattern.settings3d.globalParticleDistanceOverride = 5;
    const intervals = computeSeamEdgeIntervals(pattern);
    for (const piece of pattern.pieces) {
      const cloth = buildPieceCloth(pattern, piece, 5, intervals)!;
      assertSpacing(cloth, piece.mainPaths[3].id, 5);
      expect(cloth.edgeParticles.get(piece.mainPaths[3].id)).toHaveLength(20);
    }
  });

  it('keeps composite hem seams matched when a short path needs its own interval', () => {
    const pattern = narrowSleeves();
    for (const piece of pattern.pieces.filter(p => p.name.endsWith('b'))) {
      const path = piece.mainPaths[3], from = pattern.points.find(p => p.id === path.from)!, to = pattern.points.find(p => p.id === path.to)!;
      from.y = to.y - 5;
    }
    const refs = (side: string) => pattern.pieces.filter(p => p.name.startsWith(side))
      .map(p => ({ id: p.mainPaths[3].id, mirrored: false, reversed: false }));
    const seam = { id: 'compositeHem', name: 'Composite hem', fromPaths: refs('Left'), toPaths: refs('Right') };
    pattern.seams.push(seam);
    const intervals = computeSeamEdgeIntervals(pattern);
    const counts = [seam.fromPaths, seam.toPaths].map(side => side.reduce((sum, ref) => sum + intervals.get(ref.id)!, 0));
    expect(counts).toEqual([11, 11]);
    for (const piece of pattern.pieces) {
      const cloth = buildPieceCloth(pattern, piece, 40, intervals)!;
      assertSpacing(cloth, piece.mainPaths[3].id);
    }
  });

  it('recognizes published source component names without body metadata or panel labels', () => {
    const value = JSON.parse(readFileSync(new URL('../../../../static/examples/garmentcode/shirt_mean_specification.json', import.meta.url), 'utf8'));
    const pattern = convertGarmentCodePattern(value);
    for (const piece of pattern.pieces) piece.settings3d.particleDistance = 40;
    const intervals = computeSeamEdgeIntervals(pattern);
    for (const piece of pattern.pieces.filter(p => p.name.includes('_sleeve_'))) {
      const hem = piece.mainPaths[piece.name.endsWith('_f') ? (piece.name.startsWith('left') ? 3 : 0) : (piece.name.startsWith('left') ? 0 : 5)].id;
      const cloth = buildPieceCloth(pattern, piece, 40, intervals)!;
      expect(cloth.edgeParticles.get(hem)!.length).toBeGreaterThan(20);
      assertSpacing(cloth, hem);
    }
  });
});
