<script lang="ts">
  import {
    formulaSet,
    imageUpdate,
    isLinkedPath,
    linkPath,
    linkSourceCandidates,
    syncLinkedPaths,
    unlinkPath,
    variableReorder,
    variableSetOptions,
    type Pattern,
    type ConstrainablePoint,
    type ConstrainablePath,
    type Piece,
    type PieceArrangement,
    type PiecePath,
    type GradeSize,
    type PointConstraint,
    type SeamCornerJoinType,
    type Notch,
    type NotchType
  } from '@seamer/pattern-model';
  import type { Editor } from '@atelier/core';
  import { editorState } from '@atelier/svelte';
  import { panelRequest, pathPickRequest } from '$lib/stores/pattern';
  import FormulaDialog from '$lib/components/FormulaDialog.svelte';
  import { toastSuccess, toastError } from '$lib/stores/toast';
  import {
    materialLibrary, libraryStatus, getLibraryItem, saveNewLibraryItem, overwriteLibraryItem,
    instantiateFromLibrary, syncFromLibrary, type LibraryStatus
  } from '$lib/stores/materialLibrary';
  import { MATERIAL_PRESETS, getPreset } from '$lib/data/materialPresets';
  import { rebakeArc, arcCenter } from '@seamer/pattern-model/utils/arcParametric';
  import TextureMapSource from '$lib/components/TextureMapSource.svelte';

  interface Props {
    currentPattern: Pattern;
    editor: Editor<Pattern>;
    onchange: (p: Pattern, label?: string) => void;
    onclose?: () => void;
    labelDisplay?: 'off' | 'billboard' | 'flat';
    onlabeldisplaychange?: (v: 'off' | 'billboard' | 'flat') => void;
    ongrading?: () => void;
    onalterations?: () => void;
  }

  let { currentPattern, editor, onchange, onclose, labelDisplay = 'flat', onlabeldisplaychange, ongrading, onalterations }: Props = $props();

  // svelte-ignore state_referenced_locally -- parent keys this component by Editor identity
  const editorView = editorState(editor);
  const pointIds = $derived(editorView.selection.get('point'));
  const pathIds = $derived(editorView.selection.get('path'));
  const pieceIds = $derived(editorView.selection.get('piece'));
  const editingPoint = $derived<ConstrainablePoint | null>(
    pointIds.size === 1 ? currentPattern.points.find((p) => p.id === [...pointIds][0]) ?? null : null
  );
  const editingPiece = $derived<Piece | null>(
    pieceIds.size === 1 ? currentPattern.pieces.find((p) => p.id === [...pieceIds][0]) ?? null : null
  );

  // A single selected boundary edge (its ConstrainablePath + two endpoints). Clicking a line in the
  // 2D view selects it; this lets you retype the edge's length/angle (moves the `to` point in
  // drafting space so the edge takes the requested length/angle relative to `from`).
  const editingEdge = $derived.by<{ path: ConstrainablePath; from: ConstrainablePoint; to: ConstrainablePoint } | null>(() => {
    if (pathIds.size !== 1) return null;
    const pathId = [...pathIds][0];
    const path = currentPattern.paths.find((p) => p.id === pathId);
    if (!path) return null;
    const byId = (id: string) => currentPattern.points.find((q) => q.id === id) ?? null;
    for (const piece of currentPattern.pieces) {
      if (pieceIds.size > 0 && !pieceIds.has(piece.id)) continue;
      const pp = [...piece.mainPaths, ...piece.internalPaths].find((x) => x.path === pathId);
      if (pp) { const from = byId(pp.from), to = byId(pp.to); if (from && to) return { path, from, to }; }
    }
    const pts = path.pathPoints;
    if (pts.length >= 2) { const from = byId(pts[0].id), to = byId(pts[pts.length - 1].id); if (from && to) return { path, from, to }; }
    return null;
  });
  const edgeLenMm = $derived(editingEdge ? Math.hypot(editingEdge.to.x - editingEdge.from.x, editingEdge.to.y - editingEdge.from.y) : 0);
  const edgeAngleDeg = $derived(editingEdge ? (Math.atan2(editingEdge.to.y - editingEdge.from.y, editingEdge.to.x - editingEdge.from.x) * 180) / Math.PI : 0);
  const edgeUnit = $derived(currentPattern.lengthUnit);
  const edgeToDisp = (mm: number) => (edgeUnit === 'inch' ? mm / 25.4 : edgeUnit === 'cm' ? mm / 10 : mm);
  const edgeToMm = (v: number) => (edgeUnit === 'inch' ? v * 25.4 : edgeUnit === 'cm' ? v * 10 : v);
  // Which endpoint stays fixed while editing. 'from' (default) moves `to`; 'to' moves `from`.
  // The displayed length/angle always describe the from→to vector, so the angle field reads the
  // same regardless of pivot — flipping the pivot just chooses which end the edit rotates around.
  let edgePivot = $state<'from' | 'to'>('from');
  function edgeMove(lenMm: number, angDeg: number) {
    if (!editingEdge || !(lenMm > 0)) return;
    const rad = (angDeg * Math.PI) / 180;
    const dx = Math.cos(rad) * lenMm, dy = Math.sin(rad) * lenMm;
    let moveId: string, nx: number, ny: number;
    if (edgePivot === 'from') {
      moveId = editingEdge.to.id; nx = editingEdge.from.x + dx; ny = editingEdge.from.y + dy;
    } else {
      moveId = editingEdge.from.id; nx = editingEdge.to.x - dx; ny = editingEdge.to.y - dy;
    }
    const points = currentPattern.points.map((p) => (p.id === moveId ? { ...p, x: nx, y: ny } : p));
    onchange({ ...currentPattern, points, hasChanged: true });
  }

  // ---- Parametric arc (selected path carrying ArcParams from the arc/circle tools) ----------------
  const editingArc = $derived.by<ConstrainablePath | null>(() => {
    if (pathIds.size !== 1) return null;
    const path = currentPattern.paths.find((p) => p.id === [...pathIds][0]);
    return path?.arc ? path : null;
  });
  const rad2deg = (r: number) => (r * 180) / Math.PI;
  const deg2rad = (d: number) => (d * Math.PI) / 180;
  function patchArc(patch: Partial<NonNullable<ConstrainablePath['arc']>>) {
    if (!editingArc?.arc) return;
    const params = { ...editingArc.arc, ...patch };
    const next = rebakeArc($state.snapshot(currentPattern) as Pattern, editingArc.id, params, uid);
    if (next) onchange(next, 'Edit arc');
  }
  /** Flip the sweep direction (CW ↔ CCW) keeping the same start angle. */
  function flipArcDirection() {
    if (!editingArc?.arc) return;
    const a = editingArc.arc;
    const sweep = a.a1 - a.a0;
    patchArc({ a1: a.a0 - sweep });
  }

  // ---- Linked path (EditLink): the selected path's shape follows a source path -------------------
  const edgeIsLinked = $derived(editingEdge ? isLinkedPath(editingEdge.path) : false);
  const linkCandidates = $derived(editingEdge ? linkSourceCandidates(currentPattern, editingEdge.path.id) : []);
  function applyLink(sourceId: string) {
    if (!editingEdge || !sourceId) return;
    const next = linkPath($state.snapshot(currentPattern) as Pattern, editingEdge.path.id, sourceId, false);
    if (next) { onchange(next, 'Link path'); toastSuccess('Path linked — it now follows the source shape'); }
    else toastError('Linked path reference would be circular');
  }
  function setLinkFlip(flipped: boolean) {
    if (!editingEdge) return;
    const p = $state.snapshot(currentPattern) as Pattern;
    const paths = p.paths.map((q) => (q.id === editingEdge!.path.id ? { ...q, mirrorX: flipped, version: (q.version ?? 0) + 1 } : q));
    onchange(syncLinkedPaths({ ...p, paths, hasChanged: true }), 'Flip linked path');
  }
  function removeLink() {
    if (!editingEdge) return;
    onchange(unlinkPath($state.snapshot(currentPattern) as Pattern, editingEdge.path.id), 'Unlink path');
  }

  // ---- Curve-handle mirror constraints (per selected edge) — ports the original handle.update -----
  // The bezier handles on the selected edge's points; their sameLength/sameAngle govern how dragging
  // one handle mirrors the other (enforced live in PatternCanvas2D via applyHandleConstraint).
  const edgeHandlePoints = $derived(editingEdge ? editingEdge.path.pathPoints.filter((pp) => pp.handle) : []);
  const allSameLength = $derived(edgeHandlePoints.length > 0 && edgeHandlePoints.every((pp) => pp.handle?.sameLength));
  const allSameAngle = $derived(edgeHandlePoints.length > 0 && edgeHandlePoints.every((pp) => pp.handle?.sameAngle));
  function setEdgeHandleMirror(patch: { sameLength?: boolean; sameAngle?: boolean }) {
    if (!editingEdge) return;
    const id = editingEdge.path.id;
    const paths = currentPattern.paths.map((pa) => pa.id !== id ? pa : {
      ...pa,
      pathPoints: pa.pathPoints.map((pp) => (pp.handle ? { ...pp, handle: { ...pp.handle, ...patch } } : pp))
    });
    onchange({ ...currentPattern, paths, hasChanged: true });
  }

  // which accordion section is open (Seam boundary open by default, like the source)
  let openSection = $state<string>('seam');
  function toggle(id: string) { openSection = openSection === id ? '' : id; }

  const pointName = (id: string) => currentPattern.points.find((p) => p.id === id)?.name ?? id.slice(0, 6);
  const pathName = (id: string) => currentPattern.paths.find((p) => p.id === id)?.name || 'path';

  function updatePoint(field: 'name' | 'x' | 'y', value: string | number) {
    if (!editingPoint) return;
    const points = currentPattern.points.map((p) =>
      p.id === editingPoint.id ? { ...p, [field]: typeof value === 'string' ? value : Number(value) } : p);
    onchange({ ...currentPattern, points, hasChanged: true });
  }
  function setConstraint(c: PointConstraint | undefined) {
    if (!editingPoint) return;
    const points = currentPattern.points.map((p) => (p.id === editingPoint.id ? { ...p, constraint: c } : p));
    onchange({ ...currentPattern, points, hasChanged: true });
  }
  function changeConstraintType(type: string) {
    const others = currentPattern.points.filter((p) => p.id !== editingPoint?.id);
    const from = others[0]?.id ?? '';
    const path = currentPattern.paths[0]?.id ?? '';
    if (type === 'fixed') setConstraint(undefined);
    else if (type === 'offset') setConstraint({ type: 'offset', from, dxFormula: '0', dyFormula: '0' });
    else if (type === 'lengthAngle') setConstraint({ type: 'lengthAngle', from, lengthFormula: '0', angleFormula: '0' });
    else if (type === 'sliding') setConstraint({ type: 'sliding', path, positionFormula: '0' });
  }

  function updatePiece(fn: (p: Piece) => Piece, label = 'Edit piece') {
    if (!editingPiece) return;
    const pieces = currentPattern.pieces.map((p) => (p.id === editingPiece.id ? fn(p) : p));
    onchange({ ...currentPattern, pieces, hasChanged: true }, label);
  }

  // ---- Seam corner join (per boundary edge) — faithful to the original ro.js editor -----------
  let cornerEditId = $state<string | null>(null);
  const CORNER_TYPES: { id: SeamCornerJoinType; icon: string; title: string }[] = [
    { id: 'intersection', icon: 'call_merge', title: 'Intersection (mitred corner, optionally capped)' },
    { id: 'radius', icon: 'rounded_corner', title: 'Radius (rounded corner)' },
    { id: 'byLength', icon: 'straighten', title: 'By length (square corner at a fixed distance)' },
    { id: 'noJoin', icon: 'close_fullscreen', title: 'No join (allowance pinches back to the corner)' },
    { id: 'firstEdgeSymmetry', icon: 'align_horizontal_left', title: 'First edge symmetry (fold-back cut mirrored over the second edge)' },
    { id: 'secondEdgeSymmetry', icon: 'align_horizontal_right', title: 'Second edge symmetry (fold-back cut mirrored over the first edge)' },
    { id: 'firstEdgeRightAngle', icon: 'square', title: 'First edge right angle (square cut to the first edge)' },
    { id: 'secondEdgeRightAngle', icon: 'crop_square', title: 'Second edge right angle (square cut to the second edge)' }
  ];
  const DEFAULT_WIRE = {
    mode: 'stitched' as const,
    channelWidth: 8,
    diameter: 1.5,
    stiffness: 85,
    linearMass: 4.8,
    closed: false
  };
  /** The allowance this edge would cut at with no wire in it. */
  function baseAllowanceMm(): number {
    return editingPiece?.seamAllowance ?? currentPattern.seamAllowance ?? 0;
  }
  /**
   * A wire needs the cloth folded back around it, so its channel is extra CUT width — the finished
   * edge does not move. That is exactly the per-edge allowance override, so keep the two in step the
   * way the generators write them (`base + channelWidth`). We only touch the override while it is
   * still tracking the wire; once someone sets their own number we leave it alone, and on removal we
   * only put the base back if the override was ours.
   */
  function wireAllowancePatch(pp: PiecePath, nextChannel: number | null): Partial<PiecePath> {
    if (pp.seamAllowanceFormula) return {}; // a formula owns this edge; never overwrite it
    const base = baseAllowanceMm();
    const tracking = pp.wire
      ? pp.seamAllowance === undefined || Math.abs(pp.seamAllowance - (base + pp.wire.channelWidth)) < 1e-6
      : pp.seamAllowance === undefined;
    if (!tracking) return {};
    if (nextChannel === null) return { seamAllowance: undefined };
    return { seamAllowance: base + nextChannel };
  }
  function setWire(pp: PiecePath, partial: Partial<NonNullable<PiecePath['wire']>>) {
    const wire = { ...DEFAULT_WIRE, ...pp.wire, ...partial };
    updateMainPath(pp.id, { wire, ...wireAllowancePatch(pp, wire.channelWidth) }, 'Edit wire');
  }
  function toggleWire(pp: PiecePath, on: boolean) {
    updateMainPath(
      pp.id,
      on
        ? { wire: { ...DEFAULT_WIRE }, ...wireAllowancePatch(pp, DEFAULT_WIRE.channelWidth) }
        : { wire: undefined, ...wireAllowancePatch(pp, null) },
      on ? 'Add wire' : 'Remove wire'
    );
  }

  function updateMainPath(ppId: string, partial: Partial<PiecePath>, label = 'Edit corner join') {
    updatePiece((p) => ({ ...p, mainPaths: p.mainPaths.map((x) => (x.id === ppId ? { ...x, ...partial } : x)) }), label);
  }
  // value (mm, displayed in the pattern unit) of the field that the active join type uses
  function cornerValueMm(pp: PiecePath): number {
    if (pp.seamCornerJoinType === 'radius') return pp.cornerRadius ?? 0;
    if (pp.seamCornerJoinType === 'byLength') return pp.seamCornerLength ?? 0;
    return pp.seamCornerMaxLength ?? 0; // intersection cap (0 = uncapped)
  }
  function setCornerValueMm(pp: PiecePath, mm: number) {
    if (pp.seamCornerJoinType === 'radius') updateMainPath(pp.id, { cornerRadius: mm });
    else if (pp.seamCornerJoinType === 'byLength') updateMainPath(pp.id, { seamCornerLength: mm });
    else updateMainPath(pp.id, { seamCornerMaxLength: mm });
  }

  // ---- Notch editor (per boundary edge) -------------------------------------------------------
  const NOTCH_TYPES: { id: NotchType; label: string }[] = [
    { id: 'single', label: 'Single' }, { id: 'double', label: 'Double' }, { id: 'tee', label: 'Tee' }, { id: 'slit', label: 'Slit' }
  ];
  function addNotch(pp: PiecePath) {
    const notch: Notch = { id: uid('Notch'), position: 0.5, size: currentPattern.defaultNotchSize, type: currentPattern.defaultNotchType ?? 'single' };
    updateMainPath(pp.id, { notches: [...(pp.notches ?? []), notch] }, 'Add notch');
  }
  function updateNotch(pp: PiecePath, notchId: string, partial: Partial<Notch>) {
    updateMainPath(pp.id, { notches: (pp.notches ?? []).map((n) => (n.id === notchId ? { ...n, ...partial } : n)) }, 'Edit notch');
  }
  function removeNotch(pp: PiecePath, notchId: string) {
    updateMainPath(pp.id, { notches: (pp.notches ?? []).filter((n) => n.id !== notchId) }, 'Remove notch');
  }
  function updateArrangement(field: keyof PieceArrangement, value: string | number) {
    updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, arrangement: { ...p.settings3d.arrangement, [field]: value } } }));
  }
  function selectPath(pp: PiecePath) {
    editor.setSelection(editor.selection.replace('path', [pp.path]));
  }
  function removeMainPath(pp: PiecePath) {
    updatePiece((p) => ({ ...p, mainPaths: p.mainPaths.filter((x) => x.id !== pp.id) }), 'Remove edge');
  }
  function removeInternalPath(pp: PiecePath) {
    updatePiece((p) => ({ ...p, internalPaths: p.internalPaths.filter((x) => x.id !== pp.id) }), 'Remove internal path');
  }
  function updateInternalPath(ppId: string, partial: Partial<PiecePath>, label = 'Edit internal path') {
    updatePiece((p) => ({ ...p, internalPaths: p.internalPaths.map((x) => (x.id === ppId ? { ...x, ...partial } : x)) }), label);
  }
  // Mark a boundary edge as the piece's mirror/fold line: the cloth is reflected across it for a
  // symmetric whole (drafted as a half). One mirror line per piece, so enabling clears the others.
  function toggleMirrorLine(pp: PiecePath) {
    const enabling = !pp.isMirrorLine;
    updatePiece((p) => ({ ...p, mainPaths: p.mainPaths.map((x) =>
      x.id === pp.id ? { ...x, isMirrorLine: enabling } : (enabling ? { ...x, isMirrorLine: false } : x)) }));
  }

  const sections = [
    { id: 'general', icon: 'edit', title: 'General' },
    { id: 'scaling', icon: 'open_in_full', title: 'Scaling' },
    { id: 'orientation', icon: 'explore', title: 'Orientation' },
    { id: 'seam', icon: 'select', title: 'Seam boundary' },
    { id: 'internal', icon: 'conversion_path', title: 'Internal paths' },
    { id: 'piecePoints', icon: 'adjust', title: 'Piece points' },
    { id: 'material', icon: 'texture', title: 'Material' },
    { id: '3d', icon: 'view_in_ar', title: '3D Settings' }
  ];

  // ---- property formulas (the original's *Formula fields) ------------------
  // Compact inline editor: the ƒ button toggles a formula input that overrides the numeric field.
  let formulaEditKey = $state<string | null>(null);
  function setPathFormula(ppId: string, field: 'seamAllowance' | 'cornerRadius' | 'seamCornerLength' | 'seamCornerMaxLength', formula: string) {
    onchange(formulaSet($state.snapshot(currentPattern) as Pattern, 'piecePath', ppId, field, formula, 'mm'), 'Edit formula');
  }
  function setPieceFormula(pieceId: string, field: 'rotation' | 'grain' | 'condition', formula: string) {
    onchange(formulaSet($state.snapshot(currentPattern) as Pattern, 'piece', pieceId, field, formula, 'degrees'), 'Edit formula');
  }
  function setNotchFormula(notchId: string, formula: string) {
    onchange(formulaSet($state.snapshot(currentPattern) as Pattern, 'notch', notchId, 'distance', formula, 'mm'), 'Edit formula');
  }

  // ---- piece points (piece-local construction points) ----------------------
  function updatePiecePointLocal(id: string, patch: { name?: string; x?: number; y?: number }) {
    updatePiece((p) => ({ ...p, piecePoints: (p.piecePoints ?? []).map((pt) => (pt.id === id ? { ...pt, ...patch } : pt)) }), 'Edit piece point');
  }
  function removePiecePoint(id: string) {
    updatePiece((p) => ({ ...p, piecePoints: (p.piecePoints ?? []).filter((pt) => pt.id !== id) }), 'Delete piece point');
  }

  // ---- pattern-level (no selection) -----------------------------------------
  let patternOpen = $state<string>('materials');
  function togglePattern(id: string) { patternOpen = patternOpen === id ? '' : id; }
  // One-shot section-open requests (e.g. Shift+V → Sizes & Variables) from the studio page.
  $effect(() => panelRequest.subscribe((r) => {
    if (r) { patternOpen = r.section; panelRequest.set(null); }
  }));

  function updatePattern(partial: Partial<Pattern>) {
    onchange({ ...currentPattern, ...partial, hasChanged: true });
  }

  // ---- Edge symmetry: mirror the selected edge across a chosen axis path ----
  let mirrorAxisId = $state('');
  // candidate axes: any other path with at least two points
  const axisCandidates = $derived(
    !editingEdge ? [] : currentPattern.paths.filter((p) => p.id !== editingEdge.path.id && p.pathPoints.length >= 2)
  );
  function reflectPt(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    const projx = ax + t * dx, projy = ay + t * dy;
    return { x: 2 * projx - px, y: 2 * projy - py };
  }
  function createMirror() {
    if (!editingEdge) return;
    const src = editingEdge.path;
    const axis = currentPattern.paths.find((p) => p.id === mirrorAxisId);
    if (!axis || axis.pathPoints.length < 2) { toastError('Pick an axis path with at least two points'); return; }
    const ptById = new Map(currentPattern.points.map((p) => [p.id, p]));
    const a = ptById.get(axis.pathPoints[0].id);
    const b = ptById.get(axis.pathPoints[axis.pathPoints.length - 1].id);
    if (!a || !b) { toastError('Axis endpoints not found'); return; }
    const newPoints: ConstrainablePoint[] = [];
    const newPathPoints: ConstrainablePath['pathPoints'] = [];
    for (const pp of src.pathPoints) {
      const sp = ptById.get(pp.id);
      if (!sp) continue;
      const r = reflectPt(sp.x, sp.y, a.x, a.y, b.x, b.y);
      const id = uid('Point');
      // explicit mirror constraint → solvePoints resolves it as reflect(source, axis ends) parametrically
      newPoints.push({ id, name: `${sp.name}'`, x: r.x, y: r.y, layerId: sp.layerId, constraint: { type: 'mirror', source: sp.id, axisPath: axis.id } });
      // reflect bezier handles too (a reflection reverses orientation → swap in/out tangents)
      let handle = pp.handle;
      if (pp.handle) {
        const h = pp.handle;
        const m1 = reflectPt(sp.x + h.v2.x, sp.y + h.v2.y, a.x, a.y, b.x, b.y);
        const m2 = reflectPt(sp.x + h.v1.x, sp.y + h.v1.y, a.x, a.y, b.x, b.y);
        handle = { ...h, v1: { x: m1.x - r.x, y: m1.y - r.y }, v2: { x: m2.x - r.x, y: m2.y - r.y } };
      }
      newPathPoints.push({ id, handle });
    }
    if (newPathPoints.length < 2) { toastError('Edge has too few points to mirror'); return; }
    const newPath: ConstrainablePath = {
      id: uid('Path'), name: `${src.name || 'Edge'} (mirror)`, layerId: src.layerId,
      pathType: 'referenced', pathPoints: newPathPoints, version: 1,
      referencedPath: src.id, mirrorLine: axis.id,
      referencedFromPoint: src.pathPoints[0]?.id, referencedToPoint: src.pathPoints[src.pathPoints.length - 1]?.id
    };
    onchange({ ...currentPattern, points: [...currentPattern.points, ...newPoints], paths: [...currentPattern.paths, newPath], hasChanged: true });
    toastSuccess(`Mirrored "${src.name || 'edge'}" across "${axis.name || 'axis'}"`);
  }
  function updateBody(partial: Partial<Pattern['body']>) {
    updatePattern({ body: { ...currentPattern.body, ...partial } });
  }
  function updateBodyField(name: string, value: number) {
    updateBody({ fields: { ...currentPattern.body.fields, [name]: value } });
  }
  function updateSettings3D(partial: Partial<Pattern['settings3d']>) {
    updatePattern({ settings3d: { ...currentPattern.settings3d, ...partial } });
  }

  const uid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
  function createMaterial() {
    const mat = {
      id: uid('mat'), name: `Material${currentPattern.materials.length + 1}`,
      frontTexture: { url: '', mediaId: null, color: '#b9b9b9', scale: 100, normalUrl: '', normalMediaId: null, normalMapScale: 100, opacityUrl: '', opacityMediaId: null, opacityMapScale: 100 },
      backTexture: null, useSeparateBackSide: false,
      stretchWarpValue: 30, stretchWeftValue: 30, bendValue: 30, thickness: 0.5, weight: 200,
      roughness: 0.8, metalness: 0, specularIntensity: 0.5, opacity: 1, normalScale: 1, alphaCutoff: 0.5,
      libraryItemId: null, libraryVersion: null, libraryUpdatedAt: null
    } as Pattern['materials'][number];
    updatePattern({ materials: [...currentPattern.materials, mat] });
  }
  function deleteMaterial(id: string) {
    updatePattern({ materials: currentPattern.materials.filter((m) => m.id !== id) });
    if (editingMaterialId === id) editingMaterialId = null;
  }

  let editingMaterialId = $state<string | null>(null);
  let linkWarpWeft = $state(true);
  type Mat = Pattern['materials'][number];
  function updateMaterial(id: string, fn: (m: Mat) => Mat) {
    updatePattern({ materials: currentPattern.materials.map((m) => (m.id === id ? fn(m) : m)) });
  }
  function setFrontTexture(id: string, partial: Partial<NonNullable<Mat['frontTexture']>>) {
    updateMaterial(id, (m) => ({ ...m, frontTexture: { ...(m.frontTexture ?? { url: '', mediaId: null, color: '#bbbbbb', scale: 100, normalUrl: '', normalMediaId: null, normalMapScale: 100, opacityUrl: '', opacityMediaId: null, opacityMapScale: 100 }), ...partial } }));
  }
  function applyPreset(id: string, name: string) {
    const preset = getPreset(name);
    if (!preset) { updateMaterial(id, (m) => ({ ...m, currentPreset: null })); return; }
    updateMaterial(id, (m) => ({
      ...m,
      stretchWarpValue: preset.stretchWarpValue, stretchWeftValue: preset.stretchWeftValue,
      bendValue: preset.bendValue, thickness: preset.thickness, weight: preset.weight,
      roughness: preset.roughness, metalness: preset.metalness, specularIntensity: preset.specularIntensity,
      currentPreset: preset.name
    }));
    toastSuccess(`Applied "${preset.name}" preset`);
  }
  function setStretch(id: string, which: 'warp' | 'weft', value: number) {
    updateMaterial(id, (m) => ({
      ...m,
      stretchWarpValue: which === 'warp' || linkWarpWeft ? value : m.stretchWarpValue,
      stretchWeftValue: which === 'weft' || linkWarpWeft ? value : m.stretchWeftValue
    }));
  }
  const DEFAULT_SLOT = () => ({ url: '', mediaId: null, color: '#bbbbbb', scale: 100, normalUrl: '', normalMediaId: null, normalMapScale: 100, opacityUrl: '', opacityMediaId: null, opacityMapScale: 100 });
  function setBackTexture(id: string, partial: Partial<NonNullable<Mat['backTexture']>>) {
    updateMaterial(id, (m) => ({ ...m, backTexture: { ...(m.backTexture ?? DEFAULT_SLOT()), ...partial } }));
  }
  // ---- Material library (offline-first stand-in for the cloud library) -----------------------
  const STATUS_META: Record<LibraryStatus, { label: string; cls: string; dot: string }> = {
    local: { label: 'Local material', cls: 'opacity-60', dot: 'bg-base-300' },
    synced: { label: 'Synced with library', cls: 'text-success', dot: 'bg-success' },
    outdated: { label: 'Library has a newer version', cls: 'text-warning', dot: 'bg-warning' },
    missing: { label: 'Linked item missing', cls: 'text-error', dot: 'bg-error' }
  };
  // Recompute status when either the material or the library store changes.
  function statusOf(m: Mat): LibraryStatus {
    void $materialLibrary; // reactive dependency
    return libraryStatus(m);
  }
  function isWriteProtected(m: Mat): boolean {
    const item = getLibraryItem(m.libraryItemId);
    return !!item?.writeProtected;
  }
  function saveToLibrary(m: Mat) {
    const link = saveNewLibraryItem(m, new Date().toISOString());
    updateMaterial(m.id, (x) => ({ ...x, ...link }));
    toastSuccess(`Saved "${m.name}" to library`);
  }
  function updateLibrary(m: Mat) {
    const link = overwriteLibraryItem(m, new Date().toISOString());
    if (!link) { toastError('Cannot overwrite — library item is write-protected or missing'); return; }
    updateMaterial(m.id, (x) => ({ ...x, ...link }));
    toastSuccess(`Updated library material "${m.name}"`);
  }
  function syncMaterial(m: Mat) {
    const next = syncFromLibrary(m);
    if (!next) { toastError('Library item not found'); return; }
    updateMaterial(m.id, () => next);
    toastSuccess(`Pulled latest "${next.name}" from library`);
  }
  function unlinkMaterial(m: Mat) {
    updateMaterial(m.id, (x) => ({ ...x, libraryItemId: null, libraryVersion: null, libraryUpdatedAt: null }));
    toastSuccess('Unlinked from library');
  }
  let showLibraryPicker = $state(false);
  function addFromLibrary(itemId: string) {
    const item = getLibraryItem(itemId);
    if (!item) return;
    const mat = instantiateFromLibrary(item, uid('mat'));
    updatePattern({ materials: [...currentPattern.materials, mat] });
    showLibraryPicker = false;
    editingMaterialId = mat.id;
    toastSuccess(`Added "${item.name}" from library`);
  }

  function materialSwatch(m: Pattern['materials'][number]): string {
    const t = m.frontTexture;
    const color = t?.color || '#cccccc';
    return t?.url ? `background-color:${color};background-image:url('${t.url}');background-size:cover;background-position:center` : `background-color:${color}`;
  }

  // length-unit conversion for the Settings defaults (stored in mm)
  const lenUnit = $derived(currentPattern.lengthUnit);
  const toUnit = (mm: number) => (lenUnit === 'inch' ? mm / 25.4 : lenUnit === 'cm' ? mm / 10 : mm);
  const fromUnit = (v: number) => (lenUnit === 'inch' ? v * 25.4 : lenUnit === 'cm' ? v * 10 : v);
  const unitLabel = $derived(lenUnit === 'inch' ? 'in' : lenUnit);

  let selectedVariableId = $state<string | null>(null);
  let formulaVarId = $state<string | null>(null);
  // scope offered to the formula editor: other variables + body measurements
  const formulaScope = $derived([
    ...currentPattern.variables.filter((v) => v.id !== formulaVarId).map((v) => ({ name: v.name, value: v.value ?? 0 })),
    ...Object.entries(currentPattern.body.fields).map(([name, value]) => ({ name, value }))
  ]);
  // Categorised geometric-reference tokens for the formula picker (point coords/angles, path
  // lengths/angles, curve handles, body measurements) — resolved by the solver against geometry.
  const formulaCategories = $derived.by(() => {
    const p = currentPattern;
    const pointName = new Map(p.points.map((pt) => [pt.id, pt.name || pt.id]));
    const cats: { name: string; items: { label: string; token: string; title?: string }[] }[] = [];
    cats.push({ name: 'Custom variables', items: p.variables.filter((v) => v.id !== formulaVarId && /^[A-Za-z_$][\w$]*$/.test(v.name)).map((v) => ({ label: v.name, token: v.name, title: `${v.name} = ${v.value ?? 0}` })) });
    const body = Object.keys(p.body.fields);
    if (body.length) cats.push({ name: 'Body', items: body.map((f) => ({ label: f, token: `body.${f}`, title: 'measurement' })) });
    cats.push({ name: 'Path lengths', items: p.paths.map((pa) => ({ label: `${pa.name || pa.id}.length`, token: `${pa.id}.length` })) });
    cats.push({ name: 'Path angles', items: p.paths.map((pa) => ({ label: `${pa.name || pa.id}.angle`, token: `${pa.id}.angle` })) });
    cats.push({ name: 'Point coordinates', items: p.points.flatMap((pt) => [
      { label: `${pt.name || pt.id}.x`, token: `${pt.id}.x` },
      { label: `${pt.name || pt.id}.y`, token: `${pt.id}.y` }
    ]) });
    const ptAngles: { label: string; token: string }[] = [];
    const handles: { label: string; token: string }[] = [];
    for (const pa of p.paths) for (const pp of pa.pathPoints) {
      const nm = pointName.get(pp.id) ?? pp.id;
      ptAngles.push({ label: `${pa.name || pa.id}·${nm}.angle`, token: `${pa.id}.${pp.id}.angle` });
      if (pp.handle) for (const [suf, lbl] of [['handle.length', 'h.len'], ['handle.angle', 'h.ang'], ['handle.length2', 'h.len2'], ['handle.angle2', 'h.ang2']] as const)
        handles.push({ label: `${nm}.${lbl}`, token: `${pa.id}.${pp.id}.${suf}` });
    }
    cats.push({ name: 'Point angles', items: ptAngles });
    if (handles.length) cats.push({ name: 'Curve handles', items: handles });
    return cats.filter((c) => c.items.length);
  });
  const selectedVariable = $derived(currentPattern.variables.find((v) => v.id === selectedVariableId) ?? null);
  const VAR_TYPE_ICON: Record<string, string> = { number: 'tag', boolean: 'check', enum: 'list', string: 'text_fields', length: 'straighten', angle: 'rotate_right' };

  // ---- graded sizes ---------------------------------------------------------
  const SIZE_COLORS = ['#c91d1d', '#1d4ed8', '#15803d', '#a21caf', '#ea580c', '#0891b2'];
  const sizes = $derived(currentPattern.gradingProfile?.sizes ?? []);
  // Merge into the existing profile so alteration tracks / anchors aren't dropped.
  function setSizes(next: Partial<Pattern['gradingProfile'] & object>) {
    updatePattern({ gradingProfile: { ...(currentPattern.gradingProfile ?? { sizes: [] }), ...next } });
  }
  function addSize() {
    const list = sizes;
    const size = { id: uid('size'), name: `Size ${list.length + 1}`, scale: 1 + list.length * 0.05, color: SIZE_COLORS[list.length % SIZE_COLORS.length] };
    setSizes({ sizes: [...list, size] });
  }
  function updateSize(id: string, partial: Partial<GradeSize>) {
    setSizes({ sizes: sizes.map((s) => (s.id === id ? { ...s, ...partial } : s)) });
  }
  function removeSize(id: string) { setSizes({ sizes: sizes.filter((s) => s.id !== id) }); }

  function addVariable() {
    const v = { id: uid('var'), name: 'unnamed', description: '', type: 'number', value: 0, valueFormula: { formula: '0', unit: 'none' }, isEditable: true, isVisible: true, options: [], unitType: 'length' };
    updatePattern({ variables: [...currentPattern.variables, v] as Pattern['variables'] });
    selectedVariableId = v.id;
  }
  function updateVariable(id: string, partial: Partial<Pattern['variables'][number]>) {
    updatePattern({ variables: currentPattern.variables.map((v) => (v.id === id ? { ...v, ...partial } : v)) });
  }
  function deleteVariable(id: string) {
    updatePattern({ variables: currentPattern.variables.filter((v) => v.id !== id) });
  }

  const patternSections = [
    { id: 'general', icon: 'edit', title: 'General' },
    { id: 'settings', icon: 'settings', title: 'Settings' },
    { id: '3d', icon: 'view_in_ar', title: '3D Settings' },
    { id: 'sizes', icon: 'tag', title: 'Sizes & Variables' },
    { id: 'body', icon: 'accessibility', title: 'Body' },
    { id: 'materials', icon: 'texture', title: 'Materials' },
    { id: 'texts', icon: 'text_fields', title: 'Text' },
    { id: 'images', icon: 'image', title: 'Images' }
  ];

  type Txt = Pattern['texts'][number];
  function updateText(id: string, partial: Partial<Txt>) {
    updatePattern({ texts: currentPattern.texts.map((t) => (t.id === id ? { ...t, ...partial } : t)) });
  }
  function removeText(id: string) {
    updatePattern({ texts: currentPattern.texts.filter((t) => t.id !== id) });
  }
  type Img = Pattern['images'][number];
  function updateImage(id: string, partial: Partial<Img>) {
    updatePattern({ images: currentPattern.images.map((im) => (im.id === id ? { ...im, ...partial } : im)) });
  }
  function removeImage(id: string) {
    updatePattern({ images: currentPattern.images.filter((im) => im.id !== id) });
  }
</script>

{#snippet matSlider(label: string, value: number, min: number, max: number, step: number, oninput: (v: number) => void)}
  <label class="flex flex-col gap-0.5">
    <span class="flex justify-between"><span>{label}</span><span class="tabular-nums opacity-60">{value}</span></span>
    <input type="range" class="range range-xs" {min} {max} {step} value={value} oninput={(e) => oninput(parseFloat(e.currentTarget.value))} />
  </label>
{/snippet}

{#snippet textureMaps(m: Pattern['materials'][number], back: boolean)}
  {@const slot = back ? m.backTexture : m.frontTexture}
  {@const set = back ? (p: Partial<NonNullable<Mat['frontTexture']>>) => setBackTexture(m.id, p) : (p: Partial<NonNullable<Mat['frontTexture']>>) => setFrontTexture(m.id, p)}
  {@const activeSlot = slot ?? DEFAULT_SLOT()}
  <label class="flex items-center gap-2">Color
    <input type="color" class="w-8 h-6 rounded border" value={activeSlot.color} oninput={(e) => set({ color: e.currentTarget.value })} /></label>
  <TextureMapSource textureSlot={activeSlot} kind="base" label="Texture" onchange={set} />
  <TextureMapSource textureSlot={activeSlot} kind="normal" label="Normal" onchange={set} />
  <TextureMapSource textureSlot={activeSlot} kind="opacity" label="Opacity" onchange={set} />
{/snippet}

{#snippet libraryBlock(m: Pattern['materials'][number])}
  {@const status = statusOf(m)}
  {@const meta = STATUS_META[status]}
  {@const wp = isWriteProtected(m)}
  <div class="space-y-1.5">
    <span class="text-[11px] flex items-center gap-1 {meta.cls}"><span class="w-2 h-2 rounded-full {meta.dot}"></span>{meta.label}{wp ? ' · write-protected' : ''}</span>
    <div class="flex flex-wrap gap-1">
      {#if status === 'local'}
        <button class="btn btn-xs btn-outline" onclick={() => saveToLibrary(m)}><span class="material-symbols-rounded text-base">cloud_upload</span> Save to library</button>
      {:else}
        <button class="btn btn-xs btn-outline" disabled={wp} title={wp ? 'Library material is write-protected' : 'Overwrite the library version with these edits'} onclick={() => updateLibrary(m)}><span class="material-symbols-rounded text-base">save</span> Update library</button>
        {#if status === 'outdated'}<button class="btn btn-xs btn-warning btn-outline" onclick={() => syncMaterial(m)}><span class="material-symbols-rounded text-base">download</span> Pull latest</button>{/if}
        <button class="btn btn-xs btn-ghost" onclick={() => unlinkMaterial(m)} title="Detach from the library item"><span class="material-symbols-rounded text-base">link_off</span> Unlink</button>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet materialEditor(m: Pattern['materials'][number])}
  <div class="border-t border-base-300 p-3 space-y-3 text-sm bg-base-100">
    <label class="flex flex-col gap-0.5">Name
      <input type="text" class="input input-bordered input-xs" value={m.name} oninput={(e) => updateMaterial(m.id, (x) => ({ ...x, name: e.currentTarget.value }))} /></label>

    <hr class="border-base-200" />
    {@render libraryBlock(m)}

    <hr class="border-base-200" />
    <div class="space-y-1">
      <span class="font-semibold">Front side</span>
      {@render textureMaps(m, false)}
    </div>

    <hr class="border-base-200" />
    <div class="space-y-2">
      <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={m.useSeparateBackSide} onchange={(e) => updateMaterial(m.id, (x) => ({ ...x, useSeparateBackSide: e.currentTarget.checked, backTexture: x.backTexture ?? DEFAULT_SLOT() }))} /> <span class="font-semibold">Separate back side</span></label>
      {#if m.useSeparateBackSide}
        <div class="pl-1 space-y-1 border-l-2 border-base-200">
          {@render textureMaps(m, true)}
        </div>
      {/if}
    </div>

    <hr class="border-base-200" />
    <div class="space-y-2">
      <span class="font-semibold">Simulation</span>
      <label class="flex flex-col gap-0.5">Preset
        <select class="select select-bordered select-xs" value={m.currentPreset ?? ''} onchange={(e) => applyPreset(m.id, e.currentTarget.value)}>
          <option value="">Custom</option>
          {#each MATERIAL_PRESETS as pr}<option value={pr.name}>{pr.name}</option>{/each}
        </select></label>
      <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={linkWarpWeft} onchange={(e) => (linkWarpWeft = e.currentTarget.checked)} /> Link warp and weft</label>
      {@render matSlider('Stretch warp', m.stretchWarpValue, 0, 100, 1, (v) => setStretch(m.id, 'warp', v))}
      {#if !linkWarpWeft}{@render matSlider('Stretch weft', m.stretchWeftValue, 0, 100, 1, (v) => setStretch(m.id, 'weft', v))}{/if}
      {@render matSlider('Bend', m.bendValue, 0, 100, 1, (v) => updateMaterial(m.id, (x) => ({ ...x, bendValue: v })))}
      <label class="flex flex-col gap-0.5">Simulation thickness (mm)
        <input type="number" step="0.1" class="input input-bordered input-xs" value={m.thickness} oninput={(e) => updateMaterial(m.id, (x) => ({ ...x, thickness: parseFloat(e.currentTarget.value) || 0 }))} /></label>
      <label class="flex flex-col gap-0.5">Weight (g/m²)
        <input type="number" step="1" class="input input-bordered input-xs" value={m.weight} oninput={(e) => updateMaterial(m.id, (x) => ({ ...x, weight: parseFloat(e.currentTarget.value) || 0 }))} /></label>
    </div>

    <hr class="border-base-200" />
    <div class="space-y-2">
      <span class="font-semibold">Appearance</span>
      {@render matSlider('Roughness', m.roughness, 0, 1, 0.01, (v) => updateMaterial(m.id, (x) => ({ ...x, roughness: v })))}
      {@render matSlider('Metalness', m.metalness, 0, 1, 0.01, (v) => updateMaterial(m.id, (x) => ({ ...x, metalness: v })))}
      {@render matSlider('Specular', m.specularIntensity, 0, 1, 0.01, (v) => updateMaterial(m.id, (x) => ({ ...x, specularIntensity: v })))}
      {@render matSlider('Opacity', m.opacity, 0, 1, 0.01, (v) => updateMaterial(m.id, (x) => ({ ...x, opacity: v })))}
      {@render matSlider('Normal strength', m.normalScale, 0, 3, 0.05, (v) => updateMaterial(m.id, (x) => ({ ...x, normalScale: v })))}
      {@render matSlider('Alpha cutoff', m.alphaCutoff, 0, 1, 0.01, (v) => updateMaterial(m.id, (x) => ({ ...x, alphaCutoff: v })))}
    </div>
  </div>
{/snippet}

{#snippet labelSetting()}
  <label class="flex flex-col gap-0.5">3D piece labels
    <select class="select select-bordered select-xs" value={labelDisplay}
      onchange={(e) => onlabeldisplaychange?.(e.currentTarget.value as 'off' | 'billboard' | 'flat')}>
      <option value="off">Off</option>
      <option value="billboard">Facing camera (billboard)</option>
      <option value="flat">Flat on fabric</option>
    </select></label>
{/snippet}

<div class="w-[340px] border-l bg-base-100 flex flex-col shrink-0 overflow-y-auto" data-tour-id="tour-properties">
  <div class="w-full bg-base-300 p-2 px-4 font-bold text-sm flex items-center sticky z-10 top-0 border-b-2 border-accent">
    <span data-testid="property-panel-heading">Properties{editingEdge ? ' for Edge' : editingPiece ? ' for Piece' : editingPoint ? ' for Point' : ' for Pattern'}</span>
    {#if onclose}
      <button class="ml-auto pt-1" type="button" title="Close properties" aria-label="Close properties" onclick={onclose}>
        <span class="material-symbols-rounded">close</span>
      </button>
    {/if}
  </div>

  {#if editingArc?.arc}
    {@const a = editingArc.arc}
    <div class="bg-base-100 border-b-2 border-info p-3 space-y-2 text-sm">
      <h4 class="font-semibold text-info flex items-center gap-1">
        <span class="material-symbols-rounded text-base">radio_button_unchecked</span>
        {a.kind === 'circle' ? 'Circle' : 'Arc'} (parametric)
      </h4>
      <p class="text-xs opacity-60">
        {a.centerId ? 'Centred on a live point — move it to move the arc.' : 'Free arc (three-point).'}
        Dragging an arc anchor detaches it.
      </p>
      {#if a.kind === 'circle'}
        <!-- circles/ellipses: independent X/Y radii + axis rotation (true ellipse) -->
        <div class="grid grid-cols-2 gap-1 text-xs">
          <label class="flex flex-col gap-0.5">Radius X ({edgeUnit})
            <input type="number" min="0.1" step="0.5" class="input input-bordered input-xs"
              value={Number(edgeToDisp(a.rx ?? a.r).toFixed(2))}
              onchange={(e) => { const v = edgeToMm(parseFloat(e.currentTarget.value)); if (v > 0) patchArc({ rx: v, r: v }); }} /></label>
          <label class="flex flex-col gap-0.5">Radius Y ({edgeUnit})
            <input type="number" min="0.1" step="0.5" class="input input-bordered input-xs"
              value={Number(edgeToDisp(a.ry ?? a.r).toFixed(2))}
              onchange={(e) => { const v = edgeToMm(parseFloat(e.currentTarget.value)); if (v > 0) patchArc({ ry: v }); }} /></label>
        </div>
        <label class="flex items-center justify-between gap-2 text-xs">Rotation (°)
          <input type="number" step="1" class="input input-bordered input-xs w-24"
            value={Number(rad2deg(a.rotation ?? 0).toFixed(1))}
            onchange={(e) => { const d = parseFloat(e.currentTarget.value); if (Number.isFinite(d)) patchArc({ rotation: deg2rad(d) }); }} />
        </label>
      {:else}
        <label class="flex items-center justify-between gap-2 text-xs">Radius ({edgeUnit})
          <input type="number" min="0.1" step="0.5" class="input input-bordered input-xs w-24"
            value={Number(edgeToDisp(a.r).toFixed(2))}
            onchange={(e) => { const v = edgeToMm(parseFloat(e.currentTarget.value)); if (v > 0) patchArc({ r: v }); }} />
        </label>
      {/if}
      {#if a.kind !== 'circle'}
        <div class="grid grid-cols-2 gap-1 text-xs">
          <label class="flex flex-col gap-0.5">Start (°)
            <input type="number" step="1" class="input input-bordered input-xs"
              value={Number(rad2deg(a.a0).toFixed(1))}
              onchange={(e) => { const d = parseFloat(e.currentTarget.value); if (Number.isFinite(d)) patchArc({ a0: deg2rad(d) }); }} /></label>
          <label class="flex flex-col gap-0.5">End (°)
            <input type="number" step="1" class="input input-bordered input-xs"
              value={Number(rad2deg(a.a1).toFixed(1))}
              onchange={(e) => { const d = parseFloat(e.currentTarget.value); if (Number.isFinite(d)) patchArc({ a1: deg2rad(d) }); }} /></label>
        </div>
        <button class="btn btn-xs w-full" onclick={flipArcDirection} title="Sweep the other way around the centre (counter clockwise ↔ clockwise)">
          Counter clockwise: flip direction
        </button>
      {/if}
      {#if !a.centerId}
        <p class="text-[11px] opacity-50">Centre: {arcCenter(currentPattern, a).x.toFixed(1)}, {arcCenter(currentPattern, a).y.toFixed(1)} mm</p>
      {/if}
    </div>
  {/if}

  {#if editingEdge}
    {@const ed = editingEdge}
    <div class="bg-base-100 border-b-2 border-accent p-3 space-y-2 text-sm">
      <h4 class="font-semibold text-accent flex items-center gap-1">
        <span class="material-symbols-rounded text-base">straighten</span>
        Edge: {ed.path.name || ed.path.id.slice(0, 8)}
      </h4>
      <p class="text-xs opacity-60">{ed.from.name} → {ed.to.name}{ed.path.pathType === 'curve' ? ' · curve (edits the chord)' : ''}</p>
      <div class="flex flex-col gap-0.5">
        <span class="text-xs opacity-70">Pivot (this end stays fixed)</span>
        <div class="join" data-testid="edge-pivot">
          <button class="join-item btn btn-xs flex-1" class:btn-active={edgePivot === 'from'} onclick={() => (edgePivot = 'from')}>{ed.from.name}</button>
          <button class="join-item btn btn-xs flex-1" class:btn-active={edgePivot === 'to'} onclick={() => (edgePivot = 'to')}>{ed.to.name}</button>
        </div>
      </div>
      <label class="flex flex-col gap-0.5">Length ({edgeUnit})
        <input type="number" step="0.1" class="input input-bordered input-xs"
          value={edgeToDisp(edgeLenMm).toFixed(2)}
          onchange={(e) => edgeMove(edgeToMm(parseFloat(e.currentTarget.value) || 0), edgeAngleDeg)} /></label>
      <label class="flex flex-col gap-0.5">Angle (°)
        <input type="number" step="0.5" class="input input-bordered input-xs"
          data-testid="edge-angle-input"
          value={edgeAngleDeg.toFixed(2)}
          onchange={(e) => edgeMove(edgeLenMm, parseFloat(e.currentTarget.value) || 0)} /></label>
      <div class="flex gap-1">
        <button class="btn btn-xs flex-1" title="Rotate -1°" onclick={() => edgeMove(edgeLenMm, edgeAngleDeg - 1)}>−1°</button>
        <button class="btn btn-xs flex-1" title="Rotate -0.1°" onclick={() => edgeMove(edgeLenMm, edgeAngleDeg - 0.1)}>−0.1°</button>
        <button class="btn btn-xs flex-1" title="Rotate +0.1°" onclick={() => edgeMove(edgeLenMm, edgeAngleDeg + 0.1)}>+0.1°</button>
        <button class="btn btn-xs flex-1" title="Rotate +1°" data-testid="edge-rotate-plus-one" onclick={() => edgeMove(edgeLenMm, edgeAngleDeg + 1)}>+1°</button>
      </div>
      <p class="text-[11px] opacity-50">Edits move <b>{edgePivot === 'from' ? ed.to.name : ed.from.name}</b> around the pivot <b>{edgePivot === 'from' ? ed.from.name : ed.to.name}</b>. Shared points reshape the adjoining edge too.</p>

      <div class="border-t border-base-200 pt-2 space-y-1">
        <span class="text-xs font-semibold flex items-center gap-1"><span class="material-symbols-rounded text-sm">flip</span>Mirror across an axis</span>
        {#if axisCandidates.length === 0}
          <p class="text-[11px] opacity-50">Draw another line to use as the mirror axis, then select this edge again.</p>
        {:else}
          <div class="flex items-center gap-1">
            <select class="select select-bordered select-xs flex-1" value={mirrorAxisId} onchange={(e) => (mirrorAxisId = e.currentTarget.value)}>
              <option value="">Choose axis line…</option>
              {#each axisCandidates as ax}<option value={ax.id}>{ax.name || ax.id.slice(0, 8)}</option>{/each}
            </select>
            <button class="btn btn-xs px-1" title="Click the axis path on the canvas (the original's path picker)"
              onclick={() => pathPickRequest.set({ label: 'Click on a path to select the mirror axis', onPick: (id) => (mirrorAxisId = id) })}>
              <span class="material-symbols-rounded text-sm">colorize</span>
            </button>
          </div>
          <button class="btn btn-xs btn-primary btn-block" disabled={!mirrorAxisId} onclick={createMirror}>Create mirrored edge</button>
          <p class="text-[11px] opacity-50">Adds a referenced edge whose points stay reflected across the axis (a parametric symmetry constraint).</p>
        {/if}
      </div>

      {#if edgeHandlePoints.length > 0}
        <div class="border-t border-base-200 pt-2 space-y-1">
          <span class="text-xs font-semibold flex items-center gap-1"><span class="material-symbols-rounded text-sm">gesture</span>Curve handles</span>
          <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={allSameAngle} onchange={(e) => setEdgeHandleMirror({ sameAngle: e.currentTarget.checked })} /> Same angle (handles stay collinear)</label>
          <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={allSameLength} onchange={(e) => setEdgeHandleMirror({ sameLength: e.currentTarget.checked })} /> Same length (handles stay equal)</label>
          <p class="text-[11px] opacity-50">Drag the salmon handle dots in the 2D view; the opposite handle follows these mirror rules.</p>
        </div>
      {/if}

      <div class="border-t border-base-200 pt-2 space-y-1">
        <span class="text-xs font-semibold flex items-center gap-1"><span class="material-symbols-rounded text-sm">link</span>Linked path</span>
        {#if edgeIsLinked}
          {@const src = currentPattern.paths.find((q) => q.id === ed.path.referencedPath)}
          <p class="text-[11px] opacity-60">Follows <b>{src?.name || src?.id.slice(0, 8) || 'missing path'}</b> — its shape is mapped between this edge's endpoints.</p>
          <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={ed.path.mirrorX === true} onchange={(e) => setLinkFlip(e.currentTarget.checked)} /> Flip across the chord</label>
          <button class="btn btn-xs btn-block" onclick={removeLink}>Unlink (keep current shape)</button>
        {:else if ed.path.pathType === 'referenced'}
          <p class="text-[11px] opacity-50">This edge is a mirrored reference (see Mirror across an axis).</p>
        {:else if linkCandidates.length === 0}
          <p class="text-[11px] opacity-50">Draw another path to link this edge's shape to, then select this edge again.</p>
        {:else}
          <select class="select select-bordered select-xs w-full" onchange={(e) => { applyLink(e.currentTarget.value); e.currentTarget.value = ''; }}>
            <option value="">Link shape to…</option>
            {#each linkCandidates as cand}<option value={cand.id}>{cand.name || cand.id.slice(0, 8)}</option>{/each}
          </select>
          <p class="text-[11px] opacity-50">The edge keeps its endpoints but takes the source's shape — and follows when the source changes (matching seam edges, symmetric halves).</p>
        {/if}
      </div>
    </div>
  {/if}

  {#if editingPiece}
    {@const piece = editingPiece}
    {#each sections as s}
      {@const count = s.id === 'seam' ? piece.mainPaths.length : s.id === 'internal' ? piece.internalPaths.length : s.id === 'piecePoints' ? (piece.piecePoints?.length ?? 0) : null}
      <div class="w-full bg-base-200 block mt-[-1px]" class:bg-base-300={openSection === s.id}>
        <button type="button" class="w-full flex items-center p-2 px-3 text-sm" aria-expanded={openSection === s.id} onclick={() => toggle(s.id)}>
          <span class="material-symbols-rounded mr-2">{s.icon}</span>
          <span class="text-md font-bold">{s.title}{count !== null ? ` (${count})` : ''}</span>
          <span class="material-symbols-rounded ml-auto">{openSection === s.id ? 'keyboard_arrow_down' : 'keyboard_arrow_right'}</span>
        </button>

        {#if openSection === s.id}
          <div class="w-full bg-base-100 border-t border-base-300 p-3 pt-2 text-sm space-y-2">
            {#if s.id === 'general'}
              <label class="flex flex-col gap-0.5">Name
                <input type="text" class="input input-bordered input-xs" value={piece.name}
                  oninput={(e) => updatePiece((p) => ({ ...p, name: e.currentTarget.value }))} /></label>
              <p class="opacity-70">Type: {piece.type}</p>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.mirrorX}
                onchange={(e) => updatePiece((p) => ({ ...p, mirrorX: e.currentTarget.checked }))} /> Mirror X</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.mirrorY}
                onchange={(e) => updatePiece((p) => ({ ...p, mirrorY: e.currentTarget.checked }))} /> Mirror Y</label>
              <label class="flex items-center gap-2" title="Draft half the piece; the full shape is mirrored across the first edge (cut on fold)">
                <input type="checkbox" class="checkbox checkbox-xs" checked={piece.firstEdgeSymmetry ?? false}
                onchange={(e) => updatePiece((p) => ({ ...p, firstEdgeSymmetry: e.currentTarget.checked }), 'First edge symmetry')} /> First edge symmetry</label>
              <hr class="border-base-200" />
              <span class="text-[11px] font-semibold opacity-70">Cut count</span>
              <div class="grid grid-cols-2 gap-1">
                <label class="flex flex-col gap-0.5 text-[11px]">Right pieces
                  <input type="number" min="0" step="1" class="input input-bordered input-xs" value={piece.rightPieces}
                    oninput={(e) => updatePiece((p) => ({ ...p, rightPieces: Math.max(0, parseInt(e.currentTarget.value) || 0) }), 'Cut count')} /></label>
                <label class="flex flex-col gap-0.5 text-[11px]">Left (mirrored)
                  <input type="number" min="0" step="1" class="input input-bordered input-xs" value={piece.leftPieces}
                    oninput={(e) => updatePiece((p) => ({ ...p, leftPieces: Math.max(0, parseInt(e.currentTarget.value) || 0) }), 'Cut count')} /></label>
              </div>
              <label class="flex items-center justify-between gap-2 text-[11px]">Mirror left along
                <select class="select select-bordered select-xs w-20" value={piece.mirrorLeftPiecesAxis}
                  onchange={(e) => updatePiece((p) => ({ ...p, mirrorLeftPiecesAxis: e.currentTarget.value }), 'Mirror axis')}>
                  <option value="X">X axis</option><option value="Y">Y axis</option></select></label>
              <p class="text-[11px] opacity-50">Left/right copies appear in the cutting marker. 3D drapes the base piece only.</p>

            {:else if s.id === 'scaling'}
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.seamAllowanceInside}
                onchange={(e) => updatePiece((p) => ({ ...p, seamAllowanceInside: e.currentTarget.checked }), 'Seam allowance inside')} /> Seam allowance inside</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.seamAllowance !== undefined}
                onchange={(e) => updatePiece((p) => { if (e.currentTarget.checked) return { ...p, seamAllowance: currentPattern.seamAllowance }; const { seamAllowance, ...rest } = p; return rest as Piece; }, 'Override seam allowance')} /> Override seam allowance</label>
              {#if piece.seamAllowance !== undefined}
                <label class="flex items-center justify-between gap-2">Allowance ({unitLabel})
                  <input type="number" min="0" step="0.1" class="input input-bordered input-xs w-20" value={toUnit(piece.seamAllowance).toFixed(2)}
                    oninput={(e) => updatePiece((p) => ({ ...p, seamAllowance: fromUnit(parseFloat(e.currentTarget.value) || 0) }), 'Edit seam allowance')} /></label>
              {:else}
                <p class="opacity-70">Pattern default: {toUnit(currentPattern.seamAllowance).toFixed(2)} {unitLabel}</p>
              {/if}
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.useMaterialScaling ?? false}
                onchange={(e) => updatePiece((p) => ({ ...p, useMaterialScaling: e.currentTarget.checked }), 'Use material shrinkage')} /> Use material shrinkage</label>
              {#if piece.useMaterialScaling}
                {@const mat = currentPattern.materials.find((m) => m.id === piece.materialId)}
                <p class="opacity-70">Shrinkage: {(mat?.shrinkageHorizontalPercentage ?? 0)}% horizontal, {(mat?.shrinkageVerticalPercentage ?? 0)}% vertical</p>
              {/if}

            {:else if s.id === 'orientation'}
              <label class="flex flex-col gap-0.5">Rotation (°)
                <span class="flex items-center gap-1">
                  <input type="number" class="input input-bordered input-xs flex-1" value={piece.rotation} step="1" disabled={!!piece.rotationFormula}
                    oninput={(e) => updatePiece((p) => ({ ...p, rotation: parseFloat(e.currentTarget.value) || 0 }))} />
                  <button class="btn btn-xs px-1" class:btn-accent={!!piece.rotationFormula} title="Drive rotation with a formula (degrees)"
                    onclick={() => (formulaEditKey = formulaEditKey === `rot:${piece.id}` ? null : `rot:${piece.id}`)}>ƒ</button>
                </span></label>
              {#if formulaEditKey === `rot:${piece.id}`}
                <input type="text" class="input input-bordered input-xs w-full font-mono" placeholder="rotation formula (degrees) — empty clears" value={piece.rotationFormula?.formula ?? ''}
                  onchange={(e) => setPieceFormula(piece.id, 'rotation', e.currentTarget.value)} />
              {/if}
              <div class="grid grid-cols-2 gap-1">
                <label>Grain X<input type="number" step="0.1" class="input input-bordered input-xs w-full" value={piece.grainVector.x} disabled={!!piece.grainFormula}
                  oninput={(e) => updatePiece((p) => ({ ...p, grainVector: { ...p.grainVector, x: parseFloat(e.currentTarget.value) || 0 } }))} /></label>
                <label>Grain Y<input type="number" step="0.1" class="input input-bordered input-xs w-full" value={piece.grainVector.y} disabled={!!piece.grainFormula}
                  oninput={(e) => updatePiece((p) => ({ ...p, grainVector: { ...p.grainVector, y: parseFloat(e.currentTarget.value) || 0 } }))} /></label>
              </div>
              <label class="flex items-center justify-between gap-2 text-[11px]">Grain angle formula (°)
                <button class="btn btn-xs px-1" class:btn-accent={!!piece.grainFormula}
                  onclick={() => (formulaEditKey = formulaEditKey === `grain:${piece.id}` ? null : `grain:${piece.id}`)}>ƒ</button></label>
              {#if formulaEditKey === `grain:${piece.id}`}
                <input type="text" class="input input-bordered input-xs w-full font-mono" placeholder="grain angle formula (degrees) — empty clears" value={piece.grainFormula?.formula ?? ''}
                  onchange={(e) => setPieceFormula(piece.id, 'grain', e.currentTarget.value)} />
              {/if}
              <label class="flex items-center justify-between gap-2 text-[11px]" title="Condition formula: evaluates to 0 → piece hidden">Condition formula
                <button class="btn btn-xs px-1" class:btn-accent={!!piece.conditionFormula}
                  onclick={() => (formulaEditKey = formulaEditKey === `cond:${piece.id}` ? null : `cond:${piece.id}`)}>ƒ</button></label>
              {#if formulaEditKey === `cond:${piece.id}`}
                <input type="text" class="input input-bordered input-xs w-full font-mono" placeholder="condition (0 hides the piece) — empty clears" value={piece.conditionFormula?.formula ?? ''}
                  onchange={(e) => setPieceFormula(piece.id, 'condition', e.currentTarget.value)} />
              {/if}

            {:else if s.id === 'piecePoints'}
              {#each piece.piecePoints ?? [] as pt (pt.id)}
                <div class="flex items-center gap-1">
                  <input type="text" class="input input-bordered input-xs w-16" value={pt.name} title="Name"
                    onchange={(e) => updatePiecePointLocal(pt.id, { name: e.currentTarget.value })} />
                  <input type="number" step="0.1" class="input input-bordered input-xs w-20" value={pt.x.toFixed(1)} title="X (mm, drafting)"
                    onchange={(e) => updatePiecePointLocal(pt.id, { x: parseFloat(e.currentTarget.value) || 0 })} />
                  <input type="number" step="0.1" class="input input-bordered input-xs w-20" value={pt.y.toFixed(1)} title="Y (mm, drafting)"
                    onchange={(e) => updatePiecePointLocal(pt.id, { y: parseFloat(e.currentTarget.value) || 0 })} />
                  <button class="btn btn-xs btn-ghost text-error px-1" title="Delete piece point" onclick={() => removePiecePoint(pt.id)}>
                    <span class="material-symbols-rounded text-sm">delete</span>
                  </button>
                </div>
              {:else}
                <p class="opacity-60">No piece points. Use the piece-point tool (right toolbar) and click inside the piece to add construction points that travel with it.</p>
              {/each}

            {:else if s.id === 'seam' || s.id === 'internal'}
              {@const list = s.id === 'seam' ? piece.mainPaths : piece.internalPaths}
              <div class="flex flex-col">
                {#each list as pp}
                  {@const notchCount = pp.notches?.length ?? 0}
                  <div class="rounded-md border my-0.5"
                    class:border-accent={pathIds.has(pp.path)} class:border-base-200={!pathIds.has(pp.path)}>
                    <div class="flex items-center px-2 py-1 gap-1">
                      <button class="font-bold text-sm cursor-pointer hover:text-accent text-left" data-testid="piece-edge-select" onclick={() => selectPath(pp)}>{pathName(pp.path)}</button>
                      <span class="mx-1 text-xs opacity-70">({pointName(pp.from)} → {pointName(pp.to)})</span>
                      <div class="flex items-center ml-auto gap-1">
                        {#if s.id === 'seam'}
                          <button class="material-symbols-rounded text-base" class:text-error={pp.isMirrorLine} class:opacity-60={!pp.isMirrorLine}
                            title={pp.isMirrorLine ? 'Mirror/fold line (on) — cloth reflects across this edge' : 'Mark as mirror/fold line'}
                            onclick={() => toggleMirrorLine(pp)}>flip</button>
                          <button class="material-symbols-rounded text-base" class:text-accent={cornerEditId === pp.id} class:opacity-60={cornerEditId !== pp.id}
                            title="Seam corner join &amp; notches" aria-label="Edit corner join and notches"
                            onclick={() => (cornerEditId = cornerEditId === pp.id ? null : pp.id)}>tune</button>
                        {/if}
                        <button class="material-symbols-rounded text-base opacity-60 hover:text-error" title="Remove" onclick={() => (s.id === 'seam' ? removeMainPath(pp) : removeInternalPath(pp))}>delete</button>
                      </div>
                    </div>

                    {#if s.id === 'internal'}
                      <div class="border-t border-base-200 px-2 py-1.5 bg-base-100 space-y-1">
                        <label class="flex items-center justify-between gap-2 text-[11px]">Fold angle (°) — dart/pleat dihedral
                          <input type="number" step="1" class="input input-bordered input-xs w-20" value={pp.foldAngle ?? 0}
                            oninput={(e) => updateInternalPath(pp.id, { foldAngle: parseFloat(e.currentTarget.value) || 0 })} /></label>
                        <label class="flex items-center gap-2 text-[11px]" title="Bake this style line into the 3D fabric texture">
                          <input type="checkbox" class="checkbox checkbox-xs" checked={pp.showIn3d !== false}
                            onchange={(e) => updateInternalPath(pp.id, { showIn3d: e.currentTarget.checked }, 'Show line in 3D')} /> Show in 3D</label>
                      </div>
                    {/if}

                    {#if s.id === 'seam' && cornerEditId === pp.id}
                      {@const joinType = pp.seamCornerJoinType ?? 'intersection'}
                      <div class="border-t border-base-200 p-2 space-y-2 bg-base-100">
                        <!-- Corner join -->
                        <div class="space-y-1">
                          <span class="text-[11px] font-semibold opacity-70 flex items-center gap-1"><span class="material-symbols-rounded text-sm">rounded_corner</span>Seam corner join</span>
                          <div class="grid grid-cols-4 gap-0.5">
                            {#each CORNER_TYPES as ct}
                              <button class="btn btn-xs" class:btn-active={joinType === ct.id} title={ct.title}
                                onclick={() => updateMainPath(pp.id, { seamCornerJoinType: ct.id })}>
                                <span class="material-symbols-rounded text-base">{ct.icon}</span>
                              </button>
                            {/each}
                          </div>
                          {#if joinType === 'radius'}
                            <label class="flex items-center justify-between gap-2 text-[11px]">Radius ({unitLabel})
                              <input type="number" min="0" step="0.1" class="input input-bordered input-xs w-20" value={toUnit(cornerValueMm(pp)).toFixed(2)}
                                oninput={(e) => setCornerValueMm(pp, fromUnit(parseFloat(e.currentTarget.value) || 0))} /></label>
                          {:else if joinType === 'byLength'}
                            <label class="flex items-center justify-between gap-2 text-[11px]">Corner length ({unitLabel})
                              <input type="number" min="0" step="0.1" class="input input-bordered input-xs w-20" value={toUnit(cornerValueMm(pp)).toFixed(2)}
                                oninput={(e) => setCornerValueMm(pp, fromUnit(parseFloat(e.currentTarget.value) || 0))} /></label>
                          {:else if joinType === 'intersection'}
                            <label class="flex items-center justify-between gap-2 text-[11px]">Max length ({unitLabel}, 0 = uncapped)
                              <input type="number" min="0" step="0.1" class="input input-bordered input-xs w-20" value={toUnit(cornerValueMm(pp)).toFixed(2)}
                                oninput={(e) => setCornerValueMm(pp, fromUnit(parseFloat(e.currentTarget.value) || 0))} /></label>
                          {:else}
                            <p class="text-[10px] opacity-50">{CORNER_TYPES.find((c) => c.id === joinType)?.title}</p>
                          {/if}
                        </div>

                        <!-- Per-edge seam allowance override -->
                        <div class="space-y-1 border-t border-base-200 pt-2">
                          <label class="flex items-center gap-2 text-[11px]"><input type="checkbox" class="checkbox checkbox-xs" checked={pp.seamAllowance !== undefined}
                            onchange={(e) => updateMainPath(pp.id, e.currentTarget.checked ? { seamAllowance: piece.seamAllowance ?? currentPattern.seamAllowance } : { seamAllowance: undefined }, 'Override edge allowance')} /> Override seam allowance on this edge</label>
                          {#if pp.seamAllowance !== undefined}
                            <label class="flex items-center justify-between gap-2 text-[11px]">Edge allowance ({unitLabel})
                              <span class="flex items-center gap-1">
                                <input type="number" min="0" step="0.1" class="input input-bordered input-xs w-20" value={toUnit(pp.seamAllowance).toFixed(2)} disabled={!!pp.seamAllowanceFormula}
                                  oninput={(e) => updateMainPath(pp.id, { seamAllowance: fromUnit(parseFloat(e.currentTarget.value) || 0) }, 'Edit edge allowance')} />
                                <button class="btn btn-xs px-1" class:btn-accent={!!pp.seamAllowanceFormula} title="Drive with a formula (variables/measurements by name; mm)"
                                  onclick={() => (formulaEditKey = formulaEditKey === `sa:${pp.id}` ? null : `sa:${pp.id}`)}>ƒ</button>
                              </span></label>
                            {#if formulaEditKey === `sa:${pp.id}`}
                              <input type="text" class="input input-bordered input-xs w-full font-mono" placeholder="formula (mm) — empty clears" value={pp.seamAllowanceFormula?.formula ?? ''}
                                onchange={(e) => setPathFormula(pp.id, 'seamAllowance', e.currentTarget.value)} />
                            {/if}
                          {/if}
                        </div>

                        <!-- Wire / stiffener carried by this edge -->
                        <div class="space-y-1 border-t border-base-200 pt-2">
                          <label class="flex items-center gap-2 text-[11px] font-semibold opacity-70">
                            <input type="checkbox" class="checkbox checkbox-xs" checked={!!pp.wire}
                              onchange={(e) => toggleWire(pp, e.currentTarget.checked)} />
                            <span class="material-symbols-rounded text-sm">cable</span>Wire in this edge
                          </label>
                          {#if pp.wire}
                            {@const wire = pp.wire}
                            <div class="join w-full">
                              <button class="join-item btn btn-xs flex-1" class:btn-active={(wire.mode ?? 'stitched') === 'stitched'}
                                title="Sewn in as you make the seam — cloth and wire are fixed to each other"
                                onclick={() => setWire(pp, { mode: 'stitched' })}>Stitched in</button>
                              <button class="join-item btn btn-xs flex-1" class:btn-active={wire.mode === 'threaded'}
                                title="Fed through a finished casing afterwards — the cloth can gather along it"
                                onclick={() => setWire(pp, { mode: 'threaded' })}>Threaded</button>
                            </div>
                            <p class="text-[10px] opacity-50">
                              {wire.mode === 'threaded'
                                ? 'Fed in after the casing is sewn. The cloth may gather along the wire but cannot stretch past it.'
                                : 'Sewn into the seam as you go. Cloth and wire hold each other along their whole length.'}
                            </p>
                            <label class="flex items-center justify-between gap-2 text-[11px]"
                              title="Extra CUT width for the fold-back that houses the wire. The finished edge does not move — this is added to the edge's seam allowance.">Channel ({unitLabel})
                              <input type="number" min="0" step="0.5" class="input input-bordered input-xs w-20"
                                value={toUnit(wire.channelWidth).toFixed(2)}
                                oninput={(e) => setWire(pp, { channelWidth: fromUnit(parseFloat(e.currentTarget.value) || 0) })} /></label>
                            {#if pp.seamAllowance !== undefined && Math.abs(pp.seamAllowance - (baseAllowanceMm() + wire.channelWidth)) < 1e-6}
                              <p class="text-[10px] opacity-50">Cuts at {toUnit(baseAllowanceMm()).toFixed(2)} + {toUnit(wire.channelWidth).toFixed(2)} = {toUnit(pp.seamAllowance).toFixed(2)} {unitLabel} on this edge.</p>
                            {:else}
                              <p class="text-[10px] opacity-50">This edge has its own allowance ({toUnit(pp.seamAllowance ?? baseAllowanceMm()).toFixed(2)} {unitLabel}), so the channel is not added to it.</p>
                            {/if}
                            <label class="flex items-center justify-between gap-2 text-[11px]">Diameter ({unitLabel})
                              <input type="number" min="0.1" step="0.1" class="input input-bordered input-xs w-20"
                                value={toUnit(wire.diameter).toFixed(2)}
                                oninput={(e) => setWire(pp, { diameter: fromUnit(parseFloat(e.currentTarget.value) || 0.1) })} /></label>
                            <label class="flex items-center justify-between gap-2 text-[11px]" title="How hard the wire resists being bent away from the curve the flat pattern gives it">
                              Stiffness
                              <span class="flex items-center gap-1">
                                <input type="range" min="0" max="100" step="5" class="range range-xs w-24" value={wire.stiffness}
                                  oninput={(e) => setWire(pp, { stiffness: parseInt(e.currentTarget.value, 10) })} />
                                <span class="tabular-nums w-6 text-right">{wire.stiffness}</span>
                              </span></label>
                            <label class="flex items-center justify-between gap-2 text-[11px]" title="Annealed aluminium at 1.5 mm is about 4.8 g/m">Weight (g/m)
                              <input type="number" min="0" step="0.1" class="input input-bordered input-xs w-20"
                                value={wire.linearMass ?? 0}
                                oninput={(e) => setWire(pp, { linearMass: parseFloat(e.currentTarget.value) || 0 })} /></label>
                            <label class="flex items-center gap-2 text-[11px]" title="Join the wire end to end — a closed hoop rather than an open rib">
                              <input type="checkbox" class="checkbox checkbox-xs" checked={!!wire.closed}
                                onchange={(e) => setWire(pp, { closed: e.currentTarget.checked })} /> Closed hoop</label>
                          {/if}
                        </div>

                        <!-- Cover seam allowance at the edge ends -->
                        <div class="space-y-1 border-t border-base-200 pt-2">
                          <span class="text-[11px] font-semibold opacity-70">Cover seam allowance</span>
                          <label class="flex items-center gap-2 text-[11px]" title="Wrap the allowance around the corner at this edge's start point"><input type="checkbox" class="checkbox checkbox-xs" checked={pp.coverSeamAllowanceStart !== false}
                            onchange={(e) => updateMainPath(pp.id, { coverSeamAllowanceStart: e.currentTarget.checked }, 'Cover allowance at start')} /> at start</label>
                          <label class="flex items-center gap-2 text-[11px]" title="Wrap the allowance around the corner at this edge's end point"><input type="checkbox" class="checkbox checkbox-xs" checked={pp.coverSeamAllowanceEnd !== false}
                            onchange={(e) => updateMainPath(pp.id, { coverSeamAllowanceEnd: e.currentTarget.checked }, 'Cover allowance at end')} /> at end</label>
                        </div>

                        <!-- Notches -->
                        <div class="space-y-1 border-t border-base-200 pt-2">
                          <div class="flex items-center justify-between">
                            <span class="text-[11px] font-semibold opacity-70 flex items-center gap-1"><span class="material-symbols-rounded text-sm">content_cut</span>Notches ({notchCount})</span>
                            <button class="btn btn-xs btn-ghost" onclick={() => addNotch(pp)}><span class="material-symbols-rounded text-sm">add</span>Add</button>
                          </div>
                          {#each pp.notches ?? [] as n (n.id)}
                            {@const anchored = !!n.referencePointId}
                            <div class="space-y-0.5">
                              <div class="flex items-center gap-1">
                                {#if anchored}
                                  <input type="number" min="0" step="0.1" class="input input-bordered input-xs flex-1" title="Distance from point ({unitLabel})"
                                    value={toUnit((n.distance as number) ?? 0).toFixed(1)} disabled={!!n.distanceFormula}
                                    oninput={(e) => updateNotch(pp, n.id as string, { distance: fromUnit(parseFloat(e.currentTarget.value) || 0) })} />
                                  <button class="btn btn-xs px-1" class:btn-accent={!!n.distanceFormula} title="Drive the distance with a formula (mm)"
                                    onclick={() => (formulaEditKey = formulaEditKey === `nd:${n.id}` ? null : `nd:${n.id}`)}>ƒ</button>
                                {:else}
                                  <input type="range" min="0" max="1" step="0.01" class="range range-xs flex-1" value={typeof n.position === 'number' ? n.position : 0.5}
                                    title="Position along edge" oninput={(e) => updateNotch(pp, n.id as string, { position: parseFloat(e.currentTarget.value) })} />
                                {/if}
                                <select class="select select-bordered select-xs w-16" value={(n.type as NotchType) ?? 'single'}
                                  onchange={(e) => updateNotch(pp, n.id as string, { type: e.currentTarget.value as NotchType })}>
                                  {#each NOTCH_TYPES as nt}<option value={nt.id}>{nt.label}</option>{/each}
                                </select>
                                <input type="number" min="0" step="0.1" class="input input-bordered input-xs w-14" title="Size ({unitLabel})"
                                  value={toUnit((n.size as number) ?? currentPattern.defaultNotchSize).toFixed(1)}
                                  oninput={(e) => updateNotch(pp, n.id as string, { size: fromUnit(parseFloat(e.currentTarget.value) || 0) })} />
                                <button class="material-symbols-rounded text-base opacity-60 hover:text-error" title="Remove notch" aria-label="Remove notch"
                                  onclick={() => removeNotch(pp, n.id as string)}>delete</button>
                              </div>
                              {#if anchored && formulaEditKey === `nd:${n.id}`}
                                <input type="text" class="input input-bordered input-xs w-full font-mono" placeholder="distance formula (mm) — empty clears" value={n.distanceFormula?.formula ?? ''}
                                  onchange={(e) => setNotchFormula(n.id as string, e.currentTarget.value)} />
                              {/if}
                              <label class="flex items-center justify-between gap-2 text-[10px] opacity-80">From point
                                <select class="select select-bordered select-xs w-28" value={n.referencePointId ?? ''}
                                  onchange={(e) => {
                                    const v = e.currentTarget.value;
                                    updateNotch(pp, n.id as string, v ? { referencePointId: v, distance: (n.distance as number) ?? 0 } : { referencePointId: undefined, distance: undefined });
                                  }}>
                                  <option value="">— slider —</option>
                                  <option value={pp.from}>{pointName(pp.from)} (start)</option>
                                  <option value={pp.to}>{pointName(pp.to)} (end)</option>
                                </select></label>
                            </div>
                          {:else}
                            <p class="text-[11px] opacity-50">No notches. Add one, or right-click the edge in the 2D view.</p>
                          {/each}
                        </div>
                      </div>
                    {/if}
                  </div>
                {:else}
                  <p class="opacity-60">No {s.id === 'seam' ? 'boundary' : 'internal'} paths.</p>
                {/each}
              </div>

            {:else if s.id === 'material'}
              <label class="flex flex-col gap-0.5">Fabric
                <select class="select select-bordered select-xs" value={piece.materialId}
                  onchange={(e) => updatePiece((p) => ({ ...p, materialId: e.currentTarget.value }))}>
                  <option value="">None</option>
                  {#each currentPattern.materials as mat}<option value={mat.id}>{mat.name}</option>{/each}
                </select></label>

            {:else if s.id === '3d'}
              <label class="flex flex-col gap-0.5">Cylinder
                <input type="text" class="input input-bordered input-xs" value={piece.settings3d.arrangement.cylinderName}
                  oninput={(e) => updateArrangement('cylinderName', e.currentTarget.value)} /></label>
              <div class="grid grid-cols-2 gap-1">
                <label>u°<input type="number" class="input input-bordered input-xs w-full" value={piece.settings3d.arrangement.uDegrees}
                  oninput={(e) => updateArrangement('uDegrees', parseFloat(e.currentTarget.value) || 0)} /></label>
                <label>v<input type="number" step="0.05" class="input input-bordered input-xs w-full" value={piece.settings3d.arrangement.v}
                  oninput={(e) => updateArrangement('v', parseFloat(e.currentTarget.value) || 0)} /></label>
              </div>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.settings3d.frozen}
                onchange={(e) => updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, frozen: e.currentTarget.checked } }))} /> Freeze piece in simulation</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.settings3d.flipNormals}
                onchange={(e) => updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, flipNormals: e.currentTarget.checked } }))} /> Flip cloth normals</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={piece.settings3d.filterExternalCollisionsByClothNormal}
                onchange={(e) => updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, filterExternalCollisionsByClothNormal: e.currentTarget.checked } }))} /> Body collision by normal</label>
              <label class="flex items-center justify-between gap-2">Collision layer
                <input type="number" min="0" step="1" class="input input-bordered input-xs w-16" value={piece.settings3d.collisionLayer}
                  oninput={(e) => updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, collisionLayer: Math.max(0, parseInt(e.currentTarget.value) || 0) } }))} /></label>
              <label class="flex items-center justify-between gap-2">Particle distance
                <input type="number" min="0" step="1" placeholder="default" class="input input-bordered input-xs w-16" value={piece.settings3d.particleDistance ?? ''}
                  onchange={(e) => { const v = parseFloat(e.currentTarget.value); updatePiece((p) => ({ ...p, settings3d: { ...p.settings3d, particleDistance: Number.isFinite(v) && v > 0 ? v : null } })); }} /></label>
              <p class="text-[11px] opacity-50">Lower values = more particles and slower simulation</p>
              <hr class="border-base-200" />
              {@render labelSetting()}
            {/if}
          </div>
        {/if}
      </div>
    {/each}

  {:else if editingPoint}
    {@const ep = editingPoint}
    {@const cn = ep.constraint}
    <div class="p-3 space-y-2 text-sm">
      <h4 class="font-semibold text-accent">Point: {ep.name}</h4>
      <label class="flex flex-col gap-0.5">Name
        <input type="text" class="input input-bordered input-xs" value={ep.name} oninput={(e) => updatePoint('name', e.currentTarget.value)} /></label>
      <div class="grid grid-cols-2 gap-1">
        <label>X (mm)<input type="number" class="input input-bordered input-xs w-full" value={ep.x.toFixed(1)} disabled={!!cn} oninput={(e) => updatePoint('x', parseFloat(e.currentTarget.value) || 0)} step="0.1" /></label>
        <label>Y (mm)<input type="number" class="input input-bordered input-xs w-full" value={ep.y.toFixed(1)} disabled={!!cn} oninput={(e) => updatePoint('y', parseFloat(e.currentTarget.value) || 0)} step="0.1" /></label>
      </div>

      {#if currentPattern.gradingProfile?.rulTable}
        <label class="flex items-center justify-between gap-2 text-[11px]"
          title="Bind this point to a grade rule from the imported RUL table — it shifts per size in the grading overlay (0 = unbound)">
          Grade rule # ({currentPattern.gradingProfile.rulTable.name})
          <input type="number" min="0" step="1" class="input input-bordered input-xs w-16"
            value={currentPattern.gradingProfile.rulAnchors?.find((a) => a.pointId === ep.id)?.ruleNumber ?? 0}
            onchange={(e) => {
              const rule = Math.max(0, Math.round(parseFloat(e.currentTarget.value) || 0));
              const gp = currentPattern.gradingProfile!;
              const anchors = (gp.rulAnchors ?? []).filter((a) => a.pointId !== ep.id);
              if (rule > 0) anchors.push({ pointId: ep.id, ruleNumber: rule });
              onchange({ ...currentPattern, gradingProfile: { ...gp, rulAnchors: anchors }, hasChanged: true }, 'Bind grade rule');
            }} />
        </label>
      {/if}

      <hr class="border-base-200" />
      <h5 class="font-semibold">Construction</h5>
      <label class="flex flex-col gap-0.5">Type
        <select class="select select-bordered select-xs" value={cn?.type ?? 'fixed'} onchange={(e) => changeConstraintType(e.currentTarget.value)}>
          <option value="fixed">Fixed (x, y)</option>
          <option value="offset">Offset from point (dx, dy)</option>
          <option value="lengthAngle">Length &amp; angle from point</option>
          <option value="sliding">Sliding along path</option>
        </select></label>

      {#if cn?.type === 'offset' || cn?.type === 'lengthAngle'}
        <label class="flex flex-col gap-0.5">From point
          <select class="select select-bordered select-xs" value={cn.from} onchange={(e) => setConstraint({ ...cn, from: e.currentTarget.value })}>
            {#each currentPattern.points.filter((p) => p.id !== ep.id) as op}<option value={op.id}>{op.name}</option>{/each}
          </select></label>
      {/if}
      {#if cn?.type === 'offset'}
        <label class="flex flex-col gap-0.5">dx (formula, mm)<input class="input input-bordered input-xs font-mono" value={cn.dxFormula} oninput={(e) => setConstraint({ ...cn, dxFormula: e.currentTarget.value })} /></label>
        <label class="flex flex-col gap-0.5">dy (formula, mm)<input class="input input-bordered input-xs font-mono" value={cn.dyFormula} oninput={(e) => setConstraint({ ...cn, dyFormula: e.currentTarget.value })} /></label>
      {:else if cn?.type === 'lengthAngle'}
        <label class="flex flex-col gap-0.5">Length (formula, mm)<input class="input input-bordered input-xs font-mono" value={cn.lengthFormula} oninput={(e) => setConstraint({ ...cn, lengthFormula: e.currentTarget.value })} /></label>
        <label class="flex flex-col gap-0.5">Angle (formula, °)<input class="input input-bordered input-xs font-mono" value={cn.angleFormula} oninput={(e) => setConstraint({ ...cn, angleFormula: e.currentTarget.value })} /></label>
      {:else if cn?.type === 'sliding'}
        <label class="flex flex-col gap-0.5">Along path
          <select class="select select-bordered select-xs" value={cn.path} onchange={(e) => setConstraint({ ...cn, path: e.currentTarget.value })}>
            {#each currentPattern.paths as pa}<option value={pa.id}>{pa.name || pa.id.slice(0, 8)}</option>{/each}
          </select></label>
        <label class="flex flex-col gap-0.5">Distance along (formula, mm)<input class="input input-bordered input-xs font-mono" value={cn.positionFormula} oninput={(e) => setConstraint({ ...cn, positionFormula: e.currentTarget.value })} /></label>
      {/if}
      {#if cn}<p class="text-xs opacity-60">Position is computed from the formula(s). Reference variables and body measurements by name.</p>{/if}
    </div>

  {:else}
    {#each patternSections as s}
      <div class="w-full bg-base-200 block mt-[-1px]" class:bg-base-300={patternOpen === s.id}>
        <button type="button" class="w-full flex items-center p-2 px-3 text-sm" aria-expanded={patternOpen === s.id} onclick={() => togglePattern(s.id)}>
          <span class="material-symbols-rounded mr-2">{s.icon}</span>
          <span class="text-md font-bold">{s.title}{s.id === 'materials' ? ` (${currentPattern.materials.length})` : s.id === 'texts' && currentPattern.texts.length ? ` (${currentPattern.texts.length})` : s.id === 'images' && currentPattern.images.length ? ` (${currentPattern.images.length})` : ''}</span>
          <span class="material-symbols-rounded ml-auto">{patternOpen === s.id ? 'keyboard_arrow_down' : 'keyboard_arrow_right'}</span>
        </button>
        {#if patternOpen === s.id}
          <div class="w-full bg-base-100 border-t border-base-300 p-3 pt-2 text-sm space-y-2">
            {#if s.id === 'general'}
              <label class="flex flex-col gap-0.5">Name
                <input type="text" class="input input-bordered input-xs" value={currentPattern.name} oninput={(e) => updatePattern({ name: e.currentTarget.value })} /></label>
              <label class="flex flex-col gap-0.5">Description
                <textarea class="textarea textarea-bordered textarea-xs" rows="2" oninput={(e) => updatePattern({ description: e.currentTarget.value })}>{currentPattern.description}</textarea></label>
              <div class="grid grid-cols-2 gap-1">
                <label>Length unit
                  <select class="select select-bordered select-xs w-full" value={currentPattern.lengthUnit} onchange={(e) => updatePattern({ lengthUnit: e.currentTarget.value as Pattern['lengthUnit'] })}>
                    <option value="inch">inch</option><option value="cm">cm</option><option value="mm">mm</option></select></label>
                <label>Angle unit
                  <select class="select select-bordered select-xs w-full" value={currentPattern.angleUnit} onchange={(e) => updatePattern({ angleUnit: e.currentTarget.value as Pattern['angleUnit'] })}>
                    <option value="degrees">degrees</option><option value="radians">radians</option></select></label>
              </div>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.isPublic} onchange={(e) => updatePattern({ isPublic: e.currentTarget.checked })} /> Public</label>

            {:else if s.id === 'settings'}
              <label class="flex flex-col gap-0.5">Default length unit
                <select class="select select-bordered select-xs" value={currentPattern.lengthUnit} onchange={(e) => updatePattern({ lengthUnit: e.currentTarget.value as Pattern['lengthUnit'] })}>
                  <option value="cm">Centimeters</option><option value="mm">Millimeters</option><option value="inch">Inches</option></select></label>
              <label class="flex flex-col gap-0.5">Default seam allowance
                <span class="flex items-center gap-2"><input type="number" step="0.1" class="input input-bordered input-xs w-20" value={toUnit(currentPattern.seamAllowance).toFixed(2)} oninput={(e) => updatePattern({ seamAllowance: fromUnit(parseFloat(e.currentTarget.value) || 0) })} /><span class="opacity-60">{unitLabel}</span></span></label>
              <div class="flex items-end gap-2">
                <label class="flex flex-col gap-0.5 flex-1">Default point labeling
                  <select class="select select-bordered select-xs" value={currentPattern.pointLabeling} onchange={(e) => updatePattern({ pointLabeling: e.currentTarget.value })}>
                    <option value="numeric">Numeric (0, 1, 2...)</option><option value="alphabetic">Alphabetic (A, B, C...)</option></select></label>
                <label class="flex flex-col gap-0.5 w-16">Prefix
                  <input type="text" class="input input-bordered input-xs" value={currentPattern.pointPrefix} oninput={(e) => updatePattern({ pointPrefix: e.currentTarget.value })} /></label>
              </div>
              <div class="flex gap-2">
                <label class="flex flex-col gap-0.5 flex-1">Default notch size
                  <span class="flex items-center gap-2"><input type="number" step="0.1" class="input input-bordered input-xs w-20" value={toUnit(currentPattern.defaultNotchSize).toFixed(2)} oninput={(e) => updatePattern({ defaultNotchSize: fromUnit(parseFloat(e.currentTarget.value) || 0) })} /><span class="opacity-60">{unitLabel}</span></span></label>
                <label class="flex flex-col gap-0.5">Notch type
                  <select class="select select-bordered select-xs" value={currentPattern.defaultNotchType ?? 'single'} onchange={(e) => updatePattern({ defaultNotchType: e.currentTarget.value as 'single' | 'double' | 'tee' | 'slit' })}>
                    <option value="single">Single</option><option value="double">Double (balance)</option><option value="tee">Tee</option><option value="slit">Slit</option></select></label>
              </div>
              <hr class="border-base-200" />
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.showGrid} onchange={(e) => updatePattern({ showGrid: e.currentTarget.checked })} /> Show grid</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.snapToGrid} onchange={(e) => updatePattern({ snapToGrid: e.currentTarget.checked })} /> Snap to grid</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.showCompass} onchange={(e) => updatePattern({ showCompass: e.currentTarget.checked })} /> Show compass</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.showPieceNames} onchange={(e) => updatePattern({ showPieceNames: e.currentTarget.checked })} /> Show piece names</label>

            {:else if s.id === '3d'}
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.enable3d} onchange={(e) => updatePattern({ enable3d: e.currentTarget.checked })} /> Enable 3D</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.showAvatar} onchange={(e) => updateSettings3D({ showAvatar: e.currentTarget.checked })} /> Show avatar</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.showSeams} onchange={(e) => updateSettings3D({ showSeams: e.currentTarget.checked })} /> Show seams (3D)</label>
              <label class="flex flex-col gap-0.5">Lighting
                <select class="select select-bordered select-xs" value={currentPattern.settings3d.lightingMode} onchange={(e) => updateSettings3D({ lightingMode: e.currentTarget.value })}>
                  {#each ['flat', 'hdri', 'studio1', 'studio2', 'sunset'] as m}<option value={m}>{m}</option>{/each}</select></label>
              {@render labelSetting()}
              <hr class="border-base-200" />
              <span class="text-xs font-semibold opacity-70">Simulation</span>
              <label class="flex items-center justify-between gap-2">Gravity
                <input type="number" step="0.1" class="input input-bordered input-xs w-20" value={currentPattern.settings3d.gravity[1]}
                  oninput={(e) => updateSettings3D({ gravity: [currentPattern.settings3d.gravity[0], parseFloat(e.currentTarget.value) || 0, currentPattern.settings3d.gravity[2]] })} /></label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.handleSelfCollisions} onchange={(e) => updateSettings3D({ handleSelfCollisions: e.currentTarget.checked })} /> Self-collisions</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.forceLowEndHardware} onchange={(e) => updateSettings3D({ forceLowEndHardware: e.currentTarget.checked })} /> Force low-end hardware</label>
              <label class="flex items-center gap-2" title="Debug: pin each piece's topmost particles while simulating"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.fixTop ?? false} onchange={(e) => updateSettings3D({ fixTop: e.currentTarget.checked })} /> Fix top (debug pin)</label>
              <label class="flex items-center justify-between gap-2" title="Override the particle spacing of EVERY piece (0 = per-piece settings)">Global particle distance (mm)
                <input type="number" min="0" step="1" class="input input-bordered input-xs w-20" value={currentPattern.settings3d.globalParticleDistanceOverride ?? 0}
                  onchange={(e) => updateSettings3D({ globalParticleDistanceOverride: Math.max(0, parseFloat(e.currentTarget.value) || 0) })} /></label>
              <label class="flex items-center gap-2" title="Experimental: also drape an X-mirrored copy of each left/right-paired piece"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.drapeMirroredPieces ?? false} onchange={(e) => updateSettings3D({ drapeMirroredPieces: e.currentTarget.checked })} /> Drape mirrored pieces (experimental)</label>
              <hr class="border-base-200" />
              <span class="text-xs font-semibold opacity-70">Overlays</span>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.showArrangementPoints} onchange={(e) => updateSettings3D({ showArrangementPoints: e.currentTarget.checked })} /> Arrangement points</label>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.showTriangles} onchange={(e) => updateSettings3D({ showTriangles: e.currentTarget.checked })} /> Mesh triangles</label>
              <hr class="border-base-200" />
              <span class="text-xs font-semibold opacity-70">Post-processing</span>
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={currentPattern.settings3d.n8aoEnabled} onchange={(e) => updateSettings3D({ n8aoEnabled: e.currentTarget.checked })} /> Ambient occlusion (N8AO)</label>
              {#if currentPattern.settings3d.n8aoEnabled}
                <label class="flex items-center justify-between gap-2 text-[11px]">AO intensity
                  <input type="number" step="0.1" min="0" max="2" class="input input-bordered input-xs w-20" value={currentPattern.settings3d.n8aoIntensity}
                    oninput={(e) => updateSettings3D({ n8aoIntensity: parseFloat(e.currentTarget.value) || 0 })} /></label>
                <label class="flex items-center justify-between gap-2 text-[11px]" title="World-space occlusion radius (m) — larger darkens broader cavities">AO radius (m)
                  <input type="number" step="0.02" min="0.01" max="1" class="input input-bordered input-xs w-20" value={currentPattern.settings3d.n8aoRadius}
                    oninput={(e) => updateSettings3D({ n8aoRadius: parseFloat(e.currentTarget.value) || 0.12 })} /></label>
                <label class="flex items-center justify-between gap-2 text-[11px]" title="Distance falloff exponent — higher fades occlusion faster with distance">AO falloff
                  <input type="number" step="0.1" min="0.1" max="4" class="input input-bordered input-xs w-20" value={currentPattern.settings3d.n8aoDistanceFalloff}
                    oninput={(e) => updateSettings3D({ n8aoDistanceFalloff: parseFloat(e.currentTarget.value) || 1 })} /></label>
              {/if}
              <label class="flex items-center justify-between gap-2 text-[11px]" title="Depth of field: 0 = off; lower f-stops blur more away from the orbit target">Bokeh f-stop
                <input type="number" step="0.5" min="0" class="input input-bordered input-xs w-20" value={currentPattern.settings3d.bokehFStop}
                  oninput={(e) => updateSettings3D({ bokehFStop: parseFloat(e.currentTarget.value) || 0 })} /></label>
              <label class="flex items-center justify-between gap-2 text-[11px]">SMAA scale
                <input type="number" step="1" min="0" class="input input-bordered input-xs w-20" value={currentPattern.settings3d.smaaScale}
                  oninput={(e) => updateSettings3D({ smaaScale: parseFloat(e.currentTarget.value) || 0 })} /></label>

            {:else if s.id === 'sizes'}
              <!-- Sizes -->
              <h6 class="border-b-2 border-base-200 font-semibold pb-1">Sizes</h6>
              <div class="flex items-center gap-2">
                <select class="select select-bordered select-xs flex-1" value={currentPattern.currentSize} onchange={(e) => updatePattern({ currentSize: e.currentTarget.value })}>
                  <option value="">Custom (base)</option>
                  {#each sizes as sz}<option value={sz.name}>{sz.name}</option>{/each}
                </select>
                <button class="btn btn-xs btn-primary" onclick={addSize}>Create a size…</button>
              </div>
              {#if sizes.length}
                <div class="flex flex-col gap-1">
                  {#each sizes as sz}
                    <div class="flex items-center gap-1">
                      <span class="inline-block w-3 h-3 rounded-full shrink-0" style="background:{sz.color}"></span>
                      <input class="input input-bordered input-xs flex-1 min-w-0" value={sz.name} oninput={(e) => updateSize(sz.id, { name: e.currentTarget.value })} />
                      <input type="number" step="0.01" class="input input-bordered input-xs w-16" title="Grade scale" value={sz.scale} oninput={(e) => updateSize(sz.id, { scale: parseFloat(e.currentTarget.value) || 1 })} />
                      <button class="btn btn-ghost btn-xs p-1 text-error" title="Remove size" aria-label="Remove size" onclick={() => removeSize(sz.id)}><span class="material-symbols-rounded text-base">delete</span></button>
                    </div>
                  {/each}
                </div>
              {/if}
              {#if ongrading}<button class="btn btn-xs btn-outline w-full" onclick={ongrading}><span class="material-symbols-rounded text-base">table_chart</span> Sizes &amp; grading overlay…</button>{/if}
              {#if onalterations}<button class="btn btn-xs btn-outline w-full mt-1" onclick={onalterations}><span class="material-symbols-rounded text-base">tune</span> Alterations (grade by example)…</button>{/if}

              <!-- Variables -->
              <h6 class="border-b-2 border-base-200 font-semibold pb-1 mt-3">Variables</h6>
              <div class="border border-base-200 rounded-md bg-base-100 max-h-40 overflow-y-auto">
                <ul>
                  {#each currentPattern.variables as v, i (v.id)}
                    <li class="w-full flex items-center" class:bg-base-300={selectedVariableId === v.id}>
                      <button class="material-symbols-rounded px-1 opacity-50 hover:opacity-100 text-base disabled:opacity-20" disabled={i === 0} title="Move up" aria-label="Move variable up" onclick={() => onchange(variableReorder(currentPattern, v.id, i - 1), 'Reorder variable')}>keyboard_arrow_up</button>
                      <button class="material-symbols-rounded px-1 opacity-50 hover:opacity-100 text-base disabled:opacity-20" disabled={i === currentPattern.variables.length - 1} title="Move down" aria-label="Move variable down" onclick={() => onchange(variableReorder(currentPattern, v.id, i + 1), 'Reorder variable')}>keyboard_arrow_down</button>
                      <button class="flex items-center gap-1 p-1 w-full text-left" onclick={() => (selectedVariableId = v.id)}>
                        <span class="material-symbols-rounded text-base">{VAR_TYPE_ICON[v.type] ?? 'tag'}</span>
                        <span class="truncate">{v.name || 'unnamed'}</span>
                      </button>
                    </li>
                  {:else}<li class="p-2 opacity-60">No variables.</li>{/each}
                </ul>
              </div>
              <div class="flex gap-2">
                <button class="btn btn-sm btn-error flex-1" disabled={!selectedVariable} onclick={() => { if (selectedVariableId) { deleteVariable(selectedVariableId); selectedVariableId = null; } }}>Remove</button>
                <button class="btn btn-sm btn-primary flex-1" onclick={addVariable}>Add</button>
              </div>

              {#if selectedVariable}
                {@const v = selectedVariable}
                <div class="border-t border-base-200 pt-2 mt-1 space-y-2">
                  <label class="flex flex-col gap-0.5">Name
                    <input class="input input-bordered input-sm" value={v.name} oninput={(e) => updateVariable(v.id, { name: e.currentTarget.value })} /></label>
                  <label class="flex flex-col gap-0.5">Description
                    <input class="input input-bordered input-sm" placeholder="Add notes about how this variable is used" value={v.description ?? ''} oninput={(e) => updateVariable(v.id, { description: e.currentTarget.value })} /></label>
                  <div class="flex flex-col gap-0.5">
                    <span>Behavior</span>
                    <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-primary checkbox-sm" checked={v.isEditable} onchange={(e) => updateVariable(v.id, { isEditable: e.currentTarget.checked })} /> Is editable</label>
                    <label class="flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-primary checkbox-sm" checked={v.isVisible} onchange={(e) => updateVariable(v.id, { isVisible: e.currentTarget.checked })} /> Is visible</label>
                  </div>
                  <label class="flex flex-col gap-0.5">Type
                    <select class="select select-bordered select-sm" value={v.type} onchange={(e) => updateVariable(v.id, { type: e.currentTarget.value })}>
                      <option value="number">Number</option><option value="boolean">Boolean</option><option value="enum">Enum</option><option value="string">String</option></select></label>
                  {#if v.type === 'enum'}
                    {@const opts = (v.options ?? []).map((o) => String(o))}
                    <div class="flex flex-col gap-0.5">
                      <span>Options</span>
                      {#each opts as opt, oi}
                        <span class="flex items-center gap-1">
                          <input class="input input-bordered input-sm flex-1" value={opt}
                            oninput={(e) => { const next = [...opts]; next[oi] = e.currentTarget.value; onchange(variableSetOptions(currentPattern, v.id, next), 'Edit variable options'); }} />
                          <button class="btn btn-ghost btn-sm btn-square text-error" title="Remove option" aria-label="Remove option"
                            onclick={() => onchange(variableSetOptions(currentPattern, v.id, opts.filter((_, k) => k !== oi)), 'Remove variable option')}>✕</button>
                        </span>
                      {/each}
                      <button class="btn btn-ghost btn-sm self-start" onclick={() => onchange(variableSetOptions(currentPattern, v.id, [...opts, `Option ${opts.length + 1}`]), 'Add variable option')}>+ Add option</button>
                    </div>
                  {/if}
                  <label class="flex flex-col gap-0.5">Value
                    <span class="flex items-center gap-2">
                      <input type="number" class="input input-bordered input-sm flex-1" value={v.value ?? 0} oninput={(e) => updateVariable(v.id, { value: parseFloat(e.currentTarget.value) || 0, valueFormula: { ...v.valueFormula, formula: e.currentTarget.value } })} />
                      <select class="select select-bordered select-sm w-16" value={v.valueFormula?.unit ?? 'none'} onchange={(e) => updateVariable(v.id, { valueFormula: { ...v.valueFormula, unit: e.currentTarget.value } })}>
                        <option value="none">none</option><option value="cm">cm</option><option value="mm">mm</option><option value="inch">in</option><option value="percent">%</option><option value="degrees">°</option></select>
                      <button class="btn btn-primary btn-sm w-8 h-8 p-1" title="Formula editor" aria-label="Formula editor" onclick={() => (formulaVarId = v.id)}><span class="material-symbols-rounded">function</span></button>
                    </span>
                    {#if v.valueFormula?.formula && v.valueFormula.formula !== String(v.value)}<span class="text-xs opacity-60 font-mono">= {v.valueFormula.formula}</span>{/if}</label>
                </div>
              {/if}

            {:else if s.id === 'body'}
              <div class="grid grid-cols-2 gap-1">
                <label>Gender
                  <select class="select select-bordered select-xs w-full" value={currentPattern.body.gender} onchange={(e) => updateBody({ gender: e.currentTarget.value })}>
                    <option value="female">female</option><option value="male">male</option><option value="neutral">neutral</option></select></label>
                <label>Units
                  <select class="select select-bordered select-xs w-full" value={currentPattern.body.unitType} onchange={(e) => updateBody({ unitType: e.currentTarget.value })}>
                    <option value="imperial">imperial</option><option value="metric">metric</option></select></label>
              </div>
              {#each Object.entries(currentPattern.body.fields) as [name, value]}
                <label class="flex items-center gap-2"><span class="flex-1 capitalize">{name}</span>
                  <input type="number" step="0.1" class="input input-bordered input-xs w-20" value={value} oninput={(e) => updateBodyField(name, parseFloat(e.currentTarget.value) || 0)} /></label>
              {/each}

            {:else if s.id === 'materials'}
              <div class="flex flex-col gap-2 w-full">
                {#each currentPattern.materials as m}
                  <div class="rounded-md border" class:border-accent={editingMaterialId === m.id} class:border-base-300={editingMaterialId !== m.id}>
                    <div class="flex items-center gap-3 p-2 hover:bg-base-200/50">
                      <div class="w-10 h-10 rounded border border-base-300 shrink-0" aria-label="Material preview" style={materialSwatch(m)}></div>
                      <div class="flex flex-col flex-1 leading-tight min-w-0">
                        <span class="font-medium truncate">{m.name}</span>
                        <span class="text-[11px] flex items-center gap-1 {STATUS_META[statusOf(m)].cls}"><span class="w-2 h-2 rounded-full {STATUS_META[statusOf(m)].dot}"></span>{STATUS_META[statusOf(m)].label}</span>
                      </div>
                      <button class="btn btn-ghost btn-xs p-1" title="Edit material" aria-label="Edit material" onclick={() => (editingMaterialId = editingMaterialId === m.id ? null : m.id)}><span class="material-symbols-rounded text-base">{editingMaterialId === m.id ? 'expand_less' : 'edit'}</span></button>
                      <button class="btn btn-ghost btn-xs p-1 text-error" title="Delete material" aria-label="Delete material" onclick={() => deleteMaterial(m.id)}><span class="material-symbols-rounded text-base">delete</span></button>
                    </div>
                    {#if editingMaterialId === m.id}
                      {@render materialEditor(m)}
                    {/if}
                  </div>
                {:else}<p class="opacity-60">No materials yet.</p>{/each}
                <div class="grid grid-cols-2 gap-2 mt-1">
                  <button class="btn btn-sm btn-primary" onclick={createMaterial}><span class="material-symbols-rounded text-base">add</span> Create material</button>
                  <button class="btn btn-sm btn-secondary" title="Pick a material from your library" onclick={() => (showLibraryPicker = !showLibraryPicker)}><span class="material-symbols-rounded text-base">library_add</span> Add from library</button>
                </div>
                {#if showLibraryPicker}
                  <div class="border border-base-300 rounded-md p-2 bg-base-200 space-y-1">
                    <span class="text-[11px] font-semibold opacity-70">Material library</span>
                    {#each $materialLibrary as item (item.id)}
                      <button class="flex items-center gap-2 w-full text-left p-1 rounded hover:bg-base-300" onclick={() => addFromLibrary(item.id)}>
                        <span class="w-5 h-5 rounded border border-base-300 shrink-0" style={item.material.frontTexture?.url ? `background-image:url('${item.material.frontTexture.url}');background-size:cover` : `background-color:${item.material.frontTexture?.color ?? '#bbb'}`}></span>
                        <span class="flex-1 truncate text-xs">{item.name}</span>
                        <span class="text-[10px] opacity-50">v{item.version}{item.writeProtected ? ' 🔒' : ''}</span>
                      </button>
                    {:else}
                      <p class="text-[11px] opacity-50">Library is empty. Edit a material and choose “Save to library”.</p>
                    {/each}
                  </div>
                {/if}
              </div>

            {:else if s.id === 'texts'}
              <div class="flex flex-col gap-2 w-full">
                {#each currentPattern.texts as t (t.id)}
                  <div class="rounded-md border border-base-300 p-2 space-y-1">
                    <div class="flex items-center gap-1">
                      <input type="text" class="input input-bordered input-xs flex-1" value={t.value} placeholder="Text…"
                        oninput={(e) => updateText(t.id, { value: e.currentTarget.value })} />
                      <button class="btn btn-ghost btn-xs p-1 text-error" title="Delete text" aria-label="Delete text" onclick={() => removeText(t.id)}><span class="material-symbols-rounded text-base">delete</span></button>
                    </div>
                    <div class="grid grid-cols-3 gap-1">
                      <label class="flex flex-col gap-0.5 text-[11px]">Size (mm)
                        <input type="number" min="1" step="1" class="input input-bordered input-xs" value={t.fontSize ?? 15} oninput={(e) => updateText(t.id, { fontSize: parseFloat(e.currentTarget.value) || 15 })} /></label>
                      <label class="flex flex-col gap-0.5 text-[11px]">Angle (°)
                        <input type="number" step="1" class="input input-bordered input-xs" value={t.rotation ?? 0} oninput={(e) => updateText(t.id, { rotation: parseFloat(e.currentTarget.value) || 0 })} /></label>
                      <label class="flex flex-col gap-0.5 text-[11px]">Color
                        <input type="color" class="w-full h-6 rounded border" value={t.color ?? '#1e293b'} oninput={(e) => updateText(t.id, { color: e.currentTarget.value })} /></label>
                    </div>
                    <div class="grid grid-cols-2 gap-1">
                      <label class="flex flex-col gap-0.5 text-[11px]">Align
                        <select class="select select-bordered select-xs" value={t.align ?? 'center'} onchange={(e) => updateText(t.id, { align: e.currentTarget.value as 'left' | 'center' | 'right' })}>
                          <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
                      <label class="flex flex-col gap-0.5 text-[11px]">Layer
                        <select class="select select-bordered select-xs" value={t.layerId ?? 'default'} onchange={(e) => updateText(t.id, { layerId: e.currentTarget.value })}>
                          {#each currentPattern.layers as l (l.id)}<option value={l.id}>{l.name}</option>{/each}</select></label>
                    </div>
                  </div>
                {:else}<p class="opacity-60">No text yet. Use the Text tool (I) to place text on the canvas.</p>{/each}
              </div>

            {:else if s.id === 'images'}
              <div class="flex flex-col gap-2 w-full">
                {#each currentPattern.images as im (im.id)}
                  <div class="rounded-md border border-base-300 p-2 space-y-1">
                    <div class="flex items-center gap-2">
                      <div class="w-10 h-10 rounded border border-base-300 shrink-0 bg-base-200" style={`background-image:url('${im.url}');background-size:cover;background-position:center`}></div>
                      <div class="grid grid-cols-2 gap-1 flex-1">
                        <label class="flex flex-col gap-0.5 text-[11px]">Width (mm)
                          <input type="number" min="1" step="1" class="input input-bordered input-xs" value={(im.width ?? 100).toFixed(0)} oninput={(e) => onchange(imageUpdate(currentPattern, im.id, { width: parseFloat(e.currentTarget.value) || 100 }), 'Resize image')} /></label>
                        <label class="flex flex-col gap-0.5 text-[11px]">Height (mm)
                          <input type="number" min="1" step="1" class="input input-bordered input-xs" value={(im.height ?? 100).toFixed(0)} oninput={(e) => onchange(imageUpdate(currentPattern, im.id, { height: parseFloat(e.currentTarget.value) || 100 }), 'Resize image')} /></label>
                      </div>
                      <button class="btn btn-ghost btn-xs p-1 text-error" title="Delete image" aria-label="Delete image" onclick={() => removeImage(im.id)}><span class="material-symbols-rounded text-base">delete</span></button>
                    </div>
                    <div class="grid grid-cols-2 gap-1">
                      <label class="flex flex-col gap-0.5 text-[11px]">Angle (°)
                        <input type="number" step="1" class="input input-bordered input-xs" value={im.rotation ?? 0} oninput={(e) => updateImage(im.id, { rotation: parseFloat(e.currentTarget.value) || 0 })} /></label>
                      <label class="flex flex-col gap-0.5 text-[11px]">Opacity
                        <input type="range" min="0" max="1" step="0.05" class="range range-xs" value={im.opacity ?? 1} oninput={(e) => updateImage(im.id, { opacity: parseFloat(e.currentTarget.value) })} /></label>
                    </div>
                    <div class="grid grid-cols-2 gap-1 items-center">
                      <label class="flex items-center gap-1 text-[11px]"><input type="checkbox" class="checkbox checkbox-xs" checked={(im.lockAspect as boolean) ?? false} onchange={(e) => updateImage(im.id, { lockAspect: e.currentTarget.checked } as Partial<Img>)} /> Lock aspect</label>
                      <label class="flex items-center gap-1 text-[11px]"><input type="checkbox" class="checkbox checkbox-xs" checked={(im.locked as boolean) ?? false} onchange={(e) => updateImage(im.id, { locked: e.currentTarget.checked } as Partial<Img>)} /> Lock (no drag)</label>
                      <label class="flex flex-col gap-0.5 text-[11px] col-span-2">Layer
                        <select class="select select-bordered select-xs" value={im.layerId ?? 'default'} onchange={(e) => updateImage(im.id, { layerId: e.currentTarget.value })}>
                          {#each currentPattern.layers as l (l.id)}<option value={l.id}>{l.name}</option>{/each}</select></label>
                    </div>
                  </div>
                {:else}<p class="opacity-60">No images. Use the Image tool (G) to place a reference image or logo.</p>{/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

{#if formulaVarId}
  {@const fv = currentPattern.variables.find((v) => v.id === formulaVarId)}
  <FormulaDialog
    formula={fv?.valueFormula?.formula ?? String(fv?.value ?? '')}
    variables={formulaScope}
    categories={formulaCategories}
    onsave={(f, val) => { if (formulaVarId) updateVariable(formulaVarId, { valueFormula: { ...(fv?.valueFormula ?? { formula: '', unit: 'none' }), formula: f }, value: val ?? fv?.value ?? 0 }); formulaVarId = null; }}
    oncancel={() => (formulaVarId = null)}
  />
{/if}
