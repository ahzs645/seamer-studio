// Seamly2D / Valentina (.val/.sm2d/.xml) importer — faithful port of the original studio's
// SeamlyImporter. Seamly stores a parametric *draft*: a tree of construction tools (points built
// by endLine / alongLine / normal / intersection / contact, plus lines, splines and arcs) whose
// positions are driven by formulas over body measurements and increments.
//
// This importer evaluates those formulas to bake numeric coordinates, then emits the draft as repo
// geometry on a "Seamly Draft" layer: each source point becomes a ConstrainablePoint, each line /
// construction line a 'line' ConstrainablePath, each spline a cubic 'curve', each arc a sampled
// 'curve'. Measurements/increments are surfaced as editable Variables. It imports the draft only
// (no pieces) — matching the original, which lays the construction out for the user to trace.

import { createEmptyPattern } from '@seamer/pattern-model';
import type { Pattern, ConstrainablePath, ConstrainablePoint, PathPoint, BezierHandle, Formula, Variable } from '@seamer/pattern-model';

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
const DRAFT_LAYER = 'Seamly Draft';

interface V { x: number; y: number }
const vec = (x: number, y: number): V => ({ x, y });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s });
const len = (a: V) => Math.hypot(a.x, a.y);
const normalize = (a: V): V => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const eq = (a: V, b: V, eps = 1e-9) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
const vecFromAngle = (deg: number, l: number): V => { const r = (deg * Math.PI) / 180; return { x: Math.cos(r) * l, y: Math.sin(r) * l }; };
const normAngle = (deg: number) => { let t = deg % 360; if (t < 0) t += 360; return t; };
const unitToMm = (u: string) => (u === 'mm' ? 1 : u === 'cm' ? 10 : u === 'inch' ? 25.4 : 10);

const childrenByTag = (el: Element, tag: string) => Array.from(el.children).filter((c) => c.tagName === tag);
const firstChildByTag = (el: Element, tag: string) => childrenByTag(el, tag)[0] ?? null;
const parseNum = (s: string | null): number | null => { if (s == null) return null; const v = parseFloat(String(s).trim().replace(',', '.')); return Number.isFinite(v) ? v : null; };
const parseId = (el: Element): number | null => { const v = parseInt(el.getAttribute('id') ?? '', 10); return Number.isFinite(v) ? v : null; };
/** A measurement/length token may be written `name=value`; take the part after '=' if present. */
const parseAngleToken = (raw: string | null, evaluate: (s: string) => number | null): number | null => {
  if (!raw) return null;
  const s = raw.trim(); if (!s.length) return null;
  const i = s.indexOf('=');
  return i > -1 ? evaluate(s.slice(i + 1)) : evaluate(s);
};

interface DraftCtx {
  pattern: Pattern;
  drawName: string;
  pointsById: Map<number, V>;
  pointNameById: Map<number, string>;
  pointBySourceId: Map<number, ConstrainablePoint>;
  pointByCoord: Map<string, ConstrainablePoint>;
  emittedLineKeys: Set<string>;
  skipped: string[];
}

export function seamlyToPattern(text: string, name = 'Imported Seamly'): Pattern {
  const raw = String(text ?? '').trim();
  if (!raw.length) throw new Error('Empty Seamly input');
  const doc = new DOMParser().parseFromString(raw, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML in Seamly file');
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'pattern') throw new Error('Expected Seamly pattern XML (.val/.sm2d) with <pattern> root');

  const pattern = createEmptyPattern();
  pattern.name = name;
  if (!pattern.layers.some((l) => l.name === DRAFT_LAYER)) {
    pattern.layers.push({ id: 'seamly_draft', name: DRAFT_LAYER, visible: true, locked: false, order: pattern.layers.length, style: null });
  }
  const layerId = pattern.layers.find((l) => l.name === DRAFT_LAYER)!.id;

  const unit = firstChildByTag(root, 'unit')?.textContent?.trim() ?? 'cm';
  const mmPerUnit = unitToMm(unit);
  const measurements = readMeasurements(root);
  ensureMeasurementVariables(pattern, measurements);

  const draws = [...childrenByTag(root, 'draw'), ...childrenByTag(root, 'draftBlock')];
  let ctx: DraftCtx | null = null;

  // Substitute measurements + Line_/AngleLine_ tokens, then guard-eval the arithmetic.
  const evaluate = (input: string | null): number | null => {
    if (!ctx || !input) return null;
    let s = input.trim();
    if (!s.length) return null;
    const entries = Object.entries(measurements).sort((a, b) => b[0].length - a[0].length);
    for (const [nm, val] of entries) {
      const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = nm.startsWith('#')
        ? s.replace(new RegExp(`${esc}(?![A-Za-z0-9_])`, 'g'), val.toString())
        : s.replace(new RegExp(`\\b${esc}\\b`, 'g'), val.toString());
    }
    const resolvePair = (token: string): [string, string] | null => {
      const names = new Set(ctx!.pointNameById.values());
      if (!token.includes('_')) return null;
      let best: [string, string] | null = null;
      for (let i = 1; i < token.length - 1; i++) {
        if (token[i] !== '_') continue;
        const a = token.slice(0, i), b = token.slice(i + 1);
        if (names.has(a) && names.has(b) && (!best || a.length > best[0].length)) best = [a, b];
      }
      return best;
    };
    const pointByName = (n: string): V | null => {
      const id = [...ctx!.pointNameById.entries()].find(([, v]) => v === n)?.[0];
      return id != null ? ctx!.pointsById.get(id) ?? null : null;
    };
    s = s.replace(/Line_([^+\-*/(),\s]+)/g, (_m, u: string) => {
      const pair = resolvePair(String(u)); if (!pair) return 'NaN';
      const a = pointByName(pair[0]), b = pointByName(pair[1]);
      return !a || !b ? 'NaN' : (len(sub(a, b)) / mmPerUnit).toString();
    });
    s = s.replace(/AngleLine_([^+\-*/(),\s]+)/g, (_m, u: string) => {
      const pair = resolvePair(String(u)); if (!pair) return 'NaN';
      const a = pointByName(pair[0]), b = pointByName(pair[1]);
      return !a || !b ? 'NaN' : normAngle((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI).toString();
    });
    if (!/^[0-9+\-*/().,\sNaInfity]+$/.test(s)) return null;
    try { const r = Number(Function(`"use strict"; return (${s});`)()); return Number.isFinite(r) ? r : null; } catch { return null; }
  };

  for (const draw of draws) {
    const drawName = draw.getAttribute('name')?.trim() || `Draft ${draws.indexOf(draw) + 1}`;
    ctx = {
      pattern, drawName,
      pointsById: new Map(), pointNameById: new Map(),
      pointBySourceId: new Map(), pointByCoord: new Map(),
      emittedLineKeys: new Set(), skipped: []
    };
    parseCalculation(draw, ctx, mmPerUnit, layerId, evaluate);
  }
  const patternName = firstChildByTag(root, 'patternName')?.textContent?.trim();
  if (patternName) pattern.name = patternName;
  pattern.hasChanged = true;
  return pattern;
}

function readMeasurements(root: Element): Record<string, number> {
  const out: Record<string, number> = {};
  const increments = firstChildByTag(root, 'increments');
  if (increments) for (const inc of childrenByTag(increments, 'increment')) {
    const nm = inc.getAttribute('name')?.trim();
    const v = parseNum(inc.getAttribute('formula'));
    if (nm && v !== null) { out[nm] = v; if (nm.startsWith('#')) out[nm.slice(1)] = v; }
  }
  const measEl = firstChildByTag(root, 'measurements');
  const body = measEl ? firstChildByTag(measEl, 'body-measurements') : null;
  if (body) for (const m of childrenByTag(body, 'm')) {
    const nm = m.getAttribute('name');
    const v = parseNum(m.getAttribute('value'));
    if (nm && v !== null) out[nm] = v;
  }
  return out;
}

function ensureMeasurementVariables(pattern: Pattern, measurements: Record<string, number>) {
  for (const [nm, v] of Object.entries(measurements)) {
    if (nm.startsWith('#') || pattern.variables.some((va) => va.name === nm)) continue;
    const variable: Variable = {
      id: uid('var'), name: nm, type: 'number', value: v,
      valueFormula: { formula: String(v), unit: 'mm' }, isEditable: true, isVisible: true, options: [], unitType: 'length'
    };
    pattern.variables.push(variable);
  }
}

function parseCalculation(draw: Element, ctx: DraftCtx, mmPerUnit: number, layerId: string, evaluate: (s: string | null) => number | null) {
  const calc = firstChildByTag(draw, 'calculation');
  if (!calc) return;
  for (const node of Array.from(calc.children)) {
    if (node.tagName === 'point') parsePoint(node, ctx, mmPerUnit, layerId, evaluate);
    else if (node.tagName === 'line') parseLine(node, ctx, layerId);
    else if (node.tagName === 'spline') parseSpline(node, ctx, layerId, evaluate, mmPerUnit);
    else if (node.tagName === 'arc') parseArc(node, ctx, layerId, evaluate, mmPerUnit);
  }
}

function lineIntersection(a: V | undefined, b: V | undefined, c: V | undefined, d: V | undefined): V | null {
  if (!a || !b || !c || !d) return null;
  const denom = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  if (Math.abs(denom) < 1e-9) return null;
  const x = ((a.x * b.y - a.y * b.x) * (c.x - d.x) - (a.x - b.x) * (c.x * d.y - c.y * d.x)) / denom;
  const y = ((a.x * b.y - a.y * b.x) * (c.y - d.y) - (a.y - b.y) * (c.x * d.y - c.y * d.x)) / denom;
  return { x, y };
}

function lineCircleClosest(center: V, radius: number, a: V, b: V): V | null {
  const d = sub(b, a), u = sub(a, center);
  const c = d.x * d.x + d.y * d.y, bb = 2 * (u.x * d.x + u.y * d.y), cc = u.x * u.x + u.y * u.y - radius * radius;
  const disc = bb * bb - 4 * c * cc;
  if (disc < 0 || Math.abs(c) < 1e-9) return null;
  const sq = Math.sqrt(disc);
  const p1 = add(a, scale(d, (-bb - sq) / (2 * c))), p2 = add(a, scale(d, (-bb + sq) / (2 * c)));
  return len(sub(p1, b)) <= len(sub(p2, b)) ? p1 : p2;
}

function parsePoint(el: Element, ctx: DraftCtx, mmPerUnit: number, layerId: string, evaluate: (s: string | null) => number | null) {
  const id = parseId(el);
  if (id == null) return;
  const type = el.getAttribute('type') ?? 'single';
  const nm = el.getAttribute('name');
  if (nm) ctx.pointNameById.set(id, nm);
  const get = (attr: string) => ctx.pointsById.get(Number(el.getAttribute(attr)));
  let pt: V | null = null;

  if (type === 'single') {
    const x = parseNum(el.getAttribute('x')), y = parseNum(el.getAttribute('y'));
    if (x !== null && y !== null) pt = vec(x * mmPerUnit, y * mmPerUnit);
  } else if (type === 'endLine') {
    const base = get('basePoint'), angle = parseAngleToken(el.getAttribute('angle'), evaluate), length = evaluate(el.getAttribute('length'));
    if (base && angle !== null && length !== null) pt = add(base, vecFromAngle(angle, length * mmPerUnit));
  } else if (type === 'alongLine') {
    const a = get('firstPoint'), b = get('secondPoint'), length = evaluate(el.getAttribute('length'));
    if (a && b && length !== null) pt = add(a, scale(normalize(sub(b, a)), length * mmPerUnit));
  } else if (type === 'pointOfIntersection' || type === 'intersectXY') {
    const a = get('firstPoint'), b = get('secondPoint');
    if (a && b) pt = vec(a.x, b.y);
  } else if (type === 'lineIntersect') {
    pt = lineIntersection(get('p1Line1'), get('p2Line1'), get('p1Line2'), get('p2Line2'));
  } else if (type === 'lineIntersectAxis') {
    const base = get('basePoint'), a = get('p1Line'), b = get('p2Line'), angle = parseAngleToken(el.getAttribute('angle'), evaluate);
    if (base && a && b && angle !== null) pt = lineIntersection(base, add(base, vecFromAngle(angle, 1e5)), a, b);
  } else if (type === 'pointOfContact') {
    const center = get('center'), a = get('firstPoint'), b = get('secondPoint'), radius = evaluate(el.getAttribute('radius'));
    if (center && a && b && radius !== null) pt = lineCircleClosest(center, radius * mmPerUnit, a, b);
  } else if (type === 'normal') {
    const a = get('firstPoint'), b = get('secondPoint'), angle = parseAngleToken(el.getAttribute('angle'), evaluate) ?? 90, length = evaluate(el.getAttribute('length'));
    if (a && b && length !== null) { const baseAngle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI; pt = add(b, vecFromAngle(baseAngle + angle, length * mmPerUnit)); }
  }

  if (!pt) { ctx.skipped.push(`point:${id}:${type}`); return; }
  ctx.pointsById.set(id, pt);
  ensureDraftPoint(ctx, id, pt, nm ?? `P${id}`, layerId);
  emitConstructionLine(el, ctx, id, layerId);
}

function parseLine(el: Element, ctx: DraftCtx, layerId: string) {
  const id = parseId(el);
  if (id == null) return;
  const f = Number(el.getAttribute('firstPoint')), t = Number(el.getAttribute('secondPoint'));
  const a = ctx.pointsById.get(f), b = ctx.pointsById.get(t);
  if (!a || !b) { ctx.skipped.push(`line:${id}`); return; }
  const pa = ensureDraftPoint(ctx, f, a, ctx.pointNameById.get(f) ?? `P${f}`, layerId);
  const pb = ensureDraftPoint(ctx, t, b, ctx.pointNameById.get(t) ?? `P${t}`, layerId);
  if (eq(a, b)) return;
  addLinePath(ctx, layerId, `${ctx.drawName}_Line_${id}`, pa.id, pb.id);
}

function parseSpline(el: Element, ctx: DraftCtx, layerId: string, evaluate: (s: string | null) => number | null, mmPerUnit: number) {
  const id = parseId(el);
  if (id == null) return;
  const type = el.getAttribute('type') ?? '';
  if (type === 'simpleInteractive') {
    const c1 = Number(el.getAttribute('point1')), c4 = Number(el.getAttribute('point4'));
    const a = ctx.pointsById.get(c1), b = ctx.pointsById.get(c4);
    const ang1 = parseAngleToken(el.getAttribute('angle1'), evaluate), ang2 = parseAngleToken(el.getAttribute('angle2'), evaluate);
    const l1 = evaluate(el.getAttribute('length1')), l2 = evaluate(el.getAttribute('length2'));
    if (!a || !b || ang1 === null || ang2 === null || l1 === null || l2 === null) { ctx.skipped.push(`spline:${id}:simpleInteractive`); return; }
    const pa = ensureDraftPoint(ctx, c1, a, ctx.pointNameById.get(c1) ?? `P${c1}`, layerId);
    const pb = ensureDraftPoint(ctx, c4, b, ctx.pointNameById.get(c4) ?? `P${c4}`, layerId);
    const ppA: PathPoint = { id: pa.id, handle: makeHandle() };
    const ppB: PathPoint = { id: pb.id, handle: makeHandle() };
    ppA.handle!.v1 = vecFromAngle(ang1, l1 * mmPerUnit);
    ppB.handle!.v2 = vecFromAngle(ang2, l2 * mmPerUnit);
    addCurvePath(ctx, layerId, `${ctx.drawName}_Spline_${id}`, [ppA, ppB]);
    return;
  }
  if (type === 'pathInteractive') {
    const pathPoints = childrenByTag(el, 'pathPoint');
    if (pathPoints.length < 2) { ctx.skipped.push(`spline:${id}:pathInteractive:fewPoints`); return; }
    const pps: PathPoint[] = [];
    const handleData: { a1: number | null; a2: number | null; l1: number | null; l2: number | null }[] = [];
    for (const pp of pathPoints) {
      const sid = Number(pp.getAttribute('pSpline'));
      const v = ctx.pointsById.get(sid);
      if (!v) continue;
      const dp = ensureDraftPoint(ctx, sid, v, ctx.pointNameById.get(sid) ?? `P${sid}`, layerId);
      pps.push({ id: dp.id, handle: makeHandle() });
      handleData.push({
        a1: parseAngleToken(pp.getAttribute('angle1'), evaluate), a2: parseAngleToken(pp.getAttribute('angle2'), evaluate),
        l1: evaluate(pp.getAttribute('length1')), l2: evaluate(pp.getAttribute('length2'))
      });
    }
    if (pps.length < 2) { ctx.skipped.push(`spline:${id}:pathInteractive:empty`); return; }
    for (let i = 0; i < pps.length; i++) {
      const h = pps[i].handle!, d = handleData[i];
      if (d.a2 !== null && d.l2 !== null) h.v1 = vecFromAngle(d.a2, d.l2 * mmPerUnit);
      if (d.a1 !== null && d.l1 !== null) h.v2 = vecFromAngle(d.a1, d.l1 * mmPerUnit);
    }
    addCurvePath(ctx, layerId, `${ctx.drawName}_SplinePath_${id}`, pps);
    return;
  }
  ctx.skipped.push(`spline:${id}:${type || 'unknown'}`);
}

function parseArc(el: Element, ctx: DraftCtx, layerId: string, evaluate: (s: string | null) => number | null, mmPerUnit: number) {
  const id = parseId(el);
  if (id == null) return;
  const c = Number(el.getAttribute('center'));
  const center = ctx.pointsById.get(c);
  const radius = evaluate(el.getAttribute('radius'));
  const a1 = parseAngleToken(el.getAttribute('angle1'), evaluate), a2 = parseAngleToken(el.getAttribute('angle2'), evaluate);
  if (!center || radius === null || a1 === null || a2 === null) { ctx.skipped.push(`arc:${id}`); return; }
  // Sample the arc into a polyline-with-handles 'curve' so it renders as the intended arc.
  const r = radius * mmPerUnit;
  let sweep = normAngle(a2) - normAngle(a1); if (sweep <= 0) sweep += 360;
  const steps = Math.max(2, Math.ceil(sweep / 15));
  const pps: PathPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const ang = a1 + (sweep * i) / steps;
    const p = add(center, vecFromAngle(ang, r));
    const dp = ensureDraftPointByCoordinate(ctx, p, layerId);
    pps.push({ id: dp.id, handle: makeHandle() });
  }
  // tangent handles along the arc for a smooth curve
  const k = (4 / 3) * Math.tan((((sweep / steps) * Math.PI) / 180) / 4) * r;
  for (let i = 0; i <= steps; i++) {
    const ang = a1 + (sweep * i) / steps;
    const tangent = vecFromAngle(ang + 90, 1);
    pps[i].handle!.v1 = scale(tangent, -k); // incoming
    pps[i].handle!.v2 = scale(tangent, k);  // outgoing
  }
  addCurvePath(ctx, layerId, `${ctx.drawName}_Arc_${id}`, pps);
}

// ---- emit helpers --------------------------------------------------------------------------------

function makeHandle(): BezierHandle {
  return { v1: { x: 0, y: 0 }, v2: { x: 0, y: 0 }, sameLength: false, sameAngle: false, lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' } };
}

function ensureDraftPoint(ctx: DraftCtx, sourceId: number, v: V, name: string, layerId: string): ConstrainablePoint {
  const existing = ctx.pointBySourceId.get(sourceId);
  if (existing) { existing.name = name; return existing; }
  const cp: ConstrainablePoint = { id: uid('ConstrainablePoint'), name, x: v.x, y: v.y, layerId };
  ctx.pattern.points.push(cp);
  ctx.pointBySourceId.set(sourceId, cp);
  ctx.pointByCoord.set(coordKey(v), cp);
  return cp;
}

function ensureDraftPointByCoordinate(ctx: DraftCtx, v: V, layerId: string): ConstrainablePoint {
  const key = coordKey(v);
  const existing = ctx.pointByCoord.get(key);
  if (existing) return existing;
  const cp: ConstrainablePoint = { id: uid('ConstrainablePoint'), name: '', x: v.x, y: v.y, layerId };
  ctx.pattern.points.push(cp);
  ctx.pointByCoord.set(key, cp);
  return cp;
}

const coordKey = (v: V) => `${v.x.toFixed(5)},${v.y.toFixed(5)}`;

function addLinePath(ctx: DraftCtx, layerId: string, name: string, fromId: string, toId: string) {
  const path: ConstrainablePath = { id: uid('ConstrainablePath'), name, layerId, pathType: 'line', pathPoints: [{ id: fromId }, { id: toId }], version: 1 };
  ctx.pattern.paths.push(path);
  return path;
}

function addCurvePath(ctx: DraftCtx, layerId: string, name: string, pathPoints: PathPoint[]) {
  const path: ConstrainablePath = { id: uid('ConstrainablePath'), name, layerId, pathType: 'curve', pathPoints, version: 1 };
  ctx.pattern.paths.push(path);
  return path;
}

// Emit the visible construction line a point tool draws from its base point (when lineType ≠ none).
function emitConstructionLine(el: Element, ctx: DraftCtx, id: number, layerId: string) {
  const type = el.getAttribute('type') ?? '';
  if (!shouldRenderToolLine(el) || !ctx.pointsById.get(id)) return;
  const nm = ctx.pointNameById.get(id) ?? `P${id}`;
  const link = (baseAttr: string, suffix: string) => addConstructionLineByIds(ctx, Number(el.getAttribute(baseAttr)), id, `${nm}_${suffix}`, layerId);
  if (type === 'endLine') link('basePoint', 'endLine');
  else if (type === 'alongLine') link('firstPoint', 'along');
  else if (type === 'normal') link('secondPoint', 'normal');
  else if (type === 'lineIntersectAxis') link('basePoint', 'axis');
  else if (type === 'intersectXY') { link('firstPoint', 'xyA'); link('secondPoint', 'xyB'); }
}

function shouldRenderToolLine(el: Element): boolean {
  const lt = (el.getAttribute('lineType') ?? el.getAttribute('typeLine') ?? '').trim().toLowerCase();
  return lt.length ? !['none', 'noneline'].includes(lt) : false;
}

function addConstructionLineByIds(ctx: DraftCtx, fromSrc: number, toSrc: number, name: string, layerId: string) {
  const a = ctx.pointsById.get(fromSrc), b = ctx.pointsById.get(toSrc);
  if (!a || !b) return;
  const key = fromSrc < toSrc ? `${fromSrc}:${toSrc}` : `${toSrc}:${fromSrc}`;
  if (ctx.emittedLineKeys.has(key)) return;
  ctx.emittedLineKeys.add(key);
  const pa = ensureDraftPoint(ctx, fromSrc, a, ctx.pointNameById.get(fromSrc) ?? `P${fromSrc}`, layerId);
  const pb = ensureDraftPoint(ctx, toSrc, b, ctx.pointNameById.get(toSrc) ?? `P${toSrc}`, layerId);
  if (eq(a, b)) return;
  addLinePath(ctx, layerId, `${ctx.drawName}_${name}`, pa.id, pb.id);
}
