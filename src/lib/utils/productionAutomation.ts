import { createProductionAutomation, validateProductionAutomation, pieceCutCounts, type Pattern, type ProductionAutomation, type ProductionMarkerSettings, type ProductionConsumption } from '@seamer/pattern-model';
import { convertSpecValue } from './productionSpec';
import { buildNestItems, nestPiecesTrueShape, polysOverlap, type MarkerLayout } from './markerLayout';

export function productionGeometryFingerprint(pattern: Pattern): string {
  const settings = pattern.settings3d;
  return JSON.stringify({ points: pattern.points, paths: pattern.paths, pieces: pattern.pieces, seamAllowance: pattern.seamAllowance, seams: pattern.seams, body: pattern.body, materials: pattern.materials,
    simulation: { gravity: settings.gravity, avatarEnabled: settings.avatarEnabled, handleSelfCollisions: settings.handleSelfCollisions, globalParticleDistanceOverride: settings.globalParticleDistanceOverride, fixTop: settings.fixTop, drapeMirroredPieces: settings.drapeMirroredPieces } });
}
export function productionApprovalFingerprint(pattern: Pattern): string {
  const automation = pattern.productionAutomation ?? createProductionAutomation();
  return JSON.stringify({ geometry: productionGeometryFingerprint(pattern), materials: pattern.materials, artwork: pattern.artwork, colorways: pattern.colorways,
    spec: pattern.productionSpec, techPack: pattern.techPack, automation: { ...automation, approval: null } });
}
export function productionApprovalState(pattern: Pattern): 'unapproved' | 'approved' | 'stale' {
  const approval = pattern.productionAutomation?.approval;
  return !approval ? 'unapproved' : approval.fingerprint === productionApprovalFingerprint(pattern) ? 'approved' : 'stale';
}
export function approveProductionDocument(pattern: Pattern, name: string, notes: string, now = new Date()): ProductionAutomation {
  if (!name.trim()) throw new Error('Enter an approver name.');
  return { ...(pattern.productionAutomation ?? createProductionAutomation()), approval: { name: name.trim(), notes, approvedAt: now.toISOString(), fingerprint: productionApprovalFingerprint(pattern) } };
}

export interface ProductionTarget { target: number | null; source: string; valid: boolean; }
export function resolveProductionTarget(pattern: Pattern, pomId: string, sizeId: string): ProductionTarget {
  const row = pattern.productionSpec?.measurements.find(row => row.id === pomId);
  const sizes = pattern.techPack?.sizes ?? [];
  if (!row || !sizes.some(size => size.id === sizeId)) return { target: null, source: 'Missing POM or size reference', valid: false };
  const entered = pattern.techPack?.sizeMeasurements[pomId]?.[sizeId]?.target;
  if (entered !== null && entered !== undefined) return { target: Number.isFinite(entered) && entered >= 0 ? entered : null, source: 'Manual override', valid: Number.isFinite(entered) && entered >= 0 };
  const mapping = pattern.productionAutomation?.bodyMappings.find(mapping => mapping.pomId === pomId);
  if (mapping) {
    const body = pattern.productionAutomation?.bodyChart.find(body => body.id === mapping.bodyRowId);
    const value = body?.values[sizeId];
    if (!body || value === undefined || value === null) return { target: null, source: 'Missing body chart value or reference', valid: false };
    const converted = convertSpecValue(value, body.unit, row.unit);
    const ease = convertSpecValue(mapping.ease, mapping.unit, row.unit);
    const target = converted === null || ease === null ? null : converted * mapping.factor + ease;
    return { target: target !== null && Number.isFinite(target) && target >= 0 ? target : null, source: `Body chart · ${body.name} × ${mapping.factor} + ease`, valid: target !== null && Number.isFinite(target) && target >= 0 && mapping.factor > 0 };
  }
  const rule = pattern.productionAutomation?.grades.find(rule => rule.pomId === pomId);
  if (!rule) return { target: null, source: 'Target not set', valid: true };
  const baseIndex = sizes.findIndex(size => size.id === rule.baseSizeId);
  if (baseIndex < 0) return { target: null, source: 'Missing grade base size', valid: false };
  const base = rule.source === 'sample-target' ? row.target : convertSpecValue(rule.baseTarget, rule.unit, row.unit);
  const increment = convertSpecValue(rule.increment, rule.unit, row.unit);
  const target = base === null || increment === null ? null : base + (sizes.findIndex(size => size.id === sizeId) - baseIndex) * increment;
  return { target: target !== null && Number.isFinite(target) && target >= 0 ? target : null, source: `Grade rule · ${rule.source === 'sample-target' ? 'live POM target' : 'entered base'} · ${rule.increment} ${rule.unit}/size`, valid: target !== null && Number.isFinite(target) && target >= 0 };
}

export function materialMarkerPattern(pattern: Pattern, materialId: string): Pattern {
  return { ...pattern, pieces: pattern.pieces.filter(piece => piece.materialId === materialId).map(piece => ({ ...piece, hidden: false })) };
}
export function consumptionFingerprint(pattern: Pattern, settings: ProductionMarkerSettings): string {
  return JSON.stringify({ settings, items: buildNestItems(materialMarkerPattern(pattern, settings.materialId)) });
}
export function markerConsumptionFromLayout(pattern: Pattern, settings: ProductionMarkerSettings, layout: MarkerLayout, now = new Date()): ProductionConsumption {
  if (![settings.fabricWidthMm, settings.gapMm, settings.wastePercent].every(Number.isFinite) || settings.fabricWidthMm <= 0 || settings.gapMm < 0 || settings.wastePercent < 0 || settings.wastePercent > 1000) throw new Error('Invalid marker width, gap or waste allowance.');
  if (!pattern.materials.some(material => material.id === settings.materialId)) throw new Error('Missing fabric reference.');
  const selected = materialMarkerPattern(pattern, settings.materialId);
  const items = buildNestItems(selected);
  const expectedCopies = selected.pieces.reduce((sum, piece) => sum + pieceCutCounts(piece).total, 0);
  if (!items.length || items.length !== expectedCopies) throw new Error('Every fabric cut copy must have a valid closed outline.');
  const ids = new Set(items.map(item => item.instanceId));
  if (layout.placements.length !== items.length || new Set(layout.placements.map(placement => placement.instanceId)).size !== items.length || layout.placements.some(placement => !ids.has(placement.instanceId ?? ''))) throw new Error('Marker cut copies do not match the fabric pieces.');
  if (layout.fabricWidthMm !== settings.fabricWidthMm || layout.gapMm !== settings.gapMm || !Number.isFinite(layout.usedLengthMm) || layout.usedLengthMm <= 0) throw new Error('Marker constraints do not match the calculation.');
  if (layout.bins !== undefined) throw new Error('Production consumption requires one continuous fabric marker; recalculate without multiple sheet bins.');
  const epsilon = 1e-5;
  const originals = new Map(items.map(item => [item.instanceId, item]));
  let actualMaxY = 0;
  for (const placement of layout.placements) {
    if (placement.poly.length < 3 || placement.poly.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < settings.gapMm - epsilon || p.x > settings.fabricWidthMm - settings.gapMm + epsilon || p.y < settings.gapMm - epsilon || p.y > layout.usedLengthMm - settings.gapMm + epsilon)) throw new Error('Marker piece is outside the fabric bounds or boundary spacing.');
    const rotation = ((placement.rotationDeg ?? 0) % 360 + 360) % 360;
    if (rotation !== 0 && !(settings.allowHalfTurn && rotation === 180)) throw new Error('Marker violates the configured grain/nap direction.');
    const original = originals.get(placement.instanceId!);
    if (!original || original.pieceId !== placement.pieceId || original.cut.length !== placement.poly.length || !Number.isFinite(original.area) || original.area <= epsilon) throw new Error('Marker cut geometry or piece reference does not match the source.');
    const radians = rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
    const source = original.cut.map(point => ({ x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine }));
    const offset = { x: placement.poly[0].x - source[0].x, y: placement.poly[0].y - source[0].y };
    if (source.some((point, index) => Math.abs(point.x + offset.x - placement.poly[index].x) > epsilon || Math.abs(point.y + offset.y - placement.poly[index].y) > epsilon)) throw new Error('Marker polygon is not a rigid placement of the actual cut outline.');
    actualMaxY = Math.max(actualMaxY, ...placement.poly.map(point => point.y));
  }
  for (let a = 0; a < layout.placements.length; a++) for (let b = a + 1; b < layout.placements.length; b++) {
    const first = layout.placements[a].poly, second = layout.placements[b].poly;
    if (polysOverlap(first, second)) throw new Error('Marker pieces overlap.');
    if (settings.gapMm > epsilon && polygonSeparation(first, second, settings.gapMm - epsilon) < settings.gapMm - epsilon) throw new Error('Marker violates the configured minimum piece spacing.');
  }
  const length = actualMaxY + settings.gapMm;
  if (Math.abs(layout.usedLengthMm - length) > epsilon) throw new Error('Marker length does not match the actual cut extents and boundary spacing.');
  const efficiency = Math.min(1, items.reduce((sum, item) => sum + item.area, 0) / Math.max(1, settings.fabricWidthMm * (length - settings.gapMm)));
  if (layout.efficiency !== undefined && (!Number.isFinite(layout.efficiency) || Math.abs(layout.efficiency - efficiency) > epsilon)) throw new Error('Marker efficiency does not match the actual cut geometry.');
  const purchaseLengthM = length / 1000 * (1 + settings.wastePercent / 100);
  if (!Number.isFinite(purchaseLengthM)) throw new Error('Invalid purchase length.');
  return { materialId: settings.materialId, settings: { ...settings }, inputFingerprint: consumptionFingerprint(pattern, settings), calculatedAt: now.toISOString(), method: 'true-shape-marker', usedLengthMm: length, purchaseLengthM, efficiency, cutCopies: items.length,
    placements: layout.placements.map(placement => ({ instanceId: placement.instanceId!, pieceId: placement.pieceId, rotationDeg: placement.rotationDeg ?? 0, polygon: placement.poly.map(point => ({ ...point })) })) };
}

/** Minimum distance between disjoint closed boundaries; overlap is checked separately. */
function polygonSeparation(first: { x: number; y: number }[], second: { x: number; y: number }[], requiredGap: number): number {
  const bounds = (poly: { x: number; y: number }[]) => ({ minX: Math.min(...poly.map(p => p.x)), maxX: Math.max(...poly.map(p => p.x)), minY: Math.min(...poly.map(p => p.y)), maxY: Math.max(...poly.map(p => p.y)) });
  const a = bounds(first), b = bounds(second);
  const boxDistance = Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minY - b.maxY, b.minY - a.maxY));
  const pointSegment = (point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }) => {
    const dx = to.x - from.x, dy = to.y - from.y, denominator = dx * dx + dy * dy;
    const fraction = denominator ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / denominator)) : 0;
    return Math.hypot(point.x - from.x - fraction * dx, point.y - from.y - fraction * dy);
  };
  let distance = Infinity;
  // This lower bound lets the caller skip expensive boundary pairs that are obviously separated.
  if (boxDistance >= requiredGap) return boxDistance;
  for (let i = 0; i < first.length; i++) for (let j = 0; j < second.length; j++) {
    distance = Math.min(distance, pointSegment(first[i], second[j], second[(j + 1) % second.length]), pointSegment(second[j], first[i], first[(i + 1) % first.length]));
    if (distance === 0) return 0;
  }
  return distance;
}

export function calculateProductionConsumption(pattern: Pattern, settings: ProductionMarkerSettings): ProductionConsumption {
  const layout = nestPiecesTrueShape(materialMarkerPattern(pattern, settings.materialId), { fabricWidthMm: settings.fabricWidthMm, gapMm: settings.gapMm, allowedRotations: settings.allowHalfTurn ? [0, 180] : [0] });
  return markerConsumptionFromLayout(pattern, settings, layout);
}
const markerValidationCache = new Map<string, { signature: string; valid: boolean }>();
export function resolveProductionConsumption(pattern: Pattern, materialId: string) {
  const record = pattern.productionAutomation?.consumption.find(row => row.materialId === materialId);
  if (!record) return { record, quantity: null, status: 'Not calculated' };
  const settings = pattern.productionAutomation?.markerSettings.find(row => row.materialId === materialId);
  if (!settings || !pattern.materials.some(material => material.id === materialId)) return { record, quantity: null, status: 'Missing fabric or marker settings' };
  if (record.inputFingerprint !== consumptionFingerprint(pattern, settings)) return { record, quantity: null, status: 'Stale · recalculate marker' };
  const expected = record.usedLengthMm / 1000 * (1 + settings.wastePercent / 100);
  if (!Number.isFinite(record.purchaseLengthM) || record.purchaseLengthM < 0 || Math.abs(record.purchaseLengthM - expected) > 1e-9 * Math.max(1, expected)) return { record, quantity: null, status: 'Invalid marker quantity' };
  const key = `${pattern.id}:${materialId}`;
  const signature = JSON.stringify({ record, settings });
  const cached = markerValidationCache.get(key);
  if (cached?.signature === signature) return { record, quantity: cached.valid ? record.purchaseLengthM : null, status: cached.valid ? 'Current true-shape marker' : 'Invalid marker layout · recalculate' };
  const cache = (valid: boolean) => {
    markerValidationCache.delete(key); markerValidationCache.set(key, { signature, valid });
    while (markerValidationCache.size > 8) markerValidationCache.delete(markerValidationCache.keys().next().value!);
  };
  try {
    if (Object.keys(settings).some(key => record.settings[key as keyof ProductionMarkerSettings] !== settings[key as keyof ProductionMarkerSettings])) throw new Error('Marker settings differ from the recorded layout.');
    const checked = markerConsumptionFromLayout(pattern, settings, {
      fabricWidthMm: settings.fabricWidthMm, usedLengthMm: record.usedLengthMm, gapMm: settings.gapMm,
      ...(record.efficiency === null ? {} : { efficiency: record.efficiency }),
      placements: record.placements.map(row => ({ instanceId: row.instanceId, pieceId: row.pieceId, name: '', rotationDeg: row.rotationDeg, poly: row.polygon, outline: row.polygon, bbox: { w: 0, h: 0 } }))
    });
    if (checked.cutCopies !== record.cutCopies || Math.abs(checked.purchaseLengthM - record.purchaseLengthM) > 1e-9) throw new Error('Recorded quantity does not match the checked marker.');
  } catch { cache(false); return { record, quantity: null, status: 'Invalid marker layout · recalculate' }; }
  cache(true);
  return { record, quantity: record.purchaseLengthM, status: 'Current true-shape marker' };
}

/** Invalid optional extensions do not enter the application document. */
export function normalizeProductionAutomation(value: unknown): ProductionAutomation | undefined {
  try { validateProductionAutomation(value); return structuredClone(value); } catch { return undefined; }
}
