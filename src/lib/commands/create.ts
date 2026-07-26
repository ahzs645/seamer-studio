// Creation + structure commands — the reducers behind point/path/piece/seam/notch/variable/
// material/layer/text creation and the piece/path/seam update commands. These give the command bus
// (palette + window.seamer + MCP agents) the ability to BUILD patterns incrementally instead of
// replacing the whole JSON.

import type {
  Pattern, ConstrainablePath, PathPoint, BezierHandle, Piece, PiecePath, PiecePoint, PropertyFormula, Seam, SeamRef, Notch,
  NotchType, Variable, Material, TextureSlot, Layer, PatternText, ArcParams, SeamCornerJoinType
} from '@seamer/pattern-model';
import { arcAnchors, ellipseAnchors, centerArcAngles, threePointArcAngles, type ArcAnchor, type Vec2 } from '$lib/utils/arcGeometry';

type Uid = (prefix: string) => string;

const mkHandle = (v1: Vec2, v2: Vec2): BezierHandle => ({
  v1: { ...v1 }, v2: { ...v2 }, sameLength: false, sameAngle: false,
  lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' }
});

const nextPointName = (p: Pattern, offset = 0) => `${p.pointPrefix || 'A'}${p.points.length + offset}`;

// ---- points --------------------------------------------------------------------------------------

export function pointCreate(p: Pattern, x: number, y: number, name: string | undefined, uid: Uid): Pattern {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return p;
  const pt = { id: uid('ConstrainablePoint'), name: name || nextPointName(p), x, y, layerId: p.currentLayerId };
  return { ...p, points: [...p.points, pt], hasChanged: true };
}

/** A point reference in command params: an existing point id, or {x, y} (creates a point). */
export type PointRef = string | { x: number; y: number };

function resolveRef(p: Pattern, ref: unknown, uid: Uid, created: { id: string; name: string; x: number; y: number; layerId?: string }[]): string | null {
  if (typeof ref === 'string') {
    return p.points.some((q) => q.id === ref) ? ref : null;
  }
  if (ref && typeof ref === 'object' && Number.isFinite((ref as Vec2).x) && Number.isFinite((ref as Vec2).y)) {
    const pt = {
      id: uid('ConstrainablePoint'),
      name: nextPointName(p, created.length),
      x: (ref as Vec2).x, y: (ref as Vec2).y,
      layerId: p.currentLayerId
    };
    created.push(pt);
    return pt.id;
  }
  return null;
}

const ptOf = (p: Pattern, created: { id: string; x: number; y: number }[], id: string): Vec2 | null => {
  const q = p.points.find((c) => c.id === id) ?? created.find((c) => c.id === id);
  return q ? { x: q.x, y: q.y } : null;
};

// ---- paths ---------------------------------------------------------------------------------------

export function pathCreateLine(p: Pattern, from: unknown, to: unknown, name: string | undefined, uid: Uid): Pattern {
  const created: { id: string; name: string; x: number; y: number; layerId?: string }[] = [];
  const a = resolveRef(p, from, uid, created);
  const b = resolveRef(p, to, uid, created);
  if (!a || !b || a === b) return p;
  const path: ConstrainablePath = {
    id: uid('ConstrainablePath'), name: name ?? '', layerId: p.currentLayerId,
    pathType: 'line', pathPoints: [{ id: a }, { id: b }], version: 1
  };
  return { ...p, points: [...p.points, ...created], paths: [...p.paths, path], hasChanged: true };
}

export function pathCreateCurve(
  p: Pattern,
  refs: unknown[],
  handles: { v1?: Vec2; v2?: Vec2 }[] | undefined,
  closed: boolean,
  name: string | undefined,
  uid: Uid
): Pattern {
  if (!Array.isArray(refs) || refs.length < 2) return p;
  const created: { id: string; name: string; x: number; y: number; layerId?: string }[] = [];
  const ids: string[] = [];
  for (const r of refs) {
    const id = resolveRef(p, r, uid, created);
    if (!id) return p;
    ids.push(id);
  }
  const pathPoints: PathPoint[] = ids.map((id, i) => {
    const h = handles?.[i];
    return { id, handle: mkHandle(h?.v1 ?? { x: 0, y: 0 }, h?.v2 ?? { x: 0, y: 0 }) };
  });
  if (closed && ids[0] !== ids[ids.length - 1]) pathPoints.push({ id: ids[0], handle: mkHandle(handles?.[0]?.v1 ?? { x: 0, y: 0 }, handles?.[0]?.v2 ?? { x: 0, y: 0 }) });
  const path: ConstrainablePath = {
    id: uid('ConstrainablePath'), name: name ?? '', layerId: p.currentLayerId,
    pathType: 'curve', pathPoints, version: 1
  };
  return { ...p, points: [...p.points, ...created], paths: [...p.paths, path], hasChanged: true };
}

/** Bake arc anchors into a new curve path carrying parametric `arc` metadata. */
function bakeArcPath(p: Pattern, anchors: ArcAnchor[], closed: boolean, arc: ArcParams, name: string | undefined, uid: Uid): Pattern {
  const ids = anchors.map(() => uid('ConstrainablePoint'));
  const newPoints = anchors.map((a, i) => ({ id: ids[i], name: nextPointName(p, i), x: a.pos.x, y: a.pos.y, layerId: p.currentLayerId }));
  const pathPoints: PathPoint[] = anchors.map((a, i) => ({ id: ids[i], handle: mkHandle(a.v1, a.v2) }));
  if (closed) pathPoints.push({ id: ids[0], handle: mkHandle(anchors[0].v1, anchors[0].v2) });
  const path: ConstrainablePath = {
    id: uid('ConstrainablePath'), name: name ?? '', layerId: p.currentLayerId,
    pathType: 'curve', pathPoints, version: 1, arc
  };
  return { ...p, points: [...p.points, ...newPoints], paths: [...p.paths, path], hasChanged: true };
}

export function pathCreateEllipse(
  p: Pattern,
  center: unknown,
  radiusPoint: unknown,
  name: string | undefined,
  uid: Uid,
  opts?: { rx?: number; ry?: number; rotationDeg?: number }
): Pattern {
  const created: { id: string; name: string; x: number; y: number; layerId?: string }[] = [];
  const cId = resolveRef(p, center, uid, created);
  const rId = resolveRef(p, radiusPoint, uid, created);
  if (!cId || !rId || cId === rId) return p;
  const c = ptOf(p, created, cId)!;
  const rp = ptOf(p, created, rId)!;
  const rDist = Math.hypot(rp.x - c.x, rp.y - c.y);
  // independent X/Y radii (true ellipse) when given; the radius point sets the default circle
  const rx = Number.isFinite(opts?.rx) && (opts!.rx as number) > 0 ? (opts!.rx as number) : rDist;
  const ry = Number.isFinite(opts?.ry) && (opts!.ry as number) > 0 ? (opts!.ry as number) : rx;
  const rotation = Number.isFinite(opts?.rotationDeg) ? ((opts!.rotationDeg as number) * Math.PI) / 180 : 0;
  if (rx <= 0 || ry <= 0) return p;
  const base = { ...p, points: [...p.points, ...created] };
  return bakeArcPath(
    base,
    ellipseAnchors(c, rx, ry, rotation, 0, Math.PI * 2),
    true,
    { kind: 'circle', centerId: cId, cx: c.x, cy: c.y, r: rx, rx, ry, rotation, a0: 0, a1: Math.PI * 2, closed: true },
    name,
    uid
  );
}

export function pathCreateCenterArc(p: Pattern, center: unknown, start: unknown, end: unknown, name: string | undefined, uid: Uid): Pattern {
  const created: { id: string; name: string; x: number; y: number; layerId?: string }[] = [];
  const cId = resolveRef(p, center, uid, created);
  const sId = resolveRef(p, start, uid, created);
  const eId = resolveRef(p, end, uid, created);
  if (!cId || !sId || !eId || new Set([cId, sId, eId]).size !== 3) return p;
  const c = ptOf(p, created, cId)!;
  const s = ptOf(p, created, sId)!;
  const e = ptOf(p, created, eId)!;
  const { r, a0, a1 } = centerArcAngles(c, s, e);
  if (r <= 0) return p;
  const base = { ...p, points: [...p.points, ...created] };
  return bakeArcPath(base, arcAnchors(c, r, a0, a1), false, { kind: 'centerArc', centerId: cId, cx: c.x, cy: c.y, r, a0, a1, closed: false }, name, uid);
}

export function pathCreateThreePointArc(p: Pattern, p1: unknown, p2: unknown, p3: unknown, name: string | undefined, uid: Uid): Pattern {
  const created: { id: string; name: string; x: number; y: number; layerId?: string }[] = [];
  const ids = [p1, p2, p3].map((r) => resolveRef(p, r, uid, created));
  if (ids.some((id) => !id) || new Set(ids).size !== 3) return p;
  const pts = ids.map((id) => ptOf(p, created, id!)!);
  const arc = threePointArcAngles(pts[0], pts[1], pts[2]);
  if (!arc) return p;
  const base = { ...p, points: [...p.points, ...created] };
  return bakeArcPath(base, arcAnchors(arc.c, arc.r, arc.a0, arc.a1), false, { kind: 'threePointArc', centerId: null, cx: arc.c.x, cy: arc.c.y, r: arc.r, a0: arc.a0, a1: arc.a1, closed: false }, name, uid);
}

const PATH_FIELDS = ['name', 'layerId'] as const;
export function pathUpdate(p: Pattern, pathId: string, patch: Record<string, unknown>): Pattern {
  const path = p.paths.find((q) => q.id === pathId);
  if (!path) return p;
  const upd: Partial<ConstrainablePath> = {};
  for (const k of PATH_FIELDS) if (typeof patch[k] === 'string') (upd as Record<string, unknown>)[k] = patch[k];
  if (Object.keys(upd).length === 0) return p;
  return { ...p, paths: p.paths.map((q) => (q.id === pathId ? { ...q, ...upd, version: (q.version ?? 0) + 1 } : q)), hasChanged: true };
}

// ---- pieces --------------------------------------------------------------------------------------

export function pieceCreateDynamic(p: Pattern, pathIds: string[], internalPathIds: string[], name: string | undefined, uid: Uid): Pattern {
  if (!Array.isArray(pathIds) || pathIds.length === 0) return p;
  const find = (id: string) => p.paths.find((q) => q.id === id);
  const mk = (id: string, kind: 'main' | 'internal'): PiecePath | null => {
    const path = find(id);
    if (!path || path.pathPoints.length < 2) return null;
    return {
      id: uid('PiecePath'),
      name: path.name || (kind === 'internal' ? 'Internal' : 'Edge'),
      path: id,
      from: path.pathPoints[0].id,
      to: path.pathPoints[path.pathPoints.length - 1].id,
      reversed: false,
      notches: [],
      ...(kind === 'internal' ? { foldAngle: 0 } : {})
    };
  };
  const mainPaths = pathIds.map((id) => mk(id, 'main'));
  const internalPaths = (internalPathIds ?? []).map((id) => mk(id, 'internal'));
  if (mainPaths.some((m) => !m) || internalPaths.some((m) => !m)) return p;
  const originPoint = (mainPaths[0] as PiecePath).from;
  const op = p.points.find((q) => q.id === originPoint);
  if (!op) return p;
  const piece: Piece = {
    id: uid('Piece'), name: name || `Piece ${p.pieces.length + 1}`, type: 'dynamic',
    materialId: p.materials[0]?.id ?? '', origin: { id: uid('Point'), name: '', x: 0, y: 0 },
    originPoint, position: { x: op.x, y: op.y }, rotation: 0,
    grainVector: { id: uid('Point'), name: '', x: 0, y: 1 }, text: null,
    rightPieces: 0, leftPieces: 0, mirrorLeftPiecesAxis: 'X', mirrorX: false, mirrorY: false,
    seamAllowanceInside: false,
    mainPaths: mainPaths as PiecePath[], internalPaths: internalPaths as PiecePath[],
    settings3d: {
      arrangement: { mode: 'flat', cylinderName: '', uDegrees: 0, v: 0.5, uOffsetMm: 0, vOffsetMm: 0, radialOffsetMm: 0, use2DPosition: true, positionChanged: false, matrixWorld: [], position: [] },
      enable3d: true, frozen: false, flipNormals: false, filterExternalCollisionsByClothNormal: false, collisionLayer: 0, savedPositions: []
    }
  };
  return { ...p, pieces: [...p.pieces, piece], hasChanged: true };
}

const PIECE_BOOLS = ['mirrorX', 'mirrorY', 'seamAllowanceInside', 'firstEdgeSymmetry', 'useMaterialScaling', 'hidden'] as const;
const PIECE_NUMS = ['rightPieces', 'leftPieces', 'seamAllowance', 'rotation'] as const;
const PIECE_STRS = ['name', 'materialId', 'mirrorLeftPiecesAxis', 'layerId'] as const;
export function pieceUpdate(p: Pattern, pieceId: string, patch: Record<string, unknown>): Pattern {
  const piece = p.pieces.find((q) => q.id === pieceId);
  if (!piece) return p;
  const upd: Record<string, unknown> = {};
  for (const k of PIECE_BOOLS) if (typeof patch[k] === 'boolean') upd[k] = patch[k];
  for (const k of PIECE_NUMS) if (typeof patch[k] === 'number' && Number.isFinite(patch[k])) upd[k] = patch[k];
  for (const k of PIECE_STRS) if (typeof patch[k] === 'string') upd[k] = patch[k];
  if (Object.keys(upd).length === 0) return p;
  return { ...p, pieces: p.pieces.map((q) => (q.id === pieceId ? { ...q, ...upd } : q)), hasChanged: true };
}

export function pieceRotate(p: Pattern, pieceId: string, degrees: number): Pattern {
  if (!Number.isFinite(degrees) || degrees === 0) return p;
  const piece = p.pieces.find((q) => q.id === pieceId);
  if (!piece) return p;
  return { ...p, pieces: p.pieces.map((q) => (q.id === pieceId ? { ...q, rotation: (q.rotation + degrees) % 360 } : q)), hasChanged: true };
}

const PIECEPATH_KEYS: Record<string, 'string' | 'number' | 'boolean'> = {
  name: 'string', foldAngle: 'number', seamAllowance: 'number', isMirrorLine: 'boolean',
  reversed: 'boolean', showIn3d: 'boolean', coverSeamAllowanceStart: 'boolean', coverSeamAllowanceEnd: 'boolean',
  seamCornerJoinType: 'string', cornerRadius: 'number', seamCornerMaxLength: 'number', seamCornerLength: 'number'
};
export function piecePathUpdate(p: Pattern, piecePathId: string, patch: Record<string, unknown>): Pattern {
  const upd: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(PIECEPATH_KEYS)) {
    if (typeof patch[k] === t && (t !== 'number' || Number.isFinite(patch[k]))) upd[k] = patch[k];
  }
  if (upd.seamCornerJoinType && !['intersection', 'radius', 'byLength', 'noJoin', 'firstEdgeSymmetry', 'secondEdgeSymmetry', 'firstEdgeRightAngle', 'secondEdgeRightAngle'].includes(upd.seamCornerJoinType as string)) delete upd.seamCornerJoinType;
  if (Object.keys(upd).length === 0) return p;
  let touched = false;
  const map = (pp: PiecePath) => (pp.id === piecePathId ? ((touched = true), { ...pp, ...upd } as PiecePath) : pp);
  const pieces = p.pieces.map((piece) => ({ ...piece, mainPaths: piece.mainPaths.map(map), internalPaths: piece.internalPaths.map(map) }));
  return touched ? { ...p, pieces, hasChanged: true } : p;
}

// ---- formula.set (formula-driven properties) ------------------------------------------------------

const PIECEPATH_FORMULA_FIELDS = ['seamAllowance', 'cornerRadius', 'seamCornerLength', 'seamCornerMaxLength'] as const;
const PIECE_FORMULA_FIELDS = ['rotation', 'grain', 'condition'] as const;

/**
 * Attach/clear a formula on a formula-driven property (the original's generic formula.set).
 * Targets: piecePath (seamAllowance/cornerRadius/seamCornerLength/seamCornerMaxLength),
 * piece (rotation/grain/condition), notch (distance). Empty formula clears.
 */
export function formulaSet(
  p: Pattern,
  target: string,
  targetId: string,
  field: string,
  formula: string,
  unit?: string
): Pattern {
  const value: PropertyFormula | undefined = formula.trim() ? { formula: formula.trim(), ...(unit ? { unit } : {}) } : undefined;
  if (target === 'piecePath' && (PIECEPATH_FORMULA_FIELDS as readonly string[]).includes(field)) {
    const key = `${field}Formula` as 'seamAllowanceFormula';
    return withPiecePath(p, targetId, (pp) => {
      const next = { ...pp };
      if (value) next[key] = value; else delete next[key];
      return next;
    });
  }
  if (target === 'piece' && (PIECE_FORMULA_FIELDS as readonly string[]).includes(field)) {
    const key = `${field}Formula` as 'rotationFormula';
    let touched = false;
    const pieces = p.pieces.map((pc) => {
      if (pc.id !== targetId) return pc;
      touched = true;
      const next = { ...pc };
      if (value) next[key] = value; else delete next[key];
      return next;
    });
    return touched ? { ...p, pieces, hasChanged: true } : p;
  }
  if (target === 'notch' && field === 'distance') {
    let touched = false;
    const map = (pp: PiecePath): PiecePath => {
      if (!pp.notches?.some((n) => n.id === targetId)) return pp;
      touched = true;
      return {
        ...pp,
        notches: pp.notches.map((n) => {
          if (n.id !== targetId) return n;
          const next = { ...n };
          if (value) next.distanceFormula = value; else delete next.distanceFormula;
          return next;
        })
      };
    };
    const pieces = p.pieces.map((piece) => ({ ...piece, mainPaths: piece.mainPaths.map(map), internalPaths: piece.internalPaths.map(map) }));
    return touched ? { ...p, pieces, hasChanged: true } : p;
  }
  return p;
}

// ---- piece points (piece-local construction points) -----------------------------------------------

export function piecePointAdd(p: Pattern, pieceId: string, x: number, y: number, name: string | undefined, uid: Uid): Pattern {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return p;
  const piece = p.pieces.find((pc) => pc.id === pieceId);
  if (!piece) return p;
  if (piece.type !== 'dynamic') return p; // "Only dynamic pieces support piece points"
  const pts = piece.piecePoints ?? [];
  const pointName = name && name.trim() ? name.trim() : `PP${pts.length + 1}`;
  if (pts.some((pt) => pt.name === pointName)) return p; // "Piece point already exists"
  const point: PiecePoint = { id: uid('PiecePoint'), name: pointName, x, y };
  const pieces = p.pieces.map((pc) => (pc.id === pieceId ? { ...pc, piecePoints: [...pts, point] } : pc));
  return { ...p, pieces, hasChanged: true };
}

export function piecePointUpdate(p: Pattern, piecePointId: string, patch: { name?: string; x?: number; y?: number }): Pattern {
  let touched = false;
  const pieces = p.pieces.map((pc) => {
    if (!pc.piecePoints?.some((pt) => pt.id === piecePointId)) return pc;
    touched = true;
    return {
      ...pc,
      piecePoints: pc.piecePoints.map((pt) => (pt.id !== piecePointId ? pt : {
        ...pt,
        ...(typeof patch.name === 'string' && patch.name.trim() ? { name: patch.name.trim() } : {}),
        ...(Number.isFinite(patch.x) ? { x: patch.x as number } : {}),
        ...(Number.isFinite(patch.y) ? { y: patch.y as number } : {})
      }))
    };
  });
  return touched ? { ...p, pieces, hasChanged: true } : p;
}

export function piecePointDelete(p: Pattern, piecePointId: string): Pattern {
  let touched = false;
  const pieces = p.pieces.map((pc) => {
    if (!pc.piecePoints?.some((pt) => pt.id === piecePointId)) return pc;
    touched = true;
    return { ...pc, piecePoints: pc.piecePoints.filter((pt) => pt.id !== piecePointId) };
  });
  return touched ? { ...p, pieces, hasChanged: true } : p;
}

// ---- seams ---------------------------------------------------------------------------------------

const allPiecePathIds = (p: Pattern): Set<string> => {
  const s = new Set<string>();
  for (const piece of p.pieces) for (const pp of [...piece.mainPaths, ...piece.internalPaths]) s.add(pp.id);
  return s;
};

/** Seam side entries accept plain piece-path ids or full refs with mirrored/reversed flags
 *  (the original's seam.create payload entries are {piecePathId, mirrored, reversed}). */
export type SeamRefInput = string | { id: string; mirrored?: boolean; reversed?: boolean };

export function seamCreate(p: Pattern, from: SeamRefInput[], to: SeamRefInput[], name: string | undefined, uid: Uid): Pattern {
  if (!Array.isArray(from) || !Array.isArray(to) || from.length === 0 || to.length === 0) return p;
  const known = allPiecePathIds(p);
  const norm = (r: SeamRefInput): SeamRef | null => {
    const id = typeof r === 'string' ? r : r?.id;
    if (typeof id !== 'string' || !known.has(id)) return null;
    return { id, mirrored: typeof r === 'object' && !!r.mirrored, reversed: typeof r === 'object' && !!r.reversed };
  };
  const fromRefs = from.map(norm), toRefs = to.map(norm);
  if (fromRefs.some((r) => !r) || toRefs.some((r) => !r)) return p;
  const seam: Seam = { id: uid('Seam'), name: name ?? '', fromPaths: fromRefs as SeamRef[], toPaths: toRefs as SeamRef[] };
  return { ...p, seams: [...p.seams, seam], hasChanged: true };
}

/** Toggle seam-side orientation. Omitting `index` flips every ref of the side (the original
 *  seam.reverse semantics — its Reverse source/target buttons act on the whole side). */
export function seamReverse(p: Pattern, seamId: string, side: 'from' | 'to', index?: number): Pattern {
  const seam = p.seams.find((s) => s.id === seamId);
  if (!seam) return p;
  const key = side === 'to' ? 'toPaths' : 'fromPaths';
  const list = seam[key];
  if (index !== undefined && !list[index]) return p;
  const next = list.map((r, i) => (index === undefined || i === index ? { ...r, reversed: !r.reversed } : r));
  return { ...p, seams: p.seams.map((s) => (s.id === seamId ? { ...s, [key]: next } : s)), hasChanged: true };
}

// ---- notches -------------------------------------------------------------------------------------

const NOTCH_TYPES: NotchType[] = ['single', 'double', 'slit', 'tee'];

function withPiecePath(p: Pattern, piecePathId: string, fn: (pp: PiecePath) => PiecePath): Pattern {
  let touched = false;
  const map = (pp: PiecePath) => (pp.id === piecePathId ? ((touched = true), fn(pp)) : pp);
  const pieces = p.pieces.map((piece) => ({ ...piece, mainPaths: piece.mainPaths.map(map), internalPaths: piece.internalPaths.map(map) }));
  return touched ? { ...p, pieces, hasChanged: true } : p;
}

export function notchAdd(
  p: Pattern,
  piecePathId: string,
  position: number,
  type: string | undefined,
  size: number | undefined,
  uid: Uid,
  anchor?: { referencePointId?: string; distance?: number }
): Pattern {
  if (!Number.isFinite(position) && !(anchor?.referencePointId && Number.isFinite(anchor.distance))) return p;
  const notch: Notch = {
    id: uid('Notch'),
    position: Number.isFinite(position) ? Math.max(0, Math.min(1, position)) : 0.5,
    type: NOTCH_TYPES.includes(type as NotchType) ? (type as NotchType) : undefined,
    size: Number.isFinite(size) ? size : undefined
  };
  return withPiecePath(p, piecePathId, (pp) => {
    // "Reference point must belong to the main path": anchored placement only to this edge's ends
    if (anchor?.referencePointId && (anchor.referencePointId === pp.from || anchor.referencePointId === pp.to)) {
      notch.referencePointId = anchor.referencePointId;
      notch.distance = Number.isFinite(anchor.distance) ? anchor.distance : 0;
    }
    return { ...pp, notches: [...(pp.notches ?? []), notch] };
  });
}

export function notchUpdate(
  p: Pattern,
  notchId: string,
  patch: { position?: number; type?: string; size?: number; referencePointId?: string | null; distance?: number }
): Pattern {
  let touched = false;
  const map = (pp: PiecePath): PiecePath => {
    if (!pp.notches?.some((n) => n.id === notchId)) return pp;
    touched = true;
    return {
      ...pp,
      notches: pp.notches.map((n) => {
        if (n.id !== notchId) return n;
        const next: Notch = {
          ...n,
          ...(Number.isFinite(patch.position) ? { position: Math.max(0, Math.min(1, patch.position!)) } : {}),
          ...(NOTCH_TYPES.includes(patch.type as NotchType) ? { type: patch.type as NotchType } : {}),
          ...(Number.isFinite(patch.size) ? { size: patch.size } : {}),
          ...(Number.isFinite(patch.distance) ? { distance: patch.distance } : {})
        };
        if (patch.referencePointId === null) {
          // release the anchor -> back to parametric position
          delete next.referencePointId;
          delete next.distance;
        } else if (typeof patch.referencePointId === 'string' &&
                   (patch.referencePointId === pp.from || patch.referencePointId === pp.to)) {
          next.referencePointId = patch.referencePointId;
          if (next.distance === undefined) next.distance = 0;
        }
        return next;
      })
    };
  };
  const pieces = p.pieces.map((piece) => ({ ...piece, mainPaths: piece.mainPaths.map(map), internalPaths: piece.internalPaths.map(map) }));
  return touched ? { ...p, pieces, hasChanged: true } : p;
}

export function notchDelete(p: Pattern, notchId: string): Pattern {
  let touched = false;
  const map = (pp: PiecePath): PiecePath => {
    if (!pp.notches?.some((n) => n.id === notchId)) return pp;
    touched = true;
    return { ...pp, notches: pp.notches.filter((n) => n.id !== notchId) };
  };
  const pieces = p.pieces.map((piece) => ({ ...piece, mainPaths: piece.mainPaths.map(map), internalPaths: piece.internalPaths.map(map) }));
  return touched ? { ...p, pieces, hasChanged: true } : p;
}

// ---- variables / materials / layers / texts -------------------------------------------------------

export function variableCreate(p: Pattern, name: string, value: number | undefined, formula: string | undefined, type: string | undefined, uid: Uid): Pattern {
  const nm = (name ?? '').trim();
  if (!nm || p.variables.some((v) => v.name === nm)) return p;
  const variable: Variable = {
    id: uid('var'), name: nm, type: type || 'number',
    value: Number.isFinite(value) ? (value as number) : null,
    valueFormula: { formula: formula ?? (Number.isFinite(value) ? String(value) : ''), unit: 'mm' },
    isEditable: true, isVisible: true, options: [], unitType: 'length'
  };
  return { ...p, variables: [...p.variables, variable], hasChanged: true };
}

export function variableDelete(p: Pattern, idOrName: string): Pattern {
  const v = p.variables.find((q) => q.id === idOrName || q.name === idOrName);
  if (!v) return p;
  return { ...p, variables: p.variables.filter((q) => q.id !== v.id), hasChanged: true };
}

const defaultSlot = (color: string): TextureSlot => ({
  url: '', mediaId: null, color, scale: 100,
  normalUrl: '', normalMediaId: null, normalMapScale: 100,
  opacityUrl: '', opacityMediaId: null, opacityMapScale: 100
});

const MATERIAL_NUMS = ['stretchWarpValue', 'stretchWeftValue', 'bendValue', 'thickness', 'weight', 'roughness', 'metalness', 'specularIntensity', 'opacity', 'normalScale', 'alphaCutoff', 'shrinkageHorizontalPercentage', 'shrinkageVerticalPercentage'] as const;
export function materialUpsert(p: Pattern, id: string | undefined, name: string | undefined, patch: Record<string, unknown>, assignPieceId: string | undefined, uid: Uid): Pattern {
  const existing = id ? p.materials.find((m) => m.id === id) : undefined;
  const color = typeof patch.color === 'string' ? patch.color : '#6b7a8f';
  const base: Material = existing ?? {
    id: id || uid('Material'), name: name || 'New Fabric',
    frontTexture: defaultSlot(color), backTexture: defaultSlot(color), useSeparateBackSide: false,
    stretchWarpValue: 10, stretchWeftValue: 10, bendValue: 0, thickness: 0.5, weight: 150,
    shrinkageHorizontalPercentage: 0, shrinkageVerticalPercentage: 0,
    roughness: 0.8, metalness: 0.1, specularIntensity: 0.25, opacity: 1, normalScale: 1, alphaCutoff: 0,
    libraryItemId: null, libraryVersion: null, libraryUpdatedAt: null
  };
  const upd: Record<string, unknown> = {};
  if (name) upd.name = name;
  for (const k of MATERIAL_NUMS) if (typeof patch[k] === 'number' && Number.isFinite(patch[k])) upd[k] = patch[k];
  if (typeof patch.color === 'string' && existing) {
    upd.frontTexture = { ...(existing.frontTexture ?? defaultSlot(color)), color: patch.color };
  }
  const mat = { ...base, ...upd } as Material;
  const materials = existing ? p.materials.map((m) => (m.id === mat.id ? mat : m)) : [...p.materials, mat];
  let pieces = p.pieces;
  if (assignPieceId && pieces.some((q) => q.id === assignPieceId)) {
    pieces = pieces.map((q) => (q.id === assignPieceId ? { ...q, materialId: mat.id } : q));
  }
  return { ...p, materials, pieces, hasChanged: true };
}

export function materialDelete(p: Pattern, id: string): Pattern {
  if (!p.materials.some((m) => m.id === id)) return p;
  return {
    ...p,
    materials: p.materials.filter((m) => m.id !== id),
    pieces: p.pieces.map((q) => (q.materialId === id ? { ...q, materialId: p.materials.find((m) => m.id !== id)?.id ?? '' } : q)),
    hasChanged: true
  };
}

export function layerCreate(p: Pattern, name: string, makeCurrent: boolean, uid: Uid): Pattern {
  const nm = (name ?? '').trim();
  if (!nm) return p;
  const layer: Layer = { id: uid('Layer'), name: nm, visible: true, locked: false, order: p.layers.length, style: null };
  return { ...p, layers: [...p.layers, layer], currentLayerId: makeCurrent ? layer.id : p.currentLayerId, hasChanged: true };
}

export function layerDelete(p: Pattern, layerId: string): Pattern {
  if (layerId === 'default' || !p.layers.some((l) => l.id === layerId)) return p;
  const fallback = p.layers.find((l) => l.id === 'default')?.id ?? p.layers.find((l) => l.id !== layerId)?.id;
  if (!fallback) return p;
  const move = <T extends { layerId?: string }>(arr: T[]): T[] => arr.map((e) => (e.layerId === layerId ? { ...e, layerId: fallback } : e));
  return {
    ...p,
    layers: p.layers.filter((l) => l.id !== layerId),
    points: move(p.points),
    paths: move(p.paths),
    pieces: move(p.pieces),
    texts: move(p.texts),
    images: move(p.images),
    currentLayerId: p.currentLayerId === layerId ? fallback : p.currentLayerId,
    hasChanged: true
  };
}

export function textCreate(p: Pattern, value: string, x: number, y: number, opts: Record<string, unknown>, uid: Uid): Pattern {
  if (!value || !Number.isFinite(x) || !Number.isFinite(y)) return p;
  const text: PatternText = {
    id: uid('Text'), value, x, y,
    fontSize: typeof opts.fontSize === 'number' ? opts.fontSize : 15,
    color: typeof opts.color === 'string' ? opts.color : '#1e293b',
    align: opts.align === 'left' || opts.align === 'right' ? opts.align : 'center',
    rotation: typeof opts.rotation === 'number' ? opts.rotation : 0,
    layerId: p.currentLayerId
  };
  return { ...p, texts: [...p.texts, text], hasChanged: true };
}

// ---- sliding points --------------------------------------------------------------------------------

export function slidingPointUpdate(p: Pattern, pathId: string, pointId: string, patch: { positionFormula?: string; unit?: string; positionFrom?: string }): Pattern {
  const path = p.paths.find((q) => q.id === pathId);
  const sp = path?.slidingPoints?.find((s) => s.id === pointId);
  if (!path || !sp) return p;
  const next = {
    ...sp,
    ...(typeof patch.positionFormula === 'string'
      ? { positionFormula: { formula: patch.positionFormula, unit: typeof patch.unit === 'string' ? patch.unit : (sp.positionFormula?.unit ?? 'mm') } }
      : {}),
    ...(typeof patch.positionFrom === 'string' ? { positionFrom: patch.positionFrom } : {})
  };
  return {
    ...p,
    paths: p.paths.map((q) => (q.id !== pathId ? q : { ...q, slidingPoints: q.slidingPoints!.map((s) => (s.id === pointId ? next : s)), version: (q.version ?? 0) + 1 })),
    hasChanged: true
  };
}

export type { SeamCornerJoinType };
