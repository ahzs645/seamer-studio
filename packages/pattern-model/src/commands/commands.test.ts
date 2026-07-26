import { describe, it, expect } from 'vitest';
import { createDoc, Editor, Selection } from '@atelier/core';
import { createEmptyPattern, type Pattern, type ConstrainablePoint } from '../pattern';
import { selectionMove, selectionRotate, selectionScale, selectionMirror } from './selection';
import { elementBringToFront, elementSendToBack, elementMoveToLayer, elementRename } from './element';
import { variableReorder, variableSetOptions, layerRename, imageUpdate } from './structural';
import { pieceAddPath } from './piece';
import { COMMANDS, createPatternRegistry } from './registry';

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

function editorHost(pattern: Pattern): Editor<Pattern> {
  const instance = new Editor(createDoc(pattern), { registry: createPatternRegistry() });
  instance.setSelection(Selection.of([['point', ['p1', 'p2', 'p3', 'p4']]]));
  return instance;
}

describe('selection transforms', () => {
  const sel = Selection.of([['point', ['p1', 'p2', 'p3', 'p4']]]);

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
    const out = selectionMove(p, Selection.of([['piece', ['pc1']]]), 10, 20);
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
  function host(pattern: Pattern): Editor<Pattern> {
    const instance = new Editor(createDoc(pattern), { registry: createPatternRegistry() });
    instance.setSelection(Selection.of([['point', ['p1', 'p2', 'p3', 'p4']]]));
    return instance;
  }
  it('dispatches a selection.move and commits once with a label', () => {
    const instance = host(base());
    const res = instance.execute('selection.move', { dx: 5, dy: 0 });
    expect(res).toEqual({ ok: true, changed: true });
    expect(instance.historyLabels).toEqual(['Move selection']);
    expect(instance.content.points[0].x).toBe(5);
  });
  it('a no-op command does not commit', () => {
    const instance = host(base());
    const res = instance.execute('selection.move', { dx: 0, dy: 0 });
    expect(res.changed).toBe(false);
    expect(instance.historyLabels).toHaveLength(0);
  });
  it('unknown command returns an error', () => {
    expect(host(base()).execute('bogus.op').ok).toBe(false);
  });
});

const PRODUCTION_COMMAND_TYPES = [
  'point.create', 'point.move', 'point.rename', 'point.convertToCurvePoint',
  'point.convertToSlidingPoint', 'point.releaseSlidingPoint', 'point.disconnectPaths', 'formula.set',
  'grading.applyPointShifts', 'grading.clearProfile', 'selection.move', 'selection.delete',
  'selection.rotate', 'selection.scale', 'selection.mirror', 'selection.moveToLayer', 'element.rename',
  'element.updateLabel', 'element.moveToLayer', 'element.delete', 'element.sendToBack',
  'element.bringToFront', 'path.createLine', 'path.createCurve', 'path.createCenterArc',
  'path.createThreePointArc', 'path.createEllipse', 'path.reverse', 'path.convertToLine',
  'path.convertToCurve', 'path.splitLineAtPoint', 'path.splitCurveAtPoint',
  'path.mergeLinesAtPoint', 'path.mergeCurvesAtPoint', 'path.update', 'handle.update',
  'slidingPoint.update', 'piece.rotate', 'piece.createDynamic', 'piece.breakout', 'piece.update',
  'piecePath.update', 'piecePath.add', 'piecePoint.add', 'piecePoint.update', 'piecePoint.delete',
  'seam.create', 'seam.reverse', 'text.create', 'text.update', 'image.update', 'notch.add',
  'notch.update', 'notch.delete', 'material.upsert', 'material.delete', 'layer.create',
  'layer.delete', 'layer.rename', 'layer.setCurrent', 'layer.setVisible', 'layer.setLocked',
  'layer.setStyle', 'variable.create', 'variable.delete', 'variable.reorder', 'variable.setEditable',
  'variable.setVisible', 'variable.setDescription', 'variable.setType', 'variable.setOptions',
  'variable.setValue', 'pattern.setName', 'pattern.setDescription', 'pattern.setUnit',
  'pattern.setSeamAllowance', 'pattern.setDefaultNotchSize', 'pattern.setPointNaming',
  'transaction.commit'
] as const;

describe('production command catalog compatibility', () => {
  it('registers all 79 production command types', () => {
    expect(PRODUCTION_COMMAND_TYPES).toHaveLength(79);
    const registry = createPatternRegistry();
    for (const type of PRODUCTION_COMMAND_TYPES) expect(registry.get(type), type).toBeDefined();
  });

  it('matches the five captured public schemas exactly', () => {
    expect(COMMANDS.get('element.updateLabel')).toMatchObject({
      type: 'element.updateLabel',
      category: 'element',
      summary: 'Set or clear a free-text label on a resolvable element.',
      inputs: ['elementId', 'label?'],
      example: { type: 'element.updateLabel', elementId: 'point-a', label: 'left side seam' },
      replayable: true
    });
    expect(COMMANDS.get('grading.applyPointShifts')).toMatchObject({
      type: 'grading.applyPointShifts',
      category: 'grading',
      summary: 'Apply labeled point-shift grading to true piece-boundary points and capture it as a Freeform Parametrics anchor. With driverValue, captures a baseline anchor first, captures the graded target, then restores the baseline so the driver can activate the grade. After solving constraints, verifies that targeted points actually kept the requested deltas and fails with mismatch details if constraints redistributed the shifts. Inspect pieces first; do not target hand-drawn notch branches, pleat markers, or helper construction geometry unless explicitly requested. allowSlidingPoints only permits direct sliding-point targets and does not resolve other constraint conflicts.',
      inputs: ['pieceId', 'shifts[]{pointId?|pointRef?,dx,dy,unit?}', 'unit?', 'driverVariableId?', 'driverValue?', 'anchorName?', 'captureAnchor?', 'allowConstructionPoints?', 'allowSlidingPoints?'],
      example: {
        type: 'grading.applyPointShifts',
        pieceId: 'piece-front',
        driverVariableId: 'var_size_step',
        driverValue: 1,
        anchorName: '3XL',
        shifts: [
          { pointRef: 'left side seam', dx: -0.5, dy: 0.5, unit: 'in' },
          { pointRef: 'right side seam', dx: 0.5, dy: 0.5, unit: 'in' }
        ],
        captureAnchor: true
      },
      replayable: true
    });
    expect(COMMANDS.get('grading.clearProfile')).toMatchObject({
      type: 'grading.clearProfile',
      category: 'grading',
      summary: 'Clear Freeform Parametrics grading state after restoring a baseline anchor. Requires an unambiguous baseline unless keepCurrentGeometry is explicitly true.',
      inputs: ['restoreAnchorId?', 'restoreDriverValue?', 'keepCurrentGeometry?'],
      example: { type: 'grading.clearProfile', restoreDriverValue: 0 },
      replayable: true
    });
    expect(COMMANDS.get('handle.update')).toMatchObject({
      type: 'handle.update',
      category: 'handle',
      summary: 'Update handle mirror constraints.',
      inputs: ['handleId', 'sameLength?', 'sameAngle?'],
      example: { type: 'handle.update', handleId: 'handle-a', sameLength: false, sameAngle: false },
      replayable: true
    });
    expect(COMMANDS.get('transaction.commit')).toMatchObject({
      type: 'transaction.commit',
      category: 'transaction',
      summary: 'Internal compatibility command emitted when committing a live mutation transaction.',
      inputs: ['label'],
      example: { type: 'transaction.commit', label: 'modify drag' },
      replayable: false,
      mutating: false
    });
  });

  it('carries the captured replayability split (73 true, 6 false)', () => {
    const production = PRODUCTION_COMMAND_TYPES.map((type) => COMMANDS.get(type)!);
    expect(production.filter((command) => command.replayable === true)).toHaveLength(73);
    expect(production.filter((command) => command.replayable === false).map((command) => command.type)).toEqual([
      'selection.delete',
      'selection.rotate',
      'selection.scale',
      'selection.mirror',
      'selection.moveToLayer',
      'transaction.commit'
    ]);
  });

  it('updates labels and handle mirror constraints and accepts transaction.commit as a no-op', () => {
    const pattern = base();
    pattern.paths = [{
      id: 'curve',
      name: 'Curve',
      pathType: 'curve',
      pathPoints: [
        {
          id: 'p1',
          handle: {
            id: 'handle-a',
            v1: { x: -1, y: 0 },
            v2: { x: 1, y: 0 },
            sameLength: true,
            sameAngle: true,
            lengthFormula: { formula: '', unit: 'mm' },
            angleFormula: { formula: '', unit: 'degrees' }
          }
        },
        { id: 'p2' }
      ],
      version: 0
    }];
    const editor = editorHost(pattern);
    expect(editor.execute('element.updateLabel', { elementId: 'p1', label: 'left side seam' }).changed).toBe(true);
    expect(editor.content.points[0].label).toBe('left side seam');
    expect(editor.execute('handle.update', { handleId: 'handle-a', sameLength: false }).changed).toBe(true);
    expect(editor.content.paths[0].pathPoints[0].handle?.sameLength).toBe(false);
    const before = editor.content;
    expect(editor.execute('transaction.commit', { label: 'modify drag' })).toEqual({ ok: true, changed: false });
    expect(editor.content).toBe(before);
  });

  it('applies boundary point shifts and clears grading state while keeping geometry', () => {
    const pattern = base();
    pattern.paths = [{
      id: 'edge',
      name: 'Edge',
      pathType: 'line',
      pathPoints: [{ id: 'p1' }, { id: 'p2' }],
      version: 0
    }];
    pattern.pieces = [{
      id: 'piece-front',
      name: 'Front',
      mainPaths: [{
        id: 'piece-edge',
        name: 'Edge',
        path: 'edge',
        from: 'p1',
        to: 'p2',
        reversed: false,
        notches: []
      }],
      internalPaths: []
    } as unknown as Pattern['pieces'][number]];
    pattern.variables = [{
      id: 'var_size_step',
      name: 'size step',
      type: 'number',
      value: 0,
      valueFormula: { formula: '0', unit: 'none' },
      isEditable: true,
      isVisible: true,
      options: [],
      unitType: 'none'
    }];
    const editor = editorHost(pattern);
    const shifted = editor.execute('grading.applyPointShifts', {
      pieceId: 'piece-front',
      driverVariableId: 'var_size_step',
      shifts: [{ pointId: 'p1', dx: 1, dy: 2, unit: 'cm' }],
      anchorName: 'Large'
    });
    expect(shifted.changed).toBe(true);
    expect(editor.content.points[0]).toMatchObject({ x: 10, y: 20 });
    expect(editor.content.gradingProfile?.anchors?.[0]).toMatchObject({
      name: 'Large',
      geometry: { points: { p1: { x: 10, y: 20 } }, handles: {} }
    });
    expect(editor.execute('grading.clearProfile', { keepCurrentGeometry: true }).changed).toBe(true);
    expect(editor.content.gradingProfile).toBeNull();
    expect(editor.content.points[0]).toMatchObject({ x: 10, y: 20 });
  });
});
