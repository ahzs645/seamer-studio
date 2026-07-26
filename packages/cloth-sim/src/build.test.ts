// Pure-data tests for buildSimData: bend props buffer layout, seam-disabled bend constraints,
// and index-paired seam linking (production parity). No WebGPU.

import { describe, it, expect } from 'vitest';
import { buildSimData, type ArrangedPiece } from './build';
import {
  stretchScaleToCompliance,
  bendScaleToCompliance,
  clampStretchAlpha,
  clampBendAlpha,
  DISABLED_COMPLIANCE
} from './config';
import { createEmptyPattern, type Pattern, type Piece, type Material, type Seam } from '@seamer/pattern-model';
import type { PieceCloth } from './geometry/boundary';

// ---------------------------------------------------------------------------------------------
// Fixtures

const MAT_ID = 'mat1';
const WARP = 20;
const WEFT = 40;
const BEND = 30;

function makeMaterial(): Material {
  return {
    id: MAT_ID,
    name: 'Test',
    stretchWarpValue: WARP,
    stretchWeftValue: WEFT,
    bendValue: BEND,
    weight: 120
  } as Material;
}

function makePiece(id: string, mainPathIds: string[]): Piece {
  return {
    id,
    name: id,
    type: 'dynamic',
    materialId: MAT_ID,
    grainVector: { x: 0, y: 1 },
    leftPieces: 0,
    rightPieces: 1,
    mainPaths: mainPathIds.map((ppId) => ({
      id: ppId,
      name: '',
      path: 'p',
      from: 'a',
      to: 'b',
      reversed: false,
      notches: [],
      libraryUpdatedAt: null
    })),
    internalPaths: [],
    settings3d: {
      arrangement: null,
      enable3d: true,
      frozen: false,
      flipNormals: false,
      filterExternalCollisionsByClothNormal: false,
      collisionLayer: 0,
      savedPositions: []
    }
  } as unknown as Piece;
}

/** Unit-square quad (10mm), 4 particles, two triangles sharing the 0-2 diagonal: exactly one bend
 *  constraint with opposite pair (1,3) and hinge pair (0,2). `chainKey` registers an ordered
 *  boundary chain [0,1,2] for seam tests. */
function quadCloth(pieceId: string, chainKey?: string): PieceCloth {
  const edgeParticles = new Map<string, number[]>();
  if (chainKey) edgeParticles.set(chainKey, [0, 1, 2]);
  return {
    pieceId,
    materialId: MAT_ID,
    mesh: {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 }
      ],
      triangles: [0, 1, 2, 0, 2, 3],
      edges: [
        [0, 1],
        [1, 2],
        [0, 2],
        [2, 3],
        [0, 3]
      ],
      boundary: [0, 1, 2, 3],
      numBoundary: 4,
      internal: []
    },
    edgeParticles,
    particleDistanceMm: 10
  };
}

function arrangedQuad(cloth: PieceCloth, positions3d: number[], extra: Partial<ArrangedPiece> = {}): ArrangedPiece {
  return { cloth, positions3d: Float32Array.from(positions3d), frozen: false, fromSaved: false, ...extra };
}

function patternWith(pieces: Piece[], seams: Seam[] = []): Pattern {
  const pattern = createEmptyPattern();
  pattern.materials = [makeMaterial()];
  pattern.pieces = pieces;
  pattern.seams = seams;
  return pattern;
}

const QUAD_POS_A = [0, 0, 0, 0.01, 0, 0, 0.01, 0.01, 0, 0, 0.01, 0]; // meters, flat in z=0
// Piece B placed so its chain particles [0,1,2] are coincident with A's chain [0,1,2].
const QUAD_POS_B_FORWARD = QUAD_POS_A.slice();
// Piece B placed so its chain runs OPPOSITE A's: B0 ~ A2, B1 ~ A1, B2 ~ A0.
const QUAD_POS_B_REVERSED = [0.01, 0.01, 0, 0.01, 0, 0, 0, 0, 0, 0, 0.01, 0];

function seamOf(fromId: string, toId: string, opts: { fromRev?: boolean; toRev?: boolean } = {}): Seam {
  return {
    id: 'seam1',
    name: 'Seam',
    fromPaths: [{ id: fromId, mirrored: false, reversed: opts.fromRev ?? false }],
    toPaths: [{ id: toId, mirrored: false, reversed: opts.toRev ?? false }]
  };
}

/** Flatten all bend color-group props into [edges, props] tuples per constraint. */
function bendConstraints(sim: ReturnType<typeof buildSimData>) {
  const out: { edge: number[]; props: number[] }[] = [];
  for (const g of sim.bendColors) {
    for (let i = 0; i < g.count; i++) {
      out.push({
        edge: Array.from(g.edges.slice(i * 4, i * 4 + 4)),
        props: Array.from(g.props.slice(i * 4, i * 4 + 4))
      });
    }
  }
  return out;
}

function seamPartners(sim: ReturnType<typeof buildSimData>, particle: number): number[] {
  return Array.from(sim.seams.slice(particle * 4, particle * 4 + 4)).filter((v) => v !== -1);
}

// ---------------------------------------------------------------------------------------------

describe('bend props buffer', () => {
  it('stores the bend alpha in slot 1 and the material STRETCH alpha in slot 2 (beyond-rest)', () => {
    const pattern = patternWith([makePiece('P1', ['eA'])]);
    const sim = buildSimData(pattern, [arrangedQuad(quadCloth('P1'), QUAD_POS_A)]);

    const bends = bendConstraints(sim);
    expect(bends).toHaveLength(1);
    const { props } = bends[0];

    const expectedBend = clampBendAlpha(bendScaleToCompliance(BEND));
    // Opposite pair is (1,3): direction (-10,10)/|.| -> |warp| == |weft| component, so the
    // anisotropic stretch blend is the plain average of the warp/weft alphas.
    const warpA = clampStretchAlpha(stretchScaleToCompliance(WARP));
    const weftA = clampStretchAlpha(stretchScaleToCompliance(WEFT));
    const expectedStretch = clampStretchAlpha((warpA + weftA) / 2);

    expect(props[0]).toBeCloseTo(expectedBend, 5);
    expect(props[1]).toBeCloseTo(expectedStretch, 5);
    expect(props[1]).not.toBeCloseTo(props[0], 5); // the two slots must differ (bend != stretch alpha)
    expect(props[2]).toBeCloseTo(Math.hypot(10, 10) / 1000, 6); // rest length (m) between (10,0) and (0,10)
    expect(props[3]).toBe(0); // no fold line
  });
});

describe('fold lines (foldAngle)', () => {
  it('sets the dihedral target on bend constraints whose hinge lies along a foldAngle internal path', () => {
    const piece = makePiece('P1', ['eA']);
    piece.internalPaths = [{
      id: 'fold1', name: '', path: 'p', from: 'a', to: 'b', reversed: false, notches: [],
      libraryUpdatedAt: null, foldAngle: 90
    } as unknown as Piece['internalPaths'][number]];
    const cloth = quadCloth('P1');
    cloth.edgeParticles.set('fold1', [0, 2]); // the quad's single bend hinge pair
    const sim = buildSimData(patternWith([piece]), [arrangedQuad(cloth, QUAD_POS_A)]);

    const bends = bendConstraints(sim);
    expect(bends).toHaveLength(1);
    expect(bends[0].props[3]).toBeCloseTo(Math.PI / 2, 6); // 90° -> rad in the targetAngle slot
  });
});

describe('bend constraints across seams', () => {
  it('disables a bend constraint whose HINGE pair are both seam particles (both slots + fold zeroed)', () => {
    // Chains [0,1,2] include both hinge particles (0 and 2) of each quad; the opposite pair (1,3)
    // is only half on the seam, so only the new hinge check can disable these constraints.
    const pattern = patternWith(
      [makePiece('P1', ['eA']), makePiece('P2', ['eB'])],
      [seamOf('eA', 'eB')]
    );
    const sim = buildSimData(pattern, [
      arrangedQuad(quadCloth('P1', 'eA'), QUAD_POS_A),
      arrangedQuad(quadCloth('P2', 'eB'), QUAD_POS_B_FORWARD)
    ]);

    const bends = bendConstraints(sim);
    expect(bends).toHaveLength(2); // one per quad
    for (const { edge, props } of bends) {
      // hinge pair (slots 3,4 of the edge vec4) must be seam particles; opposite pair must not both be
      const [a, b, ha, hb] = edge;
      expect(seamPartners(sim, ha).length).toBeGreaterThan(0);
      expect(seamPartners(sim, hb).length).toBeGreaterThan(0);
      const onSeam = (p: number) => seamPartners(sim, p).length > 0;
      expect(onSeam(a) && onSeam(b)).toBe(false);
      // disabled exactly like the opposite-pair branch: both compliance slots + angular term
      expect(props[0]).toBe(DISABLED_COMPLIANCE);
      expect(props[1]).toBe(DISABLED_COMPLIANCE);
      expect(props[3]).toBe(0);
    }
  });

  it('keeps material compliance when neither pair is fully on a seam', () => {
    const pattern = patternWith([makePiece('P1', ['eA'])]);
    const sim = buildSimData(pattern, [arrangedQuad(quadCloth('P1'), QUAD_POS_A)]);
    const [{ props }] = bendConstraints(sim);
    expect(props[0]).not.toBe(DISABLED_COMPLIANCE);
    expect(props[1]).not.toBe(DISABLED_COMPLIANCE);
  });
});

describe('seam linking', () => {
  // Piece A occupies global particles 0..3, piece B 4..7. Chains: A [0,1,2], B [4,5,6].

  it('links equal-count chains index-to-index for two aligned opposite edges', () => {
    const pattern = patternWith(
      [makePiece('P1', ['eA']), makePiece('P2', ['eB'])],
      [seamOf('eA', 'eB')]
    );
    const sim = buildSimData(pattern, [
      arrangedQuad(quadCloth('P1', 'eA'), QUAD_POS_A),
      arrangedQuad(quadCloth('P2', 'eB'), QUAD_POS_B_FORWARD)
    ]);
    expect(seamPartners(sim, 0)).toEqual([4]);
    expect(seamPartners(sim, 1)).toEqual([5]);
    expect(seamPartners(sim, 2)).toEqual([6]);
    expect(seamPartners(sim, 4)).toEqual([0]);
    expect(seamPartners(sim, 6)).toEqual([2]);
    expect(seamPartners(sim, 3)).toEqual([]); // off-seam particle untouched
  });

  it('handles reversed orientation via the auto-detect fallback when no ref carries direction', () => {
    const pattern = patternWith(
      [makePiece('P1', ['eA']), makePiece('P2', ['eB'])],
      [seamOf('eA', 'eB')] // reversed: false everywhere -> data lacks orientation -> auto-detect
    );
    const sim = buildSimData(pattern, [
      arrangedQuad(quadCloth('P1', 'eA'), QUAD_POS_A),
      arrangedQuad(quadCloth('P2', 'eB'), QUAD_POS_B_REVERSED)
    ]);
    expect(seamPartners(sim, 0)).toEqual([6]);
    expect(seamPartners(sim, 1)).toEqual([5]);
    expect(seamPartners(sim, 2)).toEqual([4]);
  });

  it('trusts an explicit reversed flag over geometry (production index pairing, no auto-detect)', () => {
    // Geometry is coincident FORWARD (A0~B0), but the data says the to-edge is reversed; the
    // original links strictly by index over the (reversed) resampled chain, so we must too.
    const pattern = patternWith(
      [makePiece('P1', ['eA']), makePiece('P2', ['eB'])],
      [seamOf('eA', 'eB', { toRev: true })]
    );
    const sim = buildSimData(pattern, [
      arrangedQuad(quadCloth('P1', 'eA'), QUAD_POS_A),
      arrangedQuad(quadCloth('P2', 'eB'), QUAD_POS_B_FORWARD)
    ]);
    expect(seamPartners(sim, 0)).toEqual([6]);
    expect(seamPartners(sim, 1)).toEqual([5]);
    expect(seamPartners(sim, 2)).toEqual([4]);
  });

  it('proximity sewing is OFF by default (source parity) and opt-in via options', () => {
    // Two saved-drape pieces with coincident boundaries but NO seam definitions.
    const mk = () => [
      arrangedQuad(quadCloth('P1'), QUAD_POS_A, { fromSaved: true, boundaryLocal: [0, 1, 2, 3] }),
      arrangedQuad(quadCloth('P2'), QUAD_POS_B_FORWARD, { fromSaved: true, boundaryLocal: [0, 1, 2, 3] })
    ];
    const pattern = patternWith([makePiece('P1', ['eA']), makePiece('P2', ['eB'])]);

    const simOff = buildSimData(pattern, mk());
    expect(Array.from(simOff.seams).every((v) => v === -1)).toBe(true);

    const simOn = buildSimData(pattern, mk(), { proximitySeams: true });
    expect(seamPartners(simOn, 0)).toEqual([4]);
    expect(seamPartners(simOn, 3)).toEqual([7]);
  });
});
