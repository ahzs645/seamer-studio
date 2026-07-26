// Parametric-arc editing: re-bake a curve path that carries ArcParams metadata after its radius,
// angles or center change — keeping the path's point ids stable wherever possible so piece edges,
// seams and notches referencing them survive the edit.

import type { Pattern, ConstrainablePath, PathPoint, BezierHandle, ArcParams } from '@seamer/pattern-model';
import { ellipseAnchors, type Vec2 } from '@seamer/pattern-model';

const mkHandle = (v1: Vec2, v2: Vec2): BezierHandle => ({
  v1: { ...v1 }, v2: { ...v2 }, sameLength: false, sameAngle: false,
  lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' }
});

/** The path's distinct anchor ids in order (a closed loop repeats the first id at the end). */
function distinctAnchorIds(path: ConstrainablePath): { ids: string[]; closed: boolean } {
  const ids = path.pathPoints.map((pp) => pp.id);
  const closed = ids.length > 1 && ids[0] === ids[ids.length - 1];
  return { ids: closed ? ids.slice(0, -1) : ids, closed };
}

/** True if a point id is used by anything besides the given path. */
function usedElsewhere(p: Pattern, pointId: string, exceptPathId: string): boolean {
  for (const path of p.paths) {
    if (path.id === exceptPathId) continue;
    if (path.pathPoints.some((pp) => pp.id === pointId)) return true;
    if (path.slidingPoints?.some((sp) => sp.id === pointId)) return true;
    if (path.basePoint === pointId) return true;
  }
  for (const piece of p.pieces) {
    if (piece.originPoint === pointId) return true;
    for (const pp of [...piece.mainPaths, ...piece.internalPaths]) if (pp.from === pointId || pp.to === pointId) return true;
  }
  for (const m of p.measurements ?? []) if (m.fromPointId === pointId || m.toPointId === pointId || m.viaPointId === pointId) return true;
  return false;
}

/** The arc's centre: the live centre point when bound, else the stored numeric centre. */
export function arcCenter(p: Pattern, params: ArcParams): Vec2 {
  if (params.centerId) {
    const c = p.points.find((q) => q.id === params.centerId);
    if (c) return { x: c.x, y: c.y };
  }
  return { x: params.cx, y: params.cy };
}

/**
 * Re-bake an arc path from `params`: anchor positions/handles are rewritten in place. When the
 * segment count changes, interior anchors are added/removed (endpoint ids always survive; removed
 * interior points are deleted only when nothing else references them).
 */
export function rebakeArc(p: Pattern, pathId: string, params: ArcParams, uid: (prefix: string) => string): Pattern | null {
  const path = p.paths.find((q) => q.id === pathId);
  if (!path || !path.arc) return null;
  const center = arcCenter(p, params);
  const stored: ArcParams = { ...params, cx: center.x, cy: center.y };
  const rx = Math.max(0.01, params.rx ?? params.r);
  const ry = Math.max(0.01, params.ry ?? params.r);
  const anchors = ellipseAnchors(center, rx, ry, params.rotation ?? 0, params.a0, params.a1);
  const { ids, closed } = distinctAnchorIds(path);
  const want = params.closed ? anchors.length - 1 : anchors.length; // closed: last anchor == first
  const used = params.closed ? anchors.slice(0, -1) : anchors;

  // map old ids onto the new anchor list: keep first (and last when open) at the ends, reuse the
  // rest in order; create fresh points for any shortfall.
  const keepIds: string[] = [];
  const newPoints: Pattern['points'] = [];
  for (let i = 0; i < want; i++) {
    let id: string | undefined;
    if (i === 0) id = ids[0];
    else if (!params.closed && i === want - 1) id = ids[ids.length - 1];
    else id = ids[1 + (i - 1)] && (params.closed || 1 + (i - 1) < ids.length - 1) ? ids[1 + (i - 1)] : undefined;
    if (!id || keepIds.includes(id)) {
      id = uid('ConstrainablePoint');
      newPoints.push({ id, name: '', x: used[i].pos.x, y: used[i].pos.y, layerId: path.layerId });
    }
    keepIds.push(id);
  }
  const dropped = ids.filter((id) => !keepIds.includes(id));
  const removable = new Set(dropped.filter((id) => !usedElsewhere(p, id, pathId)));

  const posById = new Map(keepIds.map((id, i) => [id, used[i].pos]));
  const points = [
    ...p.points
      .filter((q) => !removable.has(q.id))
      .map((q) => (posById.has(q.id) ? { ...q, x: posById.get(q.id)!.x, y: posById.get(q.id)!.y } : q)),
    ...newPoints
  ];

  const pathPoints: PathPoint[] = keepIds.map((id, i) => ({ id, handle: mkHandle(used[i].v1, used[i].v2) }));
  if (params.closed) pathPoints.push({ id: keepIds[0], handle: mkHandle(anchors[0].v1, anchors[0].v2) });
  else if (closed && !params.closed) { /* open now — nothing extra */ }

  const paths = p.paths.map((q) => (q.id === pathId ? { ...q, pathPoints, arc: stored, version: (q.version ?? 0) + 1 } : q));
  return { ...p, points, paths, hasChanged: true };
}

/** Paths whose arc is centred on this point (re-baked when the centre moves). */
export function arcPathsCenteredOn(p: Pattern, pointId: string): ConstrainablePath[] {
  return p.paths.filter((q) => q.arc?.centerId === pointId);
}

/** Clear the parametric metadata of any arc path that owns this anchor (it was hand-edited). */
export function detachArcsTouchingAnchor(p: Pattern, pointId: string): Pattern {
  let touched = false;
  const paths = p.paths.map((q) => {
    if (!q.arc || q.arc.centerId === pointId) return q;
    if (!q.pathPoints.some((pp) => pp.id === pointId)) return q;
    touched = true;
    const { arc: _arc, ...rest } = q;
    return { ...rest, version: (q.version ?? 0) + 1 } as ConstrainablePath;
  });
  return touched ? { ...p, paths, hasChanged: true } : p;
}
