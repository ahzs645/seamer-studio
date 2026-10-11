import { createTechPack, type Pattern, type ProductionMeasurementUnit, type TechPackCosting, type TechPackDocument, type TechPackSizeMeasurement } from '@seamer/pattern-model';
import { convertSpecValue, evaluateSpecMeasurement } from './productionSpec';
import { resolveProductionTarget, resolveProductionConsumption } from './productionAutomation';

/** Existing POM unit edits must convert explicitly entered size values too. Angular/length swaps
 * clear incompatible values instead of silently interpreting degrees as millimeters. */
export function convertTechPackMeasurementUnits(document: TechPackDocument, measurementId: string, from: ProductionMeasurementUnit, to: ProductionMeasurementUnit): TechPackDocument {
  const values = document.sizeMeasurements[measurementId];
  if (!values || from === to) return document;
  return { ...document, sizeMeasurements: { ...document.sizeMeasurements,
    [measurementId]: Object.fromEntries(Object.entries(values).map(([sizeId, entry]) => [sizeId, {
      ...entry, target: convertSpecValue(entry.target, from, to), actual: convertSpecValue(entry.actual, from, to)
    }])) } };
}

export function resolveSizeMeasurement(pattern: Pattern, measurementId: string, sizeId: string) {
  const row = pattern.productionSpec?.measurements.find(m => m.id === measurementId);
  const size = pattern.techPack?.sizes.find(s => s.id === sizeId);
  const values: TechPackSizeMeasurement = pattern.techPack?.sizeMeasurements[measurementId]?.[sizeId] ?? { target: null, actual: null, notes: '' };
  if (!row || !size) return { row, size, values, enteredValues: values, targetSource: 'Missing POM or size reference', actual: null, status: 'Missing POM or size reference', valid: false };
  const target = resolveProductionTarget(pattern, measurementId, sizeId);
  const evaluated = evaluateSpecMeasurement(pattern, { ...row, annotationId: null, surfaceMeasurementId: null, manualValue: values.actual, target: target.target });
  return { row, size, values: { ...values, target: target.target }, enteredValues: values, targetSource: target.source, actual: evaluated.actual, status: !target.valid ? target.source : evaluated.label, valid: target.valid && evaluated.status !== 'invalid' };
}

/** Procurement links keep name, quantity and unit live; fabric rows require explicit consumption. */
export function resolveTechPackCosting(pattern: Pattern, entry: TechPackCosting) {
  const procurement = entry.procurementId ? pattern.productionSpec?.procurement.find(row => row.id === entry.procurementId) : null;
  const material = entry.materialId ? pattern.materials.find(row => row.id === entry.materialId) : null;
  const missing = !!((entry.procurementId && !procurement) || (entry.materialId && !material));
  const name = procurement?.name ?? material?.name ?? entry.name;
  const marker = entry.quantitySource === 'marker' && entry.materialId ? resolveProductionConsumption(pattern, entry.materialId) : null;
  const quantity = procurement ? procurement.quantity : marker ? marker.quantity : entry.quantity;
  const unit = procurement?.unit ?? (marker ? 'm' : entry.unit);
  const validQuantity = quantity !== null && Number.isFinite(quantity) && quantity >= 0;
  const validCost = entry.unitCost !== null && Number.isFinite(entry.unitCost) && entry.unitCost >= 0;
  const total = validQuantity && validCost && !missing ? quantity! * entry.unitCost! : null;
  return { name, quantity, unit, missing, quantityStatus: marker?.status ?? 'Entered quantity', total: total !== null && Number.isFinite(total) ? total : null };
}

export function techPackCostSummary(pattern: Pattern) {
  const rows = (pattern.techPack ?? createTechPack()).costing.map(entry => resolveTechPackCosting(pattern, entry));
  const priced = rows.filter(row => row.total !== null);
  const subtotal = priced.reduce((sum, row) => sum + row.total!, 0);
  return { subtotal: Number.isFinite(subtotal) ? subtotal : null, pricedCount: priced.length, totalCount: rows.length, complete: Number.isFinite(subtotal) && rows.length > 0 && rows.length === priced.length };
}
