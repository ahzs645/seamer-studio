import { pieceCutCounts, placedPoints, type Measurement, type Pattern, type ProductionMeasurement, type ProductionMeasurementUnit } from '@seamer/pattern-model';
import { productionGeometryFingerprint } from './productionAutomation';

const millimetersPerUnit = { mm: 1, cm: 10, inch: 25.4 } as const;

export function convertSpecValue(value: number | null, from: ProductionMeasurementUnit, to: ProductionMeasurementUnit): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (from === to) return value;
  if (from === 'deg' || to === 'deg') return null;
  return value * millimetersPerUnit[from] / millimetersPerUnit[to];
}

/** Match the canvas annotation renderer's FIRST placed occurrence for each endpoint. The renderer
 * appends extra draft-space copies, which cannot change that lookup. Layout position matters for
 * annotations spanning pieces; these are 2D endpoint distances, not sewn garment circumferences. */
export function liveAnnotationValue(pattern: Pattern, annotation: Measurement): number | null {
  const placed = placedPoints(pattern);
  const a = placed.find(point => point.pointId === annotation.fromPointId)?.world;
  const b = placed.find(point => point.pointId === annotation.toPointId)?.world;
  if (!a || !b) return null;
  if (annotation.kind !== 'angle') {
    const value = Math.hypot(b.x - a.x, b.y - a.y);
    return Number.isFinite(value) ? value : null;
  }
  const v = placed.find(point => point.pointId === annotation.viaPointId)?.world;
  if (!v || Math.hypot(a.x - v.x, a.y - v.y) < 1e-9 || Math.hypot(b.x - v.x, b.y - v.y) < 1e-9) return null;
  let angle = Math.abs(Math.atan2(a.y - v.y, a.x - v.x) - Math.atan2(b.y - v.y, b.x - v.x)) * 180 / Math.PI;
  if (angle > 180) angle = 360 - angle;
  return Number.isFinite(angle) ? angle : null;
}

export type SpecMeasurementStatus = 'within' | 'outside' | 'no-target' | 'no-actual' | 'missing-reference' | 'invalid';
export interface SpecMeasurementResult {
  actual: number | null;
  lower: number | null;
  upper: number | null;
  status: SpecMeasurementStatus;
  label: string;
}

export function evaluateSpecMeasurement(pattern: Pattern, row: ProductionMeasurement): SpecMeasurementResult {
  let actual = row.manualValue;
  const result = (status: SpecMeasurementStatus, label: string, lower: number | null = null, upper: number | null = null): SpecMeasurementResult => ({ actual, lower, upper, status, label });
  if (row.surfaceMeasurementId) {
    const measurement = pattern.productionAutomation?.surfaceMeasurements.find(item => item.id === row.surfaceMeasurementId);
    actual = null;
    if (!measurement) return result('missing-reference', 'Missing surface measurement');
    if (!measurement.captured) return result('no-actual', 'Capture current cloth measurement');
    if (!pattern.pieces.some(piece => piece.id === measurement.pieceId)) return result('missing-reference', 'Missing surface piece');
    if (measurement.captured.geometryFingerprint !== productionGeometryFingerprint(pattern)) return result('missing-reference', 'Stale surface measurement');
    if (row.unit === 'deg') return result('invalid', 'Source unit mismatch');
    actual = convertSpecValue(measurement.captured.valueMm, 'mm', row.unit);
  } else if (row.annotationId) {
    const annotation = pattern.measurements?.find(m => m.id === row.annotationId);
    actual = null;
    if (!annotation) return result('missing-reference', 'Missing annotation');
    const isAngle = annotation.kind === 'angle';
    if ((row.unit === 'deg') !== isAngle) return result('invalid', 'Source unit mismatch');
    actual = convertSpecValue(liveAnnotationValue(pattern, annotation), isAngle ? 'deg' : 'mm', row.unit);
    if (actual === null) return result('missing-reference', 'Missing or invalid endpoints');
  }
  if (actual !== null && (!Number.isFinite(actual) || actual < 0)) { actual = null; return result('invalid', 'Invalid actual'); }
  if (!Number.isFinite(row.tolMinus) || !Number.isFinite(row.tolPlus) || row.tolMinus < 0 || row.tolPlus < 0 || (row.target !== null && (!Number.isFinite(row.target) || row.target < 0))) return result('invalid', 'Invalid target or tolerance');
  if (actual === null) return result('no-actual', 'Enter sample actual');
  if (row.target === null) return result('no-target', 'Target not set');
  const lower = row.target - row.tolMinus;
  const upper = row.target + row.tolPlus;
  // Small roundoff allowance keeps equivalent inch/mm values inside exact boundaries.
  const epsilon = 1e-9 * Math.max(1, Math.abs(actual), Math.abs(lower), Math.abs(upper));
  const within = actual >= lower - epsilon && actual <= upper + epsilon;
  return result(within ? 'within' : 'outside', within ? 'Within tolerance' : 'Outside tolerance', lower, upper);
}

export function changeSpecUnit(row: ProductionMeasurement, unit: ProductionMeasurementUnit): ProductionMeasurement {
  return { ...row, unit,
    manualValue: convertSpecValue(row.manualValue, row.unit, unit),
    target: convertSpecValue(row.target, row.unit, unit),
    tolMinus: convertSpecValue(row.tolMinus, row.unit, unit) ?? 0,
    tolPlus: convertSpecValue(row.tolPlus, row.unit, unit) ?? 0
  };
}

export function assignedMaterialRows(pattern: Pattern) {
  const groups = new Map<string, { materialId: string; name: string; color: string; pieces: string[]; cutCopies: number; missing: boolean }>();
  for (const piece of pattern.pieces) {
    const material = pattern.materials.find(m => m.id === piece.materialId);
    const row = groups.get(piece.materialId) ?? { materialId: piece.materialId,
      name: material?.name ?? 'Missing fabric assignment', color: material?.frontTexture?.color ?? '#94a3b8',
      pieces: [], cutCopies: 0, missing: !material };
    row.pieces.push(piece.name || piece.id);
    row.cutCopies += pieceCutCounts(piece).total;
    groups.set(piece.materialId, row);
  }
  return [...groups.values()];
}
