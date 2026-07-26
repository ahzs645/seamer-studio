// Linked paths (the source's EditLink): a path whose SHAPE follows another path, mapped by the
// similarity transform that carries the source's endpoints onto the linked path's own endpoints —
// used for matching seam edges and symmetric halves. The mirror-line form of `referenced` paths is
// solved as constraints in solver/solve.ts; this module handles the generic endpoint-mapped link.

import type { Pattern, ConstrainablePath, PathPoint, BezierHandle } from '@seamer/pattern-model';

interface Vec2 { x: number; y: number }

const mkHandle = (v1: Vec2, v2: Vec2): BezierHandle => ({
  v1: { ...v1 }, v2: { ...v2 }, sameLength: false, sameAngle: false,
  lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' }
});

/** True for paths in the generic link form (endpoint-mapped; the mirror form has mirrorLine). */
export function isLinkedPath(path: ConstrainablePath): boolean {
  return path.pathType === 'referenced' && !!path.referencedPath && !path.mirrorLine;
}

/** Follow referencedPath chains from `sourceId`; true if `pathId` is reachable (a link would cycle). */
function reaches(p: Pattern, sourceId: string, pathId: string, guard = 64): boolean {
  let cur: string | undefined = sourceId;
  while (cur && guard-- > 0) {
    if (cur === pathId) return true;
    const path = p.paths.find((q) => q.id === cur);
    cur = path?.pathType === 'referenced' ? path.referencedPath : undefined;
  }
  return false;
}

/** Whether `pathId` may link to `sourceId`: both exist, not itself, source has ≥2 anchors, no cycle. */
export function canLinkPath(p: Pattern, pathId: string, sourceId: string): { ok: boolean; reason?: string } {
  if (pathId === sourceId) return { ok: false, reason: 'Linked path cannot reference itself' };
  const path = p.paths.find((q) => q.id === pathId);
  const src = p.paths.find((q) => q.id === sourceId);
  if (!path || !src) return { ok: false, reason: 'Path not found' };
  if (src.pathPoints.length < 2) return { ok: false, reason: 'Source path needs at least two points' };
  if (reaches(p, sourceId, pathId)) return { ok: false, reason: 'Linked path reference would be circular' };
  return { ok: true };
}

/** Paths eligible as a link source for `pathId` (used by the EditLink picker). */
export function linkSourceCandidates(p: Pattern, pathId: string): ConstrainablePath[] {
  return p.paths.filter((q) => canLinkPath(p, pathId, q.id).ok);
}

/** Convert a path into a linked path following `sourceId` (its current endpoints are kept). */
export function linkPath(p: Pattern, pathId: string, sourceId: string, flipped = false): Pattern | null {
  if (!canLinkPath(p, pathId, sourceId).ok) return null;
  const path = p.paths.find((q) => q.id === pathId)!;
  if (path.pathPoints.length < 2) return null;
  const from = path.pathPoints[0].id;
  const to = path.pathPoints[path.pathPoints.length - 1].id;
  const paths = p.paths.map((q) => (q.id !== pathId ? q : {
    ...q,
    pathType: 'referenced',
    referencedPath: sourceId,
    referencedFromPoint: from,
    referencedToPoint: to,
    mirrorX: flipped,
    mirrorLine: undefined,
    version: (q.version ?? 0) + 1
  } as ConstrainablePath));
  return syncLinkedPaths({ ...p, paths, hasChanged: true });
}

/** Detach a linked path: it keeps its current (synced) geometry as a plain curve. */
export function unlinkPath(p: Pattern, pathId: string): Pattern {
  const path = p.paths.find((q) => q.id === pathId);
  if (!path || !isLinkedPath(path)) return p;
  const paths = p.paths.map((q) => {
    if (q.id !== pathId) return q;
    const { referencedPath: _r, referencedFromPoint: _f, referencedToPoint: _t, mirrorX: _m, ...rest } = q;
    return { ...rest, pathType: q.pathPoints.some((pp) => pp.handle) ? 'curve' : 'line', version: (q.version ?? 0) + 1 } as ConstrainablePath;
  });
  return { ...p, paths, hasChanged: true };
}

/**
 * Recompute every generic linked path's geometry from its source: the source's interior anchors and
 * handles are carried by the similarity transform mapping source-endpoints → link-endpoints
 * (optionally reflected across the chord when mirrorX). Interior point ids are reused; the count
 * follows the source. Cheap no-op when the pattern has no links.
 */
export function syncLinkedPaths(p: Pattern, uid?: (prefix: string) => string): Pattern {
  const linked = p.paths.filter(isLinkedPath);
  if (linked.length === 0) return p;
  const mkId = uid ?? ((prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`);
  let points = p.points;
  let paths = p.paths;
  let touched = false;
  const byId = (id: string) => points.find((q) => q.id === id);

  // sources first where chains exist: iterate a few passes so A→B→C settles (cycle-guarded by canLink)
  for (let pass = 0; pass < 3; pass++) {
    for (const link of paths.filter(isLinkedPath)) {
      const src = paths.find((q) => q.id === link.referencedPath);
      if (!src || src.pathPoints.length < 2) continue;
      const fromId = link.referencedFromPoint ?? link.pathPoints[0]?.id;
      const toId = link.referencedToPoint ?? link.pathPoints[link.pathPoints.length - 1]?.id;
      const T0 = fromId ? byId(fromId) : null;
      const T1 = toId ? byId(toId) : null;
      const S0 = byId(src.pathPoints[0].id);
      const S1 = byId(src.pathPoints[src.pathPoints.length - 1].id);
      if (!T0 || !T1 || !S0 || !S1) continue;
      const sv = { x: S1.x - S0.x, y: S1.y - S0.y };
      const tv = { x: T1.x - T0.x, y: T1.y - T0.y };
      const sLen = Math.hypot(sv.x, sv.y);
      if (sLen < 1e-9) continue;
      const scale = Math.hypot(tv.x, tv.y) / sLen;
      const rot = Math.atan2(tv.y, tv.x) - Math.atan2(sv.y, sv.x);
      const cos = Math.cos(rot) * scale, sin = Math.sin(rot) * scale;
      const flip = link.mirrorX === true;
      // reflect a source-local offset across the source chord before rotating, when flipped
      const chord = { x: sv.x / sLen, y: sv.y / sLen };
      const reflect = (v: Vec2): Vec2 => {
        const along = v.x * chord.x + v.y * chord.y;
        const perp = -v.x * chord.y + v.y * chord.x;
        return { x: chord.x * along + chord.y * perp, y: chord.y * along - chord.x * perp };
      };
      const xform = (v: Vec2): Vec2 => {
        const w = flip ? reflect(v) : v;
        return { x: w.x * cos - w.y * sin, y: w.x * sin + w.y * cos };
      };
      const mapPoint = (q: Vec2): Vec2 => {
        const d = xform({ x: q.x - S0.x, y: q.y - S0.y });
        return { x: T0.x + d.x, y: T0.y + d.y };
      };

      // desired anchors: source interior anchors mapped over; endpoints stay the link's own points
      const srcAnchors = src.pathPoints;
      const wantInterior = srcAnchors.length - 2;
      const oldInterior = link.pathPoints.slice(1, -1).map((pp) => pp.id);
      const interiorIds: string[] = [];
      const newPoints: Pattern['points'] = [];
      for (let i = 0; i < wantInterior; i++) {
        let id = oldInterior[i];
        if (!id) {
          id = mkId('ConstrainablePoint');
          newPoints.push({ id, name: '', x: 0, y: 0, layerId: link.layerId });
        }
        interiorIds.push(id);
      }
      const dropped = oldInterior.slice(wantInterior);

      const interiorPos = new Map<string, Vec2>();
      for (let i = 0; i < wantInterior; i++) {
        const sp = byId(srcAnchors[i + 1].id);
        if (sp) interiorPos.set(interiorIds[i], mapPoint(sp));
      }

      const handleFor = (i: number): BezierHandle | undefined => {
        const h = srcAnchors[i].handle;
        if (!h) return undefined;
        return mkHandle(xform(h.v1), xform(h.v2));
      };
      const pathPoints: PathPoint[] = [
        { id: fromId!, handle: handleFor(0) },
        ...interiorIds.map((id, i) => ({ id, handle: handleFor(i + 1) })),
        { id: toId!, handle: handleFor(srcAnchors.length - 1) }
      ];

      const before = JSON.stringify(link.pathPoints);
      const after = JSON.stringify(pathPoints);
      const posChanged = [...interiorPos].some(([id, v]) => {
        const q = byId(id);
        return !q || Math.abs(q.x - v.x) > 1e-9 || Math.abs(q.y - v.y) > 1e-9;
      });
      if (before === after && !posChanged && newPoints.length === 0 && dropped.length === 0) continue;

      touched = true;
      points = [
        ...points
          .filter((q) => !dropped.includes(q.id))
          .map((q) => (interiorPos.has(q.id) ? { ...q, ...interiorPos.get(q.id)! } : q)),
        ...newPoints.map((q) => ({ ...q, ...(interiorPos.get(q.id) ?? {}) }))
      ];
      paths = paths.map((q) => (q.id === link.id ? { ...q, pathPoints, version: (q.version ?? 0) + 1 } : q));
    }
  }
  return touched ? { ...p, points, paths, hasChanged: true } : p;
}
