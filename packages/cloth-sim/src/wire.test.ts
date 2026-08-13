import { describe, expect, it } from 'vitest';
import type { ConstrainablePath, ConstrainablePoint, Pattern, Piece, WireChannel } from '@seamer/pattern-model';
import { createEmptyPattern } from '@seamer/pattern-model';
import { buildPieceCloth, computeSeamEdgeIntervals } from './geometry/boundary';
import { arrangeParticles } from './geometry/arrangement';
import { buildSimData, type ArrangedPiece, type ColorGroup } from './build';
import { DISABLED_COMPLIANCE, WIRE_AXIAL_COMPLIANCE, wireStiffnessToCompliance } from './config';

const WIRE: WireChannel = { channelWidth: 8, diameter: 1.5, stiffness: 85, linearMass: 4.8, closed: false };

/**
 * Two squares meeting along y = 0, sewn to each other there. The shared edge also carries the wire,
 * which is the arrangement that matters: in a lantern the rib runs along the seam, so the wire has
 * to survive the pass that softens fabric across seams.
 */
function twoSquares(options: { wireOnSeam?: boolean } = {}): Pattern {
  const pattern = createEmptyPattern();
  const points: ConstrainablePoint[] = [];
  const paths: ConstrainablePath[] = [];
  const pieces: Piece[] = [];
  let pointCount = 0;
  const pt = (x: number, y: number) => {
    const id = `P${pointCount++}`;
    points.push({ id, name: id, x, y });
    return id;
  };

  const square = (index: number, y0: number, wireEdge: number | null): Piece => {
    const corners = [pt(0, y0), pt(100, y0), pt(100, y0 + 100), pt(0, y0 + 100)];
    const mainPaths = corners.map((from, edge) => {
      const to = corners[(edge + 1) % 4];
      const pathId = `Path${index}_${edge}`;
      paths.push({
        id: pathId,
        name: pathId,
        pathType: 'line',
        pathPoints: [{ id: from }, { id: to }],
        basePoint: from,
        version: 1
      });
      return {
        id: `PP${index}_${edge}`,
        name: pathId,
        path: pathId,
        from,
        to,
        reversed: false,
        notches: [],
        ...(wireEdge === edge ? { wire: WIRE } : {})
      };
    });
    return {
      id: `Piece${index}`,
      name: `Piece ${index}`,
      type: 'dynamic',
      materialId: pattern.materials[0]?.id ?? 'm',
      origin: { id: `O${index}`, name: '', x: 0, y: 0 },
      originPoint: corners[0],
      position: { x: 0, y: y0 },
      rotation: 0,
      grainVector: { id: `G${index}`, name: '', x: 0, y: 1 },
      text: null,
      rightPieces: 1,
      leftPieces: 0,
      mirrorLeftPiecesAxis: 'X',
      mirrorX: false,
      mirrorY: false,
      seamAllowanceInside: false,
      mainPaths,
      internalPaths: [],
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
    } as Piece;
  };

  // piece 0 sits below the axis, its TOP edge (index 2) is the seam; piece 1 sits above, bottom edge 0
  pieces.push(square(0, -100, options.wireOnSeam === false ? 0 : 2));
  pieces.push(square(1, 0, null));

  pattern.points = points;
  pattern.paths = paths;
  pattern.pieces = pieces;
  pattern.seams = [{
    id: 'Seam0',
    name: 'centre',
    fromPaths: [{ id: 'PP0_2', mirrored: false, reversed: true }],
    toPaths: [{ id: 'PP1_0', mirrored: false, reversed: false }]
  }];
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

/** Compliance lands in a Float32Array, so compare against the rounded value, not the literal. */
const f32 = (v: number) => Math.fround(v);

/** Flatten the colour groups back into (a, b, rest, compliance) rows. */
function constraints(groups: ColorGroup[]) {
  const rows: { a: number; b: number; rest: number; alpha: number }[] = [];
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) {
      rows.push({
        a: group.edges[i * 4],
        b: group.edges[i * 4 + 1],
        rest: group.edges[i * 4 + 2],
        alpha: group.props[i * 4]
      });
    }
  }
  return rows;
}

describe('wire channels', () => {
  it('builds one run per wired edge, following the edge particles in order', () => {
    const sim = build(twoSquares());
    expect(sim.wireRuns).toHaveLength(1);
    const run = sim.wireRuns[0];
    expect(run.piecePathId).toBe('PP0_2');
    expect(run.diameter).toBe(WIRE.diameter);
    expect(run.particles.length).toBeGreaterThan(2);
    expect(new Set(run.particles).size).toBe(run.particles.length);
  });

  it('adds a near-rigid axial constraint between consecutive wire particles', () => {
    const sim = build(twoSquares());
    const run = sim.wireRuns[0];
    const rows = constraints(sim.stretchColors);
    const axial = rows.filter((r) => r.alpha === f32(WIRE_AXIAL_COMPLIANCE));
    expect(axial).toHaveLength(run.particles.length - 1);

    const pairKey = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;
    const found = new Set(axial.map((r) => pairKey(r.a, r.b)));
    for (let i = 1; i < run.particles.length; i++) {
      expect(found.has(pairKey(run.particles[i - 1], run.particles[i]))).toBe(true);
    }
  });

  it('adds a curvature constraint across alternate particles, at the requested stiffness', () => {
    const sim = build(twoSquares());
    const run = sim.wireRuns[0];
    const expected = wireStiffnessToCompliance(WIRE.stiffness);
    const curvature = constraints(sim.stretchColors).filter((r) => r.alpha === f32(expected));
    expect(curvature).toHaveLength(run.particles.length - 2);

    // each spans two segments, so its rest length is longer than a single segment
    const axialRest = constraints(sim.stretchColors)
      .filter((r) => r.alpha === f32(WIRE_AXIAL_COMPLIANCE))
      .map((r) => r.rest);
    const maxAxial = Math.max(...axialRest);
    for (const row of curvature) expect(row.rest).toBeGreaterThan(maxAxial * 0.9);
  });

  it('survives the pass that softens fabric across a seam', () => {
    // This is the whole reason wires are kept out of the fabric edge list: in a lantern the rib runs
    // along the seam, so both its endpoints are seam particles and the softening pass would
    // otherwise set exactly these constraints to DISABLED_COMPLIANCE.
    const sim = build(twoSquares());
    const run = sim.wireRuns[0];
    const seamParticles = new Set(run.particles.filter((p) => sim.seams[p * 4] !== -1));
    expect(seamParticles.size).toBeGreaterThan(0);

    const rows = constraints(sim.stretchColors);
    const softenedAlongWire = rows.filter(
      (r) => seamParticles.has(r.a) && seamParticles.has(r.b) && r.alpha === f32(DISABLED_COMPLIANCE)
    );
    const wireAlongSeam = rows.filter(
      (r) => seamParticles.has(r.a) && seamParticles.has(r.b) && r.alpha === f32(WIRE_AXIAL_COMPLIANCE)
    );
    // the fabric edge is softened AND the wire is not — both statements have to hold
    expect(softenedAlongWire.length).toBeGreaterThan(0);
    expect(wireAlongSeam.length).toBeGreaterThan(0);
  });

  it('hangs the wire mass on its particles without pinning them', () => {
    const withWire = build(twoSquares());
    const withoutWire = build({ ...twoSquares(), pieces: twoSquares().pieces.map((p) => ({
      ...p, mainPaths: p.mainPaths.map((e) => ({ ...e, wire: undefined }))
    })) } as Pattern);

    const run = withWire.wireRuns[0];
    for (const particle of run.particles) {
      const wired = withWire.positions[particle * 4 + 3];
      const bare = withoutWire.positions[particle * 4 + 3];
      expect(wired).toBeGreaterThan(0);       // still free to move
      expect(wired).toBeLessThan(bare);       // but heavier than bare cloth
    }
  });

  it('leaves patterns without wires exactly as they were', () => {
    const bare = twoSquares();
    for (const piece of bare.pieces) piece.mainPaths = piece.mainPaths.map((e) => ({ ...e, wire: undefined }));
    const sim = build(bare);
    expect(sim.wireRuns).toHaveLength(0);
    const alphas = constraints(sim.stretchColors).map((r) => r.alpha);
    expect(alphas.some((a) => a === WIRE_AXIAL_COMPLIANCE)).toBe(false);
  });

  it('closes the loop when the channel is a hoop', () => {
    const pattern = twoSquares();
    const edge = pattern.pieces[0].mainPaths.find((e) => e.wire)!;
    edge.wire = { ...WIRE, closed: true };
    const sim = build(pattern);
    const run = sim.wireRuns[0];
    expect(run.closed).toBe(true);
    const axial = constraints(sim.stretchColors).filter((r) => r.alpha === f32(WIRE_AXIAL_COMPLIANCE));
    // one extra segment closing last back to first
    expect(axial).toHaveLength(run.particles.length);
  });
});
