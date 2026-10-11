import { describe, expect, it } from 'vitest';
import { createEmptyPattern, redraft, syncLinkedPaths, pieceTransform, pieceShrinkageScale, pieceWorldOutline, pieceOutlineTagged, pieceAllowancePolygon, foldAffineProblem, indexPoints, type Pattern, type Piece } from '@seamer/pattern-model';
import { createLinkedMirror, detachLinkedMirror, isLinkedMirrorPiece, syncLinkedMirrorPlacements } from './linkedMirror';
import { diagnoseSeam, moveAssemblyStep, splitAssemblySeams } from './seamDiagnostics';
import { matchesShortcut, drawingShortcutTool, DRAWING_SHORTCUTS, SHORTCUT_GROUPS } from './shortcuts';
import { nextSidebarTab } from './studioTasks';
import { simulationStage } from './simulationStage';
function fixture(): Pattern {
  const pattern = createEmptyPattern();
  pattern.points = [{ id: 'a', name: 'A', x: 20, y: 0 }, { id: 'b', name: 'B', x: 40, y: 0 }, { id: 'c', name: 'C', x: 40, y: 30 }, { id: 'axis-a', name: 'Axis A', x: 0, y: -20 }, { id: 'axis-b', name: 'Axis B', x: 0, y: 100 }];
  pattern.paths = [
    { id: 'ab', name: 'AB', version: 1, pathType: 'line', pathPoints: [{ id: 'a' }, { id: 'b' }] },
    { id: 'bc', name: 'BC', version: 1, pathType: 'line', pathPoints: [{ id: 'b' }, { id: 'c' }] },
    { id: 'ca', name: 'CA', version: 1, pathType: 'line', pathPoints: [{ id: 'c' }, { id: 'a' }] },
    { id: 'axis', name: 'Axis', version: 1, pathType: 'line', pathPoints: [{ id: 'axis-a' }, { id: 'axis-b' }] }
  ];
  pattern.pieces = [{ id: 'piece', name: 'Triangle', originPoint: 'a', origin: { name: '', x: 0, y: 0 }, position: { x: 20, y: 0 }, rotation: 0, mirrorX: false, mirrorY: false, materialId: '', mainPaths: [{ id: 'edge-ab', path: 'ab', from: 'a', to: 'b' }, { id: 'edge-bc', path: 'bc', from: 'b', to: 'c' }, { id: 'edge-ca', path: 'ca', from: 'c', to: 'a' }], internalPaths: [], settings3d: {} } as unknown as Piece];
  pattern.seams = [{ id: 'seam', name: 'Join', fromPaths: [{ id: 'edge-ab', mirrored: false, reversed: false }], toPaths: [{ id: 'edge-bc', mirrored: true, reversed: true }] }];
  return pattern;
}
describe('persistent linked mirror authoring', () => {
  it('follows source geometry and axis changes, then detaches without changing the shape', () => {
    let n = 0;
    let pattern = createLinkedMirror(fixture(), 'piece', 'axis', prefix => `${prefix}-${++n}`);
    const mirror = pattern.pieces[1];
    expect(isLinkedMirrorPiece(pattern, mirror)).toBe(true);
    const mirroredA = pattern.points.find(point => point.id === mirror.mainPaths[0].from)!;
    expect(mirroredA.x).toBe(-20);
    pattern = { ...pattern, points: pattern.points.map(point => point.id === 'a' ? { ...point, x: 35 } : point) };
    pattern = syncLinkedMirrorPlacements(syncLinkedPaths(redraft(pattern)));
    expect(pattern.points.find(point => point.id === mirroredA.id)?.x).toBeCloseTo(-35);
    pattern = { ...pattern, points: pattern.points.map(point => point.id.startsWith('axis-') ? { ...point, x: 10 } : point) };
    pattern = syncLinkedMirrorPlacements(syncLinkedPaths(redraft(pattern)));
    expect(pattern.points.find(point => point.id === mirroredA.id)?.x).toBeCloseTo(-15);
    pattern = { ...pattern, pieces: pattern.pieces.map(piece => piece.id === 'piece' ? { ...piece, position: { x: 60, y: 25 }, rotation: 30 } : piece) };
    pattern = syncLinkedMirrorPlacements(pattern);
    expect(pattern.pieces[1].position).toEqual({ x: -40, y: 25 });
    expect(pattern.pieces[1].rotation).toBeCloseTo(-30);
    const detached = detachLinkedMirror(pattern, mirror.id);
    expect(isLinkedMirrorPiece(detached, mirror)).toBe(false);
    expect(detached.points.find(point => point.id === mirroredA.id)?.x).toBeCloseTo(-15);
    const movedSource = { ...detached, points: detached.points.map(point => point.id === 'a' ? { ...point, x: 60 } : point) };
    expect(syncLinkedPaths(redraft(movedSource)).points.find(point => point.id === mirroredA.id)?.x).toBeCloseTo(-15);
  });
  it('reflects curved handles and a moved rotated piece across a diagonal axis', () => {
    const source = fixture();
    source.points = source.points.map(point => point.id === 'axis-a' ? { ...point, x: -20 } : point.id === 'axis-b' ? { ...point, x: 100 } : point);
    source.paths[0].pathType = 'curve';
    source.paths[0].pathPoints[0].handle = { v1: { x: 0, y: 0 }, v2: { x: 5, y: 7 }, sameAngle: false, sameLength: false, lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' } };
    source.pieces[0].rotation = 45; source.pieces[0].position = { x: 60, y: 25 };
    let pattern = createLinkedMirror(source, 'piece', 'axis');
    const mirror = pattern.pieces[1], path = pattern.paths.find(path => path.id === mirror.mainPaths[0].path)!;
    expect(mirror.position.x).toBeCloseTo(25); expect(mirror.position.y).toBeCloseTo(60);
    expect(mirror.rotation).toBeCloseTo(-45);
    expect(path.pathPoints[0].handle?.v2.x).toBeCloseTo(7); expect(path.pathPoints[0].handle?.v2.y).toBeCloseTo(5);
    pattern = { ...pattern, paths: pattern.paths.map(path => path.id === 'ab' ? { ...path, pathPoints: path.pathPoints.map((point, index) => index === 0 ? { ...point, handle: { ...point.handle!, v2: { x: 9, y: 3 } } } : point) } : path) };
    pattern = syncLinkedMirrorPlacements(syncLinkedPaths(redraft(pattern)));
    expect(pattern.paths.find(item => item.id === path.id)?.pathPoints[0].handle?.v2).toMatchObject({ x: expect.closeTo(3), y: expect.closeTo(9) });
  });
  it('reuses existing identities as source edges and anchors are added or deleted', () => {
    let pattern = createLinkedMirror(fixture(), 'piece', 'axis');
    const cloneId = pattern.pieces[1].id, existingEdge = pattern.pieces[1].mainPaths[0].id, existingPoint = pattern.pieces[1].originPoint;
    pattern = { ...pattern, points: [...pattern.points, { id: 'extra', name: 'Extra', x: 55, y: 40 }], paths: [...pattern.paths, { id: 'new-path', name: 'New path', pathType: 'line', version: 1, pathPoints: [{ id: 'c' }, { id: 'extra' }] }], pieces: pattern.pieces.map(piece => piece.id === 'piece' ? { ...piece, internalPaths: [{ ...piece.mainPaths[0], id: 'extra-edge', path: 'new-path', from: 'c', to: 'extra' }] } : piece) };
    pattern = syncLinkedMirrorPlacements(pattern);
    expect(pattern.pieces[1].id).toBe(cloneId); expect(pattern.pieces[1].mainPaths[0].id).toBe(existingEdge); expect(pattern.pieces[1].originPoint).toBe(existingPoint);
    const newEdge = pattern.pieces[1].internalPaths[0];
    expect(pattern.points.find(point => point.id === newEdge.to)?.x).toBe(-55);
    pattern = { ...pattern, pieces: pattern.pieces.map(piece => piece.id === 'piece' ? { ...piece, internalPaths: [] } : piece) };
    pattern = syncLinkedMirrorPlacements(pattern);
    expect(pattern.pieces[1].internalPaths).toEqual([]); expect(pattern.paths.some(path => path.id === newEdge.path)).toBe(false);
  });
  it('reflects anisotropic material compensation exactly across a diagonal axis without applying it twice', () => {
    const source = fixture();
    source.materials = [{ id: 'fabric', shrinkageHorizontalPercentage: 25, shrinkageVerticalPercentage: 5 } as unknown as Pattern['materials'][number]];
    source.pieces[0].materialId = 'fabric'; source.pieces[0].useMaterialScaling = true; source.pieces[0].rotation = 30;
    source.points = source.points.map(point => point.id === 'axis-a' ? { ...point, x: -20 } : point.id === 'axis-b' ? { ...point, x: 100 } : point);
    let pattern = createLinkedMirror(source, 'piece', 'axis');
    const compare = () => {
      const points = indexPoints(pattern), original = pattern.pieces[0], clone = pattern.pieces[1];
      const originalTransform = pieceTransform(original, points, pieceShrinkageScale(pattern, original)), cloneTransform = pieceTransform(clone, points, pieceShrinkageScale(pattern, clone));
      for (let i = 0; i < original.mainPaths.length; i++) {
        const a = originalTransform(points.get(original.mainPaths[i].from)!), b = cloneTransform(points.get(clone.mainPaths[i].from)!);
        expect(b.x).toBeCloseTo(a.y, 6); expect(b.y).toBeCloseTo(a.x, 6);
      }
      expect(clone.useMaterialScaling).toBe(false);
    };
    compare();
    pattern.materials = pattern.materials.map(material => ({ ...material, shrinkageHorizontalPercentage: 80 }));
    pattern = syncLinkedMirrorPlacements(pattern); compare();
    const clone = pattern.pieces[1];
    const solved = redraft(pattern);
    expect(solved.points.find(point => point.id === clone.mainPaths[1].from)?.x).toBeCloseTo(pattern.points.find(point => point.id === clone.mainPaths[1].from)!.x);
  });
  it('preserves a compensated diagonal fold as an exact affine reflection, including after detachment', () => {
    const source = fixture();
    source.materials = [{ id: 'fabric', shrinkageHorizontalPercentage: 25, shrinkageVerticalPercentage: 5 } as unknown as Pattern['materials'][number]];
    source.pieces[0].materialId = 'fabric'; source.pieces[0].useMaterialScaling = true; source.pieces[0].firstEdgeSymmetry = true; source.pieces[0].rotation = 30;
    source.points = source.points.map(point => point.id === 'b' ? { ...point, y: 20 } : point.id === 'axis-a' ? { ...point, x: -20 } : point.id === 'axis-b' ? { ...point, x: 100 } : point);
    const pattern = createLinkedMirror(source, 'piece', 'axis'), clone = pattern.pieces[1];
    expect(foldAffineProblem(clone.firstEdgeSymmetryAffine)).toBeNull();
    const expected = pieceWorldOutline(pattern, pattern.pieces[0]).map(point => ({ x: point.y, y: point.x }));
    const actual = pieceWorldOutline(pattern, clone);
    expect(actual.length).toBe(expected.length);
    for (const point of expected) expect(Math.min(...actual.map(other => Math.hypot(other.x - point.x, other.y - point.y)))).toBeLessThan(1e-7);
    expect(pieceWorldOutline(detachLinkedMirror(pattern, clone.id), clone)).toEqual(actual);
    const tags = pieceOutlineTagged(pattern, clone);
    expect(tags.pts).toHaveLength(actual.length); expect(tags.edgeOf).toHaveLength(tags.pts.length);
  });
  it('offsets the full folded outline when per-edge allowances are authored', () => {
    const pattern = fixture(), piece = pattern.pieces[0]; piece.firstEdgeSymmetry = true;
    piece.mainPaths[1].seamAllowance = 4;
    const tagged = pieceOutlineTagged(pattern, piece);
    expect(Math.min(...tagged.pts.map(point => point.y))).toBe(-30);
    expect(Math.max(...tagged.pts.map(point => point.y))).toBe(30);
    expect(tagged.edgeOf.filter(id => id === 'edge-bc').length).toBe(2);
    expect(tagged.edgeOf).not.toContain('edge-ab');
    expect(tagged.pts).toHaveLength(4);
    const allowance = pieceAllowancePolygon(pattern, piece, 2);
    expect(Math.min(...allowance.map(point => point.y))).toBeLessThan(-30);
    expect(Math.max(...allowance.map(point => point.y))).toBeGreaterThan(30);
    expect(Math.max(...allowance.map(point => point.x))).toBeCloseTo(44, 4);
    expect(foldAffineProblem({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })).toBeTruthy();
  });
  it('gives duplicated and clipboard-pasted linked pieces fresh derived identities without modifying the original graph', () => {
    const source = fixture(); source.pieces[0].mainPaths[0].notches = [{ id: 'source-notch', position: 0.25 }];
    const linked = createLinkedMirror(source, 'piece', 'axis'), original = linked.pieces[1];
    const copied = structuredClone(original); copied.id = 'copy'; copied.name = 'Clipboard copy';
    for (const edge of [...copied.mainPaths, ...copied.internalPaths]) edge.id = `copy-${edge.id}`;
    const synced = syncLinkedMirrorPlacements({ ...linked, pieces: [...linked.pieces, copied] });
    const updatedOriginal = synced.pieces[1], copy = synced.pieces[2];
    expect(updatedOriginal).toEqual(original);
    expect(copy.linkedMirror?.ownerPieceId).toBe(copy.id);
    expect(copy.originPoint).not.toBe(original.originPoint);
    const oldEdges = new Set(original.mainPaths.map(edge => edge.id)), oldPaths = new Set(original.mainPaths.map(edge => edge.path));
    expect(copy.mainPaths.every(edge => !oldEdges.has(edge.id) && !oldPaths.has(edge.path))).toBe(true);
    expect(copy.mainPaths[0].notches[0].id).not.toBe(original.mainPaths[0].notches[0].id);
    expect(copy.position).toEqual(original.position);
    expect(syncLinkedMirrorPlacements(synced)).toBe(synced);
  });
  it('creates unique notch IDs and remaps anchored notch references', () => {
    const source = fixture(); source.pieces[0].mainPaths[0].notches = [{ id: 'notch', referencePointId: 'a', distance: 5 }];
    const pattern = createLinkedMirror(source, 'piece', 'axis'), notch = pattern.pieces[1].mainPaths[0].notches[0];
    expect(notch.id).not.toBe('notch'); expect(notch.referencePointId).toBe(pattern.pieces[1].mainPaths[0].from);
    expect(notch.distance).toBeCloseTo(5);
    expect(syncLinkedMirrorPlacements(pattern)).toBe(pattern);
  });
  it('rejects missing and degenerate axes without mutating the source', () => {
    const pattern = fixture();
    expect(() => createLinkedMirror(pattern, 'piece', 'missing')).toThrow(/axis/);
    pattern.points = pattern.points.map(point => point.id === 'axis-b' ? { ...point, y: -20 } : point);
    expect(() => createLinkedMirror(pattern, 'piece', 'axis')).toThrow(/distinct/);
    expect(pattern.pieces).toHaveLength(1);
  });
});
describe('sewing diagnostics and assembly', () => {
  it('measures authored ease independent of mirrored sewing direction and does not silently resolve broken references', () => {
    const pattern = fixture();
    expect(diagnoseSeam(pattern, pattern.seams[0])).toMatchObject({ fromMm: 20, toMm: 30, easeMm: -10, status: 'mismatch' });
    expect(diagnoseSeam(pattern, { ...pattern.seams[0], expectedEaseMm: -10, toleranceMm: 0 })).toMatchObject({ status: 'matched' });
    expect(diagnoseSeam(pattern, { ...pattern.seams[0], toPaths: [{ id: 'missing', mirrored: false, reversed: false }] })).toMatchObject({ status: 'unresolved', easeMm: null, missing: ['missing'] });
  });
  it('materialises implicit seams and reorders complete recording steps', () => {
    const pattern = fixture(); pattern.seams.push({ ...pattern.seams[0], id: 'other', name: 'Other' });
    const split = splitAssemblySeams(pattern);
    const moved = moveAssemblyStep(split, split.assembly!.steps[1].id, -1);
    expect(moved.assembly!.steps.map(step => step.seamIds)).toEqual([['other'], ['seam']]);
    expect(moveAssemblyStep(moved, moved.assembly!.steps[0].id, -1)).toBe(moved);
  });
});
describe('workflow keyboard and renderer states', () => {
  const event = { key: 'S', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
  it('matches exact modifiers and drawing bindings shared with help', () => {
    expect(matchesShortcut(event, 'save')).toBe(true);
    expect(matchesShortcut({ ...event, altKey: true }, 'save')).toBe(false);
    expect(matchesShortcut({ ...event, key: 'z', shiftKey: true }, 'undo')).toBe(false);
    expect(matchesShortcut({ ...event, key: 'z', shiftKey: true }, 'redo')).toBe(true);
    for (const [tool, binding] of Object.entries(DRAWING_SHORTCUTS)) {
      expect(drawingShortcutTool({ ...event, ctrlKey: false, key: binding.split('+').at(-1)!, shiftKey: binding.startsWith('Shift+') })).toBe(tool);
    }
    expect(SHORTCUT_GROUPS.find(group => group.title === 'Tools (2D)')?.items).toHaveLength(Object.keys(DRAWING_SHORTCUTS).length);
  });
  it('wraps keyboard tabs and gives running state precedence over cached checkpoints', () => {
    expect(nextSidebarTab(['a', 'b', 'c'], 'a', 'ArrowLeft')).toBe('c');
    expect(nextSidebarTab(['a', 'b', 'c'], 'b', 'Home')).toBe('a');
    expect(nextSidebarTab(['a'], 'a', 'Enter')).toBeNull();
    expect(simulationStage({ status: 'simulating', arranging: false, savedPieces: 2, held: true, source: true })).toBe('running');
    expect(simulationStage({ status: 'ready', arranging: false, savedPieces: 2, held: true, source: true })).toBe('held');
  });
});
