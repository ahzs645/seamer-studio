import { describe, it, expect } from 'vitest';
import { createDoc, Editor } from '@atelier/core';
import { createEmptyPattern, type Pattern } from '../pattern';
import { COMMANDS, createPatternRegistry } from './registry';

type ExecuteHost = Editor<Pattern>;

function executeCommand(
  host: ExecuteHost,
  type: string,
  params: Record<string, unknown> = {}
) {
  return host.execute(type, params);
}

/** A live host over a mutable pattern, like the studio installs. */
function host(initial: Pattern): { h: ExecuteHost; get: () => Pattern } {
  const instance = new Editor(createDoc(initial), { registry: createPatternRegistry() });
  return {
    h: instance,
    get: () => instance.content
  };
}

describe('creation commands (via command bus)', () => {
  it('registry exposes the full creation + topology surface', () => {
    for (const t of [
      'point.create', 'path.createLine', 'path.createCurve', 'path.createEllipse', 'path.createCenterArc',
      'path.createThreePointArc', 'piece.createDynamic', 'seam.create', 'seam.reverse', 'notch.add',
      'notch.update', 'notch.delete', 'variable.create', 'variable.delete', 'material.upsert',
      'material.delete', 'layer.create', 'layer.delete', 'text.create', 'path.update', 'piece.update',
      'piece.rotate', 'piecePath.update', 'slidingPoint.update', 'path.splitCurveAtPoint',
      'path.splitLineAtPoint', 'path.mergeCurvesAtPoint', 'path.mergeLinesAtPoint', 'path.convertToCurve',
      'path.convertToLine', 'point.convertToCurvePoint', 'point.convertToSlidingPoint',
      'point.releaseSlidingPoint', 'point.disconnectPaths', 'piece.breakout'
    ]) {
      expect(COMMANDS.has(t), t).toBe(true);
    }
  });

  it('builds a complete piece incrementally: points → lines → piece → notch → seam', () => {
    const { h, get } = host(createEmptyPattern());
    // a 100×100 square from coordinates (path.createLine creates the points)
    expect(executeCommand(h, 'path.createLine', { from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }).ok).toBe(true);
    const [a, b] = get().points.map((q) => q.id);
    expect(executeCommand(h, 'path.createLine', { from: b, to: { x: 100, y: 100 } }).ok).toBe(true);
    const c = get().points[2].id;
    expect(executeCommand(h, 'path.createLine', { from: c, to: { x: 0, y: 100 } }).ok).toBe(true);
    const d = get().points[3].id;
    expect(executeCommand(h, 'path.createLine', { from: d, to: a }).ok).toBe(true);
    expect(get().points).toHaveLength(4);
    expect(get().paths).toHaveLength(4);

    const pathIds = get().paths.map((q) => q.id);
    const res = executeCommand(h, 'piece.createDynamic', { pathIds, name: 'Square' });
    expect(res.ok && res.changed).toBe(true);
    const piece = get().pieces[0];
    expect(piece.name).toBe('Square');
    expect(piece.mainPaths).toHaveLength(4);

    // notch on the first edge
    const ppId = piece.mainPaths[0].id;
    expect(executeCommand(h, 'notch.add', { piecePathId: ppId, position: 0.5, type: 'double' }).changed).toBe(true);
    const notch = get().pieces[0].mainPaths[0].notches[0];
    expect(notch.position).toBe(0.5);
    expect(notch.type).toBe('double');
    expect(executeCommand(h, 'notch.update', { notchId: notch.id, position: 0.25 }).changed).toBe(true);
    expect(get().pieces[0].mainPaths[0].notches[0].position).toBe(0.25);
    expect(executeCommand(h, 'notch.delete', { notchId: notch.id }).changed).toBe(true);
    expect(get().pieces[0].mainPaths[0].notches).toHaveLength(0);

    // seam between two edges of the piece
    const pp2 = piece.mainPaths[1].id;
    expect(executeCommand(h, 'seam.create', { fromPiecePathIds: [ppId], toPiecePathIds: [pp2] }).changed).toBe(true);
    expect(get().seams).toHaveLength(1);
    expect(executeCommand(h, 'seam.reverse', { seamId: get().seams[0].id, side: 'to', index: 0 }).changed).toBe(true);
    expect(get().seams[0].toPaths[0].reversed).toBe(true);
  });

  it('creates a parametric circle with arc metadata', () => {
    const { h, get } = host(createEmptyPattern());
    expect(executeCommand(h, 'path.createEllipse', { center: { x: 0, y: 0 }, radiusPoint: { x: 50, y: 0 } }).changed).toBe(true);
    const path = get().paths[0];
    expect(path.pathType).toBe('curve');
    expect(path.arc?.kind).toBe('circle');
    expect(path.arc?.r).toBeCloseTo(50, 6);
    expect(path.arc?.centerId).toBe(get().points[0].id); // the created center point
    // closed loop: first/last path point identical
    expect(path.pathPoints[0].id).toBe(path.pathPoints[path.pathPoints.length - 1].id);
  });

  it('creates a center arc whose baked points lie on the radius', () => {
    const { h, get } = host(createEmptyPattern());
    executeCommand(h, 'path.createCenterArc', { center: { x: 0, y: 0 }, start: { x: 40, y: 0 }, end: { x: 0, y: 40 } });
    const path = get().paths[0];
    expect(path.arc?.kind).toBe('centerArc');
    for (const pp of path.pathPoints) {
      const pt = get().points.find((q) => q.id === pp.id)!;
      expect(Math.hypot(pt.x, pt.y)).toBeCloseTo(40, 4);
    }
  });

  it('variable / material / layer / text lifecycle', () => {
    const { h, get } = host(createEmptyPattern());
    expect(executeCommand(h, 'variable.create', { name: 'ease', value: 12 }).changed).toBe(true);
    expect(executeCommand(h, 'variable.create', { name: 'ease' }).changed).toBe(false); // duplicate name
    expect(executeCommand(h, 'variable.delete', { variableId: 'ease' }).changed).toBe(true);
    expect(get().variables).toHaveLength(0);

    expect(executeCommand(h, 'material.upsert', { name: 'Denim', color: '#3b5377', roughness: 0.9 }).changed).toBe(true);
    const mat = get().materials.find((m) => m.name === 'Denim')!;
    expect(mat.roughness).toBe(0.9);
    expect(mat.frontTexture?.color).toBe('#3b5377');
    expect(executeCommand(h, 'material.upsert', { materialId: mat.id, name: 'Denim 2' }).changed).toBe(true);
    expect(get().materials.find((m) => m.id === mat.id)?.name).toBe('Denim 2');
    expect(executeCommand(h, 'material.delete', { materialId: mat.id }).changed).toBe(true);

    expect(executeCommand(h, 'layer.create', { name: 'Construction', makeCurrent: true }).changed).toBe(true);
    const layer = get().layers.find((l) => l.name === 'Construction')!;
    expect(get().currentLayerId).toBe(layer.id);
    // a point created now lands on that layer; deleting the layer moves it to default
    executeCommand(h, 'point.create', { x: 1, y: 2 });
    expect(get().points[0].layerId).toBe(layer.id);
    expect(executeCommand(h, 'layer.delete', { layerId: layer.id }).changed).toBe(true);
    expect(get().points[0].layerId).toBe('default');
    expect(get().currentLayerId).toBe('default');
    expect(executeCommand(h, 'layer.delete', { layerId: 'default' }).changed).toBe(false); // protected

    expect(executeCommand(h, 'text.create', { value: 'Cut 2', x: 10, y: 20 }).changed).toBe(true);
    expect(get().texts[0].value).toBe('Cut 2');
  });

  it('piece.update whitelists fields and piece.rotate accumulates', () => {
    const { h, get } = host(createEmptyPattern());
    executeCommand(h, 'path.createLine', { from: { x: 0, y: 0 }, to: { x: 100, y: 0 } });
    executeCommand(h, 'piece.createDynamic', { pathIds: [get().paths[0].id] });
    const id = get().pieces[0].id;
    expect(executeCommand(h, 'piece.update', { pieceId: id, rightPieces: 2, mirrorX: true, name: 'Front', bogus: 'x' }).changed).toBe(true);
    const piece = get().pieces[0];
    expect(piece.rightPieces).toBe(2);
    expect(piece.mirrorX).toBe(true);
    expect(piece.name).toBe('Front');
    expect((piece as unknown as Record<string, unknown>).bogus).toBeUndefined();
    executeCommand(h, 'piece.rotate', { pieceId: id, degrees: 30 });
    executeCommand(h, 'piece.rotate', { pieceId: id, degrees: 45 });
    expect(get().pieces[0].rotation).toBe(75);
  });

  it('path.convertToCurve/Line round-trips', () => {
    const { h, get } = host(createEmptyPattern());
    executeCommand(h, 'path.createLine', { from: { x: 0, y: 0 }, to: { x: 50, y: 0 } });
    const id = get().paths[0].id;
    expect(executeCommand(h, 'path.convertToCurve', { pathId: id }).ok).toBe(true);
    expect(get().paths[0].pathType).toBe('curve');
    expect(executeCommand(h, 'path.convertToLine', { pathId: id }).ok).toBe(true);
    expect(get().paths[0].pathType).toBe('line');
    expect(get().paths[0].pathPoints.every((pp) => !pp.handle)).toBe(true);
  });
});
