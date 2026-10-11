import { indexPoints, indexPaths, pieceShrinkageScale, reflectAcrossLine, notchRatio, piecePathPolyline, applyFoldAffine, type Pattern, type Piece, type ConstrainablePoint, type ConstrainablePath, type PiecePath, type Vec2 } from '@seamer/pattern-model';
interface MirrorLink { ownerPieceId?: string; sourcePieceId: string; axisPathId: string; edgeMap?: Record<string, string>; pointMap?: Record<string, string> }
type LinkedPiece = Piece & { linkedMirror?: MirrorLink };
const defaultUid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
function axisEnds(pattern: Pattern, id: string): [ConstrainablePoint, ConstrainablePoint] | null {
  const path = pattern.paths.find(path => path.id === id), points = indexPoints(pattern);
  if (!path || path.pathPoints.length !== 2 || path.pathPoints.some(point => point.handle)) return null;
  const a = points.get(path.pathPoints[0].id), b = points.get(path.pathPoints[1].id);
  return a && b && Math.hypot(b.x - a.x, b.y - a.y) > 1e-6 ? [a, b] : null;
}
/** The clone stores compensated draft geometry, so anisotropic shrinkage is reflected exactly. */
export function createLinkedMirror(pattern: Pattern, sourceId: string, axisPathId: string, uid = defaultUid): Pattern {
  const source = pattern.pieces.find(piece => piece.id === sourceId);
  if (!source || !axisEnds(pattern, axisPathId)) throw new Error('Choose a piece and a straight two-point mirror axis with distinct endpoints');
  const points = indexPoints(pattern);
  if (!points.has(source.originPoint) || [...source.mainPaths, ...source.internalPaths].some(edge => !pattern.paths.some(path => path.id === edge.path && path.pathPoints.length >= 2) || !points.has(edge.from) || !points.has(edge.to))) throw new Error('Repair source piece points and paths before linking a mirror');
  const cloneId = uid('Piece');
  const clone: LinkedPiece = { ...structuredClone(source), id: cloneId, name: `Linked mirror of ${source.name}`, mainPaths: [], internalPaths: [], legacyGeometry: undefined, markers: undefined, piecePoints: undefined,
    useMaterialScaling: false, rotationFormula: undefined, grainFormula: undefined, conditionFormula: undefined,
    settings3d: { ...source.settings3d, savedPositions: [], arrangement: { ...source.settings3d.arrangement, sourcePlacement: undefined }, savedDrapeState: undefined },
    linkedMirror: { ownerPieceId: cloneId, sourcePieceId: sourceId, axisPathId, edgeMap: {}, pointMap: {} } };
  return syncLinkedMirrorPlacements({ ...pattern, pieces: [...pattern.pieces, clone], hasChanged: true }, uid);
}
export function isLinkedMirrorPiece(pattern: Pattern, piece: Piece): boolean { return Boolean((pattern.pieces.find(item => item.id === piece.id) as LinkedPiece | undefined)?.linkedMirror); }
/** Detach preserves all current geometry and references while releasing its source constraints. */
export function detachLinkedMirror(pattern: Pattern, pieceId: string): Pattern {
  const piece = pattern.pieces.find(piece => piece.id === pieceId) as LinkedPiece | undefined;
  if (!piece?.linkedMirror) return pattern;
  const edges = [...piece.mainPaths, ...piece.internalPaths], pathIds = new Set(edges.map(edge => edge.path));
  const pointIds = new Set([piece.originPoint, ...Object.values(piece.linkedMirror.pointMap ?? {}), ...edges.flatMap(edge => [edge.from, edge.to]), ...pattern.paths.filter(path => pathIds.has(path.id)).flatMap(path => path.pathPoints.map(point => point.id))]);
  return { ...pattern, pieces: pattern.pieces.map(item => { if (item.id !== pieceId) return item; const { linkedMirror: _link, ...rest } = item as LinkedPiece; return rest as Piece; }),
    paths: pattern.paths.map(path => { if (!pathIds.has(path.id)) return path; const { referencedPath: _source, mirrorLine: _axis, referencedFromPoint: _from, referencedToPoint: _to, mirrorX: _x, mirrorY: _y, ...rest } = path; return { ...rest, pathType: path.pathPoints.some(point => point.handle) ? 'curve' : 'line', pathPoints: path.pathPoints.map(point => point.handle ? { ...point, handle: { ...point.handle, lengthFormula: { formula: '', unit: point.handle.lengthFormula.unit }, angleFormula: { formula: '', unit: point.handle.angleFormula.unit } } } : point) }; }),
    points: pattern.points.map(point => pointIds.has(point.id) && point.constraint?.type === 'mirror' ? { ...point, constraint: undefined } : point), hasChanged: true };
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
/** Synchronise source topology, curve handles, compensation and placement in one undo transaction. */
export function syncLinkedMirrorPlacements(pattern: Pattern, uid = defaultUid): Pattern {
  if (!pattern.pieces.some(piece => piece.linkedMirror)) return pattern;
  const pieces = new Map(pattern.pieces.map(piece => [piece.id, piece as LinkedPiece])), points = indexPoints(pattern), paths = indexPaths(pattern);
  const done = new Set<string>(), active = new Set<string>(), removedEdges = new Set<string>(), orphanPaths = new Set<string>(), orphanPoints = new Set<string>();
  let changed = false;
  function sync(id: string): boolean {
    const piece = pieces.get(id);
    if (!piece || done.has(id)) return Boolean(piece);
    if (active.has(id)) return false;
    const link = piece.linkedMirror;
    if (!link) { done.add(id); return true; }
    active.add(id);
    if (!sync(link.sourcePieceId)) { active.delete(id); return false; }
    const source = pieces.get(link.sourcePieceId)!, ends = axisEnds({ ...pattern, points: [...points.values()], paths: [...paths.values()] }, link.axisPathId);
    const sourceOrigin = points.get(source.originPoint);
    if (!ends || !sourceOrigin) { active.delete(id); return false; }
    const [a, b] = ends, scale = pieceShrinkageScale(pattern, source);
    const transform = (point: Vec2): Vec2 => reflectAcrossLine({ x: sourceOrigin.x + (point.x - sourceOrigin.x) * scale.x, y: sourceOrigin.y + (point.y - sourceOrigin.y) * scale.y }, a, b);
    const reflectedZero = transform({ x: 0, y: 0 });
    const vector = (point: Vec2): Vec2 => { const reflected = transform(point); return { x: reflected.x - reflectedZero.x, y: reflected.y - reflectedZero.y }; };
    // Copying a linked piece must create a fresh derivative graph, never reuse its original owner's identities.
    const priorOwner = pattern.pieces.find(other => other.id !== piece.id && other.linkedMirror && Object.values(other.linkedMirror.pointMap ?? {}).some(target => Object.values(link.pointMap ?? {}).includes(target)));
    const copying = link.ownerPieceId ? link.ownerPieceId !== piece.id : Boolean(priorOwner && pattern.pieces.indexOf(priorOwner) < pattern.pieces.findIndex(item => item.id === piece.id));
    const pointMap = copying ? {} as Record<string, string> : { ...link.pointMap }, edgeMap = copying ? {} as Record<string, string> : { ...link.edgeMap };
    // Migrate documents created before maps were stored using their explicit source constraints.
    for (const edge of copying ? [] : [...piece.mainPaths, ...piece.internalPaths]) {
      const path = paths.get(edge.path);
      for (const point of path?.pathPoints ?? []) { const constraint = points.get(point.id)?.constraint; if (constraint?.type === 'mirror') pointMap[constraint.source] ??= point.id; }
      const sourceEdge = [...source.mainPaths, ...source.internalPaths].find(item => item.path === path?.referencedPath && (!edgeMap[item.id] || edgeMap[item.id] === edge.id));
      if (sourceEdge) edgeMap[sourceEdge.id] ??= edge.id;
    }
    const sourceEdges = [...source.mainPaths, ...source.internalPaths];
    if (sourceEdges.some(edge => !paths.has(edge.path) || (paths.get(edge.path)?.pathPoints.length ?? 0) < 2 || paths.get(edge.path)?.pathPoints.some(point => !points.has(point.id)) || !points.has(edge.from) || !points.has(edge.to))) { active.delete(id); return false; }
    const wantedPoints = new Set([source.originPoint, ...sourceEdges.flatMap(edge => [edge.from, edge.to, ...(paths.get(edge.path)?.pathPoints.map(point => point.id) ?? [])])]);
    for (const sourcePointId of wantedPoints) {
      const sourcePoint = points.get(sourcePointId); if (!sourcePoint) { active.delete(id); return false; }
      const targetId = pointMap[sourcePointId] ??= uid('Point');
      const next: ConstrainablePoint = { ...sourcePoint, id: targetId, name: `Mirror of ${sourcePoint.name}`, ...transform(sourcePoint),
        constraint: { type: 'mirror', source: sourcePointId, axisPath: link.axisPathId, compensation: { originPointId: source.originPoint, scaleX: scale.x, scaleY: scale.y } } };
      if (!same(points.get(targetId), next)) { points.set(targetId, next); changed = true; }
    }
    const targetPathBySource = new Map<string, string>();
    for (const edge of copying ? [] : [...piece.mainPaths, ...piece.internalPaths]) { const path = paths.get(edge.path); if (path?.referencedPath) targetPathBySource.set(path.referencedPath, path.id); }
    for (const sourcePathId of new Set(sourceEdges.map(edge => edge.path))) {
      const sourcePath = paths.get(sourcePathId)!, targetId = targetPathBySource.get(sourcePathId) ?? uid('Path'); targetPathBySource.set(sourcePathId, targetId);
      const target: ConstrainablePath = { ...sourcePath, id: targetId, name: `Mirror of ${sourcePath.name}`, pathType: 'referenced', referencedPath: sourcePathId, mirrorLine: link.axisPathId, referencedFromPoint: undefined, referencedToPoint: undefined, basePoint: undefined, lengthFormula: undefined, angleFormula: undefined, arc: undefined, slidingPoints: undefined,
        pathPoints: sourcePath.pathPoints.map(point => {
          const oldHandle = paths.get(targetId)?.pathPoints.find(item => item.id === pointMap[point.id])?.handle;
          const handleId = point.handle?.id ? oldHandle?.id && oldHandle.id !== point.handle.id ? oldHandle.id : uid('Handle') : undefined;
          return { id: pointMap[point.id], ...(point.handle ? { handle: { ...point.handle, id: handleId, v1: vector(point.handle.v1), v2: vector(point.handle.v2) } } : {}) };
        }) };
      if (!same(paths.get(targetId), target)) { paths.set(targetId, target); changed = true; }
    }
    const cloneEdge = (edge: PiecePath): PiecePath => {
      const targetId = edgeMap[edge.id] ??= uid('PiecePath');
      const existing = [...piece.mainPaths, ...piece.internalPaths].find(item => item.id === targetId) ?? (copying ? source.mainPaths.includes(edge) ? piece.mainPaths[source.mainPaths.indexOf(edge)] : piece.internalPaths[source.internalPaths.indexOf(edge)] : undefined);
      const poly = piecePathPolyline(edge, paths, points, 4).map(transform);
      const total = poly.slice(1).reduce((length, point, index) => length + Math.hypot(point.x - poly[index].x, point.y - poly[index].y), 0);
      const notches = (edge.notches ?? []).map((notch, index) => {
        const sourceNotchKey = notch.id ?? `index-${index}`;
        const old = existing?.notches?.find(item => item.linkedSourceNotchId === sourceNotchKey) ?? (existing?.notches?.[index]?.linkedSourceNotchId === undefined ? existing?.notches?.[index] : undefined);
        const ratio = notchRatio(notch, edge, paths, points);
        return { ...notch, id: !copying && old?.id && old.id !== notch.id ? old.id : uid('Notch'), linkedSourceNotchId: sourceNotchKey, referencePointId: notch.referencePointId ? pointMap[notch.referencePointId] : undefined,
          ...(notch.referencePointId ? { distance: (notch.referencePointId === edge.to ? 1 - ratio : ratio) * total, distanceFormula: undefined } : { position: ratio }) };
      });
      return { ...(existing ?? edge), id: targetId, path: targetPathBySource.get(edge.path)!, from: pointMap[edge.from], to: pointMap[edge.to], reversed: edge.reversed, notches };
    };
    const mainPaths = source.mainPaths.map(cloneEdge), internalPaths = source.internalPaths.map(cloneEdge), wantedEdges = new Set([...mainPaths, ...internalPaths].map(edge => edge.id));
    for (const edge of [...piece.mainPaths, ...piece.internalPaths]) { if (!wantedEdges.has(edge.id)) removedEdges.add(edge.id); if (![...mainPaths, ...internalPaths].some(item => item.path === edge.path)) orphanPaths.add(edge.path); }
    for (const [sourceId, targetId] of Object.entries(pointMap)) if (!wantedPoints.has(sourceId)) { orphanPoints.add(targetId); delete pointMap[sourceId]; }
    for (const sourceId of Object.keys(edgeMap)) if (!sourceEdges.some(edge => edge.id === sourceId)) delete edgeMap[sourceId];
    const theta = Math.atan2(b.y - a.y, b.x - a.x), c = Math.cos(2 * theta), s = Math.sin(2 * theta), angle = source.rotation * Math.PI / 180;
    const ax = c * (source.mirrorX ? -1 : 1), ay = s * (source.mirrorY ? -1 : 1);
    const bx = Math.cos(angle) * ax - Math.sin(angle) * ay, by = Math.sin(angle) * ax + Math.cos(angle) * ay, cx = c * bx + s * by, cy = s * bx - c * by;
    const mirrorX = source.mirrorX !== source.mirrorY;
    let firstEdgeSymmetryAffine: Piece['firstEdgeSymmetryAffine'];
    const sourceFold = source.mainPaths[0], foldA = sourceFold && points.get(sourceFold.from), foldB = sourceFold && points.get(sourceFold.to);
    if (source.firstEdgeSymmetry && foldA && foldB) {
      const fold = (point: Vec2): Vec2 => {
        const unreflected = reflectAcrossLine(point, a, b);
        const raw = { x: sourceOrigin.x + (unreflected.x - sourceOrigin.x) / scale.x, y: sourceOrigin.y + (unreflected.y - sourceOrigin.y) / scale.y };
        return transform(source.firstEdgeSymmetryAffine ? applyFoldAffine(source.firstEdgeSymmetryAffine, raw) : reflectAcrossLine(raw, foldA, foldB));
      };
      const zero = fold({ x: 0, y: 0 }), x = fold({ x: 1, y: 0 }), y = fold({ x: 0, y: 1 });
      firstEdgeSymmetryAffine = { a: x.x - zero.x, b: y.x - zero.x, c: x.y - zero.y, d: y.y - zero.y, tx: zero.x, ty: zero.y };
    }
    const next: LinkedPiece = { ...piece, mainPaths, internalPaths, originPoint: pointMap[source.originPoint], useMaterialScaling: false, firstEdgeSymmetry: source.firstEdgeSymmetry, firstEdgeSymmetryAffine,
      position: reflectAcrossLine(source.position, a, b), rotation: Math.atan2(cy * (mirrorX ? -1 : 1), cx * (mirrorX ? -1 : 1)) * 180 / Math.PI, mirrorX, mirrorY: false,
      grainVector: { ...source.grainVector, ...vector(source.grainVector ?? { x: 0, y: 1 }) },
      markers: source.markers?.map((marker) => ({ ...marker, id: `${piece.id}-marker-${marker.id}`, ...transform(marker) })),
      piecePoints: source.piecePoints?.map((point) => ({ ...point, id: `${piece.id}-point-${point.id}`, ...transform(point) })), linkedMirror: { ...link, ownerPieceId: piece.id, edgeMap, pointMap } };
    if (!same(piece, next)) { pieces.set(id, next); changed = true; }
    active.delete(id); done.add(id); return true;
  }
  for (const piece of pattern.pieces) sync(piece.id);
  if (!changed) return pattern;
  const livePieces = [...pieces.values()], referencedPaths = new Set(livePieces.flatMap(piece => [...piece.mainPaths, ...piece.internalPaths].map(edge => edge.path)));
  for (const id of orphanPaths) if (!referencedPaths.has(id) && ![...paths.values()].some(path => path.referencedPath === id) && ![...points.values()].some(point => point.constraint && ('path' in point.constraint && point.constraint.path === id || 'axisPath' in point.constraint && point.constraint.axisPath === id))) paths.delete(id);
  const referencedPoints = new Set([...livePieces.flatMap(piece => [piece.originPoint, ...piece.mainPaths.flatMap(edge => [edge.from, edge.to]), ...piece.internalPaths.flatMap(edge => [edge.from, edge.to])]), ...[...paths.values()].flatMap(path => path.pathPoints.map(point => point.id)), ...(pattern.measurements ?? []).flatMap(row => [row.fromPointId, row.toPointId, row.viaPointId ?? ''])]);
  for (const id of orphanPoints) if (!referencedPoints.has(id) && ![...points.values()].some(point => point.constraint && ('source' in point.constraint && point.constraint.source === id || 'from' in point.constraint && point.constraint.from === id || point.constraint.type === 'intersection' && (point.constraint.a === id || point.constraint.b === id) || point.constraint.type === 'mirror' && point.constraint.compensation?.originPointId === id))) points.delete(id);
  return { ...pattern, pieces: livePieces, points: [...points.values()], paths: [...paths.values()], seams: pattern.seams.filter(seam => ![...seam.fromPaths, ...seam.toPaths].some(ref => removedEdges.has(ref.id))) };
}
export function linkedMirrorProblem(pattern: Pattern, piece: Piece): string | null {
  const link = (piece as LinkedPiece).linkedMirror;
  if (!link) return null;
  if (!pattern.pieces.some(source => source.id === link.sourcePieceId)) return 'Linked mirror source piece is missing. Detach to keep the current geometry.';
  if (!axisEnds(pattern, link.axisPathId)) return 'Linked mirror axis is missing or no longer a straight, nondegenerate two-point path. Restore the axis or detach to keep the current geometry.';
  const seen = new Set([piece.id]); let source = pattern.pieces.find(item => item.id === link.sourcePieceId) as LinkedPiece | undefined;
  while (source?.linkedMirror) { if (seen.has(source.id)) return 'Linked mirror references are circular. Detach to keep the current geometry.'; seen.add(source.id); source = pattern.pieces.find(item => item.id === source?.linkedMirror?.sourcePieceId); }
  return null;
}
