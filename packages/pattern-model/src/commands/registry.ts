// The command registry — the unified operation surface. Each entry is schema-described (like the
// original studio's registry) and backed by a pure reducer. Components, the command palette,
// keyboard shortcuts and external automation all dispatch through these.

import type { Pattern } from '../pattern';
import { CommandRegistry } from '@atelier/core';
import type { CommandDef } from './types';
import {
  selectionMove, selectionRotate, selectionScale, selectionMirror, selectionMoveToLayer, selectionDelete
} from './selection';
import {
  elementBringToFront, elementSendToBack, elementMoveToLayer, elementRename, elementDelete
} from './element';
import {
  variableReorder, variableSetOptions, variableUpdate,
  layerRename, layerSetStyle, imageUpdate, textUpdate, type LayerStyle
} from './structural';
import { pieceAddPath } from './piece';
import {
  pointCreate, pathCreateLine, pathCreateCurve, pathCreateEllipse, pathCreateCenterArc,
  pathCreateThreePointArc, pathUpdate, pieceCreateDynamic, pieceUpdate, pieceRotate,
  piecePathUpdate, piecePointAdd, piecePointUpdate, piecePointDelete, formulaSet,
  seamCreate, seamReverse, notchAdd, notchUpdate, notchDelete,
  variableCreate, variableDelete, materialUpsert, materialDelete, layerCreate, layerDelete,
  textCreate, slidingPointUpdate, type SeamRefInput
} from './create';
import * as ops from '../utils/pathPointOps';
import { breakoutPiece, type BreakoutMode } from '../utils/breakout';

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strArr = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');
const seamRefArr = (v: unknown): SeamRefInput[] =>
  arr(v).filter((x): x is SeamRefInput => typeof x === 'string' || (!!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string'));

const defs: CommandDef[] = [
  // --- selection (batch transforms) -----------------------------------------
  {
    type: 'selection.move', category: 'selection', label: 'Move selection',
    summary: 'Move the current selection by a delta (mm).', inputs: ['dx', 'dy'],
    example: { dx: 10, dy: 0 },
    run: (p, a, c) => selectionMove(p, c.selection, num(a.dx), num(a.dy))
  },
  {
    type: 'selection.rotate', category: 'selection', label: 'Rotate selection',
    summary: 'Rotate the current selection by degrees about its centroid.', inputs: ['degrees'],
    example: { degrees: 90 },
    run: (p, a, c) => selectionRotate(p, c.selection, num(a.degrees))
  },
  {
    type: 'selection.scale', category: 'selection', label: 'Scale selection',
    summary: 'Scale the current selection by a factor about its centroid.', inputs: ['factor', 'factorY?'],
    example: { factor: 1.1 },
    run: (p, a, c) => selectionScale(p, c.selection, num(a.factor, 1), a.factorY === undefined ? num(a.factor, 1) : num(a.factorY, 1))
  },
  {
    type: 'selection.mirror', category: 'selection', label: 'Mirror selection',
    summary: 'Mirror the current selection on the x or y axis.', inputs: ['axis'],
    example: { axis: 'x' },
    run: (p, a, c) => selectionMirror(p, c.selection, str(a.axis, 'x') === 'y' ? 'y' : 'x')
  },
  {
    type: 'selection.moveToLayer', category: 'selection', label: 'Move selection to layer',
    summary: 'Move selected elements to a layer.', inputs: ['layerId'],
    run: (p, a, c) => selectionMoveToLayer(p, c.selection, str(a.layerId))
  },
  {
    type: 'selection.delete', category: 'selection', label: 'Delete selection',
    summary: 'Delete the selected elements.', inputs: [],
    run: (p, _a, c) => selectionDelete(p, c.selection)
  },

  // --- element (any-kind ops) -----------------------------------------------
  {
    type: 'element.bringToFront', category: 'element', label: 'Bring to front',
    summary: 'Move a path or piece to the front of its draw order.', inputs: ['id'],
    run: (p, a) => elementBringToFront(p, str(a.id))
  },
  {
    type: 'element.sendToBack', category: 'element', label: 'Send to back',
    summary: 'Move a path or piece to the back of its draw order.', inputs: ['id'],
    run: (p, a) => elementSendToBack(p, str(a.id))
  },
  {
    type: 'element.moveToLayer', category: 'element', label: 'Move to layer',
    summary: 'Move one element (point/path/piece/text) to a layer.', inputs: ['id', 'layerId'],
    run: (p, a) => elementMoveToLayer(p, str(a.id), str(a.layerId))
  },
  {
    type: 'element.rename', category: 'element', label: 'Rename element',
    summary: 'Rename a resolvable element.', inputs: ['id', 'name'],
    run: (p, a) => elementRename(p, str(a.id), str(a.name))
  },
  {
    type: 'element.delete', category: 'element', label: 'Delete element',
    summary: 'Delete one resolvable element by id.', inputs: ['id'],
    run: (p, a) => elementDelete(p, str(a.id))
  },

  // --- piece building --------------------------------------------------------
  {
    type: 'piecePath.add', category: 'piecePath', label: 'Add path to piece',
    summary: 'Add an existing draft path to a piece as a boundary or internal edge.',
    inputs: ['pieceId', 'pathId', 'kind?'],
    example: { pieceId: 'Piece_x', pathId: 'Path_y', kind: 'main' },
    run: (p, a, c) => pieceAddPath(p, str(a.pieceId), str(a.pathId), str(a.kind, 'main') === 'internal' ? 'internal' : 'main', c.uid)
  },

  // --- point -----------------------------------------------------------------
  {
    type: 'point.move', category: 'point', label: 'Move point',
    summary: 'Move one point to an absolute coordinate (mm).', inputs: ['pointId', 'x', 'y'],
    run: (p, a) => ({
      ...p,
      points: p.points.map((pt) => (pt.id === str(a.pointId) ? { ...pt, x: num(a.x, pt.x), y: num(a.y, pt.y) } : pt)),
      hasChanged: true
    })
  },
  {
    type: 'point.rename', category: 'point', label: 'Rename point',
    summary: 'Rename a construction point.', inputs: ['pointId', 'name'],
    run: (p, a) => ({
      ...p,
      points: p.points.map((pt) => (pt.id === str(a.pointId) ? { ...pt, name: str(a.name, pt.name) } : pt)),
      hasChanged: true
    })
  },

  // --- path ------------------------------------------------------------------
  {
    type: 'path.reverse', category: 'path', label: 'Reverse path',
    summary: 'Reverse a path direction.', inputs: ['pathId'],
    run: (p, a) => ({
      ...p,
      paths: p.paths.map((path) => {
        if (path.id !== str(a.pathId)) return path;
        const pathPoints = [...path.pathPoints].reverse().map((pp) =>
          pp.handle ? { ...pp, handle: { ...pp.handle, v1: pp.handle.v2, v2: pp.handle.v1 } } : pp
        );
        return { ...path, pathPoints, version: (path.version ?? 0) + 1 };
      }),
      hasChanged: true
    })
  },

  // --- variable --------------------------------------------------------------
  {
    type: 'variable.reorder', category: 'variable', label: 'Reorder variable',
    summary: 'Move a variable to a new index in the variable list.', inputs: ['variableId', 'toIndex'],
    run: (p, a) => variableReorder(p, str(a.variableId), num(a.toIndex))
  },
  {
    type: 'variable.setOptions', category: 'variable', label: 'Set variable options',
    summary: 'Set enum options for a variable.', inputs: ['variableId', 'options[]'],
    example: { variableId: 'var_x', options: ['Small', 'Medium', 'Large'] },
    run: (p, a) => variableSetOptions(p, str(a.variableId), Array.isArray(a.options) ? a.options : [])
  },
  {
    type: 'variable.setType', category: 'variable', label: 'Set variable type',
    summary: 'Set a variable type.', inputs: ['variableId', 'type'],
    run: (p, a) => variableUpdate(p, str(a.variableId), { type: str(a.type, 'number') })
  },
  {
    type: 'variable.setValue', category: 'variable', label: 'Set variable value',
    summary: 'Set a variable override value.', inputs: ['variableId', 'value'],
    run: (p, a) => variableUpdate(p, str(a.variableId), { overrideValue: (a.value ?? null) as string | number | null })
  },
  {
    type: 'variable.setVisible', category: 'variable', label: 'Toggle variable visibility',
    summary: 'Toggle whether a variable is visible in the UI.', inputs: ['variableId', 'visible'],
    run: (p, a) => variableUpdate(p, str(a.variableId), { isVisible: a.visible !== false })
  },
  {
    type: 'variable.setEditable', category: 'variable', label: 'Toggle variable editable',
    summary: 'Toggle whether a variable is editable.', inputs: ['variableId', 'editable'],
    run: (p, a) => variableUpdate(p, str(a.variableId), { isEditable: a.editable !== false })
  },
  {
    type: 'variable.setDescription', category: 'variable', label: 'Set variable description',
    summary: 'Set variable documentation text.', inputs: ['variableId', 'description'],
    run: (p, a) => variableUpdate(p, str(a.variableId), { description: str(a.description) })
  },

  // --- layer -----------------------------------------------------------------
  {
    type: 'layer.rename', category: 'layer', label: 'Rename layer',
    summary: 'Rename a layer.', inputs: ['layerId', 'name'],
    run: (p, a) => layerRename(p, str(a.layerId), str(a.name))
  },
  {
    type: 'layer.setStyle', category: 'layer', label: 'Set layer style',
    summary: 'Set or clear a layer style override.', inputs: ['layerId', 'style'],
    example: { layerId: 'default', style: { color: '#3b82f6', dashed: true } },
    run: (p, a) => layerSetStyle(p, str(a.layerId), (a.style ?? null) as LayerStyle | null)
  },
  {
    type: 'layer.setVisible', category: 'layer', label: 'Toggle layer visibility',
    summary: 'Show or hide a layer.', inputs: ['layerId', 'visible'],
    run: (p, a) => ({ ...p, layers: p.layers.map((l) => (l.id === str(a.layerId) ? { ...l, visible: a.visible !== false } : l)), hasChanged: true })
  },
  {
    type: 'layer.setLocked', category: 'layer', label: 'Toggle layer lock',
    summary: 'Lock or unlock a layer.', inputs: ['layerId', 'locked'],
    run: (p, a) => ({ ...p, layers: p.layers.map((l) => (l.id === str(a.layerId) ? { ...l, locked: a.locked === true } : l)), hasChanged: true })
  },
  {
    type: 'layer.setCurrent', category: 'layer', label: 'Set current layer',
    summary: 'Set the current layer for new geometry.', inputs: ['layerId'],
    run: (p, a) => ({ ...p, currentLayerId: str(a.layerId, p.currentLayerId), hasChanged: true })
  },

  // --- pattern settings ------------------------------------------------------
  {
    type: 'pattern.setName', category: 'pattern', label: 'Set pattern name',
    summary: 'Set the pattern name.', inputs: ['name'],
    run: (p, a) => ({ ...p, name: str(a.name, p.name), hasChanged: true })
  },
  {
    type: 'pattern.setDescription', category: 'pattern', label: 'Set pattern description',
    summary: 'Set the pattern description.', inputs: ['description'],
    run: (p, a) => ({ ...p, description: str(a.description), hasChanged: true })
  },
  {
    type: 'pattern.setSeamAllowance', category: 'pattern', label: 'Set seam allowance',
    summary: 'Set the default seam allowance (mm).', inputs: ['seamAllowance'],
    run: (p, a) => ({ ...p, seamAllowance: num(a.seamAllowance, p.seamAllowance), hasChanged: true })
  },
  {
    type: 'pattern.setDefaultNotchSize', category: 'pattern', label: 'Set default notch size',
    summary: 'Set the default notch size (mm).', inputs: ['size'],
    run: (p, a) => ({ ...p, defaultNotchSize: num(a.size, p.defaultNotchSize), hasChanged: true })
  },
  {
    type: 'pattern.setPointNaming', category: 'pattern', label: 'Set point naming',
    summary: 'Set point naming mode and prefix.', inputs: ['mode?', 'prefix?'],
    run: (p, a) => ({ ...p, pointLabeling: str(a.mode, p.pointLabeling), pointPrefix: str(a.prefix, p.pointPrefix), hasChanged: true })
  },
  {
    type: 'pattern.setUnit', category: 'pattern', label: 'Set units',
    summary: 'Set pattern length and/or angle units.', inputs: ['lengthUnit?', 'angleUnit?'],
    run: (p, a) => ({
      ...p,
      lengthUnit: (str(a.lengthUnit, p.lengthUnit) as Pattern['lengthUnit']),
      angleUnit: (str(a.angleUnit, p.angleUnit) as Pattern['angleUnit']),
      hasChanged: true
    })
  },
  {
    type: 'pattern.setPublic', category: 'pattern', label: 'Set pattern visibility',
    summary: 'Mark the pattern public or private (local metadata).', inputs: ['isPublic'],
    run: (p, a) => ({ ...p, isPublic: a.isPublic === true, hasChanged: true })
  },

  // --- image / text ----------------------------------------------------------
  {
    type: 'image.update', category: 'image', label: 'Update background image',
    summary: 'Update background image dimensions and locks.', inputs: ['imageId', 'width?', 'height?', 'rotation?', 'opacity?', 'locked?', 'lockAspect?', 'layerId?'],
    run: (p, a) => imageUpdate(p, str(a.imageId), a as Parameters<typeof imageUpdate>[2])
  },
  {
    type: 'text.update', category: 'text', label: 'Update text',
    summary: 'Update text annotation content, style and layer.', inputs: ['textId', 'value?', 'fontSize?', 'color?', 'align?', 'rotation?', 'layerId?'],
    run: (p, a) => textUpdate(p, str(a.textId), a as Parameters<typeof textUpdate>[2])
  },

  // --- creation ---------------------------------------------------------------
  {
    type: 'point.create', category: 'point', label: 'Create point',
    summary: 'Create a construction point at a coordinate (mm).', inputs: ['x', 'y', 'name?'],
    example: { x: 100, y: 50 },
    run: (p, a, c) => pointCreate(p, num(a.x, NaN), num(a.y, NaN), a.name ? str(a.name) : undefined, c.uid)
  },
  {
    type: 'path.createLine', category: 'path', label: 'Create line',
    summary: 'Create a line from point references or coordinates ({x,y} creates points).', inputs: ['from', 'to', 'name?'],
    example: { from: { x: 0, y: 0 }, to: { x: 200, y: 0 } },
    run: (p, a, c) => pathCreateLine(p, a.from, a.to, a.name ? str(a.name) : undefined, c.uid)
  },
  {
    type: 'path.createCurve', category: 'path', label: 'Create curve',
    summary: 'Create a curve path from point references or coordinates, with optional bezier handles.', inputs: ['points[]', 'handles[]?', 'closed?', 'name?'],
    example: { points: [{ x: 0, y: 0 }, { x: 100, y: 60 }], handles: [{ v2: { x: 30, y: 0 } }, { v1: { x: -30, y: 0 } }] },
    run: (p, a, c) => pathCreateCurve(p, arr(a.points), Array.isArray(a.handles) ? (a.handles as { v1?: { x: number; y: number }; v2?: { x: number; y: number } }[]) : undefined, a.closed === true, a.name ? str(a.name) : undefined, c.uid)
  },
  {
    type: 'path.createEllipse', category: 'path', label: 'Create circle/ellipse',
    summary: 'Create a circle or true ellipse from a center and radius point; radiusX/radiusY (mm) + rotation (deg) make it elliptical.', inputs: ['center', 'radiusPoint', 'radiusX?', 'radiusY?', 'rotation?', 'name?'],
    example: { center: { x: 0, y: 0 }, radiusPoint: { x: 50, y: 0 }, radiusY: 30 },
    run: (p, a, c) => pathCreateEllipse(p, a.center, a.radiusPoint, a.name ? str(a.name) : undefined, c.uid, {
      rx: typeof a.radiusX === 'number' ? a.radiusX : undefined,
      ry: typeof a.radiusY === 'number' ? a.radiusY : undefined,
      rotationDeg: typeof a.rotation === 'number' ? a.rotation : undefined
    })
  },
  {
    type: 'path.createCenterArc', category: 'path', label: 'Create center arc',
    summary: 'Create a CCW arc from a center, a start (radius) point and an end point.', inputs: ['center', 'start', 'end', 'name?'],
    example: { center: { x: 0, y: 0 }, start: { x: 50, y: 0 }, end: { x: 0, y: 50 } },
    run: (p, a, c) => pathCreateCenterArc(p, a.center, a.start, a.end, a.name ? str(a.name) : undefined, c.uid)
  },
  {
    type: 'path.createThreePointArc', category: 'path', label: 'Create three-point arc',
    summary: 'Create an arc through three points (refs or coordinates).', inputs: ['p1', 'p2', 'p3', 'name?'],
    example: { p1: { x: 0, y: 0 }, p2: { x: 40, y: 30 }, p3: { x: 80, y: 0 } },
    run: (p, a, c) => pathCreateThreePointArc(p, a.p1, a.p2, a.p3, a.name ? str(a.name) : undefined, c.uid)
  },
  {
    type: 'piece.createDynamic', category: 'piece', label: 'Create piece',
    summary: 'Create a dynamic pattern piece from existing draft paths (ordered boundary loop).', inputs: ['pathIds[]', 'internalPathIds[]?', 'name?'],
    example: { pathIds: ['Path_a', 'Path_b', 'Path_c'] },
    run: (p, a, c) => pieceCreateDynamic(p, strArr(a.pathIds), strArr(a.internalPathIds), a.name ? str(a.name) : undefined, c.uid)
  },
  {
    type: 'formula.set', category: 'pattern', label: 'Set property formula',
    summary: 'Attach or clear (empty formula) a formula on a property: piecePath.seamAllowance/cornerRadius/seamCornerLength/seamCornerMaxLength, piece.rotation/grain/condition (degrees; condition 0 hides), notch.distance.',
    inputs: ['target', 'targetId', 'field', 'formula', 'unit?'],
    example: { target: 'piecePath', targetId: 'PiecePath_x', field: 'seamAllowance', formula: 'hem * 2', unit: 'mm' },
    run: (p, a) => formulaSet(p, str(a.target), str(a.targetId), str(a.field), str(a.formula), a.unit ? str(a.unit) : undefined)
  },
  {
    type: 'piecePoint.add', category: 'piece', label: 'Add piece point',
    summary: 'Add a construction point to a dynamic piece (drafting mm, travels with the piece).', inputs: ['pieceId', 'x', 'y', 'name?'],
    example: { pieceId: 'Piece_x', x: 120, y: 80 },
    run: (p, a, c) => piecePointAdd(p, str(a.pieceId), num(a.x, NaN), num(a.y, NaN), a.name ? str(a.name) : undefined, c.uid)
  },
  {
    type: 'piecePoint.update', category: 'piece', label: 'Update piece point',
    summary: 'Rename or move a piece point.', inputs: ['piecePointId', 'name?', 'x?', 'y?'],
    example: { piecePointId: 'PiecePoint_x', x: 100 },
    run: (p, a) => piecePointUpdate(p, str(a.piecePointId), {
      name: typeof a.name === 'string' ? a.name : undefined,
      x: typeof a.x === 'number' ? a.x : undefined,
      y: typeof a.y === 'number' ? a.y : undefined
    })
  },
  {
    type: 'piecePoint.delete', category: 'piece', label: 'Delete piece point',
    summary: 'Remove a point from a dynamic piece.', inputs: ['piecePointId'],
    example: { piecePointId: 'PiecePoint_x' },
    run: (p, a) => piecePointDelete(p, str(a.piecePointId))
  },
  {
    type: 'seam.create', category: 'seam', label: 'Create seam',
    summary: 'Create a seam between piece paths. Entries are PiecePath ids or {id, mirrored?, reversed?} refs.', inputs: ['fromPiecePathIds[]', 'toPiecePathIds[]', 'name?'],
    example: { fromPiecePathIds: ['PiecePath_a'], toPiecePathIds: [{ id: 'PiecePath_b', reversed: true }] },
    run: (p, a, c) => seamCreate(p, seamRefArr(a.fromPiecePathIds), seamRefArr(a.toPiecePathIds), a.name ? str(a.name) : undefined, c.uid)
  },
  {
    type: 'seam.reverse', category: 'seam', label: 'Reverse seam side',
    summary: 'Toggle the reversed flag on one seam side entry, or the whole side when index is omitted.', inputs: ['seamId', 'side', 'index?'],
    example: { seamId: 'Seam_x', side: 'to' },
    run: (p, a) => seamReverse(p, str(a.seamId), str(a.side, 'from') === 'to' ? 'to' : 'from', typeof a.index === 'number' && Number.isFinite(a.index) ? a.index : undefined)
  },
  {
    type: 'notch.add', category: 'notch', label: 'Add notch',
    summary: 'Add a notch at an arc-length position (0..1), or anchored by distance (mm) from the edge\'s from/to point.', inputs: ['piecePathId', 'position?', 'type?', 'size?', 'referencePointId?', 'distance?'],
    example: { piecePathId: 'PiecePath_x', position: 0.5, type: 'single' },
    run: (p, a, c) => notchAdd(p, str(a.piecePathId), num(a.position, NaN), a.type ? str(a.type) : undefined, typeof a.size === 'number' ? a.size : undefined, c.uid,
      a.referencePointId ? { referencePointId: str(a.referencePointId), distance: num(a.distance, 0) } : undefined)
  },
  {
    type: 'notch.update', category: 'notch', label: 'Update notch',
    summary: 'Update notch position/type/size, or its reference-point anchor (referencePointId: null releases it).', inputs: ['notchId', 'position?', 'type?', 'size?', 'referencePointId?', 'distance?'],
    run: (p, a) => notchUpdate(p, str(a.notchId), a as { position?: number; type?: string; size?: number; referencePointId?: string | null; distance?: number })
  },
  {
    type: 'notch.delete', category: 'notch', label: 'Delete notch',
    summary: 'Delete a notch.', inputs: ['notchId'],
    run: (p, a) => notchDelete(p, str(a.notchId))
  },
  {
    type: 'variable.create', category: 'variable', label: 'Create variable',
    summary: 'Create a pattern variable with a unique name.', inputs: ['name', 'value?', 'formula?', 'varType?'],
    example: { name: 'waist_ease', value: 20 },
    run: (p, a, c) => variableCreate(p, str(a.name), typeof a.value === 'number' ? a.value : undefined, a.formula ? str(a.formula) : undefined, a.varType ? str(a.varType) : undefined, c.uid)
  },
  {
    type: 'variable.delete', category: 'variable', label: 'Delete variable',
    summary: 'Delete a pattern variable by id or name.', inputs: ['variableId'],
    run: (p, a) => variableDelete(p, str(a.variableId))
  },
  {
    type: 'material.upsert', category: 'material', label: 'Create or update material',
    summary: 'Create or update a material and optionally assign it to a piece.', inputs: ['materialId?', 'name?', 'color?', 'pieceId?', '…physics/PBR fields?'],
    example: { name: 'Denim', color: '#3b5377', pieceId: 'Piece_x' },
    run: (p, a, c) => materialUpsert(p, a.materialId ? str(a.materialId) : undefined, a.name ? str(a.name) : undefined, a, a.pieceId ? str(a.pieceId) : undefined, c.uid)
  },
  {
    type: 'material.delete', category: 'material', label: 'Delete material',
    summary: 'Delete a material and reassign pieces using it.', inputs: ['materialId'],
    run: (p, a) => materialDelete(p, str(a.materialId))
  },
  {
    type: 'layer.create', category: 'layer', label: 'Create layer',
    summary: 'Create a layer and optionally make it current.', inputs: ['name', 'makeCurrent?'],
    example: { name: 'Construction', makeCurrent: true },
    run: (p, a, c) => layerCreate(p, str(a.name), a.makeCurrent === true, c.uid)
  },
  {
    type: 'layer.delete', category: 'layer', label: 'Delete layer',
    summary: 'Delete a layer and move its elements to the default layer.', inputs: ['layerId'],
    run: (p, a) => layerDelete(p, str(a.layerId))
  },
  {
    type: 'text.create', category: 'text', label: 'Create text',
    summary: 'Create a pattern text annotation at a coordinate (mm).', inputs: ['value', 'x', 'y', 'fontSize?', 'color?', 'align?', 'rotation?'],
    example: { value: 'Cut 2', x: 100, y: 60 },
    run: (p, a, c) => textCreate(p, str(a.value), num(a.x, NaN), num(a.y, NaN), a, c.uid)
  },

  // --- updates ----------------------------------------------------------------
  {
    type: 'path.update', category: 'path', label: 'Update path',
    summary: 'Update simple path settings (name, layer).', inputs: ['pathId', 'name?', 'layerId?'],
    run: (p, a) => pathUpdate(p, str(a.pathId), a)
  },
  {
    type: 'piece.update', category: 'piece', label: 'Update piece',
    summary: 'Update piece metadata and simple settings (name, cut counts, mirrors, allowance, material…).',
    inputs: ['pieceId', 'name?', 'rightPieces?', 'leftPieces?', 'mirrorX?', 'mirrorY?', 'seamAllowance?', 'seamAllowanceInside?', 'rotation?', 'materialId?', 'hidden?', 'firstEdgeSymmetry?', 'useMaterialScaling?', 'mirrorLeftPiecesAxis?', 'layerId?'],
    run: (p, a) => pieceUpdate(p, str(a.pieceId), a)
  },
  {
    type: 'piece.rotate', category: 'piece', label: 'Rotate piece',
    summary: 'Rotate a piece by a number of degrees.', inputs: ['pieceId', 'degrees'],
    example: { pieceId: 'Piece_x', degrees: 90 },
    run: (p, a) => pieceRotate(p, str(a.pieceId), num(a.degrees, NaN))
  },
  {
    type: 'piecePath.update', category: 'piecePath', label: 'Update piece path',
    summary: 'Update main/internal piece-path settings (fold angle, allowance, corner finishing, covers…).',
    inputs: ['piecePathId', 'name?', 'foldAngle?', 'seamAllowance?', 'isMirrorLine?', 'reversed?', 'coverSeamAllowanceStart?', 'coverSeamAllowanceEnd?', 'seamCornerJoinType?', 'cornerRadius?', 'seamCornerMaxLength?', 'seamCornerLength?'],
    run: (p, a) => piecePathUpdate(p, str(a.piecePathId), a)
  },
  {
    type: 'slidingPoint.update', category: 'point', label: 'Update sliding point',
    summary: 'Update a sliding point\'s position formula and reference.', inputs: ['pathId', 'pointId', 'positionFormula?', 'unit?', 'positionFrom?'],
    run: (p, a) => slidingPointUpdate(p, str(a.pathId), str(a.pointId), a as { positionFormula?: string; unit?: string; positionFrom?: string })
  },

  // --- topology (wrappers around the canvas context-menu operations) ----------
  {
    type: 'path.splitCurveAtPoint', category: 'path', label: 'Split curve',
    summary: 'Split a curve at an interior path point.', inputs: ['pointId'],
    run: (p, a) => ops.splitCurveAtPoint(p, str(a.pointId)) ?? p
  },
  {
    type: 'path.splitLineAtPoint', category: 'path', label: 'Split line',
    summary: 'Split a line at an interior path point or sliding point.', inputs: ['pointId'],
    run: (p, a) => ops.splitLineAtPoint(p, str(a.pointId)) ?? p
  },
  {
    type: 'path.mergeCurvesAtPoint', category: 'path', label: 'Merge curves',
    summary: 'Merge two curve paths connected at a point.', inputs: ['pointId'],
    run: (p, a) => ops.mergeCurvesAtPoint(p, str(a.pointId)) ?? p
  },
  {
    type: 'path.mergeLinesAtPoint', category: 'path', label: 'Merge lines',
    summary: 'Merge two line paths connected at a point.', inputs: ['pointId'],
    run: (p, a) => ops.mergeLinesAtPoint(p, str(a.pointId)) ?? p
  },
  {
    type: 'path.convertToCurve', category: 'path', label: 'Convert to curve',
    summary: 'Convert a line path to a curve path.', inputs: ['pathId'],
    run: (p, a) => ({
      ...p,
      paths: p.paths.map((path) => (path.id === str(a.pathId) && path.pathType === 'line' ? { ...path, pathType: 'curve', version: (path.version ?? 0) + 1 } : path)),
      hasChanged: true
    })
  },
  {
    type: 'path.convertToLine', category: 'path', label: 'Convert to line',
    summary: 'Convert a curve path to a line path (drops bezier handles).', inputs: ['pathId'],
    run: (p, a) => ({
      ...p,
      paths: p.paths.map((path) => (path.id === str(a.pathId) && path.pathType === 'curve' ? { ...path, pathType: 'line', pathPoints: path.pathPoints.map((pp) => ({ id: pp.id })), version: (path.version ?? 0) + 1 } : path)),
      hasChanged: true
    })
  },
  {
    type: 'point.convertToCurvePoint', category: 'point', label: 'Convert to curve point',
    summary: 'Convert a sliding point into a curve anchor where valid.', inputs: ['pointId'],
    run: (p, a) => ops.convertToCurvePoint(p, str(a.pointId)) ?? p
  },
  {
    type: 'point.convertToSlidingPoint', category: 'point', label: 'Convert to sliding point',
    summary: 'Convert an interior curve anchor into a sliding point where valid.', inputs: ['pointId'],
    run: (p, a) => ops.convertToSlidingPoint(p, str(a.pointId)) ?? p
  },
  {
    type: 'point.releaseSlidingPoint', category: 'point', label: 'Release sliding point',
    summary: 'Release a sliding point from one or all parent paths.', inputs: ['pointId', 'pathId?'],
    run: (p, a) => ops.releaseSlidingPoint(p, str(a.pointId), a.pathId ? str(a.pathId) : undefined) ?? p
  },
  {
    type: 'point.disconnectPaths', category: 'point', label: 'Disconnect paths',
    summary: 'Disconnect joined paths at a point (duplicates the anchor).', inputs: ['pointId', 'pathId?'],
    run: (p, a) => ops.disconnectPaths(p, str(a.pointId), a.pathId ? str(a.pathId) : undefined) ?? p
  },
  {
    type: 'piece.breakout', category: 'piece', label: 'Breakout piece',
    summary: 'Break generated piece geometry into editable pattern geometry.', inputs: ['pieceId', 'mode?'],
    example: { pieceId: 'Piece_x', mode: 'all' },
    run: (p, a) => {
      const mode = ['all', 'seams', 'cut', 'internal', 'seamsInternal'].includes(str(a.mode)) ? (str(a.mode) as BreakoutMode) : 'all';
      return breakoutPiece(p, str(a.pieceId), mode) ?? p;
    }
  }
];

export const COMMANDS: ReadonlyMap<string, CommandDef> = new Map(defs.map((d) => [d.type, d]));

/** All command definitions, sorted by category then type — for the palette / docs. */
export const COMMAND_LIST: readonly CommandDef[] = [...defs].sort(
  (a, b) => a.category.localeCompare(b.category) || a.type.localeCompare(b.type)
);

/** Construct an isolated registry for each editor instance. */
export function createPatternRegistry(): CommandRegistry<Pattern> {
  const registry = new CommandRegistry<Pattern>();
  for (const def of COMMAND_LIST) registry.register(def);
  return registry;
}

/** The category → commands index, for grouped display. */
export function commandsByCategory(): Map<string, CommandDef[]> {
  const m = new Map<string, CommandDef[]>();
  for (const d of COMMAND_LIST) {
    const arr = m.get(d.category) ?? [];
    arr.push(d);
    m.set(d.category, arr);
  }
  return m;
}
