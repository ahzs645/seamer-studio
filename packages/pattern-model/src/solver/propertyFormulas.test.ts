// Formula-driven properties (the original's *Formula fields): evaluated by redraft against the
// variable scope — seam allowance, piece rotation/grain, conditionFormula (0 hides), notch distance.

import { describe, it, expect } from 'vitest';
import { redraft, hasConstraints } from './solve';
import { createEmptyPattern, type Pattern, type Piece } from '../pattern';

function patternWithPiece(): Pattern {
  const p = createEmptyPattern();
  p.variables = [{
    id: 'var_hem', name: 'hem', description: '', type: 'number', value: 12,
    valueFormula: { formula: '12', unit: 'none' }, isEditable: true, isVisible: true, options: [], unitType: 'length'
  } as unknown as Pattern['variables'][number]];
  p.pieces = [{
    id: 'P1', name: 'P1', type: 'dynamic', materialId: '', origin: { x: 0, y: 0 }, originPoint: '',
    position: { x: 0, y: 0 }, rotation: 0, grainVector: { x: 0, y: 1 }, text: null,
    rightPieces: 1, leftPieces: 0, mirrorLeftPiecesAxis: 'X', mirrorX: false, mirrorY: false,
    seamAllowanceInside: false,
    mainPaths: [{
      id: 'pp1', name: '', path: 'p', from: 'a', to: 'b', reversed: false,
      notches: [{ id: 'n1', position: 0.5, referencePointId: 'a', distance: 0, distanceFormula: { formula: 'hem * 2', unit: 'mm' } }],
      seamAllowanceFormula: { formula: 'hem + 3', unit: 'mm' }
    }],
    internalPaths: [],
    settings3d: { arrangement: null, enable3d: true, frozen: false, flipNormals: false, filterExternalCollisionsByClothNormal: false, collisionLayer: 0, savedPositions: [] },
    rotationFormula: { formula: 'hem * 10', unit: 'degrees' },
    conditionFormula: { formula: 'hem - 12', unit: 'none' } // 0 → hidden
  } as unknown as Piece];
  return p;
}

describe('property formulas', () => {
  it('redraft drives seam allowance, rotation, notch distance and condition from formulas', () => {
    const p = redraft(patternWithPiece());
    const piece = p.pieces[0];
    expect(piece.mainPaths[0].seamAllowance).toBe(15); // hem + 3
    expect(piece.rotation).toBe(120); // hem * 10
    expect(piece.mainPaths[0].notches?.[0].distance).toBe(24); // hem * 2
    expect(piece.hidden).toBe(true); // hem - 12 === 0
  });

  it('property formulas alone make the pattern parametric (hasConstraints)', () => {
    expect(hasConstraints(patternWithPiece())).toBe(true);
    const bare = createEmptyPattern();
    expect(hasConstraints(bare)).toBe(false);
  });
});
