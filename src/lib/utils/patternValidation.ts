// Pattern integrity checks — surfaces broken references and degenerate geometry the way the
// original studio's "Errors" panel does. Pure: takes a Pattern, returns a list of issues.

import type { Pattern } from '@seamer/pattern-model';
import { indexPoints, indexPaths, pieceOutline } from '$lib/utils/patternGeometry';
import { resolveVariables } from '@seamer/pattern-model/solver/solve';
import { evalExpr } from '@seamer/pattern-model/solver/formula';

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
  /** id of the offending object, if selectable */
  targetId?: string;
}

export function validatePattern(pattern: Pattern): Issue[] {
  const issues: Issue[] = [];
  const points = indexPoints(pattern);
  const paths = indexPaths(pattern);
  const piecePathIds = new Set<string>();
  for (const piece of pattern.pieces) {
    for (const pp of piece.mainPaths) piecePathIds.add(pp.id);
    for (const pp of piece.internalPaths) piecePathIds.add(pp.id);
  }

  // duplicate point names
  const nameCounts = new Map<string, number>();
  for (const pt of pattern.points) nameCounts.set(pt.name, (nameCounts.get(pt.name) ?? 0) + 1);
  for (const [nm, n] of nameCounts) {
    if (nm && n > 1) issues.push({ severity: 'warning', message: `Duplicate point name "${nm}" (${n} points)` });
  }

  // paths referencing missing points
  for (const path of pattern.paths) {
    for (const pp of path.pathPoints) {
      if (!points.has(pp.id)) {
        issues.push({ severity: 'error', message: `Path "${path.name || path.id}" references a missing point`, targetId: path.id });
        break;
      }
    }
  }

  // piece-level checks
  for (const piece of pattern.pieces) {
    if (piece.mainPaths.length < 3) {
      issues.push({ severity: 'error', message: `Piece "${piece.name}" has fewer than 3 boundary edges`, targetId: piece.id });
    }
    for (const pp of [...piece.mainPaths, ...piece.internalPaths]) {
      if (pp.path && !paths.has(pp.path)) {
        issues.push({ severity: 'error', message: `Piece "${piece.name}": edge "${pp.name || pp.id}" references a missing path`, targetId: piece.id });
      }
      if (!points.has(pp.from) || !points.has(pp.to)) {
        issues.push({ severity: 'error', message: `Piece "${piece.name}": edge "${pp.name || pp.id}" has a missing endpoint`, targetId: piece.id });
      }
    }
    // boundary fails to stitch into a closed loop
    if (piece.mainPaths.length >= 3) {
      const outline = pieceOutline(pattern, piece, paths, points, 8);
      if (outline.length < 3) {
        issues.push({ severity: 'warning', message: `Piece "${piece.name}" boundary does not form a closed loop`, targetId: piece.id });
      }
    }
  }

  // seams referencing missing piece-path edges
  for (const seam of pattern.seams) {
    for (const ref of [...seam.fromPaths, ...seam.toPaths]) {
      if (!piecePathIds.has(ref.id)) {
        issues.push({ severity: 'error', message: `Seam "${seam.name || seam.id}" references a deleted edge`, targetId: seam.id });
        break;
      }
    }
  }

  issues.push(...diagnoseConstraints(pattern));
  return issues;
}

/**
 * Categorized constraint diagnostics (the original's "Constraint issue" reporting: point-formula,
 * length-formula, angle-formula, sliding-path/position, missing-driver…). Each issue names the
 * offending point and the category so unsatisfiable constructions are findable.
 */
export function diagnoseConstraints(pattern: Pattern): Issue[] {
  const issues: Issue[] = [];
  if (!pattern.points.some((p) => p.constraint)) return issues;
  const scope = resolveVariables(pattern);
  const pointIds = new Set(pattern.points.map((p) => p.id));
  const pathIds = new Set(pattern.paths.map((p) => p.id));
  const bad = (category: string, pointName: string, detail: string, targetId: string) =>
    issues.push({ severity: 'error', message: `Constraint issue (${category}) on "${pointName}": ${detail}`, targetId });
  const checkFormula = (category: string, pointName: string, expr: string | undefined, targetId: string) => {
    if (expr?.trim() && evalExpr(expr, scope) === null) bad(category, pointName, `formula "${expr}" does not evaluate`, targetId);
  };
  const checkDriver = (pointName: string, id: string | undefined, targetId: string) => {
    if (id && !pointIds.has(id)) bad('missing-driver', pointName, 'references a deleted point', targetId);
  };
  for (const p of pattern.points) {
    const c = p.constraint;
    if (!c) continue;
    const nm = p.name || p.id;
    if (c.type === 'offset') {
      checkDriver(nm, c.from, p.id);
      checkFormula('point-formula', nm, c.dxFormula, p.id);
      checkFormula('point-formula', nm, c.dyFormula, p.id);
    } else if (c.type === 'lengthAngle') {
      checkDriver(nm, c.from, p.id);
      checkFormula('length-formula', nm, c.lengthFormula, p.id);
      checkFormula('angle-formula', nm, c.angleFormula, p.id);
    } else if (c.type === 'sliding') {
      if (!pathIds.has(c.path)) bad('sliding-path', nm, 'slides on a deleted path', p.id);
      checkDriver(nm, c.from, p.id);
      checkFormula('sliding-position', nm, c.positionFormula, p.id);
      if (c.fraction !== undefined && (c.fraction < 0 || c.fraction > 1)) {
        issues.push({ severity: 'warning', message: `Constraint issue (sliding-order) on "${nm}": fraction ${c.fraction} is outside 0..1`, targetId: p.id });
      }
    } else if (c.type === 'mirror') {
      checkDriver(nm, c.source, p.id);
      if (!pathIds.has(c.axisPath)) bad('sliding-path', nm, 'mirrors across a deleted path', p.id);
    } else if (c.type === 'intersection') {
      checkDriver(nm, c.a, p.id);
      checkDriver(nm, c.b, p.id);
      checkFormula('angle-formula', nm, c.aAngleFormula, p.id);
      checkFormula('angle-formula', nm, c.bAngleFormula, p.id);
    }
  }
  return issues;
}
