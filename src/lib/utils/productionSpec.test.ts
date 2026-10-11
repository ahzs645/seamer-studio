import { describe, expect, it } from 'vitest';
import { EMPTY_PATTERN, type Pattern, type ProductionMeasurement } from '@seamer/pattern-model';
import { assignedMaterialRows, changeSpecUnit, convertSpecValue, evaluateSpecMeasurement, liveAnnotationValue } from './productionSpec';
import { convertSimplePattern, convertSimplePatternWithLegacyProject, type SimpleFile } from './importSimplePattern';
import { patternToSSP, sspToPattern } from './ssp';

function sample(): Pattern {
  const p = structuredClone(EMPTY_PATTERN);
  p.points = [ ['a', 0, 0], ['v', 30, 0], ['b', 30, 40] ].map(([id, x, y]) => ({ id: id as string, name: id as string, x: x as number, y: y as number }));
  p.measurements = [{ id: 'd', name: 'Diagonal', fromPointId: 'a', toPointId: 'b', targetMm: 50 }, { id: 'angle', name: 'Corner', kind: 'angle', fromPointId: 'a', viaPointId: 'v', toPointId: 'b', targetMm: 90 }];
  return p;
}
function row(patch: Partial<ProductionMeasurement> = {}): ProductionMeasurement {
  return { id: 'r', name: 'Length', annotationId: 'd', unit: 'cm', manualValue: null, target: 5, tolMinus: 0.1, tolPlus: 0.2, notes: '', ...patch };
}

describe('production specs', () => {
  it('uses live annotation endpoints and independent row units', () => {
    const p = sample();
    expect(evaluateSpecMeasurement(p, row())).toMatchObject({ actual: 5, lower: 4.9, upper: 5.2, status: 'within' });
    p.points[2].y = 80;
    expect(evaluateSpecMeasurement(p, row()).status).toBe('outside');
  });
  it('uses placed endpoints exactly as the canvas, including cross-piece layout translations', () => {
    const p = convertSimplePattern({ pieces: [
      { name: 'A', sewLines: [], boundary: [[[0, 0], [10, 0]], [[10, 0], [0, 10]], [[0, 10], [0, 0]]] },
      { name: 'B', sewLines: [], boundary: [[[20, 0], [30, 0]], [[30, 0], [20, 10]], [[20, 10], [20, 0]]] }
    ] });
    const fromPointId = p.pieces[0].mainPaths[0].from;
    const toPointId = p.pieces[1].mainPaths[0].from;
    expect(fromPointId).not.toBe(toPointId);
    p.pieces[0].position = { x: 100, y: 200 };
    p.pieces[1].position = { x: 400, y: 600 };
    p.pieces[0].origin = { id: 'originA', name: '', x: 0, y: 0 };
    p.pieces[1].origin = { id: 'originB', name: '', x: 0, y: 0 };
    p.pieces[0].originPoint = fromPointId; p.pieces[1].originPoint = toPointId;
    p.pieces[0].rotation = 0; p.pieces[1].rotation = 0;
    expect(liveAnnotationValue(p, { id: 'cross', name: '', fromPointId, toPointId, targetMm: null })).toBeCloseTo(500);
  });
  it('reports deleted annotation references rather than substituting a manual or zero actual', () => {
    expect(evaluateSpecMeasurement(sample(), row({ annotationId: 'deleted', manualValue: 5 }))).toMatchObject({ actual: null, status: 'missing-reference', label: 'Missing annotation' });
    const p = sample(); p.points = p.points.filter(point => point.id !== 'b');
    expect(evaluateSpecMeasurement(p, row())).toMatchObject({ actual: null, status: 'missing-reference' });
  });
  it('computes interior angles in degrees, and flags coincident rays', () => {
    const p = sample();
    expect(evaluateSpecMeasurement(p, row({ annotationId: 'angle', unit: 'deg', target: 90 })).actual).toBe(90);
    p.points[0].x = 30;
    expect(liveAnnotationValue(p, p.measurements![1])).toBeNull();
    expect(evaluateSpecMeasurement(p, row({ annotationId: 'angle', unit: 'cm' })).status).toBe('invalid');
  });
  it('converts target, asymmetric tolerances and manual actual without reinterpreting the sample', () => {
    const converted = changeSpecUnit(row({ annotationId: null, unit: 'inch', manualValue: 2, target: 2, tolMinus: 0.1, tolPlus: 0.2 }), 'mm');
    expect(converted.manualValue).toBeCloseTo(50.8);
    expect(converted.target).toBeCloseTo(50.8);
    expect(converted.tolMinus).toBeCloseTo(2.54);
    expect(converted.tolPlus).toBeCloseTo(5.08);
    expect(convertSpecValue(20, 'deg', 'mm')).toBeNull();
  });
  it('checks asymmetric limits inclusively and tolerates only floating-point roundoff', () => {
    const r = row({ annotationId: null, target: 10, tolMinus: 1, tolPlus: 2 });
    expect(evaluateSpecMeasurement(sample(), { ...r, manualValue: 9 }).status).toBe('within');
    expect(evaluateSpecMeasurement(sample(), { ...r, manualValue: 12 }).status).toBe('within');
    expect(evaluateSpecMeasurement(sample(), { ...r, manualValue: 8.99 }).status).toBe('outside');
    expect(evaluateSpecMeasurement(sample(), { ...r, manualValue: 12.01 }).status).toBe('outside');
  });
  it('does not represent unknown actuals, unset targets or nonfinite values as passing', () => {
    expect(evaluateSpecMeasurement(sample(), row({ annotationId: null, manualValue: null })).status).toBe('no-actual');
    expect(evaluateSpecMeasurement(sample(), row({ target: null })).status).toBe('no-target');
    expect(evaluateSpecMeasurement(sample(), row({ tolMinus: -1 })).status).toBe('invalid');
    expect(evaluateSpecMeasurement(sample(), row({ annotationId: null, manualValue: Infinity })).status).toBe('invalid');
    const p = sample(); p.points[0].x = NaN;
    expect(evaluateSpecMeasurement(p, row()).actual).toBeNull();
  });
  it('derives assigned fabric and cut copies without pretending those counts are yardage', () => {
    const p = convertSimplePattern({ pieces: [{ name: 'Panel', sewLines: [], boundary: [[[0, 0], [10, 0]], [[10, 0], [0, 10]], [[0, 10], [0, 0]]] }] });
    p.pieces[0].rightPieces = 2; p.pieces[0].leftPieces = 1;
    expect(assignedMaterialRows(p)).toMatchObject([{ pieces: ['Panel'], cutCopies: 3, missing: false }]);
    p.materials = [];
    expect(assignedMaterialRows(p)[0].missing).toBe(true);
  });
  it('round-trips specs and the Specs workspace through a complete SSP project', async () => {
    const p = sample(); p.viewMode = 'specs'; p.productionSpec = { measurements: [row()], procurement: [{ id: 'zip', name: 'Zip', category: 'trim', quantity: 1, unit: 'each', notes: 'Invisible' }] };
    const blob = await patternToSSP(p);
    const restored = await sspToPattern(blob);
    expect(restored?.productionSpec).toEqual(p.productionSpec);
    expect(restored?.viewMode).toBe('specs');
  });
  it('preserves production values during paired legacy geometry import and exposes stale links', () => {
    const raw: SimpleFile = { pieces: [{ name: 'Panel', sewLines: [], boundary: [[[0, 0], [10, 0]], [[10, 0], [0, 10]], [[0, 10], [0, 0]]] }] };
    const legacy = convertSimplePattern(raw);
    legacy.productionSpec = { measurements: [row()], procurement: [{ id: 'zip', name: 'Zip', category: 'trim', quantity: 1, unit: 'each', notes: '' }] };
    legacy.viewMode = 'all';
    const restored = convertSimplePatternWithLegacyProject(raw, legacy);
    expect(restored.productionSpec).toEqual(legacy.productionSpec);
    expect(restored.productionSpec).not.toBe(legacy.productionSpec);
    expect(restored.viewMode).toBe('all');
    expect(evaluateSpecMeasurement(restored, restored.productionSpec!.measurements[0]).status).toBe('missing-reference');
  });
});
