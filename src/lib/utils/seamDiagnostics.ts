import { indexPaths, indexPoints, piecePathPolyline, pieceTransform, pieceShrinkageScale, resolveAssembly, type Pattern, type Seam, type Assembly } from '@seamer/pattern-model';
export interface SeamEaseSettings { expectedEaseMm?: number; toleranceMm?: number }
export interface SeamDiagnostic { fromMm: number | null; toMm: number | null; easeMm: number | null; expectedEaseMm: number; toleranceMm: number; deviationMm: number | null; status: 'matched' | 'mismatch' | 'unresolved'; missing: string[] }
/** Sewing-line lengths, including material compensation. Mirroring and direction do not alter length. */
export function diagnoseSeam(pattern: Pattern, seam: Seam & SeamEaseSettings): SeamDiagnostic {
  const points = indexPoints(pattern), paths = indexPaths(pattern), missing: string[] = [];
  const measure = (refs: Seam['fromPaths']) => {
    let sum = 0;
    for (const ref of refs) {
      const piece = pattern.pieces.find(piece => [...piece.mainPaths, ...piece.internalPaths].some(edge => edge.id === ref.id));
      const edge = piece && [...piece.mainPaths, ...piece.internalPaths].find(edge => edge.id === ref.id);
      if (!piece || !edge) { missing.push(ref.id); continue; }
      const transform = pieceTransform(piece, points, pieceShrinkageScale(pattern, piece));
      const poly = piecePathPolyline(edge, paths, points, 0.5).map(transform);
      if (poly.length < 2 || poly.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) { missing.push(ref.id); continue; }
      for (let i = 1; i < poly.length; i++) sum += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
    }
    return refs.length ? sum : null;
  };
  const fromMm = measure(seam.fromPaths), toMm = measure(seam.toPaths);
  const expectedEaseMm = Number.isFinite(seam.expectedEaseMm) ? seam.expectedEaseMm! : 0;
  const toleranceMm = Number.isFinite(seam.toleranceMm) && seam.toleranceMm! >= 0 ? seam.toleranceMm! : 1;
  const easeMm = !missing.length && fromMm !== null && toMm !== null ? fromMm - toMm : null;
  const deviationMm = easeMm === null ? null : easeMm - expectedEaseMm;
  return { fromMm: missing.length ? null : fromMm, toMm: missing.length ? null : toMm, easeMm, expectedEaseMm, toleranceMm, deviationMm,
    status: deviationMm === null ? 'unresolved' : Math.abs(deviationMm) <= toleranceMm + 1e-7 ? 'matched' : 'mismatch', missing };
}
/** Materialise implicit steps before edits so every seam stays in the assembly order. */
export function editableAssembly(pattern: Pattern): Assembly {
  return { ...pattern.assembly, steps: resolveAssembly(pattern).map(({ id, label, seamIds, settleFrames }) => ({ id, label, seamIds: [...seamIds], settleFrames })) };
}
export function moveAssemblyStep(pattern: Pattern, id: string, delta: -1 | 1): Pattern {
  const assembly = editableAssembly(pattern), index = assembly.steps.findIndex(step => step.id === id), target = index + delta;
  if (index < 0 || target < 0 || target >= assembly.steps.length) return pattern;
  [assembly.steps[index], assembly.steps[target]] = [assembly.steps[target], assembly.steps[index]];
  return { ...pattern, assembly, hasChanged: true };
}
export function splitAssemblySeams(pattern: Pattern): Pattern {
  const resolved = resolveAssembly(pattern), byId = new Map(pattern.seams.map(seam => [seam.id, seam]));
  return { ...pattern, assembly: { ...pattern.assembly, steps: resolved.flatMap(step => step.seamIds.map(id => ({ id: `step-${id}`, label: byId.get(id)?.name || id, seamIds: [id], settleFrames: step.settleFrames }))) }, hasChanged: true };
}
