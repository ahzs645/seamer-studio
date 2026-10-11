import type { ProductionMeasurementUnit } from './pattern';

/** Rules author garment targets, never sample actuals or fit certification. */
export interface ProductionGradeRule {
  pomId: string;
  baseSizeId: string;
  baseTarget: number | null;
  increment: number;
  unit: ProductionMeasurementUnit;
  source: 'entered' | 'sample-target';
}
export interface ProductionBodyChartRow {
  id: string;
  name: string;
  unit: Exclude<ProductionMeasurementUnit, 'deg'>;
  values: Record<string, number | null>;
}
export interface ProductionBodyMapping {
  pomId: string;
  bodyRowId: string;
  /** e.g. 0.5 converts a body circumference to a flat garment width. */
  factor: number;
  ease: number;
  unit: Exclude<ProductionMeasurementUnit, 'deg'>;
}
export interface ProductionMarkerSettings {
  materialId: string;
  fabricWidthMm: number;
  gapMm: number;
  /** 0 preserves the drafted grain direction; 180 additionally permits end-for-end turns. */
  allowHalfTurn: boolean;
  wastePercent: number;
}
export interface ProductionConsumption {
  materialId: string;
  settings: ProductionMarkerSettings;
  inputFingerprint: string;
  calculatedAt: string;
  method: 'true-shape-marker';
  usedLengthMm: number;
  purchaseLengthM: number;
  efficiency: number | null;
  cutCopies: number;
  placements: { instanceId: string; pieceId: string; rotationDeg: number; polygon: { x: number; y: number }[] }[];
}
export interface ProductionApproval {
  name: string;
  notes: string;
  approvedAt: string;
  /** Exact relevant document snapshot; layout/camera-only changes do not invalidate approval. */
  fingerprint: string;
}
export interface ProductionSurfaceMeasurement {
  id: string;
  name: string;
  pomId: string | null;
  pieceId: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  method: 'chord' | 'surface-path';
  /** Capture from the renderer's current mesh, not an inferred flat pattern value. */
  captured?: { valueMm: number; source: string; capturedAt: string; geometryFingerprint: string };
}
export interface ProductionAutomation {
  grades: ProductionGradeRule[];
  bodyChart: ProductionBodyChartRow[];
  bodyMappings: ProductionBodyMapping[];
  markerSettings: ProductionMarkerSettings[];
  consumption: ProductionConsumption[];
  surfaceMeasurements: ProductionSurfaceMeasurement[];
  approval: ProductionApproval | null;
}
export function createProductionAutomation(): ProductionAutomation {
  return { grades: [], bodyChart: [], bodyMappings: [], markerSettings: [], consumption: [], surfaceMeasurements: [], approval: null };
}

/** Validate structure at the import boundary; deleted references are kept for explicit repair. */
export function validateProductionAutomation(value: unknown): asserts value is ProductionAutomation {
  const fail = () => { throw new Error('Invalid production automation document.'); };
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const str = (v: unknown) => typeof v === 'string';
  const id = (v: unknown) => str(v) && (v as string).length > 0;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const nonnegative = (v: unknown) => finite(v) && v >= 0;
  const lengthUnit = (v: unknown) => v === 'mm' || v === 'cm' || v === 'inch';
  const unit = (v: unknown) => lengthUnit(v) || v === 'deg';
  const point = (v: unknown) => record(v) && finite(v.x) && finite(v.y);
  const settings = (v: unknown) => record(v) && id(v.materialId) && finite(v.fabricWidthMm) && v.fabricWidthMm > 0 && nonnegative(v.gapMm) && nonnegative(v.wastePercent) && (v.wastePercent as number) <= 1000 && typeof v.allowHalfTurn === 'boolean';
  if (!record(value)) fail();
  const doc = value as Record<string, unknown>;
  function rows(key: string, uniqueKey: string, check: (row: Record<string, unknown>) => boolean) {
    const values = doc[key];
    if (!Array.isArray(values)) fail();
    const seen = new Set<unknown>();
    for (const row of values as unknown[]) {
      if (!record(row) || !id(row[uniqueKey]) || seen.has(row[uniqueKey]) || !check(row)) fail();
      seen.add((row as Record<string, unknown>)[uniqueKey]);
    }
  }
  rows('grades', 'pomId', r => id(r.baseSizeId) && (r.baseTarget === null || nonnegative(r.baseTarget)) && finite(r.increment) && unit(r.unit) && (r.source === 'entered' || r.source === 'sample-target'));
  rows('bodyChart', 'id', r => str(r.name) && lengthUnit(r.unit) && record(r.values) && Object.values(r.values).every(v => v === null || nonnegative(v)));
  rows('bodyMappings', 'pomId', r => id(r.bodyRowId) && finite(r.factor) && r.factor > 0 && finite(r.ease) && lengthUnit(r.unit));
  rows('markerSettings', 'materialId', settings);
  rows('consumption', 'materialId', r => settings(r.settings) && (r.settings as Record<string, unknown>).materialId === r.materialId && str(r.inputFingerprint) && str(r.calculatedAt) && r.method === 'true-shape-marker' && nonnegative(r.usedLengthMm) && nonnegative(r.purchaseLengthM) && (r.efficiency === null || finite(r.efficiency) && r.efficiency >= 0 && r.efficiency <= 1) && nonnegative(r.cutCopies) && Number.isInteger(r.cutCopies) && Array.isArray(r.placements) && r.placements.length === r.cutCopies && new Set(r.placements.map(p => record(p) ? p.instanceId : null)).size === r.placements.length && r.placements.every(p => record(p) && id(p.instanceId) && id(p.pieceId) && finite(p.rotationDeg) && Array.isArray(p.polygon) && p.polygon.length >= 3 && p.polygon.every(point)));
  rows('surfaceMeasurements', 'id', r => str(r.name) && (r.pomId === null || id(r.pomId)) && id(r.pieceId) && point(r.from) && point(r.to) && (r.method === 'chord' || r.method === 'surface-path') && (r.captured === undefined || record(r.captured) && nonnegative(r.captured.valueMm) && str(r.captured.source) && str(r.captured.capturedAt) && str(r.captured.geometryFingerprint)));
  if (doc.approval !== null && !(record(doc.approval) && id(doc.approval.name) && str(doc.approval.notes) && str(doc.approval.approvedAt) && str(doc.approval.fingerprint))) fail();
}
