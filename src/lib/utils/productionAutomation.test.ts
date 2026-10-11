import { describe, expect, it } from 'vitest';
import { createProductionAutomation, createTechPack, validateProductionAutomation, type Pattern, type ProductionMarkerSettings } from '@seamer/pattern-model';
import { convertSimplePattern } from './importSimplePattern';
import { approveProductionDocument, calculateProductionConsumption, markerConsumptionFromLayout, normalizeProductionAutomation, productionApprovalState, productionGeometryFingerprint, resolveProductionConsumption, resolveProductionTarget } from './productionAutomation';
import { evaluateSpecMeasurement } from './productionSpec';
import { resolveSizeMeasurement, resolveTechPackCosting } from './techPack';
import { nestPiecesTrueShape } from './markerLayout';
import { patternToSSP, sspToPattern } from './ssp';
function garment(): Pattern {
  const p = convertSimplePattern({ pieces: [{ name: 'Panel', sewLines: [], boundary: [[[0, 0], [100, 0]], [[100, 0], [100, 200]], [[100, 200], [0, 200]], [[0, 200], [0, 0]]] }] });
  p.productionSpec = { measurements: [{ id: 'width', name: 'Width', annotationId: null, unit: 'cm', manualValue: null, target: 50, tolMinus: 1, tolPlus: 2, notes: '' }], procurement: [] };
  p.techPack = createTechPack(); p.techPack.sizes = [{ id: 's', name: 'S' }, { id: 'm', name: 'M' }, { id: 'l', name: 'L' }]; p.techPack.sampleSizeId = 'm';
  p.productionAutomation = createProductionAutomation(); return p;
}
describe('automatic production relationships', () => {
  it('grades relative to ordered base size in independently stored units without inventing actuals', () => {
    const p = garment(); p.productionAutomation!.grades = [{ pomId: 'width', baseSizeId: 'm', baseTarget: 500, increment: 40, unit: 'mm', source: 'entered' }];
    expect(resolveProductionTarget(p, 'width', 's')).toMatchObject({ target: 46, valid: true });
    expect(resolveSizeMeasurement(p, 'width', 'l')).toMatchObject({ values: { target: 54, actual: null }, actual: null, status: 'Enter sample actual' });
    p.productionSpec!.measurements[0].unit = 'inch';
    expect(resolveProductionTarget(p, 'width', 'l').target).toBeCloseTo(540 / 25.4);
    expect(p.productionAutomation!.grades[0].increment).toBe(40);
  });
  it('honors explicit targets and keeps measured actuals while live base targets update', () => {
    const p = garment(); p.productionAutomation!.grades = [{ pomId: 'width', baseSizeId: 'm', baseTarget: null, increment: 4, unit: 'cm', source: 'sample-target' }];
    p.techPack!.sizeMeasurements = { width: { l: { target: 57, actual: 58, notes: 'Manual override' } } };
    expect(resolveSizeMeasurement(p, 'width', 'l')).toMatchObject({ values: { target: 57, actual: 58 }, targetSource: 'Manual override', status: 'Within tolerance' });
    p.productionSpec!.measurements[0].target = 60;
    expect(resolveProductionTarget(p, 'width', 's').target).toBe(56);
    expect(resolveProductionTarget(p, 'width', 'l').target).toBe(57);
    p.techPack!.sizeMeasurements.width.l.target = null;
    expect(resolveProductionTarget(p, 'width', 'l').target).toBe(64);
  });
  it('maps body circumference to garment flat width with explicit multiplier and ease across units', () => {
    const p = garment(); p.productionAutomation!.bodyChart = [{ id: 'chest', name: 'Body chest', unit: 'cm', values: { m: 100, l: 108 } }];
    p.productionAutomation!.bodyMappings = [{ pomId: 'width', bodyRowId: 'chest', factor: .5, ease: 20, unit: 'mm' }];
    expect(resolveProductionTarget(p, 'width', 'm')).toMatchObject({ target: 52, valid: true });
    expect(resolveProductionTarget(p, 'width', 's')).toMatchObject({ target: null, valid: false });
    p.productionAutomation!.bodyChart = [];
    expect(resolveProductionTarget(p, 'width', 'm')).toMatchObject({ target: null, source: 'Missing body chart value or reference', valid: false });
  });
  it('reports deleted base sizes/POMs and incompatible angular rules without manufactured targets', () => {
    const p = garment(); p.productionAutomation!.grades = [{ pomId: 'width', baseSizeId: 'missing', baseTarget: 50, increment: 4, unit: 'cm', source: 'entered' }];
    expect(resolveProductionTarget(p, 'width', 'm')).toMatchObject({ target: null, valid: false });
    p.productionAutomation!.grades[0].baseSizeId = 'm'; p.productionSpec!.measurements[0].unit = 'deg';
    expect(resolveProductionTarget(p, 'width', 'l')).toMatchObject({ target: null, valid: false });
    p.productionSpec!.measurements = [];
    expect(resolveSizeMeasurement(p, 'width', 'm').valid).toBe(false);
  });
  it('records author review and invalidates it on geometry, production, material and size changes but not camera/layout', () => {
    const p = garment(); p.productionAutomation = approveProductionDocument(p, 'Factory reviewer', 'Sample B', new Date('2026-10-11'));
    expect(productionApprovalState(p)).toBe('approved');
    p.viewMode = '3d'; expect(productionApprovalState(p)).toBe('approved');
    for (const mutate of [(p: Pattern) => p.productionSpec!.measurements[0].target = 51, (p: Pattern) => p.points[0].x += 1, (p: Pattern) => p.techPack!.sizes[0].name = 'XS', (p: Pattern) => p.materials[0].name = 'Changed fabric']) {
      const copy = structuredClone(p); mutate(copy); expect(productionApprovalState(copy)).toBe('stale');
    }
    expect(() => approveProductionDocument(p, '', '')).toThrow('approver');
  });
  it('links a captured actual mesh measurement to sample POMs with unit conversion and stale/missing checks', () => {
    const p = garment(); const row = p.productionSpec!.measurements[0]; row.surfaceMeasurementId = 'surface';
    p.productionAutomation!.surfaceMeasurements = [{ id: 'surface', name: 'Cloth path', pomId: row.id, pieceId: p.pieces[0].id, from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, method: 'surface-path', captured: { valueMm: 500, capturedAt: '2026-10-11', source: 'Current displayed mesh', geometryFingerprint: productionGeometryFingerprint(p) } }];
    expect(evaluateSpecMeasurement(p, row)).toMatchObject({ actual: 50, status: 'within' });
    row.unit = 'inch'; row.target = 500 / 25.4; expect(evaluateSpecMeasurement(p, row).actual).toBeCloseTo(500 / 25.4);
    expect(resolveSizeMeasurement(p, row.id, 'm').actual).toBeNull();
    p.points[0].x += 1; expect(evaluateSpecMeasurement(p, row)).toMatchObject({ actual: null, label: 'Stale surface measurement' });
    p.productionAutomation!.surfaceMeasurements = []; expect(evaluateSpecMeasurement(p, row)).toMatchObject({ actual: null, label: 'Missing surface measurement' });
  });
  it('calculates real marker purchase length and rejects stale consumption in costing after geometry or settings change', () => {
    const p = garment(); const settings: ProductionMarkerSettings = { materialId: p.pieces[0].materialId, fabricWidthMm: 500, gapMm: 10, wastePercent: 10, allowHalfTurn: false };
    const record = calculateProductionConsumption(p, settings);
    expect(record.cutCopies).toBeGreaterThan(0); expect(record.placements).toHaveLength(record.cutCopies);
    expect(record.purchaseLengthM).toBeCloseTo(record.usedLengthMm / 1000 * 1.1);
    p.productionAutomation!.markerSettings = [settings]; p.productionAutomation!.consumption = [record];
    const cost = { id: 'fabric', name: 'Fabric', materialId: settings.materialId, procurementId: null, supplier: '', sku: '', quantity: 99, unit: 'each', unitCost: 10, notes: '', quantitySource: 'marker' as const };
    expect(resolveTechPackCosting(p, cost)).toMatchObject({ quantity: record.purchaseLengthM, unit: 'm', total: record.purchaseLengthM * 10 });
    settings.fabricWidthMm = 600; expect(resolveProductionConsumption(p, settings.materialId)).toMatchObject({ quantity: null, status: 'Stale · recalculate marker' });
    expect(resolveTechPackCosting(p, cost).total).toBeNull();
    settings.fabricWidthMm = 500; p.points[0].x += 10; expect(resolveProductionConsumption(p, settings.materialId).quantity).toBeNull();
  });
  it('rejects impossible widths, omitted or overlapping marker copies and violated rotation constraints', () => {
    const p = garment(); const settings: ProductionMarkerSettings = { materialId: p.pieces[0].materialId, fabricWidthMm: 500, gapMm: 10, wastePercent: 0, allowHalfTurn: false };
    const layout = nestPiecesTrueShape(p, { fabricWidthMm: 500, gapMm: 10, allowedRotations: [0] });
    expect(() => markerConsumptionFromLayout(p, settings, { ...layout, placements: [] })).toThrow('cut copies');
    const badRotation = structuredClone(layout); badRotation.placements[0].rotationDeg = 90;
    expect(() => markerConsumptionFromLayout(p, settings, badRotation)).toThrow('grain');
    const outside = structuredClone(layout); outside.placements[0].poly[0].x = 600;
    expect(() => markerConsumptionFromLayout(p, settings, outside)).toThrow('bounds');
    expect(() => calculateProductionConsumption(p, { ...settings, fabricWidthMm: 20 })).toThrow();
  });
  it('round-trips automation and rejects malformed extension structures while retaining explicit orphan references', async () => {
    const p = garment(); p.productionAutomation!.grades = [{ pomId: 'deleted', baseSizeId: 'm', baseTarget: 50, increment: 4, unit: 'cm', source: 'entered' }];
    const restored = await sspToPattern(await patternToSSP(p)); expect(restored.productionAutomation).toEqual(p.productionAutomation);
    expect(normalizeProductionAutomation(p.productionAutomation)).toEqual(p.productionAutomation);
    expect(normalizeProductionAutomation({ ...p.productionAutomation, grades: [...p.productionAutomation!.grades, ...p.productionAutomation!.grades] })).toBeUndefined();
    expect(normalizeProductionAutomation({ ...p.productionAutomation, bodyChart: [{ id: 'a', name: 'A', unit: 'cm', values: [] }] })).toBeUndefined();
    expect(() => validateProductionAutomation({ ...p.productionAutomation, markerSettings: [{ materialId: 'x', fabricWidthMm: -1, gapMm: 0, wastePercent: 0, allowHalfTurn: true }] })).toThrow();
  });
});
