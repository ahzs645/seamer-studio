import { describe, it, expect } from 'vitest';
import { createEmptyPattern, type Pattern, type ConstrainablePoint } from '@seamer/pattern-model';
import { selectionMove, selectionRotate, selectionScale, selectionMirror } from './selection';
import { elementBringToFront, elementSendToBack, elementMoveToLayer, elementRename } from './element';
import { variableReorder, variableSetOptions, layerRename, imageUpdate } from './structural';
import { pieceAddPath } from './piece';
import { executeCommand, type ExecuteHost } from './execute';

function pt(id: string, x: number, y: number, fixed = true): ConstrainablePoint {
  const p: ConstrainablePoint = { id, name: id, x, y };
  if (!fixed) p.constraint = { type: 'offset', from: 'A', dxFormula: '0', dyFormula: '0' };
  return p;
}

function base(): Pattern {
  const p = createEmptyPattern();
  p.points = [pt('p1', 0, 0), pt('p2', 10, 0), pt('p3', 10, 10), pt('p4', 0, 10)];
  return p;
}

describe('selection transforms', () => {
  const sel = { pointIds: ['p1', 'p2', 'p3', 'p4'] };

  it('move translates every selected free point', () => {
    const out = selectionMove(base(), sel, 5, -3);
    expect(out.points.map((q) => [q.x, q.y])).toEqual([[5, -3], [15, -3], [15, 7], [5, 7]]);
    expect(out.hasChanged).toBe(true);
  });

  it('move by zero is a no-op (same reference)', () => {
    const p = base();
    expect(selectionMove(p, sel, 0, 0)).toBe(p);
  });

  it('rotate 90° about centroid (5,5) maps corners correctly', () => {
    const out = selectionRotate(base(), sel, 90);
    // (0,0)-(5,5) = (-5,-5) -> rot90 CCW -> (5,-5) -> +c = (10,0)
    const p1 = out.points.find((q) => q.id === 'p1')!;
    expect(p1.x).toBeCloseTo(10, 6);
    expect(p1.y).toBeCloseTo(0, 6);
  });

  it('scale 2x about centroid doubles distance from centre', () => {
    const out = selectionScale(base(), sel, 2);
    const p1 = out.points.find((q) => q.id === 'p1')!;
    expect(p1.x).toBeCloseTo(-5, 6); // 5 + (0-5)*2
    expect(p1.y).toBeCloseTo(-5, 6);
  });

  it('mirror on x axis reflects y about centroid', () => {
    const out = selectionMirror(base(), sel, 'x');
    const p1 = out.points.find((q) => q.id === 'p1')!; // y: 2*5 - 0 = 10
    expect(p1.y).toBeCloseTo(10, 6);
    expect(p1.x).toBeCloseTo(0, 6);
  });

  it('constrained points are left untouched by transforms', () => {
    const p = base();
    p.points[1] = pt('p2', 10, 0, false); // constrained
    const out = selectionMove(p, sel, 5, 5);
    const p2 = out.points.find((q) => q.id === 'p2')!;
    expect([p2.x, p2.y]).toEqual([10, 0]); // unchanged
  });

  it('moving a selected piece updates its position', () => {
    const p = base();
    p.pieces = [{ id: 'pc1', position: { x: 100, y: 100 }, mainPaths: [], internalPaths: [], rotation: 0, mirrorX: false, mirrorY: false } as unknown as Pattern['pieces'][number]];
    const out = selectionMove(p, { pieceIds: ['pc1'] }, 10, 20);
    expect(out.pieces[0].position).toEqual({ x: 110, y: 120 });
  });
});

describe('element ops', () => {
  function withPaths(): Pattern {
    const p = base();
    p.paths = [
      { id: 'a', name: 'a', pathType: 'line', pathPoints: [], version: 0 },
      { id: 'b', name: 'b', pathType: 'line', pathPoints: [], version: 0 },
      { id: 'c', name: 'c', pathType: 'line', pathPoints: [], version: 0 }
    ];
    return p;
  }
  it('bringToFront moves a path to the end of the array', () => {
    const out = elementBringToFront(withPaths(), 'a');
    expect(out.paths.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
  it('sendToBack moves a path to the start', () => {
    const out = elementSendToBack(withPaths(), 'c');
    expect(out.paths.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
  it('rename works across kinds', () => {
    expect(elementRename(base(), 'p1', 'Origin').points[0].name).toBe('Origin');
  });
  it('moveToLayer assigns a point to a layer', () => {
    const out = elementMoveToLayer(base(), 'p1', 'L2');
    expect(out.points[0].layerId).toBe('L2');
  });
});

describe('structural ops', () => {
  function withVars(): Pattern {
    const p = base();
    p.variables = ['v1', 'v2', 'v3'].map((id) => ({
      id, name: id, type: 'number', value: 0, valueFormula: { formula: '0', unit: 'none' },
      isEditable: true, isVisible: true, options: [], unitType: 'length'
    }));
    return p;
  }
  it('variableReorder moves a variable to a new index', () => {
    const out = variableReorder(withVars(), 'v1', 2);
    expect(out.variables.map((v) => v.id)).toEqual(['v2', 'v3', 'v1']);
  });
  it('variableSetOptions sets enum options', () => {
    const out = variableSetOptions(withVars(), 'v1', ['S', 'M', 'L']);
    expect(out.variables[0].options).toEqual(['S', 'M', 'L']);
  });
  it('layerRename renames a layer', () => {
    expect(layerRename(base(), 'default', 'Construction').layers[0].name).toBe('Construction');
  });
  it('imageUpdate keeps aspect ratio when locked', () => {
    const p = base();
    p.images = [{ id: 'img', url: '', x: 0, y: 0, width: 100, height: 50 }];
    const out = imageUpdate(p, 'img', { width: 200, lockAspect: true });
    expect(out.images[0].height).toBe(100); // 200 / (100/50)
  });
});

describe('pieceAddPath', () => {
  function withPieceAndPath(): Pattern {
    const p = base();
    p.points = [pt('a', 0, 0), pt('b', 10, 0)];
    p.paths = [{ id: 'path1', name: 'EdgeAB', pathType: 'line', pathPoints: [{ id: 'a' }, { id: 'b' }], version: 0 }];
    p.pieces = [{ id: 'pc1', mainPaths: [], internalPaths: [], position: { x: 0, y: 0 }, rotation: 0 } as unknown as Pattern['pieces'][number]];
    return p;
  }
  const uid = (pre: string) => `${pre}_test`;
  it('attaches an existing path to a piece as a boundary edge', () => {
    const out = pieceAddPath(withPieceAndPath(), 'pc1', 'path1', 'main', uid);
    expect(out.pieces[0].mainPaths).toHaveLength(1);
    expect(out.pieces[0].mainPaths[0]).toMatchObject({ path: 'path1', from: 'a', to: 'b', reversed: false });
  });
  it('attaches as an internal path with a fold angle', () => {
    const out = pieceAddPath(withPieceAndPath(), 'pc1', 'path1', 'internal', uid);
    expect(out.pieces[0].internalPaths).toHaveLength(1);
    expect(out.pieces[0].internalPaths[0].foldAngle).toBe(0);
    expect(out.pieces[0].mainPaths).toHaveLength(0);
  });
  it('is a no-op if the path is already attached', () => {
    const once = pieceAddPath(withPieceAndPath(), 'pc1', 'path1', 'main', uid);
    const twice = pieceAddPath(once, 'pc1', 'path1', 'main', uid);
    expect(twice.pieces[0].mainPaths).toHaveLength(1);
  });
  it('is a no-op for an unknown piece or path', () => {
    const p = withPieceAndPath();
    expect(pieceAddPath(p, 'nope', 'path1', 'main', uid)).toBe(p);
    expect(pieceAddPath(p, 'pc1', 'nope', 'main', uid)).toBe(p);
  });
});

describe('executeCommand', () => {
  function host(p: Pattern): { host: ExecuteHost; applied: { pattern: Pattern; label: string }[] } {
    const applied: { pattern: Pattern; label: string }[] = [];
    let current = p;
    return {
      applied,
      host: {
        getPattern: () => current,
        getSelection: () => ({ pointIds: ['p1', 'p2', 'p3', 'p4'] }),
        apply: (next, label) => { current = next; applied.push({ pattern: next, label }); }
      }
    };
  }
  it('dispatches a selection.move and commits once with a label', () => {
    const { host: h, applied } = host(base());
    const res = executeCommand(h, 'selection.move', { dx: 5, dy: 0 });
    expect(res).toEqual({ ok: true, changed: true });
    expect(applied).toHaveLength(1);
    expect(applied[0].label).toBe('Move selection');
    expect(applied[0].pattern.points[0].x).toBe(5);
  });
  it('a no-op command does not commit', () => {
    const { host: h, applied } = host(base());
    const res = executeCommand(h, 'selection.move', { dx: 0, dy: 0 });
    expect(res.changed).toBe(false);
    expect(applied).toHaveLength(0);
  });
  it('unknown command returns an error', () => {
    const { host: h } = host(base());
    expect(executeCommand(h, 'bogus.op').ok).toBe(false);
  });
});
