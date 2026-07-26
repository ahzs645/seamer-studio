// Parametric constraint solver: resolves variables from formulas, then computes the positions of
// formula-constrained points (offset / length+angle / sliding) in dependency order. Points without a
// `constraint` keep their fixed x/y. Enables measurement-driven re-drafting and true grading.

import type { Pattern, ConstrainablePoint, ConstrainablePath, AlterationDelta, AlterationTrack, PathPoint, BezierHandle, PiecePath } from '../pattern';
import { evalExpr, referencedNames } from './formula';

export type Scope = Record<string, number>;

/**
 * Resolve all variables (+ body measurements) to a scope. Each variable is bound by BOTH its id and
 * its name (the source's formulas reference variables by id; authored constraints use names).
 * `overrides` are per-variable-id (used for grading sizes).
 */
export function resolveVariables(pattern: Pattern, overrides: Record<string, number> = {}): Scope {
  const scope: Scope = {};
  for (const [name, value] of Object.entries(pattern.body?.fields ?? {})) scope[name] = value as number;
  const bind = (v: Pattern['variables'][number], val: number) => { scope[v.id] = val; if (v.name) scope[v.name] = val; };

  // identifiers that count as a real dependency (other variables / body measurements)
  const known = new Set<string>(Object.keys(pattern.body?.fields ?? {}));
  for (const v of pattern.variables) { known.add(v.id); if (v.name) known.add(v.name); }
  const isDerived = (f: string) => referencedNames(f).some((n) => known.has(n));

  const resolved = new Set<string>();
  let changed = true;
  let guard = pattern.variables.length + 3;
  while (changed && guard-- > 0) {
    changed = false;
    for (const v of pattern.variables) {
      if (resolved.has(v.id)) continue;
      if (v.id in overrides) { bind(v, overrides[v.id]); resolved.add(v.id); changed = true; continue; }
      const f = v.valueFormula?.formula?.trim();
      // Leaf/input variable (constant or no formula): use the cached `value` — it's the current value
      // the baked geometry was resolved with (the user may have overridden the formula default).
      if (!f || !isDerived(f)) {
        bind(v, typeof v.value === 'number' ? v.value : (f ? evalExpr(f, scope) ?? 0 : 0));
        resolved.add(v.id); changed = true; continue;
      }
      // Derived variable: evaluate its formula from its inputs (so edits/grading propagate).
      const r = evalExpr(f, scope);
      if (r !== null) { bind(v, r); resolved.add(v.id); changed = true; }
    }
  }
  for (const v of pattern.variables) if (!resolved.has(v.id)) bind(v, v.value ?? 0);
  return scope;
}

type Pt = { x: number; y: number };

/** Position `dist` mm along a polyline (straight segments between anchors), clamped to its ends. */
function pointAlong(anchors: Pt[], dist: number): Pt {
  if (anchors.length === 1) return { ...anchors[0] };
  let remaining = dist;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= segLen || i === anchors.length - 1) {
      const t = segLen > 0 ? Math.max(0, remaining) / segLen : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= segLen;
  }
  return { ...anchors[anchors.length - 1] };
}

const UNIT_MM: Record<string, number> = { cm: 10, mm: 1, inch: 25.4, in: 25.4 };
const unitToMm = (u?: string) => UNIT_MM[u ?? ''] ?? 1;

function cubicAt(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const mt = 1 - t, w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
  return { x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x, y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y };
}

/** Geometric length (mm) of a path from its currently-solved anchors (cubic when handles exist). */
function pathLengthMm(path: ConstrainablePath, solved: Map<string, Pt>): number | null {
  const seq = path.pathPoints.map((pp) => ({ p: solved.get(pp.id), h: pp.handle }));
  if (seq.some((s) => !s.p)) return null;
  let L = 0;
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1].p!, b = seq[i].p!;
    const out = seq[i - 1].h?.v2, inc = seq[i].h?.v1;
    if (out || inc) {
      const c1 = out ? { x: a.x + out.x, y: a.y + out.y } : a;
      const c2 = inc ? { x: b.x + inc.x, y: b.y + inc.y } : b;
      let prev = a;
      for (let s = 1; s <= 16; s++) { const q = cubicAt(a, c1, c2, b, s / 16); L += Math.hypot(q.x - prev.x, q.y - prev.y); prev = q; }
    } else L += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return L;
}

/** Replace `PathId.length` tokens with the path's length expressed in `unit`. null if unresolvable yet. */
function subLengths(formula: string, unit: string, solved: Map<string, Pt>, pathById: Map<string, ConstrainablePath>): string | null {
  formula = formula.replace(/[{}]/g, ''); // source wraps `{Path_id.length}` in braces
  if (!/\.length/.test(formula)) return formula;
  let ok = true;
  const r = formula.replace(/([A-Za-z_$][\w$]*)\.length/g, (_m, id) => {
    const path = pathById.get(id);
    const L = path ? pathLengthMm(path, solved) : null;
    if (L === null) { ok = false; return '0'; }
    return String(L / unitToMm(unit));
  });
  return ok ? r : null;
}

// --- Geometric-reference tokens (the formula picker's Point coordinates / Point angles / Curve
// handles categories). These resolve against already-solved geometry, so they return null when a
// referenced point/path isn't solved yet (the solver retries on the next sweep, exactly like path
// `.length`). All are no-ops on formulas that don't contain them, so existing formulas are unchanged.

const RAD2DEG = 180 / Math.PI;
/** The BezierHandle on `pointId` within `pathId`, if any. */
function handleOf(pathById: Map<string, ConstrainablePath>, pathId: string, pointId: string): BezierHandle | undefined {
  return pathById.get(pathId)?.pathPoints.find((pp) => pp.id === pointId)?.handle;
}
/** Tangent direction (deg) of `pathId` at `pointId`: outgoing handle if any, else toward the next (or previous) point. */
function pointTangentDeg(path: ConstrainablePath | undefined, pointId: string, solved: Map<string, Pt>): number | null {
  if (!path) return null;
  const idx = path.pathPoints.findIndex((pp) => pp.id === pointId);
  if (idx < 0) return null;
  const cur = solved.get(pointId); if (!cur) return null;
  const h = path.pathPoints[idx].handle;
  if (h?.v2 && (h.v2.x || h.v2.y)) return Math.atan2(h.v2.y, h.v2.x) * RAD2DEG;
  const nxt = idx + 1 < path.pathPoints.length ? solved.get(path.pathPoints[idx + 1].id) : undefined;
  if (nxt) return Math.atan2(nxt.y - cur.y, nxt.x - cur.x) * RAD2DEG;
  const prv = idx - 1 >= 0 ? solved.get(path.pathPoints[idx - 1].id) : undefined;
  if (prv) return Math.atan2(cur.y - prv.y, cur.x - prv.x) * RAD2DEG;
  return null;
}

/**
 * Substitute length-like geometric tokens (expressed in `unit`): curve-handle lengths
 * `Path.Point.handle.length` / `.length2` (v1 / v2 vector magnitude) and point coordinates
 * `Point.x` / `Point.y`. Must run BEFORE subLengths so handle tokens are consumed before the bare
 * `.length` regex sees them. Returns null if any reference is unresolved; unchanged if none present.
 */
function subGeometryLengths(formula: string, unit: string, solved: Map<string, Pt>, pathById: Map<string, ConstrainablePath>): string | null {
  let f = formula.replace(/[{}]/g, '');
  let ok = true;
  const toUnit = (mm: number) => String(mm / unitToMm(unit));
  // handle vector lengths (4-segment) first
  f = f.replace(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.handle\.length2\b/g, (_m, pa, pt) => {
    const h = handleOf(pathById, pa, pt); if (!h) { ok = false; return '0'; } return toUnit(Math.hypot(h.v2.x, h.v2.y));
  });
  f = f.replace(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.handle\.length\b/g, (_m, pa, pt) => {
    const h = handleOf(pathById, pa, pt); if (!h) { ok = false; return '0'; } return toUnit(Math.hypot(h.v1.x, h.v1.y));
  });
  // point coordinates (mm) — x/y are absolute drafting coords
  f = f.replace(/([A-Za-z_$][\w$]*)\.([xy])\b/g, (_m, id, axis) => {
    const p = solved.get(id); if (!p) { ok = false; return '0'; } return toUnit(axis === 'x' ? p.x : p.y);
  });
  return ok ? f : null;
}

/**
 * Substitute angle-like geometric tokens (degrees): curve-handle angles `Path.Point.handle.angle` /
 * `.angle2` and per-point path tangents `Path.Point.angle`. Must run BEFORE the bare `.angle` regex
 * so these are consumed first. Returns null if unresolved; unchanged if none present.
 */
function subGeometryAngles(formula: string, solved: Map<string, Pt>, pathById: Map<string, ConstrainablePath>): string | null {
  let f = formula;
  let ok = true;
  f = f.replace(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.handle\.angle2\b/g, (_m, pa, pt) => {
    const h = handleOf(pathById, pa, pt); if (!h) { ok = false; return '0'; } return String(Math.atan2(h.v2.y, h.v2.x) * RAD2DEG);
  });
  f = f.replace(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.handle\.angle\b/g, (_m, pa, pt) => {
    const h = handleOf(pathById, pa, pt); if (!h) { ok = false; return '0'; } return String(Math.atan2(h.v1.y, h.v1.x) * RAD2DEG);
  });
  // per-point path tangent (2-segment): Path.Point.angle
  f = f.replace(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.angle\b/g, (_m, pa, pt) => {
    const a = pointTangentDeg(pathById.get(pa), pt, solved); if (a === null) { ok = false; return '0'; } return String(a);
  });
  return ok ? f : null;
}

function evalLen(formula: string, unit: string, scope: Scope, solved: Map<string, Pt>, pathById: Map<string, ConstrainablePath>): number | null {
  const geo = subGeometryLengths(formula, unit, solved, pathById);
  if (geo === null) return null;
  const sub = subLengths(geo, unit, solved, pathById);
  if (sub === null) return null;
  const r = evalExpr(sub, scope);
  return r === null ? null : r * unitToMm(unit);
}
function evalAngleDeg(formula: string, unit: string | undefined, scope: Scope, solved: Map<string, Pt>, pathById: Map<string, ConstrainablePath>): number | null {
  let f: string | null = subGeometryLengths(formula, 'mm', solved, pathById); // handle lengths / point coords stay in mm
  if (f === null) return null;
  f = subLengths(f, 'mm', solved, pathById); // any path-length ref in an angle stays in mm
  if (f === null) return null;
  f = subGeometryAngles(f, solved, pathById); // handle angles + per-point tangents (consumed before bare .angle)
  if (f === null) return null;
  if (/\.angle/.test(f)) {
    // `PathId.angle` → the path's direction (first→last endpoint), in degrees
    let ok = true;
    f = f.replace(/([A-Za-z_$][\w$]*)\.angle/g, (_m, id) => {
      const ends = axisEnds(pathById.get(id), solved);
      if (!ends) { ok = false; return '0'; }
      return String((Math.atan2(ends[1].y - ends[0].y, ends[1].x - ends[0].x) * 180) / Math.PI);
    });
    if (!ok) return null;
  }
  const r = evalExpr(f, scope);
  return r === null ? null : r * (unit === 'radians' ? 180 / Math.PI : 1);
}

/** Reflect P across the line through A and B. */
function reflect(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy || 1;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / d;
  const px = a.x + t * dx, py = a.y + t * dy;
  return { x: 2 * px - p.x, y: 2 * py - p.y };
}
/** The two endpoints (first/last solved pathPoints) defining a path's line, or null if unsolved. */
function axisEnds(path: ConstrainablePath | undefined, solved: Map<string, Pt>): [Pt, Pt] | null {
  if (!path || path.pathPoints.length < 2) return null;
  const a = solved.get(path.pathPoints[0].id), b = solved.get(path.pathPoints[path.pathPoints.length - 1].id);
  return a && b ? [a, b] : null;
}

/** Compute a constrained point's position, or null if its dependencies aren't solved yet. */
function constraintPos(cn: NonNullable<ConstrainablePoint['constraint']>, scope: Scope, solved: Map<string, Pt>, pathById: Map<string, ConstrainablePath>): Pt | null {
  if (cn.type === 'offset') {
    const a = solved.get(cn.from); if (!a) return null;
    const dx = evalLen(cn.dxFormula, cn.unit ?? 'mm', scope, solved, pathById);
    const dy = evalLen(cn.dyFormula, cn.unit ?? 'mm', scope, solved, pathById);
    return dx === null || dy === null ? null : { x: a.x + dx, y: a.y + dy };
  }
  if (cn.type === 'lengthAngle') {
    const a = solved.get(cn.from); if (!a) return null;
    const len = evalLen(cn.lengthFormula, cn.lengthUnit ?? 'mm', scope, solved, pathById);
    const ang = evalAngleDeg(cn.angleFormula, cn.angleUnit ?? 'degrees', scope, solved, pathById);
    if (len === null || ang === null) return null;
    const r = (ang * Math.PI) / 180;
    return { x: a.x + len * Math.cos(r), y: a.y + len * Math.sin(r) };
  }
  if (cn.type === 'mirror') {
    const src = solved.get(cn.source); const ax = axisEnds(pathById.get(cn.axisPath), solved);
    return src && ax ? reflect(src, ax[0], ax[1]) : null;
  }
  if (cn.type === 'intersection') {
    const pa = solved.get(cn.a), pb = solved.get(cn.b); if (!pa || !pb) return null;
    const aDeg = evalAngleDeg(cn.aAngleFormula, cn.aAngleUnit ?? 'degrees', scope, solved, pathById);
    const bDeg = evalAngleDeg(cn.bAngleFormula, cn.bAngleUnit ?? 'degrees', scope, solved, pathById);
    if (aDeg === null || bDeg === null) return null;
    const ar = (aDeg * Math.PI) / 180, br = (bDeg * Math.PI) / 180;
    const d1x = Math.cos(ar), d1y = Math.sin(ar), d2x = Math.cos(br), d2y = Math.sin(br);
    const den = d1x * d2y - d1y * d2x; if (Math.abs(den) < 1e-9) return null; // parallel rays
    // pa + t·d1 = pb + s·d2  →  solve for t
    const t = ((pb.x - pa.x) * d2y - (pb.y - pa.y) * d2x) / den;
    return { x: pa.x + t * d1x, y: pa.y + t * d1y };
  }
  // sliding: a point on a path — by a fixed arc-length fraction, or a distance formula from an anchor
  const path = pathById.get(cn.path); if (!path) return null;
  const anchors = path.pathPoints.map((pp) => solved.get(pp.id));
  if (anchors.some((a) => !a)) return null;
  const pts = anchors as Pt[];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (cn.fraction != null) return pointAlong(pts, total * cn.fraction);
  const dist = evalLen(cn.positionFormula ?? '0', cn.unit ?? 'mm', scope, solved, pathById);
  if (dist === null) return null;
  let base = 0;
  if (cn.from) {
    let cum = 0;
    for (let i = 1; i < path.pathPoints.length; i++) {
      if (path.pathPoints[i - 1].id === cn.from) { base = cum; break; }
      cum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
  }
  return pointAlong(pts, base + dist);
}

/** Solve every point's position given a variable scope. Fixed points keep x/y; constrained points compute. */
export function solvePoints(pattern: Pattern, scope: Scope): Map<string, Pt> {
  const out = new Map<string, Pt>();
  for (const p of pattern.points) if (!p.constraint) out.set(p.id, { x: p.x, y: p.y });
  const pathById = new Map(pattern.paths.map((pa) => [pa.id, pa]));

  let changed = true;
  let guard = pattern.points.length + 6;
  while (changed && guard-- > 0) {
    changed = false;
    for (const p of pattern.points) {
      if (out.has(p.id) || !p.constraint) continue;
      const pos = constraintPos(p.constraint, scope, out, pathById);
      if (pos) { out.set(p.id, pos); changed = true; }
    }
  }
  // unresolved constrained points (cycles / missing deps) → keep their last baked position
  for (const p of pattern.points) if (!out.has(p.id)) out.set(p.id, { x: p.x, y: p.y });
  return out;
}

/** Any point in the pattern is parametrically constrained? */
export function hasConstraints(pattern: Pattern): boolean {
  if (pattern.points.some((p) => !!p.constraint)) return true;
  // property formulas (seam allowance / rotation / grain / condition / notch distance) also redraft
  return pattern.pieces.some((piece) =>
    piece.rotationFormula?.formula || piece.grainFormula?.formula || piece.conditionFormula?.formula ||
    [...piece.mainPaths, ...piece.internalPaths].some((pp) =>
      pp.seamAllowanceFormula?.formula || pp.cornerRadiusFormula?.formula ||
      pp.seamCornerLengthFormula?.formula || pp.seamCornerMaxLengthFormula?.formula ||
      pp.notches?.some((n) => n.distanceFormula?.formula)));
}

// ---------------------------------------------------------------------------
// Alterations (grading by example): point/handle deltas sampled at driver values, linearly interpolated.
// Faithful port of the source — additive deltas, implicit zero sample, linear extrapolation past the ends.
// ---------------------------------------------------------------------------

const ALT_NEAR = 1e-6;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ZH = { v1: { x: 0, y: 0 }, v2: { x: 0, y: 0 } };

export function emptyDelta(): AlterationDelta {
  return { points: {}, handles: {} };
}
function cloneDelta(d: AlterationDelta): AlterationDelta {
  return JSON.parse(JSON.stringify(d ?? emptyDelta()));
}
const handleKey = (pathId: string, pointId: string) => `${pathId}:${pointId}`;

/** Linearly blend two deltas (union of keys; missing keys treated as zero). */
function interpolateDelta(A: AlterationDelta, B: AlterationDelta, t: number): AlterationDelta {
  const out = emptyDelta();
  for (const id of new Set([...Object.keys(A.points), ...Object.keys(B.points)])) {
    const a = A.points[id] ?? { x: 0, y: 0 }, b = B.points[id] ?? { x: 0, y: 0 };
    out.points[id] = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  }
  for (const id of new Set([...Object.keys(A.handles), ...Object.keys(B.handles)])) {
    const a = A.handles[id] ?? ZH, b = B.handles[id] ?? ZH;
    out.handles[id] = {
      v1: { x: lerp(a.v1.x, b.v1.x, t), y: lerp(a.v1.y, b.v1.y, t) },
      v2: { x: lerp(a.v2.x, b.v2.x, t), y: lerp(a.v2.y, b.v2.y, t) }
    };
  }
  return out;
}

/** The interpolated delta for a track at a given driver value (null if the track has no samples). */
export function alterationDeltaAtDriver(track: AlterationTrack, driverValue: number): AlterationDelta | null {
  const exact = track.samples.find((s) => Math.abs(s.driverValue - driverValue) <= ALT_NEAR);
  if (exact) return cloneDelta(exact.deltaGeometry);
  const s = [...track.samples];
  if (!s.some((x) => Math.abs(x.driverValue) <= ALT_NEAR)) s.push({ id: 'implicit-zero', driverValue: 0, deltaGeometry: emptyDelta() });
  s.sort((a, b) => a.driverValue - b.driverValue);
  if (s.length < 2) return null;
  let r = s[0], o = s[1];
  if (driverValue <= s[0].driverValue) { r = s[0]; o = s[1]; }
  else if (driverValue >= s[s.length - 1].driverValue) { r = s[s.length - 2]; o = s[s.length - 1]; }
  else for (let i = 0; i < s.length - 1; i++) { if (driverValue >= s[i].driverValue && driverValue <= s[i + 1].driverValue) { r = s[i]; o = s[i + 1]; break; } }
  const l = o.driverValue - r.driverValue;
  const h = Math.abs(l) <= ALT_NEAR ? 0 : (driverValue - r.driverValue) / l;
  return interpolateDelta(r.deltaGeometry, o.deltaGeometry, h);
}

/** Accumulate every enabled track's interpolated delta into one combined additive delta for `scope`. */
export function combinedAlterationDelta(pattern: Pattern, scope: Scope): AlterationDelta {
  const out = emptyDelta();
  const gp = pattern.gradingProfile;
  const tracks = gp?.alterationTracks ?? [];
  if (!tracks.length) return out;
  const preview = gp?.previewAlterationTrackId ?? null;
  for (const track of tracks) {
    if (preview && track.id !== preview) continue;
    if (!track.enabled || !track.driverVariableId || track.samples.length === 0) continue;
    const driverValue = scope[track.driverVariableId];
    if (typeof driverValue !== 'number' || !isFinite(driverValue)) continue;
    const d = alterationDeltaAtDriver(track, driverValue);
    if (!d) continue;
    for (const id of Object.keys(d.points)) {
      const p = d.points[id]; const cur = out.points[id] ?? { x: 0, y: 0 };
      out.points[id] = { x: cur.x + p.x, y: cur.y + p.y };
    }
    for (const id of Object.keys(d.handles)) {
      const hd = d.handles[id]; const cur = out.handles[id] ?? { v1: { x: 0, y: 0 }, v2: { x: 0, y: 0 } };
      out.handles[id] = {
        v1: { x: cur.v1.x + hd.v1.x, y: cur.v1.y + hd.v1.y },
        v2: { x: cur.v2.x + hd.v2.x, y: cur.v2.y + hd.v2.y }
      };
    }
  }
  return out;
}

/**
 * Capture the delta between an edited geometry and a base (delta = edited − base), keeping only
 * point/handle offsets above `threshold` mm — the inverse of applying a delta. `base`/`edited` are the
 * solved point maps; handle offsets come straight off the paths' BezierHandles (already anchor-relative).
 */
export function captureAlterationDelta(
  base: Map<string, Pt>,
  edited: Map<string, Pt>,
  baseHandles: Map<string, BezierHandle>,
  editedHandles: Map<string, BezierHandle>,
  threshold = ALT_NEAR
): AlterationDelta {
  const out = emptyDelta();
  for (const [id, e] of edited) {
    const b = base.get(id); if (!b) continue;
    const dx = e.x - b.x, dy = e.y - b.y;
    if (Math.hypot(dx, dy) > threshold) out.points[id] = { x: dx, y: dy };
  }
  for (const [key, e] of editedHandles) {
    const b = baseHandles.get(key); if (!b) continue;
    const d = { v1: { x: e.v1.x - b.v1.x, y: e.v1.y - b.v1.y }, v2: { x: e.v2.x - b.v2.x, y: e.v2.y - b.v2.y } };
    if (Math.hypot(d.v1.x, d.v1.y) > threshold || Math.hypot(d.v2.x, d.v2.y) > threshold) out.handles[key] = d;
  }
  return out;
}

/** Return a copy of the pattern with variables resolved, constrained points recomputed, alterations applied. */
export function applySolved(pattern: Pattern, scope: Scope): Pattern {
  // Iterate to a fixed point (the original's "Satisfied constraints after N"): constraints that
  // read path geometry (sliding/mirror/intersection) see the PREVIOUS pass's positions, so passes
  // repeat until no point moves more than 0.01 mm (or the pass budget runs out).
  let solved = solvePoints(pattern, scope);
  for (let pass = 0; pass < 6; pass++) {
    const fedBack = {
      ...pattern,
      points: pattern.points.map((p) => {
        const s = solved.get(p.id);
        return s && (s.x !== p.x || s.y !== p.y) ? { ...p, x: s.x, y: s.y } : p;
      })
    };
    const next = solvePoints(fedBack, scope);
    let maxD = 0;
    for (const [id, pt] of next) {
      const prev = solved.get(id);
      if (prev) maxD = Math.max(maxD, Math.hypot(pt.x - prev.x, pt.y - prev.y));
    }
    solved = next;
    if (maxD < 0.01) break;
    if (pass === 5) console.warn(`Failed to satisfy constraints after ${pass + 2} passes (residual ${maxD.toFixed(2)} mm)`);
  }
  const delta = combinedAlterationDelta(pattern, scope);
  const points: ConstrainablePoint[] = pattern.points.map((p) => {
    const s = solved.get(p.id);
    const dp = delta.points[p.id];
    if (!s && !dp) return p;
    const x = (s ? s.x : p.x) + (dp ? dp.x : 0);
    const y = (s ? s.y : p.y) + (dp ? dp.y : 0);
    return { ...p, x, y };
  });
  // Apply handle deltas onto curve path points (offsets are anchor-relative, so add directly).
  const hKeys = Object.keys(delta.handles);
  const paths = hKeys.length
    ? pattern.paths.map((pa) => {
        let touched = false;
        const pathPoints = pa.pathPoints.map((pp: PathPoint) => {
          const hd = delta.handles[handleKey(pa.id, pp.id)];
          if (!hd || !pp.handle) return pp;
          touched = true;
          return { ...pp, handle: { ...pp.handle, v1: { x: pp.handle.v1.x + hd.v1.x, y: pp.handle.v1.y + hd.v1.y }, v2: { x: pp.handle.v2.x + hd.v2.x, y: pp.handle.v2.y + hd.v2.y } } };
        });
        return touched ? { ...pa, pathPoints } : pa;
      })
    : pattern.paths;
  const variables = pattern.variables.map((v) => (v.name in scope ? { ...v, value: scope[v.name] } : v));
  return applyPropertyFormulas({ ...pattern, points, paths, variables }, scope);
}

/**
 * Formula-driven properties (the original's *Formula fields): seam allowance, corner radius/length,
 * notch distance, piece rotation/grain, and conditionFormula (0 → piece hidden). Evaluated against
 * the same variable/measurement scope as point constraints on every redraft; an empty formula
 * leaves the plain numeric field in charge.
 */
function applyPropertyFormulas(pattern: Pattern, scope: Scope): Pattern {
  const num = (f: { formula: string; unit?: string } | undefined): number | null => {
    if (!f?.formula?.trim()) return null;
    const v = evalExpr(f.formula, scope);
    if (v === null || !Number.isFinite(v)) return null;
    const u = f.unit;
    return u === 'cm' ? v * 10 : u === 'inch' ? v * 25.4 : v; // lengths default to mm; angles raw
  };
  let touched = false;
  const mapPath = (pp: PiecePath): PiecePath => {
    const sa = num(pp.seamAllowanceFormula);
    const cr = num(pp.cornerRadiusFormula);
    const cl = num(pp.seamCornerLengthFormula);
    const cm = num(pp.seamCornerMaxLengthFormula);
    let notches = pp.notches;
    if (pp.notches?.some((n) => n.distanceFormula?.formula?.trim())) {
      notches = pp.notches.map((n) => {
        const d = num(n.distanceFormula);
        return d === null || d === n.distance ? n : { ...n, distance: d };
      });
      if (notches.some((n, i) => n !== pp.notches![i])) touched = true;
      else notches = pp.notches;
    }
    if (sa === null && cr === null && cl === null && cm === null && notches === pp.notches) return pp;
    const next: PiecePath = { ...pp, notches };
    if (sa !== null && sa !== pp.seamAllowance) { next.seamAllowance = sa; touched = true; }
    if (cr !== null && cr !== pp.cornerRadius) { next.cornerRadius = cr; touched = true; }
    if (cl !== null && cl !== pp.seamCornerLength) { next.seamCornerLength = cl; touched = true; }
    if (cm !== null && cm !== pp.seamCornerMaxLength) { next.seamCornerMaxLength = cm; touched = true; }
    return touched ? next : pp;
  };
  const pieces = pattern.pieces.map((piece) => {
    const next = { ...piece, mainPaths: piece.mainPaths.map(mapPath), internalPaths: piece.internalPaths.map(mapPath) };
    const rot = num(piece.rotationFormula);
    if (rot !== null && rot !== piece.rotation) { next.rotation = rot; touched = true; }
    const grain = num(piece.grainFormula);
    if (grain !== null) {
      const rad = (grain * Math.PI) / 180;
      const gv = { ...piece.grainVector, x: Math.cos(rad), y: Math.sin(rad) };
      if (Math.abs(gv.x - piece.grainVector.x) > 1e-9 || Math.abs(gv.y - piece.grainVector.y) > 1e-9) {
        next.grainVector = gv;
        touched = true;
      }
    }
    const cond = num(piece.conditionFormula);
    if (cond !== null) {
      const hidden = cond === 0;
      if (hidden !== !!piece.hidden) { next.hidden = hidden; touched = true; }
    }
    return next;
  });
  return touched ? { ...pattern, pieces } : pattern;
}

/** Re-draft from the pattern's own variable values/formulas (live editing). */
export function redraft(pattern: Pattern): Pattern {
  return applySolved(pattern, resolveVariables(pattern));
}

/** Geometry resolved at a graded size (size.values override variable values). */
export function solveForSize(pattern: Pattern, overrides: Record<string, number>): Pattern {
  return applySolved(pattern, resolveVariables(pattern, overrides));
}

type Constraint = NonNullable<ConstrainablePoint['constraint']>;

/**
 * Recover parametric constructions from a template whose points are baked. The original app stores
 * construction on PATHS — a line/curve path with `basePoint` + length/angle formulas positions its
 * other endpoint by polar; a path's `slidingPoints` position points along it; formulas may reference
 * `OtherPath.length` and variables (by id), in cm/inch/etc. The construction *order* is lost, so we
 * disambiguate each point's constructor by which candidate reproduces its baked position (within tol),
 * resolving path-length references iteratively. Recovered points get a constraint (units preserved) so
 * they re-draft from variables. Never moves geometry at base values — only enables parametric editing.
 */
export function makeParametric(pattern: Pattern, tolMm = 1): Pattern {
  if (!pattern.points?.length || !pattern.paths?.length) return pattern;
  if (pattern.points.some((p) => p.constraint)) return pattern; // already parametric / authored
  const scope = resolveVariables(pattern);
  const baked = new Map(pattern.points.map((p) => [p.id, { x: p.x, y: p.y }]));
  const pathById = new Map(pattern.paths.map((pa) => [pa.id, pa]));

  // candidate constructions per point (length+angle from line/curve paths; sliding from slidingPoints)
  const cand = new Map<string, Constraint[]>();
  const add = (pid: string, c: Constraint) => { if (baked.has(pid)) (cand.get(pid) ?? cand.set(pid, []).get(pid)!).push(c); };
  // arc-length fraction (0..1) of a baked point projected onto a baked path's polyline
  const bakedFraction = (path: ConstrainablePath, pid: string): number | null => {
    const pts = path.pathPoints.map((pp) => baked.get(pp.id)); const t = baked.get(pid);
    if (!t || pts.some((p) => !p)) return null;
    let total = 0; const cum = [0];
    for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y); cum.push(total); }
    if (total === 0) return null;
    let bestArc = 0, bestErr = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!; const dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy || 1;
      const tt = Math.max(0, Math.min(1, ((t.x - a.x) * dx + (t.y - a.y) * dy) / d));
      const err = Math.hypot(t.x - (a.x + tt * dx), t.y - (a.y + tt * dy));
      if (err < bestErr) { bestErr = err; bestArc = cum[i - 1] + tt * Math.hypot(dx, dy); }
    }
    return bestErr < 1 ? bestArc / total : null; // only if the point really lies on the path
  };

  for (const pa of pattern.paths) {
    if ((pa.pathType === 'line' || pa.pathType === 'curve') && pa.basePoint && pa.pathPoints.length === 2 && pa.lengthFormula?.formula) {
      const other = pa.pathPoints.find((q) => q.id !== pa.basePoint);
      if (other) add(other.id, { type: 'lengthAngle', from: pa.basePoint, lengthFormula: pa.lengthFormula.formula, angleFormula: pa.angleFormula?.formula ?? '0', lengthUnit: pa.lengthFormula.unit, angleUnit: pa.angleFormula?.unit ?? 'degrees' });
    }
    // mirror / referenced paths: each instance point is a reflection of an original point across mirrorLine
    if (pa.pathType === 'referenced' && pa.mirrorLine && pa.referencedPath) {
      const refPath = pathById.get(pa.referencedPath);
      const sources = new Set<string>([...(refPath?.pathPoints.map((q) => q.id) ?? []), pa.referencedFromPoint!, pa.referencedToPoint!].filter(Boolean) as string[]);
      for (const ip of pa.pathPoints) for (const s of sources) if (s !== ip.id) add(ip.id, { type: 'mirror', source: s, axisPath: pa.mirrorLine });
    }
    for (const sp of pa.slidingPoints ?? []) {
      if (sp.positionFormula?.formula) add(sp.id, { type: 'sliding', path: pa.id, from: sp.positionFrom, positionFormula: sp.positionFormula.formula, unit: sp.positionFormula.unit });
      else { const fr = bakedFraction(pa, sp.id); if (fr != null) add(sp.id, { type: 'sliding', path: pa.id, fraction: fr }); }
    }
  }

  // Ray intersections: the source draws direction-only paths (basePoint + angleFormula, no length) that
  // meet at a constructed point. Collect, per point, the angle-only rays it terminates; any two of them
  // give an intersection candidate (disambiguation below keeps the pair that reproduces the baked point).
  const rays = new Map<string, { from: string; angleFormula: string; angleUnit?: string }[]>();
  for (const pa of pattern.paths) {
    if ((pa.pathType === 'line' || pa.pathType === 'curve') && pa.basePoint && pa.pathPoints.length === 2 && pa.angleFormula?.formula && !pa.lengthFormula?.formula) {
      const other = pa.pathPoints.find((q) => q.id !== pa.basePoint);
      if (other) (rays.get(other.id) ?? rays.set(other.id, []).get(other.id)!).push({ from: pa.basePoint, angleFormula: pa.angleFormula.formula, angleUnit: pa.angleFormula.unit });
    }
  }
  for (const [pid, rs] of rays) {
    if (rs.length < 2) continue;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++)
      add(pid, { type: 'intersection', a: rs[i].from, aAngleFormula: rs[i].angleFormula, aAngleUnit: rs[i].angleUnit, b: rs[j].from, bAngleFormula: rs[j].angleFormula, bAngleUnit: rs[j].angleUnit });
  }
  if (cand.size === 0) return pattern;

  // iterative disambiguation: solve points whose deps are ready, choosing the candidate matching baked
  const sol = new Map<string, Pt>();
  const chosen = new Map<string, Constraint>();
  for (const p of pattern.points) if (!cand.has(p.id)) sol.set(p.id, baked.get(p.id)!);

  // One greedy sweep: solve every still-unsolved candidate point whose deps are ready, choosing the
  // candidate that best reproduces the baked position. Returns true if anything new was solved.
  const greedyPass = (): boolean => {
    let any = false, changed = true, guard = pattern.points.length + 8;
    while (changed && guard-- > 0) {
      changed = false;
      for (const [pid, cands] of cand) {
        if (sol.has(pid)) continue;
        let best: Pt | null = null, bestErr = tolMm, bestC: Constraint | null = null;
        for (const c of cands) {
          const pos = constraintPos(c, scope, sol, pathById);
          if (!pos) continue;
          const err = Math.hypot(pos.x - baked.get(pid)!.x, pos.y - baked.get(pid)!.y);
          if (err < bestErr) { bestErr = err; best = pos; bestC = c; }
        }
        if (best && bestC) { sol.set(pid, best); chosen.set(pid, bestC); changed = true; any = true; }
      }
    }
    return any;
  };

  // Cascade with baked fallback. A point that can't be recovered must not silently block its entire
  // downstream subtree (the cause of the deep-chain stalls). So: run the greedy sweep; when it stalls,
  // find the unsolved candidate points that ARE determined now (≥1 candidate evaluates to a position)
  // but didn't reproduce baked within tol — these are genuinely unrecoverable. Seed them with their
  // baked position as fixed anchors (NOT added to `chosen`, so they stay plain fixed points, exact at
  // base) and sweep again: their dependents, previously blocked, can now recover. Repeat until every
  // candidate point is either recovered or pinned. If only undetermined (dep-missing / cyclic) points
  // remain, pin them all to break the cycle and do a final sweep.
  let outerGuard = pattern.points.length + 4;
  while (outerGuard-- > 0) {
    greedyPass();
    let determined: string[] | null = null, undetermined = false;
    for (const [pid, cands] of cand) {
      if (sol.has(pid)) continue;
      const evaluable = cands.some((c) => constraintPos(c, scope, sol, pathById) !== null);
      if (evaluable) (determined ??= []).push(pid);
      else undetermined = true;
    }
    if (determined) { for (const pid of determined) sol.set(pid, baked.get(pid)!); continue; }
    if (undetermined) { for (const [pid] of cand) if (!sol.has(pid)) sol.set(pid, baked.get(pid)!); greedyPass(); }
    break;
  }
  if (chosen.size === 0) return pattern;

  const points = pattern.points.map((p) => (chosen.has(p.id) ? { ...p, constraint: chosen.get(p.id) } : p));
  return { ...pattern, points };
}
