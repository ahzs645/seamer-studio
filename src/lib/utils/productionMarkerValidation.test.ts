import { describe, expect, it } from 'vitest';
import { createProductionAutomation, type ProductionMarkerSettings } from '@seamer/pattern-model';
import { convertSimplePattern } from './importSimplePattern';
import { nestPiecesTrueShape } from './markerLayout';
import { calculateProductionConsumption, markerConsumptionFromLayout, productionGeometryFingerprint, resolveProductionConsumption } from './productionAutomation';

function fixture() {
  const pattern = convertSimplePattern({ pieces: [{ name: 'Panel', sewLines: [], boundary: [[[0, 0], [100, 0]], [[100, 0], [100, 200]], [[100, 200], [0, 200]], [[0, 200], [0, 0]]] }] });
  pattern.pieces[0].rightPieces = 2;
  pattern.productionAutomation = createProductionAutomation();
  const settings: ProductionMarkerSettings = { materialId: pattern.pieces[0].materialId, fabricWidthMm: 500, gapMm: 10, wastePercent: 10, allowHalfTurn: false };
  return { pattern, settings };
}
describe('validated marker geometry and recorded consumption', () => {
  it('rejects forged tiny polygons and wrong piece references despite matching cut-copy IDs', () => {
    const { pattern, settings } = fixture();
    const layout = nestPiecesTrueShape(pattern, { fabricWidthMm: 500, gapMm: 10, allowedRotations: [0] });
    const forged = structuredClone(layout); forged.placements[0].poly = [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 10, y: 11 }];
    expect(() => markerConsumptionFromLayout(pattern, settings, forged)).toThrow(/geometry|rigid/);
    const wrongPiece = structuredClone(layout); wrongPiece.placements[0].pieceId = 'foreign';
    expect(() => markerConsumptionFromLayout(pattern, settings, wrongPiece)).toThrow(/reference/);
  });
  it('rejects rigid valid outlines that overlap or violate configured minimum spacing', () => {
    const { pattern, settings } = fixture();
    const layout = nestPiecesTrueShape(pattern, { fabricWidthMm: 500, gapMm: 10, allowedRotations: [0] });
    expect(layout.placements).toHaveLength(2);
    const gapViolation = structuredClone(layout);
    const first = gapViolation.placements[0], second = gapViolation.placements[1];
    const targetX = Math.max(...first.poly.map(p => p.x)) + 5;
    const dx = targetX - Math.min(...second.poly.map(p => p.x));
    const dy = Math.min(...first.poly.map(p => p.y)) - Math.min(...second.poly.map(p => p.y));
    second.poly = second.poly.map(point => ({ x: point.x + dx, y: point.y + dy }));
    expect(() => markerConsumptionFromLayout(pattern, settings, gapViolation)).toThrow('minimum piece spacing');
    second.poly = second.poly.map(point => ({ x: point.x - 10, y: point.y }));
    expect(() => markerConsumptionFromLayout(pattern, settings, gapViolation)).toThrow('overlap');
  });
  it('rejects inflated marker extents/efficiency and revalidates stored layouts before quantity reaches costing', () => {
    const { pattern, settings } = fixture();
    const record = calculateProductionConsumption(pattern, settings);
    pattern.productionAutomation!.markerSettings = [settings]; pattern.productionAutomation!.consumption = [record];
    expect(resolveProductionConsumption(pattern, settings.materialId).quantity).toBe(record.purchaseLengthM);
    record.placements[0].polygon[0].x += 1;
    expect(resolveProductionConsumption(pattern, settings.materialId)).toMatchObject({ quantity: null, status: 'Invalid marker layout · recalculate' });
    const layout = nestPiecesTrueShape(pattern, { fabricWidthMm: 500, gapMm: 10, allowedRotations: [0] });
    expect(() => markerConsumptionFromLayout(pattern, settings, { ...layout, usedLengthMm: layout.usedLengthMm + 100 })).toThrow('extents');
    expect(() => markerConsumptionFromLayout(pattern, settings, { ...layout, efficiency: 1 })).toThrow('efficiency');
  });
  it('invalidates captured surface eligibility for physical settings/fabric changes and keeps camera changes irrelevant', () => {
    const { pattern } = fixture(); const initial = productionGeometryFingerprint(pattern);
    pattern.settings3d.cameraPosition = [100, 200, 300]; pattern.settings3d.showAvatar = !pattern.settings3d.showAvatar;
    expect(productionGeometryFingerprint(pattern)).toBe(initial);
    pattern.settings3d.gravity = [0, -1, 0]; expect(productionGeometryFingerprint(pattern)).not.toBe(initial);
    const withGravity = productionGeometryFingerprint(pattern); pattern.materials[0].stretchWarpValue += 1;
    expect(productionGeometryFingerprint(pattern)).not.toBe(withGravity);
  });
});
