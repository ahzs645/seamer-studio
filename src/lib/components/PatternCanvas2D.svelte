<script lang="ts">
  import { base as pathsBase } from '$app/paths';
  import { onMount, untrack } from 'svelte';
  import type { Editor } from '@atelier/core';
  import { editorState } from '@atelier/svelte';
  import {
    EMPTY_SEAM_TOOL,
    advanceSeamToolPhase,
    applySeamPick,
    breakoutPiece,
    deletePiece as deletePieceCascade,
    layerDashPattern,
    layerStrokeColor,
    pieceAddPath,
    piecePointAdd,
    piecePointUpdate,
    samePick,
    type BreakoutMode,
    type LayerStyle,
    type Measurement,
    type Pattern,
    type Piece,
    type SeamPick
  } from '@seamer/pattern-model';
  import { buildSilhouette, type Silhouette } from '@seamer/avatar';
  import { isDarkTheme, onThemeChange } from '$lib/utils/theme';
  import DrawingTools from '$lib/components/DrawingTools.svelte';
  import ContextMenu, { type MenuItem } from '$lib/components/ContextMenu.svelte';
  import { toast } from '$lib/stores/toast';
  import { selectedTool, zoom, panOffset, selectedSeamId, seamTool, pathPickRequest, cursorMm, interactionMode, frozenSnapshotOpacity, pendingPaste, type PendingPaste } from '$lib/stores/pattern';
  import {
    indexPoints,
    indexPaths,
    pathPolyline,
    pieceWorldInternalPolylines,
    pieceTransform,
    pieceShrinkageScale,
    pieceInverseTransform,
    pieceCutCounts,
    piecePathPolyline,
    placedPoints,
    allSeamGeometry,
    seamColor,
    notchRatio,
    pieceMirrorAxis,
    reflectAcrossLine,
    resamplePolyline,
    polygonCentroid,
    pointInPolygon,
    offsetPolygon,
    pieceAllowancePolygon,
    type Vec2,
    type PlacedPoint
  } from '@seamer/pattern-model';
  import * as ops from '@seamer/pattern-model/utils/pathPointOps';
  import { traceFromHPGL, traceImageRegion } from '$lib/utils/autoTrace';
  import { draggablePanel } from '$lib/utils/draggablePanel';
  import { rebakeArc, arcPathsCenteredOn, detachArcsTouchingAnchor } from '@seamer/pattern-model/utils/arcParametric';
  import { buildWarp, drawWarpedImage } from '$lib/utils/thinPlateSpline';
  import { explicitBoundaryMirrorAxis, pieceDisplayEdgePolylines, pieceDisplayOutline } from '$lib/utils/patternCanvasGeometry';
  import { loadImageFromCandidates, textureUrlCandidates } from '$lib/scene/textureUrl';

  interface Props {
    currentPattern: Pattern;
    editor: Editor<Pattern>;
    onchange: (p: Pattern, label?: string) => void;
  }

  let { currentPattern, editor, onchange }: Props = $props();
  // svelte-ignore state_referenced_locally -- parent keys this component by Editor identity
  const editorView = editorState(editor);
  const pointIds = $derived(editorView.selection.get('point'));
  const pathIds = $derived(editorView.selection.get('path'));
  const pieceIds = $derived(editorView.selection.get('piece'));
  const setPointIds = (ids: Iterable<string>) => editor.setSelection(editor.selection.replace('point', ids));
  const setPathIds = (ids: Iterable<string>) => editor.setSelection(editor.selection.replace('path', ids));
  const setPieceIds = (ids: Iterable<string>) => editor.setSelection(editor.selection.replace('piece', ids));

  let canvasEl: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = $state(null);
  let isDark = $state(false); // follows the app theme (utils/theme); themes the canvas bg/grid
  let canvasW = $state(800);
  let canvasH = $state(600);
  let isPanning = $state(false);
  let isDragging = $state(false);
  let dragPointId: string | null = $state(null);
  let dragInvert: ((w: Vec2) => Vec2) | null = null;
  let dragStartWorld: Vec2 | null = null;
  // interactive bezier-handle drag (on the selected edge's anchor points)
  let dragHandle: { pathId: string; pointId: string; which: 'v1' | 'v2'; invert: (w: Vec2) => Vec2; anchor: Vec2 } | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let currentZoom = $state(1);
  let currentPanX = $state(0);
  let currentPanY = $state(0);
  let hoveredPointId: string | null = $state(null);
  let cursorPos = $state({ x: 0, y: 0 });
  let measureFrom: string | null = $state(null);
  let showSeams = $state(false); // manual "pin seams on" override; otherwise seams show with the seam tool
  let showBody = $state(true);

  // Background reference image to trace over (local file; not persisted). Placed in world mm, centred
  // on (bgX, bgY), `bgWidthMm` wide (height keeps aspect), drawn behind the pattern at `bgOpacity`.
  let bgImage = $state<HTMLImageElement | null>(null);
  let bgUrl: string | null = null;
  let showBgControls = $state(false);
  let bgOpacity = $state(0.5);
  let bgWidthMm = $state(300);
  let bgX = $state(0);
  let bgY = $state(0);
  function loadBgImage(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (bgUrl) URL.revokeObjectURL(bgUrl);
    bgUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { bgImage = img; render(); };
    img.src = bgUrl;
  }
  function clearBgImage() {
    if (bgUrl) { URL.revokeObjectURL(bgUrl); bgUrl = null; }
    bgImage = null;
    bgBrightness = 0; bgContrast = 0; bgGrayscale = false; bgThreshold = null;
    matchPairs = []; warpEnabled = false; calibrating = null;
    processedCacheKey = ''; warpedKey = '';
    render();
  }

  // ---- Scan digitization: image filters + match-point calibration (TPS warp) ---------------------
  let bgBrightness = $state(0); // -100..100
  let bgContrast = $state(0); // -100..100
  let bgGrayscale = $state(false);
  let bgThreshold = $state<number | null>(null); // null = off; else 0..255 luminance cut
  /** match-point pairs: a feature on the scan (image px) and its true drafting location (world mm) */
  let matchPairs = $state<{ srcPx: Vec2; dst: Vec2 }[]>([]);
  let warpEnabled = $state(false);
  /** armed calibration: first click marks the image feature, second its true world position */
  let calibrating = $state<{ src: Vec2 | null } | null>(null);

  const bgMmPerPx = () => (bgImage ? bgWidthMm / bgImage.naturalWidth : 1);
  function imgPxToWorld(px: Vec2): Vec2 {
    const s = bgMmPerPx(), W = bgImage!.naturalWidth, H = bgImage!.naturalHeight;
    return { x: bgX + (px.x - W / 2) * s, y: bgY + (H / 2 - px.y) * s };
  }
  function worldToImgPx(w: Vec2): Vec2 {
    const s = bgMmPerPx(), W = bgImage!.naturalWidth, H = bgImage!.naturalHeight;
    return { x: (w.x - bgX) / s + W / 2, y: H / 2 - (w.y - bgY) / s };
  }

  // filtered copy of the scan (brightness/contrast/grayscale/threshold), rebuilt only on change
  let processedCache: HTMLCanvasElement | null = null;
  let processedCacheKey = '';
  const hasBgFilters = () => bgBrightness !== 0 || bgContrast !== 0 || bgGrayscale || bgThreshold != null;
  function processedImage(): HTMLCanvasElement | HTMLImageElement | null {
    if (!bgImage || bgImage.naturalWidth === 0) return bgImage;
    if (!hasBgFilters()) return bgImage;
    const key = `${bgImage.src.length}:${bgImage.naturalWidth}:${bgBrightness}:${bgContrast}:${bgGrayscale}:${bgThreshold}`;
    if (processedCache && processedCacheKey === key) return processedCache;
    const W = bgImage.naturalWidth, H = bgImage.naturalHeight;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const c2 = off.getContext('2d', { willReadFrequently: true });
    if (!c2) return bgImage;
    c2.drawImage(bgImage, 0, 0);
    const data = c2.getImageData(0, 0, W, H);
    const px = data.data;
    const bright = bgBrightness * 1.275;
    const cval = bgContrast * 2.55;
    const cf = (259 * (cval + 255)) / (255 * (259 - cval));
    for (let i = 0; i < px.length; i += 4) {
      let r: number = px[i], g: number = px[i + 1], b: number = px[i + 2];
      if (bright !== 0) { r += bright; g += bright; b += bright; }
      if (bgContrast !== 0) { r = cf * (r - 128) + 128; g = cf * (g - 128) + 128; b = cf * (b - 128) + 128; }
      if (bgGrayscale || bgThreshold != null) {
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (bgThreshold != null) { const v = lum < bgThreshold ? 0 : 255; r = v; g = v; b = v; }
        else { r = lum; g = lum; b = lum; }
      }
      px[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      px[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      px[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    c2.putImageData(data, 0, 0);
    processedCache = off;
    processedCacheKey = key;
    return off;
  }

  // TPS-warped scan rendered to a world-space offscreen (drawn like a flat image afterwards)
  let warpedCache: { canvas: HTMLCanvasElement; minX: number; maxY: number; pxPerMm: number } | null = null;
  let warpedKey = '';
  function ensureWarped(): typeof warpedCache {
    if (!bgImage || bgImage.naturalWidth === 0 || matchPairs.length === 0) return null;
    const key = JSON.stringify([matchPairs, bgX, bgY, bgWidthMm, bgBrightness, bgContrast, bgGrayscale, bgThreshold, bgImage.src.length]);
    if (warpedCache && warpedKey === key) return warpedCache;
    const warp = buildWarp(matchPairs.map((q) => ({ src: imgPxToWorld(q.srcPx), dst: q.dst })));
    const W = bgImage.naturalWidth, H = bgImage.naturalHeight;
    const grid = 24;
    const mapWorld = (p: Vec2) => warp(imgPxToWorld(p));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let gy = 0; gy <= grid; gy++) for (let gx = 0; gx <= grid; gx++) {
      const w = mapWorld({ x: (gx / grid) * W, y: (gy / grid) * H });
      minX = Math.min(minX, w.x); maxX = Math.max(maxX, w.x);
      minY = Math.min(minY, w.y); maxY = Math.max(maxY, w.y);
    }
    const wMm = Math.max(1, maxX - minX), hMm = Math.max(1, maxY - minY);
    const pxPerMm = Math.min(3, 3000 / Math.max(wMm, hMm));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(wMm * pxPerMm));
    canvas.height = Math.max(1, Math.ceil(hMm * pxPerMm));
    const c2 = canvas.getContext('2d', { willReadFrequently: true });
    const src = processedImage() ?? bgImage;
    if (c2 && src) {
      drawWarpedImage(c2, src, W, H, (p) => {
        const w = mapWorld(p);
        return { x: (w.x - minX) * pxPerMm, y: (maxY - w.y) * pxPerMm };
      }, grid);
    }
    warpedCache = { canvas, minX, maxY, pxPerMm };
    warpedKey = key;
    return warpedCache;
  }

  /** Calibration pins: image feature (red dot) → true position (green cross), dashed connector. */
  function drawMatchPins(c: CanvasRenderingContext2D) {
    if (!bgImage || (!showBgControls && !calibrating)) return;
    c.save();
    for (const pair of matchPairs) {
      const a = toCanvas(imgPxToWorld(pair.srcPx));
      const b = toCanvas(pair.dst);
      c.strokeStyle = '#94a3b8';
      c.setLineDash([4, 3]);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      c.setLineDash([]);
      c.fillStyle = '#dc2626';
      c.beginPath(); c.arc(a.x, a.y, 4, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#16a34a';
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(b.x - 5, b.y); c.lineTo(b.x + 5, b.y); c.moveTo(b.x, b.y - 5); c.lineTo(b.x, b.y + 5); c.stroke();
      c.lineWidth = 1;
    }
    if (calibrating?.src) {
      const a = toCanvas(imgPxToWorld(calibrating.src));
      c.fillStyle = '#dc2626';
      c.beginPath(); c.arc(a.x, a.y, 4, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#dc2626';
      c.setLineDash([4, 3]);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(cursorPos.x, cursorPos.y); c.stroke();
      c.setLineDash([]);
    }
    c.restore();
  }
  // HPGL (plotter) vector overlay — parsed to polylines (mm), drawn offset by (bgX, bgY).
  let hpglPolys = $state<Vec2[][] | null>(null);
  async function loadHpgl(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    const { parseHPGL } = await import('@atelier/io');
    hpglPolys = parseHPGL(await file.text());
    render();
  }
  function clearHpgl() { hpglPolys = null; render(); }

  // Frozen snapshot — a saved copy of the geometry (points/paths/pieces) rendered as a
  // non-interactive ghost under the live pattern, for before/after reference while editing.
  // Stored on the pattern (pattern.frozenSnapshot) so it survives reload and is undoable;
  // the ghost opacity is a persisted view setting.
  type FrozenGeometry = { points: Pattern['points']; paths: Pattern['paths']; pieces: Pattern['pieces'] };
  let showSnapshotControls = $state(false);
  const frozenGeometry = $derived.by<FrozenGeometry | null>(() => {
    const fs = currentPattern.frozenSnapshot as Partial<FrozenGeometry> | null;
    if (!fs || !Array.isArray(fs.points)) return null;
    return { points: fs.points, paths: fs.paths ?? [], pieces: fs.pieces ?? [] };
  });
  function freezeSnapshot() {
    const p = $state.snapshot(currentPattern) as Pattern;
    onchange({ ...p, frozenSnapshot: { points: p.points, paths: p.paths, pieces: p.pieces }, hasChanged: true }, 'Freeze snapshot');
    toast('Snapshot frozen as reference.', 'success');
  }
  function removeFrozenSnapshot() {
    onchange({ ...($state.snapshot(currentPattern) as Pattern), frozenSnapshot: null, hasChanged: true }, 'Remove frozen snapshot');
    toast('Removed frozen snapshot');
  }
  /** Ghost of the frozen snapshot, drawn under the live pattern (never hit-tested). */
  function drawFrozenSnapshot(c: CanvasRenderingContext2D) {
    const fs = frozenGeometry;
    if (!fs) return;
    const ghost = { ...currentPattern, points: fs.points, paths: fs.paths, pieces: fs.pieces } as Pattern;
    const gPaths = indexPaths(ghost);
    const gPoints = indexPoints(ghost);
    c.save();
    c.globalAlpha = Math.max(0, Math.min(1, $frozenSnapshotOpacity));
    c.strokeStyle = isDark ? '#94a3b8' : '#64748b';
    c.lineWidth = 1.5;
    c.setLineDash([]);
    const drawn = new Set<string>();
    for (const piece of ghost.pieces) {
      const outline = pieceDisplayOutline(ghost, piece, gPaths, gPoints, 4);
      if (outline.length < 2) continue;
      tracePoly(c, outline, true);
      c.stroke();
      c.setLineDash([4, 3]);
      for (const ip of pieceWorldInternalPolylines(ghost, piece, gPaths, gPoints, 4)) { tracePoly(c, ip, false); c.stroke(); }
      c.setLineDash([]);
      for (const pp of [...piece.mainPaths, ...piece.internalPaths]) drawn.add(pp.path);
    }
    for (const path of ghost.paths) {
      if (drawn.has(path.id)) continue;
      tracePoly(c, pathPolyline(path, gPoints, 4), false);
      c.stroke();
    }
    c.restore();
  }

  const isSeamToolActive = () => $selectedTool === 'seam' || $selectedTool === 'seam-single' || $selectedTool === 'seam-multi';
  // pen / create-piece in-progress point ids
  let penDraft = $state<string[]>([]);
  let draftPathId: string | null = null;
  // seam tool: first picked piece-path edge (single) / accumulated edges (multi)
  // Seam tool selection lives in the shared `seamTool` store (the 3D viewport picks edges into the
  // same selection). Locals mirror it for rendering; hover is canvas-local.
  let seamFromPicks = $state<SeamPick[]>([]);
  let seamToPicks = $state<SeamPick[]>([]);
  let seamPhase = $state<'from' | 'to'>('from');
  let seamHover = $state<SeamPick | null>(null);
  let contextMenu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  // marquee (rubber-band) selection
  let isMarquee = $state(false);
  let marqueeStart = { x: 0, y: 0 };
  let marqueeCur = $state({ x: 0, y: 0 });
  // multi-point drag: original drafting-space positions + the primary point's transform
  let dragDraftStart: Vec2 | null = null;
  let multiDrag: { id: string; x: number; y: number }[] | null = null;
  // dragged point's drafting-space position at drag start — Shift angle snapping pivots on it
  let dragOrigDraft: Vec2 | null = null;
  // arc/circle tools: accumulated world-space clicks
  let arcClicks = $state<Vec2[]>([]);
  // pen drag-for-curve
  let penDragging = false;
  let penDragPointId: string | null = null;
  let silhouette: Silhouette | null = null;
  let silhouetteKey = '';
  let mounted = false;
  // local view center (world point shown at canvas center); never mutate the pattern prop.
  let viewOffset = $state({ x: 0, y: 0 });

  // The source Studio uses a coarse ten-inch drafting grid. A one-inch grid turns into visual
  // noise as soon as the whole front/back layout is fitted into view.
  const GRID_DRAW_MM = 254; // 10 inches
  const GRID_SNAP_MM = 25.4; // retain one-inch editing precision
  const POINT_RADIUS = 4;
  const HOVER_THRESHOLD = 12;
  const SELECT_BLUE = '#2563eb';
  const GRAIN_MAGENTA = '#e11d8f';
  const PATH_MAGENTA = '#ff50cf'; // sewn-edge colour, matching the source 2D editor

  // ---- fabric textures ------------------------------------------------------
  // Material front textures are remote media URLs; we serve a local copy by
  // basename under /textures and tile it in world-mm space on the piece fill.
  const texImages = new Map<string, HTMLImageElement>(); // url -> loaded image
  function textureFor(url: string | undefined | null): HTMLImageElement | null {
    if (!url) return null;
    if (texImages.has(url)) {
      const img = texImages.get(url)!;
      return img.complete && img.naturalWidth > 0 ? img : null;
    }
    const img = new Image();
    img.onload = () => render();
    img.crossOrigin = 'anonymous';
    loadImageFromCandidates(img, textureUrlCandidates(url, pathsBase));
    texImages.set(url, img);
    return null;
  }
  function materialOf(id: string) {
    const mats = currentPattern.materials ?? [];
    return mats.find((m) => m.id === id) ?? mats[0] ?? null;
  }

  // ---- layers: visibility / lock --------------------------------------------
  function layerOf(layerId?: string) {
    return (currentPattern.layers ?? []).find((l) => l.id === (layerId ?? 'default'));
  }
  const layerVisible = (layerId?: string) => layerOf(layerId)?.visible ?? true;
  const layerLocked = (layerId?: string) => layerOf(layerId)?.locked ?? false;

  /** A fabric-tiled CanvasPattern — anchored at the PIECE ORIGIN and rotated so the print follows
   *  the piece's grain (the original's fillWithMaterial DOMMatrix) — or a flat color fallback. */
  function pieceFill(
    c: CanvasRenderingContext2D,
    material: ReturnType<typeof materialOf>,
    piece?: Piece,
    points?: Map<string, import('@seamer/pattern-model').ConstrainablePoint>
  ): string | CanvasPattern {
    const tex = material?.frontTexture;
    if (currentPattern.show2dTextures === false) return tex?.color || 'rgba(148,163,184,0.16)';
    const img = tex ? textureFor(tex.url) : null;
    if (img && tex) {
      const pat = c.createPattern(img, 'repeat');
      if (pat) {
        const mm = tex.scale && tex.scale > 0 ? tex.scale : 100;
        const f = (mm * baseScale()) / img.naturalWidth;
        if (piece && points) {
          const tfp = pieceTransform(piece, points, pieceShrinkageScale(currentPattern, piece));
          const op = points.get(piece.originPoint);
          const o0 = { x: op?.x ?? 0, y: op?.y ?? 0 };
          const oc = toCanvas(tfp(o0));
          // world grain direction mapped through the piece transform, measured in canvas space
          const g = piece.grainVector;
          const gc = toCanvas(tfp({ x: o0.x + g.x, y: o0.y + g.y }));
          const ang = (Math.atan2(gc.y - oc.y, gc.x - oc.x) * 180) / Math.PI;
          // the image's vertical (canvas -y, angle -90°) follows the grain: rotate by ang + 90
          pat.setTransform(new DOMMatrix().translateSelf(oc.x, oc.y).rotateSelf(ang + 90).scaleSelf(f));
        } else {
          const o = toCanvas({ x: 0, y: 0 });
          pat.setTransform(new DOMMatrix([f, 0, 0, f, o.x, o.y]));
        }
        return pat;
      }
    }
    return tex?.color || 'rgba(148,163,184,0.16)';
  }

  function fmtLen(mm: number): string {
    const u = currentPattern.lengthUnit;
    const v = u === 'inch' ? mm / 25.4 : u === 'cm' ? mm / 10 : mm;
    return `${v.toFixed(1)} ${u}`;
  }

  function polyLen(poly: Vec2[]): number {
    let s = 0;
    for (let i = 1; i < poly.length; i++) s += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
    return s;
  }

  /** Rounded pill name tag for a piece (matches the source's centred badge). */
  function pieceNameChip(c: CanvasRenderingContext2D, text: string, x: number, y: number) {
    c.font = '600 12px "Noto Sans", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const w = c.measureText(text).width + 16;
    const h = 19;
    const rx = x - w / 2, ry = y - h / 2, r = 6;
    c.beginPath();
    c.moveTo(rx + r, ry);
    c.arcTo(rx + w, ry, rx + w, ry + h, r);
    c.arcTo(rx + w, ry + h, rx, ry + h, r);
    c.arcTo(rx, ry + h, rx, ry, r);
    c.arcTo(rx, ry, rx + w, ry, r);
    c.closePath();
    c.fillStyle = 'rgba(248,250,252,0.92)';
    c.fill();
    c.strokeStyle = 'rgba(100,116,139,0.35)';
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = '#334155';
    c.fillText(text, x, y + 0.5);
    c.textAlign = 'start';
    c.textBaseline = 'alphabetic';
  }

  function labelChip(c: CanvasRenderingContext2D, text: string, x: number, y: number, fg = '#be185d', bg = 'rgba(255,255,255,0.85)') {
    c.font = '10px sans-serif';
    c.textAlign = 'center';
    const w = c.measureText(text).width;
    c.fillStyle = bg;
    c.fillRect(x - w / 2 - 3, y - 7, w + 6, 13);
    c.fillStyle = fg;
    c.fillText(text, x, y + 2);
    c.textAlign = 'start';
  }

  /** Length label at the midpoint of each main edge of a (selected) piece. */
  /**
   * Draw the single selected boundary edge the way the source does when you click a line:
   * highlight it magenta with a direction arrow + length label, and show salmon bezier
   * tangent handles on its anchor points.
   */
  function drawSelectedEdge(
    c: CanvasRenderingContext2D,
    paths: ReturnType<typeof indexPaths>,
    points: ReturnType<typeof indexPoints>
  ) {
    // the selected edge = the (selected) piece's path matching the single selected ConstrainablePath
    if (pathIds.size !== 1) return;
    const pathId = [...pathIds][0];
    let owner: { piece: Piece; pp: import('@seamer/pattern-model').PiecePath } | null = null;
    for (const piece of currentPattern.pieces) {
      if (piece.hidden) continue;
      if (pieceIds.size > 0 && !pieceIds.has(piece.id)) continue;
      const pp = [...piece.mainPaths, ...piece.internalPaths].find((x) => x.path === pathId);
      if (pp) { owner = { piece, pp }; break; }
    }
    if (!owner) return;
    const tf = pieceTransform(owner.piece, points, pieceShrinkageScale(currentPattern, owner.piece));
    const poly = piecePathPolyline(owner.pp, paths, points, 4).map(tf);
    if (poly.length < 2) return;

    // highlighted edge
    c.strokeStyle = PATH_MAGENTA;
    c.lineWidth = 2.5;
    tracePoly(c, poly, false);
    c.stroke();

    // direction arrow at the midpoint
    const mi = Math.floor(poly.length / 2);
    const m0 = toCanvas(poly[Math.max(0, mi - 1)]);
    const m1 = toCanvas(poly[Math.min(poly.length - 1, mi + 1)]);
    const ang = Math.atan2(m1.y - m0.y, m1.x - m0.x);
    const mc = toCanvas(poly[mi]);
    c.fillStyle = PATH_MAGENTA;
    c.beginPath();
    c.moveTo(mc.x, mc.y);
    c.lineTo(mc.x - 8 * Math.cos(ang - 0.4), mc.y - 8 * Math.sin(ang - 0.4));
    c.lineTo(mc.x - 8 * Math.cos(ang + 0.4), mc.y - 8 * Math.sin(ang + 0.4));
    c.closePath(); c.fill();

    // length label
    labelChip(c, fmtLen(polyLen(poly)), mc.x + 12, mc.y);

    // green anchor endpoints + salmon bezier handles
    const path = paths.get(owner.pp.path);
    if (path) {
      const salmon = '#fb7185';
      for (const ap of path.pathPoints) {
        const anchor = points.get(ap.id);
        if (!anchor) continue;
        const aw = toCanvas(tf(anchor));
        c.beginPath(); c.arc(aw.x, aw.y, 4, 0, Math.PI * 2); c.fillStyle = '#22c55e'; c.fill();
        if (!ap.handle) continue;
        for (const v of [ap.handle.v1, ap.handle.v2]) {
          if (!v || (v.x === 0 && v.y === 0)) continue;
          const hw = toCanvas(tf({ x: anchor.x + v.x, y: anchor.y + v.y }));
          c.strokeStyle = salmon; c.lineWidth = 1;
          c.beginPath(); c.moveTo(aw.x, aw.y); c.lineTo(hw.x, hw.y); c.stroke();
          c.beginPath(); c.arc(hw.x, hw.y, 3.5, 0, Math.PI * 2); c.fillStyle = salmon; c.fill();
        }
      }
    }
  }

  /** (Re)build the real avatar silhouette raster when the body changes. */
  async function ensureSilhouette() {
    const b = currentPattern.body;
    const key = JSON.stringify({ g: b.gender, u: b.unitType, f: b.fields });
    if (key === silhouetteKey) return;
    silhouetteKey = key;
    try {
      const s = await buildSilhouette(b);
      if (s && silhouetteKey === key) { silhouette = s; render(); }
    } catch { /* assets unavailable — skip the silhouette */ }
  }

  /**
   * Blit the avatar silhouette behind the pieces. True scale, centred on the x=0 draft
   * axis, vertically centred on the spread of pieces (decorative reference, as in the source).
   */
  function drawSilhouette(c: CanvasRenderingContext2D, piecesMinY: number, piecesMaxY: number) {
    const s = silhouette;
    if (!s) return;
    const offY = (piecesMinY + piecesMaxY) / 2 - (s.minY + s.maxY) / 2;
    const tl = toCanvas({ x: s.minX, y: s.maxY + offY }); // world maxY -> canvas top
    const br = toCanvas({ x: s.maxX, y: s.minY + offY });
    const w = br.x - tl.x, h = br.y - tl.y;
    if (w <= 0 || h <= 0) return;
    c.save();
    c.globalAlpha = 0.35;
    c.drawImage(s.canvas, tl.x, tl.y, w, h);
    c.restore();
  }

  onMount(() => {
    mounted = true;
    ctx = canvasEl.getContext('2d');
    const observer = new ResizeObserver(() => {
      const nextW = Math.max(1, Math.round(canvasEl.clientWidth));
      const nextH = Math.max(1, Math.round(canvasEl.clientHeight));
      if (nextW === canvasW && nextH === canvasH) return;
      canvasW = nextW;
      canvasH = nextH;
      canvasEl.width = canvasW;
      canvasEl.height = canvasH;
      // Split/2D mode and the inspector change the available canvas after the pattern effect has
      // already run. Refit to the final viewport, like the legacy Studio, instead of retaining the
      // zoom calculated for the narrow initial column.
      if (currentPattern.points.length > 0 || currentPattern.pieces.length > 0) fitView();
      else render();
    });
    if (canvasEl.parentElement) observer.observe(canvasEl.parentElement);
    const unsubZoom = zoom.subscribe((v) => { currentZoom = v; render(); });
    const unsubPan = panOffset.subscribe((v) => { currentPanX = v.x; currentPanY = v.y; render(); });
    const unsubTool = selectedTool.subscribe(() => render());
    const unsubSelSeam = selectedSeamId.subscribe(() => render());
    // mirror the shared seam-tool selection (2D + 3D picks) into the render locals
    const unsubSeamTool = seamTool.subscribe((s) => {
      seamFromPicks = s.from; seamToPicks = s.to; seamPhase = s.phase;
      render();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const drawing = isDrawingTool($selectedTool);
      if (e.key === 'Enter') {
        if (penDraft.length > 0) { e.preventDefault(); finishDraft(); }
        else if ($selectedTool === 'seam-multi' && (seamFromPicks.length || seamToPicks.length)) { e.preventDefault(); advanceSeamPhase(); }
      } else if (e.key === 'Escape') {
        if ($pathPickRequest) { e.preventDefault(); pathPickRequest.set(null); render(); return; }
        if (calibrating) { e.preventDefault(); calibrating = null; render(); return; }
        if ($pendingPaste) { e.preventDefault(); pendingPaste.set(null); render(); return; }
        if (penDraft.length || seamFromPicks.length || seamToPicks.length || measureFrom || measureChain.length || drawing) { e.preventDefault(); cancelOperation(); }
      } else if ((e.key === 'v' || e.key === 'V') && drawing && !e.metaKey && !e.ctrlKey) {
        // 'V' returns to select and cancels the in-progress operation (like the source)
        e.preventDefault(); cancelOperation();
      } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault(); fitView(); render();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === '-' || e.key === '=' || e.key === '+')) {
        e.preventDefault();
        const f = e.key === '-' ? 1 / 1.25 : 1.25;
        zoom.update((z) => Math.max(0.05, Math.min(20, z * f)));
      }
    };
    window.addEventListener('keydown', onKey);
    isDark = isDarkTheme();
    const unsubTheme = onThemeChange(() => { isDark = isDarkTheme(); render(); });
    render();
    return () => {
      mounted = false;
      observer.disconnect();
      unsubZoom();
      unsubPan();
      unsubTool();
      unsubSelSeam();
      unsubSeamTool();
      unsubTheme();
      window.removeEventListener('keydown', onKey);
    };
  });

  // Repaint when immutable Editor selection identity changes, including picks driven by the 3D view.
  $effect(() => {
    void editorView.selection;
    untrack(() => render());
  });

  let lastFitKey = '';
  $effect(() => {
    const key = `${currentPattern.id}:${currentPattern.points.length}`;
    if (key !== lastFitKey) { lastFitKey = key; if (ctx) fitView(); }
    void currentPattern.body; // rebuild silhouette when measurements/gender change
    ensureSilhouette();
    void currentPattern;
    render();
  });

  function baseScale(): number { return currentPattern.graphicsScale * currentZoom; }

  function toCanvas(pt: Vec2): Vec2 {
    const o = viewOffset;
    const s = baseScale();
    return {
      x: canvasW / 2 + (pt.x - o.x) * s + currentPanX,
      y: canvasH / 2 - (pt.y - o.y) * s + currentPanY
    };
  }

  function toPattern(cx: number, cy: number): Vec2 {
    const o = viewOffset;
    const s = baseScale();
    return {
      x: (cx - canvasW / 2 - currentPanX) / s + o.x,
      y: -(cy - canvasH / 2 - currentPanY) / s + o.y
    };
  }

  function fitView() {
    const placed = editorPlacedPoints(currentPattern);
    if (placed.length === 0) { zoom.set(1); panOffset.set({ x: 0, y: 0 }); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pp of placed) {
      const p = pp.world;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const paths = indexPaths(currentPattern);
    const points = indexPoints(currentPattern);
    for (const piece of currentPattern.pieces) {
      if (piece.hidden) continue;
      for (const p of pieceDisplayOutline(currentPattern, piece, paths, points, 4)) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const pad = 1.2;
    const sx = canvasW / (w * pad * currentPattern.graphicsScale);
    const sy = canvasH / (h * pad * currentPattern.graphicsScale);
    viewOffset = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    zoom.set(Math.max(0.05, Math.min(20, Math.min(sx, sy))));
    panOffset.set({ x: 0, y: 0 });
  }

  /**
   * The source editor shows the canonical drafting geometry as well as every placed piece copy.
   * pattern-model's placedPoints intentionally omits a raw point once a piece owns it, so add a
   * draft-space occurrence when none of its placed copies already occupies that coordinate.
   */
  function editorPlacedPoints(patternValue: Pattern, points = indexPoints(patternValue)): PlacedPoint[] {
    const out = placedPoints(patternValue, points);
    const occurrencesById = new Map<string, PlacedPoint[]>();
    for (const placedPoint of out) {
      const occurrences = occurrencesById.get(placedPoint.pointId) ?? [];
      occurrences.push(placedPoint);
      occurrencesById.set(placedPoint.pointId, occurrences);
    }
    for (const point of patternValue.points) {
      const occurrences = occurrencesById.get(point.id) ?? [];
      if (occurrences.length === 0 || occurrences.some((placedPoint) =>
        Math.hypot(placedPoint.world.x - point.x, placedPoint.world.y - point.y) < 0.05
      )) continue;
      out.push({ pointId: point.id, pieceId: '', world: { x: point.x, y: point.y }, invert: (world) => world });
    }
    return out;
  }

  function hitTestPlaced(cx: number, cy: number, threshold = HOVER_THRESHOLD): PlacedPoint | null {
    const pt = toPattern(cx, cy);
    const t = threshold / baseScale();
    const pts = indexPoints(currentPattern);
    let best: PlacedPoint | null = null;
    let bestDist = Infinity;
    for (const pp of editorPlacedPoints(currentPattern, pts)) {
      const lid = pts.get(pp.pointId)?.layerId;
      if (!layerVisible(lid) || layerLocked(lid)) continue; // can't pick hidden/locked-layer points
      const d = Math.hypot(pt.x - pp.world.x, pt.y - pp.world.y);
      if (d < t && d < bestDist) { bestDist = d; best = pp; }
    }
    return best;
  }

  function hitTestPoint(cx: number, cy: number, threshold = HOVER_THRESHOLD): string | null {
    return hitTestPlaced(cx, cy, threshold)?.pointId ?? null;
  }

  /**
   * Hit-test the salmon bezier-handle endpoints shown on the single selected edge (drawSelectedEdge).
   * Returns the handle to drag (with the owning piece's world→draft invert + the anchor's draft pos),
   * or null. Tested in canvas pixels since the handles are drawn at a fixed pixel radius.
   */
  function hitTestHandle(cx: number, cy: number, px = 9): { pathId: string; pointId: string; which: 'v1' | 'v2'; invert: (w: Vec2) => Vec2; anchor: Vec2 } | null {
    if (pathIds.size !== 1) return null;
    const pathId = [...pathIds][0];
    const points = indexPoints(currentPattern);
    let owner: { piece: Piece; pp: import('@seamer/pattern-model').PiecePath } | null = null;
    for (const piece of currentPattern.pieces) {
      if (piece.hidden) continue;
      if (pieceIds.size > 0 && !pieceIds.has(piece.id)) continue;
      const pp = [...piece.mainPaths, ...piece.internalPaths].find((x) => x.path === pathId);
      if (pp) { owner = { piece, pp }; break; }
    }
    if (!owner) return null;
    const path = currentPattern.paths.find((p) => p.id === pathId);
    if (!path) return null;
    const tf = pieceTransform(owner.piece, points, pieceShrinkageScale(currentPattern, owner.piece));
    const inv = pieceInverseTransform(owner.piece, points);
    let best: { pathId: string; pointId: string; which: 'v1' | 'v2'; invert: (w: Vec2) => Vec2; anchor: Vec2 } | null = null;
    let bestD = px;
    for (const ap of path.pathPoints) {
      const anchor = points.get(ap.id);
      if (!anchor || !ap.handle) continue;
      for (const which of ['v1', 'v2'] as const) {
        const v = ap.handle[which];
        if (!v || (v.x === 0 && v.y === 0)) continue;
        const hw = toCanvas(tf({ x: anchor.x + v.x, y: anchor.y + v.y }));
        const d = Math.hypot(cx - hw.x, cy - hw.y);
        if (d < bestD) { bestD = d; best = { pathId, pointId: ap.id, which, invert: inv, anchor: { x: anchor.x, y: anchor.y } }; }
      }
    }
    return best;
  }

  function tracePoly(c: CanvasRenderingContext2D, poly: Vec2[], close: boolean) {
    if (poly.length < 2) return;
    c.beginPath();
    const a = toCanvas(poly[0]);
    c.moveTo(a.x, a.y);
    for (let i = 1; i < poly.length; i++) {
      const p = toCanvas(poly[i]);
      c.lineTo(p.x, p.y);
    }
    if (close) c.closePath();
  }

  function render() {
    // Image/avatar promises may resolve after a keyed canvas has been destroyed. Bail out before
    // touching component-owned derived selections; Svelte correctly warns when stale effects read
    // those values after teardown.
    if (!mounted || !ctx) return;
    const c = ctx;
    c.clearRect(0, 0, canvasW, canvasH);
    c.fillStyle = isDark ? '#15191e' : '#fafafa';
    c.fillRect(0, 0, canvasW, canvasH);

    // background reference image (trace-over), behind the grid + pattern. Filters apply via the
    // processed copy; with match points + warp on, the TPS-warped world-space offscreen is drawn
    // instead (calibration mode shows the unwarped image so pins land on true image features).
    if (bgImage && bgImage.naturalWidth > 0) {
      c.save();
      c.globalAlpha = bgOpacity;
      c.imageSmoothingEnabled = true;
      const warped = warpEnabled && matchPairs.length > 0 && !calibrating ? ensureWarped() : null;
      if (warped) {
        const tl = toCanvas({ x: warped.minX, y: warped.maxY });
        c.drawImage(warped.canvas, tl.x, tl.y, (warped.canvas.width / warped.pxPerMm) * baseScale(), (warped.canvas.height / warped.pxPerMm) * baseScale());
      } else {
        const img = processedImage() ?? bgImage;
        const wPx = bgWidthMm * baseScale();
        const hPx = wPx * (bgImage.naturalHeight / bgImage.naturalWidth);
        const cc = toCanvas({ x: bgX, y: bgY });
        c.drawImage(img, cc.x - wPx / 2, cc.y - hPx / 2, wPx, hPx);
      }
      c.restore();
      drawMatchPins(c);
    }
    // placed image elements (reference photos / logos), behind the pattern geometry
    for (const im of currentPattern.images) {
      const img = textureFor(im.url);
      if (!img) continue;
      const layer = currentPattern.layers.find((l) => l.id === im.layerId);
      if (layer && !layer.visible) continue;
      const wPx = (im.width || 100) * baseScale();
      const hPx = (im.height || 100) * baseScale();
      const cc = toCanvas({ x: im.x, y: im.y });
      c.save();
      c.globalAlpha = im.opacity ?? 1;
      c.imageSmoothingEnabled = true;
      c.translate(cc.x, cc.y);
      if (im.rotation) c.rotate((im.rotation * Math.PI) / 180);
      c.drawImage(img, -wPx / 2, -hPx / 2, wPx, hPx);
      c.restore();
    }

    if (hpglPolys && hpglPolys.length) {
      c.save();
      c.globalAlpha = bgOpacity;
      c.strokeStyle = isDark ? '#7dd3fc' : '#0369a1';
      c.lineWidth = 1;
      for (const poly of hpglPolys) {
        if (poly.length < 2) continue;
        c.beginPath();
        for (let i = 0; i < poly.length; i++) {
          const cp = toCanvas({ x: poly[i].x + bgX, y: poly[i].y + bgY });
          if (i === 0) c.moveTo(cp.x, cp.y); else c.lineTo(cp.x, cp.y);
        }
        c.stroke();
      }
      c.restore();
    }

    if (currentPattern.showGrid) {
      const step = GRID_DRAW_MM * baseScale();
      if (step > 4) {
        const origin = toCanvas({ x: 0, y: 0 });
        const ox = ((origin.x % step) + step) % step;
        const oy = ((origin.y % step) + step) % step;
        c.strokeStyle = isDark ? '#252b33' : '#ececec';
        c.lineWidth = 0.5;
        for (let x = ox; x < canvasW; x += step) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, canvasH); c.stroke(); }
        for (let y = oy; y < canvasH; y += step) { c.beginPath(); c.moveTo(0, y); c.lineTo(canvasW, y); c.stroke(); }
      }
    }

    // frozen snapshot ghost — a non-interactive reference under the live pattern
    drawFrozenSnapshot(c);

    const paths = indexPaths(currentPattern);
    const points = indexPoints(currentPattern);
    const placed = editorPlacedPoints(currentPattern, points);
    const seamPP = new Set<string>();
    const seamPathColor = new Map<string, string>();
    for (const [seamIndex, seam] of currentPattern.seams.entries()) {
      for (const ref of [...seam.fromPaths, ...seam.toPaths]) {
        seamPP.add(ref.id);
        seamPathColor.set(ref.id, seamColor(seamIndex));
      }
    }

    // avatar silhouette behind the pieces (real projected body, centred on the x=0 draft axis)
    if (showBody && placed.length > 0) {
      let minY = Infinity, maxY = -Infinity;
      for (const pp of placed) { minY = Math.min(minY, pp.world.y); maxY = Math.max(maxY, pp.world.y); }
      drawSilhouette(c, minY, maxY);
    }

    for (const piece of currentPattern.pieces) {
      if (piece.hidden || !layerVisible(piece.layerId)) continue; // hidden piece or hidden layer
      const isSelected = pieceIds.has(piece.id);
      const outline = pieceDisplayOutline(currentPattern, piece, paths, points, 4);
      if (outline.length < 2) continue;

      const tf = pieceTransform(piece, points, pieceShrinkageScale(currentPattern, piece));

      if (isSelected) {
        // selected piece -> clean editable line-art (no fabric fill): each boundary edge
        // coloured by role — magenta = sewn edge, red dashed = mirror/fold line, black
        // dashed = free edge — matching the original 2D editor.
        c.fillStyle = 'rgba(255,255,255,0.55)';
        tracePoly(c, outline, true);
        c.fill();
        for (const pp of piece.mainPaths) {
          if (seamPP.has(pp.id)) { c.strokeStyle = seamPathColor.get(pp.id) ?? PATH_MAGENTA; c.lineWidth = 2; c.setLineDash([]); }
          else { c.strokeStyle = 'rgba(15,23,42,0.9)'; c.lineWidth = 1.5; c.setLineDash([6, 4]); }
          for (const edge of pieceDisplayEdgePolylines(currentPattern, piece, pp, paths, points, 4)) {
            tracePoly(c, edge, false);
            c.stroke();
          }
        }
        c.setLineDash([]);
        c.strokeStyle = '#1d4ed8';
        c.lineWidth = 1;
        c.setLineDash([5, 4]);
        for (const ip of pieceWorldInternalPolylines(currentPattern, piece, paths, points, 4)) {
          tracePoly(c, ip, false); c.stroke();
        }
        c.setLineDash([]);
      } else {
        // unselected -> fabric-textured fill, with every sewn edge retaining its seam colour.
        // The legacy editor keeps these pair colours visible even when the seam-rung overlay is
        // hidden, which makes the four-piece construction understandable at a glance.
        tracePoly(c, outline, true);
        c.fillStyle = pieceFill(c, materialOf(piece.materialId), piece, points);
        c.fill();
        for (const pp of piece.mainPaths) {
          if (seamPP.has(pp.id)) { c.strokeStyle = seamPathColor.get(pp.id) ?? PATH_MAGENTA; c.lineWidth = 2; c.setLineDash([]); }
          else { c.strokeStyle = 'rgba(30,41,59,0.85)'; c.lineWidth = 1.5; c.setLineDash([]); }
          for (const edge of pieceDisplayEdgePolylines(currentPattern, piece, pp, paths, points, 4)) {
            tracePoly(c, edge, false);
            c.stroke();
          }
        }
        c.strokeStyle = 'rgba(30,41,59,0.55)';
        c.lineWidth = 1;
        c.setLineDash([4, 3]);
        for (const ip of pieceWorldInternalPolylines(currentPattern, piece, paths, points, 4)) {
          tracePoly(c, ip, false); c.stroke();
        }
        c.setLineDash([]);
      }

      // seam allowance — a dashed offset of the boundary (outward, or inward if the piece is set so),
      // honouring a per-piece override and per-edge corner joins (radius/byLength/intersection cap).
      const sa = piece.seamAllowance ?? currentPattern.seamAllowance ?? 0;
      if (!piece.legacyGeometry?.boundary?.length && sa > 0.05 && outline.length >= 3) {
        const allow = explicitBoundaryMirrorAxis(piece, points)
          ? offsetPolygon(outline, piece.seamAllowanceInside ? -sa : sa)
          : pieceAllowancePolygon(currentPattern, piece, piece.seamAllowanceInside ? -sa : sa, paths, points);
        c.save();
        c.strokeStyle = isSelected ? 'rgba(29,78,216,0.5)' : 'rgba(30,41,59,0.4)';
        c.lineWidth = 1;
        c.setLineDash([3, 3]);
        tracePoly(c, allow, true);
        c.stroke();
        c.setLineDash([]);
        c.restore();
      }

      // SeamScape raw JSON carries its actual sampled cut boundary separately from the stitch
      // outline. Draw that exact source geometry instead of manufacturing a uniform allowance.
      // Keeping each source segment separate also preserves corners and shaped allowances.
      if (piece.legacyGeometry?.boundary?.length) {
        c.save();
        c.strokeStyle = isSelected ? '#1d4ed8' : 'rgba(15,23,42,0.92)';
        c.lineWidth = isSelected ? 1.8 : 1.25;
        c.setLineDash([]);
        const sourceBoundary = piece.legacyGeometry.cutBoundary?.length
          ? [piece.legacyGeometry.cutBoundary]
          : piece.legacyGeometry.boundary;
        for (const segment of sourceBoundary) {
          const world = segment.map(([x, y]) => tf({ x, y }));
          if (world.length < 2) continue;
          tracePoly(c, world, false);
          c.stroke();
        }
        for (const notch of piece.legacyGeometry.notches ?? []) {
          const world = notch.map(([x, y]) => tf({ x, y }));
          if (world.length < 2) continue;
          c.strokeStyle = '#dc2626';
          c.lineWidth = 1.5;
          tracePoly(c, world, false);
          c.stroke();
        }
        c.restore();
      }

      // grain line through centroid (magenta, like the source)
      const cen = polygonCentroid(outline);
      const o0 = tf({ x: 0, y: 0 });
      const gv = piece.grainVector;
      const gd = { x: tf(gv).x - o0.x, y: tf(gv).y - o0.y };
      const glen = Math.hypot(gd.x, gd.y) || 1;
      const gl = 70;
      const g0 = toCanvas({ x: cen.x - (gd.x / glen) * gl, y: cen.y - (gd.y / glen) * gl });
      const g1 = toCanvas({ x: cen.x + (gd.x / glen) * gl, y: cen.y + (gd.y / glen) * gl });
      c.strokeStyle = GRAIN_MAGENTA;
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(g0.x, g0.y); c.lineTo(g1.x, g1.y); c.stroke();

      // piece points (piece-local construction points): teal diamonds, labeled when selected
      if (baseScale() > 0.12) {
        for (const pt of piece.piecePoints ?? []) {
          const cp = toCanvas(tf(pt));
          c.save();
          c.translate(cp.x, cp.y);
          c.rotate(Math.PI / 4);
          c.fillStyle = '#0d9488';
          c.fillRect(-3.5, -3.5, 7, 7);
          c.strokeStyle = '#fff';
          c.lineWidth = 1.25;
          c.strokeRect(-3.5, -3.5, 7, 7);
          c.restore();
          if (isSelected && baseScale() > 0.18) {
            c.font = '10px sans-serif';
            c.textAlign = 'left';
            c.fillStyle = '#0d9488';
            c.fillText(pt.name, cp.x + 6, cp.y - 5);
          }
        }
      }
      // little arrow head at the top of the grain line
      const ah = 6, adx = (gd.x / glen), ady = (gd.y / glen);
      c.beginPath();
      c.moveTo(g1.x, g1.y);
      c.lineTo(g1.x - (adx * ah) + (ady * ah * 0.6), g1.y + (ady * ah) + (adx * ah * 0.6));
      c.moveTo(g1.x, g1.y);
      c.lineTo(g1.x - (adx * ah) - (ady * ah * 0.6), g1.y + (ady * ah) - (adx * ah * 0.6));
      c.stroke();

      // bbox only while actively dragging the piece
      if (isSelected && isDragging) {
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const p of outline) { const cp = toCanvas(p); bx0 = Math.min(bx0, cp.x); by0 = Math.min(by0, cp.y); bx1 = Math.max(bx1, cp.x); by1 = Math.max(by1, cp.y); }
        c.strokeStyle = 'rgba(37,99,235,0.6)';
        c.lineWidth = 1;
        c.setLineDash([6, 4]);
        c.strokeRect(bx0 - 8, by0 - 8, bx1 - bx0 + 16, by1 - by0 + 16);
        c.setLineDash([]);
      }

      if (currentPattern.showPieceNames) {
        const mid = toCanvas(cen);
        const cuts = pieceCutCounts(piece);
        pieceNameChip(c, cuts.total > 1 ? `${piece.name}  ×${cuts.total}` : piece.name, mid.x, mid.y);
      }
    }

    // notches — short perpendicular ticks at their position along each main edge
    for (const piece of currentPattern.pieces) {
      if (piece.hidden) continue;
      const tf = pieceTransform(piece, points, pieceShrinkageScale(currentPattern, piece));
      for (const pp of piece.mainPaths) {
        if (!pp.notches?.length) continue;
        const poly = piecePathPolyline(pp, paths, points, 4).map(tf);
        if (poly.length < 2) continue;
        const cum = [0];
        for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
        const total = cum[cum.length - 1] || 1;
        for (const notch of pp.notches) {
          const t = notchRatio(notch, pp, paths, points);
          const target = t * total;
          let i = 1; while (i < poly.length - 1 && cum[i] < target) i++;
          const seg = cum[i] - cum[i - 1] || 1;
          const f = (target - cum[i - 1]) / seg;
          const px = poly[i - 1].x + (poly[i].x - poly[i - 1].x) * f;
          const py = poly[i - 1].y + (poly[i].y - poly[i - 1].y) * f;
          let tx = poly[i].x - poly[i - 1].x, ty = poly[i].y - poly[i - 1].y;
          const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
          const nx = -ty, ny = tx; // edge normal
          const len = ((notch.size as number) || currentPattern.defaultNotchSize || 6.35);
          const type = (notch.type as string) || currentPattern.defaultNotchType || 'single';
          c.strokeStyle = isDark ? '#cbd5e1' : '#1e293b'; c.lineWidth = 1.5; c.setLineDash([]);
          // one tick crossing the edge along its normal, offset `o` mm along the tangent
          const tick = (o: number) => {
            const a = toCanvas({ x: px + tx * o + nx * len, y: py + ty * o + ny * len });
            const b = toCanvas({ x: px + tx * o - nx * len, y: py + ty * o - ny * len });
            c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
          };
          if (type === 'double') { tick(-len * 0.55); tick(len * 0.55); } // balance notch
          else if (type === 'slit') { // shallow V pointing across the edge
            const tip = toCanvas({ x: px, y: py });
            const l = toCanvas({ x: px + tx * len * 0.6 + nx * len, y: py + ty * len * 0.6 + ny * len });
            const r = toCanvas({ x: px - tx * len * 0.6 + nx * len, y: py - ty * len * 0.6 + ny * len });
            c.beginPath(); c.moveTo(l.x, l.y); c.lineTo(tip.x, tip.y); c.lineTo(r.x, r.y); c.stroke();
          } else if (type === 'tee') { // tick + a tangential crossbar at the edge (a plus)
            tick(0);
            const a = toCanvas({ x: px + tx * len, y: py + ty * len });
            const b = toCanvas({ x: px - tx * len, y: py - ty * len });
            c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
          } else tick(0); // single
        }
      }
    }

    // drill holes / punch markers — placed inside each piece (piece-local → plan → canvas)
    for (const piece of currentPattern.pieces) {
      if (piece.hidden || !piece.markers?.length) continue;
      const tf = pieceTransform(piece, points, pieceShrinkageScale(currentPattern, piece));
      c.strokeStyle = isDark ? '#cbd5e1' : '#1e293b';
      c.fillStyle = c.strokeStyle;
      c.lineWidth = 1.2; c.setLineDash([]);
      for (const m of piece.markers) {
        const p = toCanvas(tf({ x: m.x, y: m.y }));
        if (m.type === 'drill') {
          c.beginPath(); c.arc(p.x, p.y, 5, 0, Math.PI * 2); c.stroke();
          c.beginPath(); c.arc(p.x, p.y, 1.2, 0, Math.PI * 2); c.fill();
        } else { // punch: an X
          c.beginPath();
          c.moveTo(p.x - 4, p.y - 4); c.lineTo(p.x + 4, p.y + 4);
          c.moveTo(p.x - 4, p.y + 4); c.lineTo(p.x + 4, p.y - 4);
          c.stroke();
        }
      }
    }

    // text annotations (pattern-level), placed in plan space, with formatting
    for (const t of currentPattern.texts) {
      if (!t.value) continue;
      const layer = currentPattern.layers.find((l) => l.id === t.layerId);
      if (layer && !layer.visible) continue;
      const o = toCanvas({ x: t.x, y: t.y });
      const e = toCanvas({ x: t.x + (t.fontSize ?? 15), y: t.y });
      const fontPx = Math.max(6, Math.hypot(e.x - o.x, e.y - o.y));
      c.save();
      c.translate(o.x, o.y);
      if (t.rotation) c.rotate((t.rotation * Math.PI) / 180);
      c.fillStyle = t.color ?? (isDark ? '#e2e8f0' : '#1e293b');
      c.font = `${fontPx}px Inter, system-ui, sans-serif`;
      c.textAlign = t.align ?? 'center';
      c.textBaseline = 'middle';
      c.fillText(t.value, 0, 0);
      c.restore();
    }

    // seams — shown only while a seam tool is active (or pinned via the Seams toggle),
    // matching the source. Each seam's two sewn edges are stroked in the seam's own colour
    // (golden-angle hue spacing) so matching colours = same seam; faint dashed "rungs" link them.
    // A selected seam shows even when "Show seams" is off (the original's shouldDisplaySeams),
    // with extra emphasis + direction arrows on both sides.
    const selSeam = $selectedSeamId;
    if (showSeams || isSeamToolActive() || selSeam) {
      const onlySelected = !showSeams && !isSeamToolActive();
      const sel = pieceIds;
      for (const sg of allSeamGeometry(currentPattern, paths, points, 4)) {
        if (onlySelected && sg.id !== selSeam) continue;
        const isSel = sg.id === selSeam;
        const focused = isSel || (sel.size > 0 && sg.pieceIds.some((id) => sel.has(id)));
        const col = seamColor(sg.index);
        c.strokeStyle = col;
        c.globalAlpha = sel.size === 0 || focused ? 1 : 0.35;
        c.lineWidth = isSel ? 5 : focused ? 4 : 3;
        c.setLineDash([]);
        tracePoly(c, sg.fromEdge, false); c.stroke();
        tracePoly(c, sg.toEdge, false); c.stroke();
        if (isSel) {
          drawDirectionArrow(c, sg.fromEdge, col);
          drawDirectionArrow(c, sg.toEdge, col);
        }
        if (focused || sel.size === 0) {
          c.lineWidth = 0.8;
          c.globalAlpha = focused ? 0.5 : 0.18;
          c.setLineDash([5, 5]);
          for (const r of sg.rungs) {
            const a = toCanvas(r.a); const b = toCanvas(r.b);
            c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
          }
          c.setLineDash([]);
        }
        c.globalAlpha = 1;
      }
    }

    // Drafting geometry in its canonical (unplaced) coordinates. The source keeps this editable
    // construction visible alongside the arranged cut pieces. Avoid drawing an exact duplicate
    // when an identity-placed piece already represents the same path.
    const usedPaths = new Set<string>();
    for (const piece of currentPattern.pieces) {
      for (const pp of piece.mainPaths) usedPaths.add(pp.path);
      for (const pp of piece.internalPaths) usedPaths.add(pp.path);
    }
    const pathNeedsDraftCopy = (path: Pattern['paths'][number]) => {
      if (!usedPaths.has(path.id)) return true;
      const raw = pathPolyline(path, points, 4);
      if (raw.length === 0) return false;
      for (const piece of currentPattern.pieces) {
        const ownsPath = [...piece.mainPaths, ...piece.internalPaths].some((piecePath) => piecePath.path === path.id);
        if (!ownsPath) continue;
        const transform = pieceTransform(piece, points, pieceShrinkageScale(currentPattern, piece));
        if (raw.every((point) => {
          const placedPoint = transform(point);
          return Math.hypot(placedPoint.x - point.x, placedPoint.y - point.y) < 0.05;
        })) return false;
      }
      return true;
    };
    // Construction geometry is hidden only when the Construction toggle is off.
    const showConstruction = currentPattern.showConstruction !== false;
    if (showConstruction) {
      for (const path of currentPattern.paths) {
        if (!pathNeedsDraftCopy(path) || !layerVisible(path.layerId)) continue;
        const isSelected = pathIds.has(path.id);
        const st = (layerOf(path.layerId)?.style ?? null) as LayerStyle | null;
        c.save();
        c.globalAlpha = st?.opacity ?? 1;
        c.strokeStyle = isSelected ? '#f97316' : (layerStrokeColor(st, isDark) ?? '#cbd5e1');
        c.lineWidth = isSelected ? 2.5 : (st?.lineWidth ?? 1);
        c.setLineDash(isSelected ? [] : layerDashPattern(st));
        tracePoly(c, pathPolyline(path, points, 4), false);
        c.stroke();
        c.restore();
      }
    }

    if (baseScale() > 0.12 || pointIds.size > 0 || hoveredPointId) {
      const selPieces = pieceIds;
      const allEditorPoints = editorPlacedPoints(currentPattern, points);
      const piecesById = new Map(currentPattern.pieces.map((piece) => [piece.id, piece]));
      const idsWithDraftCopy = new Set(allEditorPoints.filter((point) => point.pieceId === '').map((point) => point.pointId));
      const basePointIds = new Set(currentPattern.paths.map((path) => path.basePoint).filter((id): id is string => !!id));
      const showDraftMarkers = baseScale() > 0.18;
      const showLabels = baseScale() > 0.28;
      for (const pp of allEditorPoints) {
        if (!layerVisible(points.get(pp.pointId)?.layerId)) continue;
        if (!showConstruction && pp.pieceId === '') continue; // hide construction points
        if (pp.pieceId && piecesById.get(pp.pieceId)?.hideEditorPoints && !pointIds.has(pp.pointId) && hoveredPointId !== pp.pointId) continue;

        const pt = pp.world;
        const cp = toCanvas(pt);
        const isHovered = hoveredPointId === pp.pointId;
        const isSelected = pointIds.has(pp.pointId);
        const onSelPiece = pp.pieceId !== '' && selPieces.has(pp.pieceId);
        const isDraftCopy = pp.pieceId === '';
        // When the canonical draft is shown in the centre, do not repeat all of its dots on the
        // arranged cut pieces. The source reveals those placed anchors only while their piece or
        // point is selected. Identity-placed patterns still retain their sole visible occurrence.
        const isRedBasePoint = basePointIds.has(pp.pointId);
        const hasSeparateDraftCopy = idsWithDraftCopy.has(pp.pointId);
        if (!isSelected && !isHovered && !onSelPiece &&
          ((hasSeparateDraftCopy && !isDraftCopy) || (isDraftCopy && !showDraftMarkers))) continue;
        const r = isHovered ? POINT_RADIUS + 2 : isSelected || isRedBasePoint ? POINT_RADIUS + 1.5 : POINT_RADIUS;
        c.beginPath();
        c.arc(cp.x, cp.y, r, 0, Math.PI * 2);
        c.fillStyle = isSelected ? '#f97316' : isHovered ? '#fb923c'
          : isDraftCopy ? (isRedBasePoint ? '#ef4444' : SELECT_BLUE)
          : (onSelPiece ? SELECT_BLUE : '#64748b');
        c.fill();
        if (isSelected || isHovered || !isDraftCopy) {
          c.strokeStyle = '#fff';
          c.lineWidth = 1.25;
          c.stroke();
        }
        // point name label (A0, A1, ...) — like the source
        const nm = points.get(pp.pointId)?.name;
        if (showLabels && nm && (selPieces.size === 0 || onSelPiece || isSelected)) {
          c.font = '11px sans-serif';
          c.textAlign = 'left';
          c.fillStyle = '#334155';
          c.fillText(nm, cp.x + 6, cp.y - 6);
        }
      }
      // measurement + bezier handles ONLY for the clicked boundary edge (like the source)
      drawSelectedEdge(c, paths, points);
    }

    drawMeasurements(c, points);
    drawSelectionGizmo(c);
    drawPasteGhost(c);
    drawGuideLines(c);

    // live drag readout (dX / dY / dL), like the source
    if (isDragging && dragStartWorld) {
      const cur = toPattern(cursorPos.x, cursorPos.y);
      const dx = cur.x - dragStartWorld.x;
      const dy = cur.y - dragStartWorld.y;
      const dl = Math.hypot(dx, dy);
      const conv = (mm: number) => currentPattern.lengthUnit === 'inch' ? mm / 25.4 : currentPattern.lengthUnit === 'cm' ? mm / 10 : mm;
      const u = currentPattern.lengthUnit;
      const lines = [
        `dX ${conv(dx) >= 0 ? '+' : ''}${conv(dx).toFixed(1)} ${u}`,
        `dY ${conv(dy) >= 0 ? '+' : ''}${conv(dy).toFixed(1)} ${u}`,
        `dL ${conv(dl).toFixed(1)} ${u}`
      ];
      const bx = cursorPos.x + 14, by = cursorPos.y + 14;
      c.font = '11px sans-serif';
      const w = Math.max(...lines.map((l) => c.measureText(l).width)) + 12;
      c.fillStyle = 'rgba(15,23,42,0.88)';
      c.fillRect(bx, by, w, lines.length * 14 + 6);
      c.fillStyle = '#fff';
      c.textAlign = 'left';
      lines.forEach((l, i) => c.fillText(l, bx + 6, by + 14 + i * 14));
    }

    // pen / create-piece draft preview
    if (penDraft.length > 0) {
      const pts = penDraft.map((id) => points.get(id)).filter(Boolean) as { x: number; y: number }[];
      c.strokeStyle = $selectedTool === 'piece' ? '#2563eb' : '#0ea5e9';
      c.lineWidth = 1.5;
      c.beginPath();
      const a0 = toCanvas(pts[0]);
      c.moveTo(a0.x, a0.y);
      for (let i = 1; i < pts.length; i++) { const p = toCanvas(pts[i]); c.lineTo(p.x, p.y); }
      const last = toCanvas(pts[pts.length - 1]);
      c.lineTo(last.x, last.y);
      c.setLineDash([4, 3]);
      c.lineTo(cursorPos.x, cursorPos.y); // rubber-band to cursor
      c.stroke();
      c.setLineDash([]);
      for (const p of pts) { const cp = toCanvas(p); c.beginPath(); c.arc(cp.x, cp.y, 4, 0, Math.PI * 2); c.fillStyle = '#0ea5e9'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 1.25; c.stroke(); }
    }

    // seam tool overlays: mirrored-half ghosts, per-side picked edges with direction arrows,
    // hover highlight, and live preview rungs to the candidate side (like the original).
    if (isSeamToolActive()) {
      // faint ghost of mirrored halves so the mirrored copy is visible + clickable
      for (const piece of currentPattern.pieces) {
        if (piece.hidden || !layerVisible(piece.layerId)) continue;
        const axis = pieceMirrorAxis(piece, points);
        if (!axis) continue;
        const tf = pieceTransform(piece, points, pieceShrinkageScale(currentPattern, piece));
        c.strokeStyle = isDark ? 'rgba(148,163,184,0.4)' : 'rgba(100,116,139,0.35)';
        c.lineWidth = 1; c.setLineDash([3, 4]);
        for (const pp of piece.mainPaths) {
          if (pp.isMirrorLine) continue;
          const ghost = piecePathPolyline(pp, paths, points, 4).map((p) => reflectAcrossLine(p, axis.a, axis.b)).map(tf);
          tracePoly(c, ghost, false); c.stroke();
        }
        c.setLineDash([]);
      }
      const drawPick = (pick: SeamPick, color: string, width: number) => {
        const poly = seamPickPoly(pick, paths, points);
        if (!poly) return;
        c.strokeStyle = color; c.lineWidth = width; c.setLineDash([]);
        tracePoly(c, poly, false); c.stroke();
        drawDirectionArrow(c, poly, color);
      };
      for (const pick of seamFromPicks) drawPick(pick, PATH_MAGENTA, 3);
      for (const pick of seamToPicks) drawPick(pick, '#2563eb', 3);
      if (seamHover &&
          !seamFromPicks.some((r) => samePick(r, seamHover!)) &&
          !seamToPicks.some((r) => samePick(r, seamHover!))) {
        const toPhase = $selectedTool === 'seam-multi' ? seamPhase === 'to' : seamFromPicks.length > 0;
        drawPick(seamHover, toPhase ? 'rgba(37,99,235,0.6)' : 'rgba(217,70,239,0.6)', 2);
      }
      drawSeamPreviewRungs(c, paths, points);
    }

    // arc/circle tool: placed clicks + a live preview to the cursor
    if (arcClicks.length > 0) {
      for (const w of arcClicks) { const cp = toCanvas(w); c.beginPath(); c.arc(cp.x, cp.y, 4, 0, Math.PI * 2); c.fillStyle = '#0ea5e9'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 1.25; c.stroke(); }
      const cur = toPattern(cursorPos.x, cursorPos.y);
      c.strokeStyle = 'rgba(14,165,233,0.8)'; c.lineWidth = 1.25; c.setLineDash([4, 3]);
      if ($selectedTool === 'circle') {
        const ctr = toCanvas(arcClicks[0]);
        const r = Math.hypot(cursorPos.x - ctr.x, cursorPos.y - ctr.y);
        c.beginPath(); c.arc(ctr.x, ctr.y, r, 0, Math.PI * 2); c.stroke();
      } else {
        c.beginPath(); const a0 = toCanvas(arcClicks[0]); c.moveTo(a0.x, a0.y);
        for (const w of arcClicks.slice(1)) { const cp = toCanvas(w); c.lineTo(cp.x, cp.y); }
        c.lineTo(cursorPos.x, cursorPos.y); c.stroke();
      }
      c.setLineDash([]);
    }

    // marquee (rubber-band) selection rectangle
    if (isMarquee) {
      const x = Math.min(marqueeStart.x, marqueeCur.x), y = Math.min(marqueeStart.y, marqueeCur.y);
      const w = Math.abs(marqueeCur.x - marqueeStart.x), h = Math.abs(marqueeCur.y - marqueeStart.y);
      c.fillStyle = 'rgba(37,99,235,0.10)';
      c.fillRect(x, y, w, h);
      c.strokeStyle = 'rgba(37,99,235,0.7)';
      c.lineWidth = 1;
      c.setLineDash([4, 3]);
      c.strokeRect(x, y, w, h);
      c.setLineDash([]);
    }

    // compass — a small orientation widget in the top-right corner showing the canvas axes
    // (pattern +y is up = N, +x is right = E)
    if (currentPattern.showCompass) drawCompass(c);
  }

  function drawCompass(c: CanvasRenderingContext2D) {
    const cx = canvasW - 44, cy = 44, r = 24;
    c.save();
    c.globalAlpha = 0.9;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = isDark ? 'rgba(21,25,30,0.75)' : 'rgba(255,255,255,0.8)';
    c.fill();
    c.strokeStyle = isDark ? '#3b4452' : '#cbd5e1';
    c.lineWidth = 1;
    c.stroke();
    // E–W axis
    c.strokeStyle = isDark ? '#64748b' : '#94a3b8';
    c.beginPath(); c.moveTo(cx - r + 9, cy); c.lineTo(cx + r - 9, cy); c.stroke();
    // N–S grainline arrow (north = pattern +y, which renders upward)
    c.strokeStyle = GRAIN_MAGENTA;
    c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(cx, cy + r - 9); c.lineTo(cx, cy - r + 9); c.stroke();
    c.beginPath();
    c.moveTo(cx, cy - r + 9); c.lineTo(cx - 3.5, cy - r + 15);
    c.moveTo(cx, cy - r + 9); c.lineTo(cx + 3.5, cy - r + 15);
    c.stroke();
    c.font = '600 8px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = isDark ? '#cbd5e1' : '#475569';
    c.fillText('N', cx, cy - r + 4.5);
    c.fillText('S', cx, cy + r - 4.5);
    c.fillText('E', cx + r - 4.5, cy);
    c.fillText('W', cx - r + 4.5, cy);
    c.restore();
  }

  function pieceOwnerOf(ppId: string): { piece: Piece; pp: import('@seamer/pattern-model').PiecePath } | null {
    for (const piece of currentPattern.pieces) {
      for (const pp of piece.mainPaths) if (pp.id === ppId) return { piece, pp };
      for (const pp of piece.internalPaths) if (pp.id === ppId) return { piece, pp };
    }
    return null;
  }

  function getPos(e: MouseEvent): Vec2 {
    const rect = canvasEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---- piece operations (context menu) --------------------------------------
  function pieceAt(pos: Vec2): Piece | null {
    const pat = toPattern(pos.x, pos.y);
    const paths = indexPaths(currentPattern);
    const points = indexPoints(currentPattern);
    for (const piece of currentPattern.pieces) {
      if (piece.hidden || !layerVisible(piece.layerId) || layerLocked(piece.layerId)) continue;
      if (pointInPolygon(pat, pieceDisplayOutline(currentPattern, piece, paths, points, 6))) return piece;
    }
    return null;
  }
  function mutatePieces(fn: (pieces: Piece[]) => Piece[]) {
    onchange({ ...currentPattern, pieces: fn(currentPattern.pieces), hasChanged: true });
  }
  function duplicatePiece(piece: Piece) {
    const clone: Piece = structuredClone($state.snapshot(piece) as Piece);
    clone.id = uid('Piece');
    clone.name = `Copy of ${piece.name}`;
    clone.position = { x: piece.position.x + 50, y: piece.position.y - 50 };
    clone.origin = { ...piece.origin, id: uid('Point') };
    for (const pp of [...clone.mainPaths, ...clone.internalPaths]) pp.id = uid('PiecePath');
    mutatePieces((ps) => [...ps, clone]);
    setPieceIds([clone.id]);
    toast(`Duplicated "${piece.name}"`, 'success');
  }
  function deletePiece(piece: Piece) {
    // cascade: also drop seams that sewed this piece's edges
    onchange(deletePieceCascade(currentPattern, piece.id));
    setPieceIds([]);
    toast(`Deleted "${piece.name}"`);
  }
  function togglePieceHidden(piece: Piece) {
    mutatePieces((ps) => ps.map((p) => (p.id === piece.id ? { ...p, hidden: !p.hidden } : p)));
    toast(piece.hidden ? `Showing "${piece.name}"` : `Hid "${piece.name}"`);
  }
  function reorderPiece(piece: Piece, toFront: boolean) {
    mutatePieces((ps) => { const rest = ps.filter((p) => p.id !== piece.id); return toFront ? [...rest, piece] : [piece, ...rest]; });
    toast(toFront ? 'Brought to front' : 'Sent to back');
  }
  function mirrorPiece(piece: Piece, axis: 'X' | 'Y') {
    mutatePieces((ps) => ps.map((p) => (p.id === piece.id ? { ...p, [axis === 'X' ? 'mirrorX' : 'mirrorY']: !(axis === 'X' ? p.mirrorX : p.mirrorY) } : p)));
    toast(`Mirrored on ${axis} axis`);
  }

  // ---- path / point operations ---------------------------------------------
  /** Convert a ConstrainablePath between line and curve (adds/removes bezier handles). */
  function convertPath(pathId: string, toCurve: boolean) {
    const p = $state.snapshot(currentPattern) as Pattern;
    const pts = indexPoints(currentPattern);
    const paths = p.paths.map((path) => {
      if (path.id !== pathId) return path;
      if (!toCurve) {
        return { ...path, pathType: 'line', pathPoints: path.pathPoints.map((pp) => ({ id: pp.id })) };
      }
      const anchors = path.pathPoints.map((pp) => pts.get(pp.id)).filter(Boolean) as typeof currentPattern.points;
      const pathPoints = path.pathPoints.map((pp, i) => {
        const a = pts.get(pp.id); if (!a) return pp;
        const prev = anchors[i - 1] ?? a, next = anchors[i + 1] ?? a;
        const tx = (next.x - prev.x) / 3, ty = (next.y - prev.y) / 3;
        return { id: pp.id, handle: { v1: { x: -tx, y: -ty }, v2: { x: tx, y: ty }, sameLength: true, sameAngle: true, lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' } } };
      });
      return { ...path, pathType: 'curve', pathPoints };
    });
    onchange({ ...p, paths, hasChanged: true });
    toast(toCurve ? 'Converted to curve' : 'Converted to line', 'success');
  }

  /** Reverse a path's direction (and swap each bézier handle's in/out tangents). */
  function reversePath(pathId: string) {
    const p = $state.snapshot(currentPattern) as Pattern;
    const paths = p.paths.map((pa) =>
      pa.id === pathId
        ? { ...pa, pathPoints: pa.pathPoints.slice().reverse().map((pp) => (pp.handle ? { ...pp, handle: { ...pp.handle, v1: pp.handle.v2, v2: pp.handle.v1 } } : pp)) }
        : pa
    );
    onchange({ ...p, paths, hasChanged: true });
    toast('Reversed path', 'success');
  }

  /** Move a path to another layer. */
  function movePathToLayer(pathId: string, layerId: string) {
    const p = $state.snapshot(currentPattern) as Pattern;
    onchange({ ...p, paths: p.paths.map((pa) => (pa.id === pathId ? { ...pa, layerId } : pa)), hasChanged: true });
    toast('Moved to layer', 'success');
  }

  /** Mirror the selected points across their centroid (horizontal or vertical axis). */
  function flipSelectedPoints(axis: 'h' | 'v') {
    const ids = pointIds; if (ids.size === 0) return;
    const sel = currentPattern.points.filter((p) => ids.has(p.id));
    const cx = sel.reduce((s, p) => s + p.x, 0) / sel.length, cy = sel.reduce((s, p) => s + p.y, 0) / sel.length;
    const points = currentPattern.points.map((p) =>
      ids.has(p.id) ? { ...p, x: axis === 'h' ? 2 * cx - p.x : p.x, y: axis === 'v' ? 2 * cy - p.y : p.y } : p
    );
    onchange({ ...currentPattern, points, hasChanged: true });
    toast(`Flipped ${sel.length} point${sel.length === 1 ? '' : 's'}`, 'success');
  }

  /** Split a piece edge at the clicked location: insert a midpoint and replace the edge with two. */
  function splitEdge(owner: { piece: Piece; pp: import('@seamer/pattern-model').PiecePath }, world: Vec2) {
    const paths = indexPaths(currentPattern); const points = indexPoints(currentPattern);
    const poly = piecePathPolyline(owner.pp, paths, points, 2);
    if (poly.length < 2) { toast('Cannot split this edge', 'error'); return; }
    // nearest point on the edge polyline to the click
    let best = poly[0]; let bestD = Infinity;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy || 1;
      let t = ((world.x - a.x) * dx + (world.y - a.y) * dy) / l2; t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx, py = a.y + t * dy; const d = Math.hypot(world.x - px, world.y - py);
      if (d < bestD) { bestD = d; best = { x: px, y: py }; }
    }
    let p = $state.snapshot(currentPattern) as Pattern;
    const r = withNewPoint(p, best); p = r.p; const mid = r.id;
    const path1 = lineThrough([owner.pp.from, mid]); const path2 = lineThrough([mid, owner.pp.to]);
    p = { ...p, paths: [...p.paths, path1, path2] };
    const pp1 = { ...owner.pp, id: uid('PiecePath'), path: path1.id, from: owner.pp.from, to: mid, notches: [] };
    const pp2 = { ...owner.pp, id: uid('PiecePath'), path: path2.id, from: mid, to: owner.pp.to, notches: [] };
    const isMain = owner.piece.mainPaths.some((x) => x.id === owner.pp.id);
    const repl = (list: import('@seamer/pattern-model').PiecePath[]) => list.flatMap((x) => (x.id === owner.pp.id ? [pp1, pp2] : [x]));
    const pieces = p.pieces.map((pc) => (pc.id === owner.piece.id
      ? { ...pc, mainPaths: isMain ? repl(pc.mainPaths) : pc.mainPaths, internalPaths: isMain ? pc.internalPaths : repl(pc.internalPaths) }
      : pc));
    onchange({ ...p, pieces, hasChanged: true });
    toast('Split edge', 'success');
  }

  /** Rotate the selected construction points around their centre (degrees). */
  function rotateSelectedPoints(deg: number) {
    const ids = pointIds; if (ids.size === 0) return;
    const sel = currentPattern.points.filter((p) => ids.has(p.id));
    const cx = sel.reduce((s, p) => s + p.x, 0) / sel.length, cy = sel.reduce((s, p) => s + p.y, 0) / sel.length;
    const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
    const points = currentPattern.points.map((p) => {
      if (!ids.has(p.id)) return p;
      const dx = p.x - cx, dy = p.y - cy;
      return { ...p, x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    });
    onchange({ ...currentPattern, points, hasChanged: true });
    toast(`Rotated ${sel.length} point${sel.length === 1 ? '' : 's'} ${deg}°`, 'success');
  }

  /** Scale the selected construction points around their centre (percent). */
  function scaleSelectedPoints(pct: number) {
    const ids = pointIds; if (ids.size === 0) return;
    const sel = currentPattern.points.filter((p) => ids.has(p.id));
    const cx = sel.reduce((s, p) => s + p.x, 0) / sel.length, cy = sel.reduce((s, p) => s + p.y, 0) / sel.length;
    const f = pct / 100;
    const points = currentPattern.points.map((p) => (ids.has(p.id) ? { ...p, x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f } : p));
    onchange({ ...currentPattern, points, hasChanged: true });
    toast(`Scaled ${sel.length} point${sel.length === 1 ? '' : 's'} to ${pct}%`, 'success');
  }

  /** Arc-length parameter (0..1) of the closest point on a piece-path's WORLD polyline. */
  function edgeParamAt(pp: import('@seamer/pattern-model').PiecePath, world: Vec2): number {
    const owner = pieceOwnerOf(pp.id); if (!owner) return 0.5;
    const tf = pieceTransform(owner.piece, indexPoints(currentPattern));
    const poly = piecePathPolyline(pp, indexPaths(currentPattern), indexPoints(currentPattern), 4).map(tf);
    if (poly.length < 2) return 0.5;
    const cum = [0];
    for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
    const total = cum[cum.length - 1] || 1;
    let best = 0.5, bestD = Infinity;
    for (let i = 1; i < poly.length; i++) {
      const dx = poly[i].x - poly[i - 1].x, dy = poly[i].y - poly[i - 1].y;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((world.x - poly[i - 1].x) * dx + (world.y - poly[i - 1].y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = poly[i - 1].x + t * dx, py = poly[i - 1].y + t * dy;
      const d = Math.hypot(world.x - px, world.y - py);
      if (d < bestD) { bestD = d; best = (cum[i - 1] + t * Math.sqrt(l2)) / total; }
    }
    return best;
  }
  function addNotch(piecePathId: string, position: number) {
    mutatePieces((ps) => ps.map((pc) => ({
      ...pc,
      mainPaths: pc.mainPaths.map((pp) => pp.id === piecePathId ? { ...pp, notches: [...(pp.notches ?? []), { id: uid('Notch'), position, size: currentPattern.defaultNotchSize, type: currentPattern.defaultNotchType ?? 'single' }] } : pp)
    })));
    toast('Added notch', 'success');
  }
  /** Add a drill-hole / punch marker inside a piece at the clicked (plan-space) location. */
  function addMarker(piece: Piece, type: 'drill' | 'punch', worldPlan: Vec2) {
    const local = pieceInverseTransform(piece, indexPoints(currentPattern))(worldPlan);
    mutatePieces((ps) => ps.map((p) => (p.id === piece.id
      ? { ...p, markers: [...(p.markers ?? []), { id: uid('Marker'), type, x: local.x, y: local.y }] }
      : p)));
    toast(type === 'drill' ? 'Added drill hole' : 'Added punch marker', 'success');
  }
  function clearMarkers(piece: Piece) {
    mutatePieces((ps) => ps.map((p) => (p.id === piece.id ? { ...p, markers: [] } : p)));
    toast('Cleared markers');
  }
  function clearNotches(piecePathId: string) {
    mutatePieces((ps) => ps.map((pc) => ({ ...pc, mainPaths: pc.mainPaths.map((pp) => pp.id === piecePathId ? { ...pp, notches: [] } : pp) })));
    toast('Cleared notches');
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    const pos = getPos(e);

    // right-click a point → point ops (incl. rotate/scale a multi-selection)
    const ptHit = hitTestPlaced(pos.x, pos.y);
    if (ptHit) {
      if (!pointIds.has(ptHit.pointId)) { setPointIds([ptHit.pointId]); setPieceIds([]); setPathIds([]); }
      render();
      const n = pointIds.size;
      const items: MenuItem[] = [];
      if (n > 1) {
        items.push({ label: `Rotate ${n} points…`, icon: 'rotate_right', onClick: () => { const d = prompt('Degrees to rotate selected points:', '90'); if (d) rotateSelectedPoints(parseFloat(d) || 0); } });
        items.push({ label: `Scale ${n} points…`, icon: 'open_in_full', onClick: () => { const s = prompt('Scale selected points by percent:', '100'); if (s) scaleSelectedPoints(parseFloat(s) || 100); } });
        items.push({ label: 'Flip horizontal', icon: 'flip', onClick: () => flipSelectedPoints('h') });
        items.push({ label: 'Flip vertical', icon: 'flip', onClick: () => flipSelectedPoints('v') });
      } else {
        // single point → topology edits (port of the original right-click point ops)
        const pid = ptHit.pointId;
        const p = currentPattern;
        const apply = (res: Pattern | null, msg: string) => { if (res) { onchange(res); toast(msg, 'success'); } else { toast('Operation not available here', 'error'); } };
        if (ops.canConvertToCurvePoint(p, pid)) items.push({ label: 'Convert to curve point', icon: 'gesture', onClick: () => apply(ops.convertToCurvePoint(p, pid), 'Converted to curve point') });
        if (ops.canConvertToSlidingPoint(p, pid)) items.push({ label: 'Convert to sliding point', icon: 'drag_pan', onClick: () => apply(ops.convertToSlidingPoint(p, pid), 'Converted to sliding point') });
        if (ops.canSplitCurve(p, pid)) items.push({ label: 'Split into two curves', icon: 'call_split', onClick: () => apply(ops.splitCurveAtPoint(p, pid), 'Split curve') });
        if (ops.canSplitLine(p, pid)) items.push({ label: 'Split into two lines', icon: 'call_split', onClick: () => apply(ops.splitLineAtPoint(p, pid), 'Split line') });
        if (ops.canMergeCurves(p, pid)) items.push({ label: 'Merge into one curve', icon: 'arrow_and_edge', onClick: () => apply(ops.mergeCurvesAtPoint(p, pid), 'Merged curves') });
        if (ops.canMergeLines(p, pid)) items.push({ label: 'Merge into one line', icon: 'arrow_and_edge', onClick: () => apply(ops.mergeLinesAtPoint(p, pid), 'Merged lines') });
        if (ops.isSlidingPointAnywhere(p, pid)) {
          const hosts = ops.slidingHostPaths(p, pid);
          if (hosts.length > 1) hosts.forEach((h, i) => items.push({ label: `Release from ${h.name || `Path ${i + 1}`}`, icon: 'toggle_off', onClick: () => apply(ops.releaseSlidingPoint(p, pid, h.id), 'Released sliding point') }));
          else items.push({ label: 'Release point from path', icon: 'toggle_off', onClick: () => apply(ops.releaseSlidingPoint(p, pid), 'Released sliding point') });
        }
        if (ops.canDisconnectPaths(p, pid)) {
          const hosts = ops.disconnectHostPaths(p, pid);
          if (hosts.length > 2) hosts.slice(1).forEach((h, i) => items.push({ label: `Disconnect ${h.name || `Path ${i + 2}`}`, icon: 'call_split', onClick: () => apply(ops.disconnectPaths(p, pid, h.id), 'Disconnected path') }));
          else items.push({ label: 'Disconnect path', icon: 'call_split', onClick: () => apply(ops.disconnectPaths(p, pid), 'Disconnected path') });
        }
      }
      items.push({ label: `Delete point${n > 1 ? 's' : ''}`, icon: 'delete', danger: true, sep: items.length > 0, onClick: () => {
        const ids = pointIds;
        onchange({ ...currentPattern, points: currentPattern.points.filter((p) => !ids.has(p.id)), hasChanged: true });
        setPointIds([]); toast('Deleted points');
      } });
      contextMenu = { x: e.clientX, y: e.clientY, items };
      return;
    }

    // right-click an edge → path conversions + delete
    const edgePP = hitTestEdge(pos);
    if (edgePP) {
      const owner = pieceOwnerOf(edgePP);
      const path = owner ? indexPaths(currentPattern).get(owner.pp.path) : null;
      if (owner && path) {
        setPieceIds([owner.piece.id]); setPathIds([path.id]); setPointIds([]);
        render();
        const isCurve = path.pathType === 'curve';
        const world = toPattern(pos.x, pos.y);
        const hasNotches = (owner.pp.notches?.length ?? 0) > 0;
        contextMenu = { x: e.clientX, y: e.clientY, items: [
          isCurve
            ? { label: 'Convert to line', icon: 'show_chart', onClick: () => convertPath(path.id, false) }
            : { label: 'Convert to curve', icon: 'gesture', onClick: () => convertPath(path.id, true) },
          { label: 'Reverse path', icon: 'swap_horiz', onClick: () => reversePath(path.id) },
          { label: 'Split edge here', icon: 'content_cut', onClick: () => splitEdge(owner, world) },
          { label: 'Add notch here', icon: 'straighten', sep: true, onClick: () => addNotch(owner.pp.id, edgeParamAt(owner.pp, world)) },
          ...(hasNotches ? [{ label: 'Clear notches', icon: 'backspace', onClick: () => clearNotches(owner.pp.id) } as MenuItem] : []),
          ...currentPattern.layers.filter((l) => l.id !== path.layerId).map((l) => ({ label: `Move to layer: ${l.name}`, icon: 'layers', sep: l === currentPattern.layers.find((x) => x.id !== path.layerId), onClick: () => movePathToLayer(path.id, l.id) } as MenuItem)),
          { label: 'Remove edge from piece', icon: 'delete', danger: true, sep: true, onClick: () => { mutatePieces((ps) => ps.map((p) => p.id === owner.piece.id ? { ...p, mainPaths: p.mainPaths.filter((x) => x.id !== owner.pp.id) } : p)); toast('Removed edge'); } }
        ] };
        return;
      }
    }

    const piece = pieceAt(pos);
    if (!piece) { contextMenu = null; return; }
    setPieceIds([piece.id]);
    setPointIds([]);
    setPathIds([]);
    render();
    contextMenu = {
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Duplicate', icon: 'content_copy', onClick: () => duplicatePiece(piece) },
        { label: 'Add drill hole here', icon: 'radio_button_checked', onClick: () => addMarker(piece, 'drill', toPattern(pos.x, pos.y)) },
        { label: 'Add punch marker here', icon: 'add', onClick: () => addMarker(piece, 'punch', toPattern(pos.x, pos.y)) },
        ...((piece.markers?.length ?? 0) > 0 ? [{ label: 'Clear markers', icon: 'backspace', onClick: () => clearMarkers(piece) } as MenuItem] : []),
        { label: 'Mirror along X-axis', icon: 'flip', sep: true, onClick: () => mirrorPiece(piece, 'X') },
        { label: 'Mirror along Y-axis', icon: 'flip', onClick: () => mirrorPiece(piece, 'Y') },
        { label: 'Bring to front', icon: 'flip_to_front', sep: true, onClick: () => reorderPiece(piece, true) },
        { label: 'Send to back', icon: 'flip_to_back', onClick: () => reorderPiece(piece, false) },
        ...currentPattern.layers
          .filter((l) => l.id !== (piece.layerId ?? 'default'))
          .map((l, i): MenuItem => ({ label: `Move to: ${l.name}`, icon: 'layers', sep: i === 0, onClick: () => moveToLayer(piece, l.id) })),
        { label: piece.hidden ? 'Show piece' : 'Hide piece', icon: piece.hidden ? 'visibility' : 'visibility_off', sep: true, onClick: () => togglePieceHidden(piece) },
        ...looseAttachItems(piece),
        ...([
          ['Breakout: all', 'all'],
          ['Breakout: seams', 'seams'],
          ['Breakout: cut', 'cut'],
          ['Breakout: internal lines', 'internal'],
          ['Breakout: seams + internal', 'seamsInternal']
        ] as [string, BreakoutMode][]).map(([label, m], i): MenuItem => ({
          label, icon: 'copy_all', sep: i === 0,
          onClick: () => { const res = breakoutPiece(currentPattern, piece.id, m); if (res) { onchange(res); toast('Broke out piece geometry', 'success'); } else { toast('Nothing to break out', 'error'); } }
        })),
        { label: 'Delete', icon: 'delete', danger: true, sep: true, onClick: () => deletePiece(piece) }
      ]
    };
  }

  function moveToLayer(piece: Piece, layerId: string) {
    mutatePieces((ps) => ps.map((p) => (p.id === piece.id ? { ...p, layerId } : p)));
    const name = currentPattern.layers.find((l) => l.id === layerId)?.name ?? layerId;
    toast(`Moved to ${name}`, 'success');
  }

  // ---- tool actions (new point / pen / create piece / seam / text) ----------
  const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;

  /** Context-menu items to attach existing (unattached) draft paths to a piece as boundary/internal
   *  edges — the "addBoundaryPath / addInternalPath" capability. Capped to keep the menu usable. */
  function looseAttachItems(piece: Piece): MenuItem[] {
    const attached = new Set(currentPattern.pieces.flatMap((p) => [...p.mainPaths, ...p.internalPaths].map((pp) => pp.path)));
    const loose = currentPattern.paths.filter((pa) => !attached.has(pa.id) && pa.pathPoints.length >= 2).slice(0, 6);
    if (loose.length === 0) return [];
    const attach = (pathId: string, kind: 'main' | 'internal') => {
      onchange(pieceAddPath($state.snapshot(currentPattern) as Pattern, piece.id, pathId, kind, uid));
      toast(kind === 'internal' ? 'Added internal path' : 'Added boundary edge', 'success');
    };
    const items: MenuItem[] = [];
    loose.forEach((pa, i) => {
      items.push({ label: `Add edge: ${pa.name || pa.id}`, icon: 'add_link', sep: i === 0, onClick: () => attach(pa.id, 'main') });
      items.push({ label: `Add internal: ${pa.name || pa.id}`, icon: 'timeline', onClick: () => attach(pa.id, 'internal') });
    });
    return items;
  }
  function nextPointName(p: Pattern): string {
    const prefix = p.pointPrefix || 'A';
    let n = p.points.length;
    const names = new Set(p.points.map((q) => q.name));
    while (names.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  /** Name an edge from its endpoint points, like the source ("LineA0A1" / "CurveA4A5"). */
  function edgeName(p: Pattern, fromId: string, toId: string, curve = false): string {
    const nm = (id: string) => p.points.find((q) => q.id === id)?.name ?? id.slice(0, 4);
    return `${curve ? 'Curve' : 'Line'}${nm(fromId)}${nm(toId)}`;
  }

  /** Add a free ConstrainablePoint at a world position; returns the new pattern + id. */
  function withNewPoint(p: Pattern, world: Vec2): { p: Pattern; id: string } {
    const id = uid('ConstrainablePoint');
    const points = [...p.points, { id, name: nextPointName(p), x: world.x, y: world.y, layerId: p.currentLayerId }];
    return { p: { ...p, points }, id };
  }

  /** A straight ConstrainablePath through an ordered list of point ids. */
  function lineThrough(ids: string[]): import('@seamer/pattern-model').ConstrainablePath {
    return { id: uid('ConstrainablePath'), name: '', pathType: 'line', pathPoints: ids.map((id) => ({ id })), version: 1 };
  }

  // ---- arc / circle tools ---------------------------------------------------
  type Anchor = { pos: Vec2; v1: Vec2; v2: Vec2 };
  const mkHandle = (v1: Vec2, v2: Vec2) => ({ v1, v2, sameLength: true, sameAngle: true, lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' } });

  /** Cubic-bezier anchors approximating an arc of `r` around `c` from angle a0→a1 (radians, CCW). */
  function arcAnchors(c: Vec2, r: number, a0: number, a1: number): Anchor[] {
    const span = a1 - a0;
    const nSeg = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2)));
    const dθ = span / nSeg;
    const k = (4 / 3) * Math.tan(dθ / 4) * r;
    const out: Anchor[] = [];
    for (let i = 0; i <= nSeg; i++) {
      const θ = a0 + dθ * i;
      const tx = -Math.sin(θ), ty = Math.cos(θ);
      out.push({ pos: { x: c.x + r * Math.cos(θ), y: c.y + r * Math.sin(θ) }, v1: { x: -tx * k, y: -ty * k }, v2: { x: tx * k, y: ty * k } });
    }
    return out;
  }

  /** Materialise anchors into ConstrainablePoints + a curve ConstrainablePath. */
  function addCurveFromAnchors(anchors: Anchor[], closed: boolean, arc?: import('@seamer/pattern-model').ArcParams) {
    let p = $state.snapshot(currentPattern) as Pattern;
    const ids: string[] = [];
    const newPoints = anchors.map((a, i) => {
      const id = uid('ConstrainablePoint');
      ids.push(id);
      return { id, name: `${p.pointPrefix || 'A'}${p.points.length + i}`, x: a.pos.x, y: a.pos.y };
    });
    // circle/center-arc: also place a live centre construction point that drives the parametric arc
    let arcMeta = arc;
    if (arc && (arc.kind === 'circle' || arc.kind === 'centerArc')) {
      const centerId = uid('ConstrainablePoint');
      newPoints.push({ id: centerId, name: `${p.pointPrefix || 'A'}${p.points.length + anchors.length}`, x: arc.cx, y: arc.cy });
      arcMeta = { ...arc, centerId };
    }
    const pathPoints = anchors.map((a, i) => ({ id: ids[i], handle: mkHandle(a.v1, a.v2) }));
    if (closed) pathPoints.push({ id: ids[0], handle: mkHandle(anchors[0].v1, anchors[0].v2) });
    const path = { id: uid('ConstrainablePath'), name: '', pathType: 'curve', pathPoints, version: 1, ...(arcMeta ? { arc: arcMeta } : {}) } as import('@seamer/pattern-model').ConstrainablePath;
    onchange({ ...p, points: [...p.points, ...newPoints], paths: [...p.paths, path], hasChanged: true });
  }

  function circumcircle(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-6) return null;
    const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
    const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
    const center = { x: ux, y: uy };
    return { c: center, r: Math.hypot(a.x - ux, a.y - uy) };
  }

  /** Handle a click for the active arc/circle tool; builds geometry once enough clicks land. */
  function arcClick(pos: Vec2) {
    const w = toPattern(pos.x, pos.y);
    const clicks = [...arcClicks, w];
    const tool = $selectedTool;
    if (tool === 'circle') {
      if (clicks.length < 2) { arcClicks = clicks; render(); return; }
      const r = Math.hypot(clicks[1].x - clicks[0].x, clicks[1].y - clicks[0].y);
      addCurveFromAnchors(arcAnchors(clicks[0], r, 0, Math.PI * 2), true,
        { kind: 'circle', cx: clicks[0].x, cy: clicks[0].y, r, a0: 0, a1: Math.PI * 2, closed: true });
      arcClicks = []; toast('Added circle', 'success');
    } else if (tool === 'arc-center') {
      if (clicks.length < 3) { arcClicks = clicks; render(); return; }
      const c0 = clicks[0];
      const r = Math.hypot(clicks[1].x - c0.x, clicks[1].y - c0.y);
      let a0 = Math.atan2(clicks[1].y - c0.y, clicks[1].x - c0.x);
      let a1 = Math.atan2(clicks[2].y - c0.y, clicks[2].x - c0.x);
      if (a1 <= a0) a1 += Math.PI * 2;
      addCurveFromAnchors(arcAnchors(c0, r, a0, a1), false,
        { kind: 'centerArc', cx: c0.x, cy: c0.y, r, a0, a1, closed: false });
      arcClicks = []; toast('Added arc', 'success');
    } else if (tool === 'arc-3pt') {
      if (clicks.length < 3) { arcClicks = clicks; render(); return; }
      const cc = circumcircle(clicks[0], clicks[1], clicks[2]);
      if (cc) {
        const ang = (pt: Vec2) => Math.atan2(pt.y - cc.c.y, pt.x - cc.c.x);
        let a0 = ang(clicks[0]), am = ang(clicks[1]), a1 = ang(clicks[2]);
        // choose the CCW direction a0→a1 that passes through the middle point
        const norm = (x: number) => { while (x < 0) x += Math.PI * 2; while (x >= Math.PI * 2) x -= Math.PI * 2; return x; };
        const dm = norm(am - a0), d1 = norm(a1 - a0);
        const end = dm <= d1 ? a0 + d1 : a0 + d1 - Math.PI * 2;
        addCurveFromAnchors(arcAnchors(cc.c, cc.r, a0, end), false,
          { kind: 'threePointArc', centerId: null, cx: cc.c.x, cy: cc.c.y, r: cc.r, a0, a1: end, closed: false });
        toast('Added arc', 'success');
      }
      arcClicks = [];
    }
    render();
  }

  function penOrPieceClick(pos: Vec2) {
    const world = toPattern(pos.x, pos.y);
    let p: Pattern = $state.snapshot(currentPattern) as Pattern;
    let pid = hitTestPoint(pos.x, pos.y);
    // close the loop (create-piece) when clicking the first point again
    if ($selectedTool === 'piece' && pid && penDraft.length >= 2 && pid === penDraft[0]) { finishDraft(); return; }
    if (!pid) {
      // snap onto a nearby path (or between two) so traced points land exactly on existing geometry
      const proj = projectPlacement(world, draftPathId);
      const r = withNewPoint(p, proj?.pos ?? world); p = r.p; pid = r.id;
    }
    const draft = [...penDraft, pid];
    penDraft = draft;
    if ($selectedTool === 'pen' || $selectedTool === 'internal') {
      // maintain one working line path through the placed points
      if (!draftPathId) { const path = lineThrough(draft); draftPathId = path.id; p = { ...p, paths: [...p.paths, path] }; }
      else p = { ...p, paths: p.paths.map((pa) => (pa.id === draftPathId ? { ...pa, pathPoints: draft.map((id) => ({ id })) } : pa)) };
    }
    onchange({ ...p, hasChanged: true });
    render();
  }

  function finishDraft() {
    const tool = $selectedTool;
    if (tool === 'internal') {
      // Attach the drafted polyline to the selected piece as an internal path (dart / fold line).
      if (penDraft.length < 2) { cancelDraft(); return; }
      const pieceId = [...pieceIds][0];
      const piece = pieceId ? currentPattern.pieces.find((p) => p.id === pieceId) : null;
      if (!piece || !draftPathId) { toast('Select a piece first, then draw the internal path', 'error'); cancelDraft(); return; }
      const from = penDraft[0], to = penDraft[penDraft.length - 1];
      const ip: import('@seamer/pattern-model').PiecePath = { id: uid('PiecePath'), name: 'Internal', path: draftPathId, from, to, reversed: false, notches: [], foldAngle: 0 };
      const pieces = currentPattern.pieces.map((p) => (p.id === piece.id ? { ...p, internalPaths: [...p.internalPaths, ip] } : p));
      onchange({ ...$state.snapshot(currentPattern) as Pattern, pieces, hasChanged: true });
      toast('Added internal path', 'success');
      penDraft = []; draftPathId = null; render();
      return;
    }
    if (tool === 'piece' && penDraft.length >= 3) {
      let p: Pattern = $state.snapshot(currentPattern) as Pattern;
      const loop = penDraft;
      const newPaths: import('@seamer/pattern-model').ConstrainablePath[] = [];
      const mainPaths: import('@seamer/pattern-model').PiecePath[] = [];
      for (let i = 0; i < loop.length; i++) {
        const from = loop[i], to = loop[(i + 1) % loop.length];
        const path = lineThrough([from, to]);
        path.name = edgeName(p, from, to);
        newPaths.push(path);
        mainPaths.push({ id: uid('PiecePath'), name: edgeName(p, from, to), path: path.id, from, to, reversed: false, notches: [] });
      }
      const originPoint = loop[0];
      const op = p.points.find((q) => q.id === originPoint)!;
      const piece: Piece = {
        id: uid('Piece'), name: `Piece ${p.pieces.length + 1}`, type: 'dynamic',
        materialId: p.materials[0]?.id ?? '', origin: { id: uid('Point'), name: '', x: 0, y: 0 },
        originPoint, position: { x: op.x, y: op.y }, rotation: 0,
        grainVector: { id: uid('Point'), name: '', x: 0, y: 1 }, text: null,
        rightPieces: 0, leftPieces: 0, mirrorLeftPiecesAxis: 'X', mirrorX: false, mirrorY: false,
        seamAllowanceInside: false, mainPaths, internalPaths: [],
        settings3d: {
          arrangement: { mode: 'flat', cylinderName: '', uDegrees: 0, v: 0.5, uOffsetMm: 0, vOffsetMm: 0, radialOffsetMm: 0, use2DPosition: true, positionChanged: false, matrixWorld: [], position: [] },
          enable3d: true, frozen: false, flipNormals: false, filterExternalCollisionsByClothNormal: false, collisionLayer: 0, savedPositions: []
        }
      };
      onchange({ ...p, paths: [...p.paths, ...newPaths], pieces: [...p.pieces, piece], hasChanged: true });
    }
    penDraft = []; draftPathId = null; render();
  }

  function cancelDraft() { penDraft = []; draftPathId = null; render(); }

  // ---- trace tool (auto-trace a piece from the HPGL overlay / background image) ----
  /** Materialise a traced outline (world mm) as a new piece of straight edges. */
  function createTracedPiece(outline: Vec2[]) {
    // ensure a counter-clockwise loop
    let area = 0;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) area += outline[j].x * outline[i].y - outline[i].x * outline[j].y;
    const loopPts = area < 0 ? outline.slice().reverse() : outline;
    let p: Pattern = $state.snapshot(currentPattern) as Pattern;
    const ids: string[] = [];
    for (const w of loopPts) { const r = withNewPoint(p, w); p = r.p; ids.push(r.id); }
    const newPaths: import('@seamer/pattern-model').ConstrainablePath[] = [];
    const mainPaths: import('@seamer/pattern-model').PiecePath[] = [];
    for (let i = 0; i < ids.length; i++) {
      const from = ids[i], to = ids[(i + 1) % ids.length];
      const path = lineThrough([from, to]);
      path.name = edgeName(p, from, to);
      newPaths.push(path);
      mainPaths.push({ id: uid('PiecePath'), name: edgeName(p, from, to), path: path.id, from, to, reversed: false, notches: [] });
    }
    const n = p.pieces.filter((pc) => /^Traced piece \d+$/.test(pc.name)).length + 1;
    const originPoint = ids[0];
    const op = p.points.find((q) => q.id === originPoint)!;
    const piece: Piece = {
      id: uid('Piece'), name: `Traced piece ${n}`, type: 'dynamic',
      materialId: p.materials[0]?.id ?? '', origin: { id: uid('Point'), name: '', x: 0, y: 0 },
      originPoint, position: { x: op.x, y: op.y }, rotation: 0,
      grainVector: { id: uid('Point'), name: '', x: 0, y: 1 }, text: null,
      rightPieces: 0, leftPieces: 0, mirrorLeftPiecesAxis: 'X', mirrorX: false, mirrorY: false,
      seamAllowanceInside: false, mainPaths, internalPaths: [],
      settings3d: {
        arrangement: { mode: 'flat', cylinderName: '', uDegrees: 0, v: 0.5, uOffsetMm: 0, vOffsetMm: 0, radialOffsetMm: 0, use2DPosition: true, positionChanged: false, matrixWorld: [], position: [] },
        enable3d: true, frozen: false, flipNormals: false, filterExternalCollisionsByClothNormal: false, collisionLayer: 0, savedPositions: []
      }
    };
    onchange({ ...p, paths: [...p.paths, ...newPaths], pieces: [...p.pieces, piece], hasChanged: true }, 'Trace piece');
    setPieceIds([piece.id]);
    toast(`Traced "${piece.name}" (${ids.length} points)`, 'success');
    selectedTool.set('select');
    render();
  }

  /** Trace-tool click: prefer a closed HPGL loop near the click, else the background image region. */
  function traceClick(pos: Vec2) {
    const world = toPattern(pos.x, pos.y);
    if (hpglPolys?.length) {
      // HPGL polylines are drawn offset by (bgX, bgY)
      const click = { x: world.x - bgX, y: world.y - bgY };
      const outline = traceFromHPGL(hpglPolys, click, { gapToleranceMm: 2, simplifyToleranceMm: 0.5, maxDistanceMm: 30 });
      if (outline) { createTracedPiece(outline.map((q) => ({ x: q.x + bgX, y: q.y + bgY }))); return; }
    }
    if (bgImage && bgImage.naturalWidth > 0) {
      // calibrated scan: trace on the TPS-warped world-space bitmap so traced pieces are true-scale
      const warped = warpEnabled && matchPairs.length > 0 ? ensureWarped() : null;
      if (warped) {
        const px = (world.x - warped.minX) * warped.pxPerMm;
        const py = (warped.maxY - world.y) * warped.pxPerMm;
        if (px >= 0 && py >= 0 && px < warped.canvas.width && py < warped.canvas.height) {
          const c2 = warped.canvas.getContext('2d', { willReadFrequently: true });
          if (c2) {
            const boundary = traceImageRegion(c2.getImageData(0, 0, warped.canvas.width, warped.canvas.height), px, py, { simplifyTolerancePx: Math.max(1, 0.5 * warped.pxPerMm) });
            if (boundary && boundary.length >= 3) {
              createTracedPiece(boundary.map((q) => ({ x: warped.minX + q.x / warped.pxPerMm, y: warped.maxY - q.y / warped.pxPerMm })));
              return;
            }
          }
          toast('Could not trace a shape here — click inside the outline you want to trace.', 'error');
          return;
        }
      }
      const W = bgImage.naturalWidth, H = bgImage.naturalHeight;
      const s = bgWidthMm / W; // mm per pixel
      const px = (world.x - bgX) / s + W / 2;
      const py = H / 2 - (world.y - bgY) / s;
      if (px >= 0 && py >= 0 && px < W && py < H) {
        const off = document.createElement('canvas');
        off.width = W; off.height = H;
        const c2 = off.getContext('2d');
        if (c2) {
          c2.drawImage(processedImage() ?? bgImage, 0, 0); // trace the filtered scan (threshold helps)
          const boundary = traceImageRegion(c2.getImageData(0, 0, W, H), px, py, { simplifyTolerancePx: Math.max(1, 0.5 / s) });
          if (boundary && boundary.length >= 3) {
            createTracedPiece(boundary.map((q) => ({ x: bgX + (q.x - W / 2) * s, y: bgY + (H / 2 - q.y) * s })));
            return;
          }
        }
        toast('Could not trace a shape here — click inside the outline you want to trace.', 'error');
        return;
      }
    }
    if (!hpglPolys?.length && !bgImage) toast('Load a background image or HPGL overlay first (Trace panel, top left).', 'error');
    else toast('Could not trace a shape here — click inside a closed outline.', 'error');
  }

  const DRAWING_TOOLS = new Set(['pen', 'piece', 'internal', 'point', 'text', 'image', 'trace', 'seam', 'seam-single', 'seam-multi', 'circle', 'arc', 'arc-center', 'arc-3pt']);
  function isDrawingTool(t: string) { return DRAWING_TOOLS.has(t); }

  /** Reset any in-progress operation and return to the select tool (Esc / V / Cancel button). */
  function cancelOperation() {
    penDraft = []; draftPathId = null; seamFromPicks = []; seamToPicks = []; seamPhase = 'from'; seamHover = null; arcClicks = []; measureFrom = null; measureChain = [];
    pendingPaste.set(null);
    selectedTool.set('select');
    render();
  }

  /** Bottom status-bar instruction for the active tool/operation (null = no bar). */
  const toolStatus = $derived.by(() => {
    if ($pathPickRequest) return `${$pathPickRequest.label} · Esc to cancel`;
    if (calibrating) return calibrating.src ? 'Calibrate: click the TRUE drafting position for the marked image feature · Esc to cancel' : 'Calibrate: click a known feature on the scanned image · Esc to cancel';
    if ($pendingPaste) return `Select where you want to place the ${$pendingPaste.items.length === 1 ? 'copy' : 'copies'} · Esc to cancel`;
    switch ($selectedTool) {
      case 'text': return 'Click to place text';
      case 'image': return 'Click to place an image, then choose a file';
      case 'trace': return hpglPolys?.length || bgImage ? 'Click inside a closed outline on the HPGL overlay or background image to trace a piece' : 'Load a background image or HPGL overlay (Trace panel), then click inside a shape to trace it';
      case 'point': return 'Click to add a point';
      case 'pen': return penDraft.length ? 'Click to add points · Enter to finish · Esc to cancel' : 'Click to start a path';
      case 'piece': return penDraft.length ? 'Click points to outline the piece · click the first point to close' : 'Click points to outline a new piece';
      case 'internal': return pieceIds.size !== 1 ? 'Select one piece first, then draw a dart / fold line' : penDraft.length ? 'Click to add points · Enter to attach to the piece · Esc to cancel' : 'Click to start an internal path in the selected piece';
      case 'seam': case 'seam-single': return seamFromPicks.length
        ? 'Click the matching edge to sew it (near the end where the seam starts)'
        : 'Click an edge to start a seam — click near the end where the seam starts';
      case 'seam-multi': return seamPhase === 'from'
        ? (seamFromPicks.length
            ? `Select seam segments (${seamFromPicks.length}). Press Enter or tap Next to choose matching segments.`
            : 'Select seam segments. Press Enter or tap Next to choose matching segments.')
        : `Select matching segments (${seamToPicks.length}). Press Enter or tap Finish.`;
      case 'circle': return arcClicks.length ? 'Click to set the radius' : 'Click to set the centre of the circle';
      case 'arc-center': return ['Click to set the centre of the arc', 'Click to set the radius / start', 'Click to set the end of the arc'][arcClicks.length] ?? '';
      case 'arc-3pt': return ['Click the first point of the arc', 'Click a point on the arc', 'Click the last point of the arc'][arcClicks.length] ?? '';
      case 'arc': return 'Arc/circle tools';
      case 'measure': return measureMode === 'angle'
        ? (measureChain.length === 0 ? 'Angle: click the first arm point' : measureChain.length === 1 ? 'Angle: click the vertex point' : 'Angle: click the second arm point to save · Esc to cancel')
        : (measureFrom ? 'Click the second point to save the measurement · Esc to cancel' : 'Click two points to measure — saved measurements stay on the canvas');
      default: return null;
    }
  });

  function insertTextAt(pos: Vec2) {
    const world = toPattern(pos.x, pos.y);
    const value = prompt('Text:');
    if (!value) return;
    const p = $state.snapshot(currentPattern) as Pattern;
    const text = { id: uid('Text'), value, x: world.x, y: world.y, fontSize: 15, color: '#1e293b', align: 'center' as const, rotation: 0 } as import('@seamer/pattern-model').PatternText;
    onchange({ ...p, texts: [...p.texts, text], hasChanged: true });
  }

  function insertImageAt(pos: Vec2) {
    const world = toPattern(pos.x, pos.y);
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        const probe = new Image();
        probe.onload = () => {
          const widthMm = 150;
          const heightMm = widthMm * (probe.naturalHeight / probe.naturalWidth || 1);
          const p = $state.snapshot(currentPattern) as Pattern;
          const image = { id: uid('Image'), url, x: world.x, y: world.y, width: widthMm, height: heightMm, rotation: 0, opacity: 1 } as import('@seamer/pattern-model').PatternImage;
          onchange({ ...p, images: [...p.images, image], hasChanged: true });
          toast('Inserted image', 'success');
          selectedTool.set('select');
        };
        probe.src = url;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  /** Hit-test ANY ConstrainablePath: placed piece edges first (their base path), then loose
   *  construction paths in draft space. For the modal path picker and drag-onto-path conversion. */
  function hitTestAnyPath(pos: Vec2): string | null {
    const edge = hitTestSeamEdge(pos);
    if (edge) {
      const owner = pieceOwnerOf(edge.id);
      if (owner) return owner.pp.path;
    }
    const points = indexPoints(currentPattern);
    const world = toPattern(pos.x, pos.y);
    const tol = 10 / baseScale();
    let best: string | null = null, bestD = tol;
    for (const path of currentPattern.paths) {
      if (!layerVisible(path.layerId)) continue;
      const poly = pathPolyline(path, points, 4);
      for (let i = 1; i < poly.length; i++) {
        const d = distToSeg(world, poly[i - 1], poly[i]);
        if (d < bestD) { bestD = d; best = path.id; }
      }
    }
    return best;
  }

  // ---- Piece points (piece-local construction points, the original's AddPiecePointTool) ----------
  let dragPiecePt: { id: string; invert: (w: Vec2) => Vec2 } | null = null;

  function piecePointClick(pos: Vec2) {
    const world = toPattern(pos.x, pos.y);
    const paths = indexPaths(currentPattern);
    const points = indexPoints(currentPattern);
    for (const piece of currentPattern.pieces) {
      if (piece.hidden || !layerVisible(piece.layerId) || layerLocked(piece.layerId)) continue;
      if (piece.type !== 'dynamic') continue;
      if (!pointInPolygon(world, pieceDisplayOutline(currentPattern, piece, paths, points, 6))) continue;
      const draft = pieceInverseTransform(piece, points)(world);
      const next = piecePointAdd($state.snapshot(currentPattern) as Pattern, piece.id, draft.x, draft.y, undefined, uid);
      if (next !== currentPattern) { onchange(next, 'Add piece point'); toast('Piece point added', 'success'); }
      return;
    }
    toast('Click inside a dynamic piece to add a piece point', 'error');
  }

  function hitTestPiecePoint(cx: number, cy: number): { id: string; invert: (w: Vec2) => Vec2 } | null {
    const points = indexPoints(currentPattern);
    for (const piece of currentPattern.pieces) {
      if (piece.hidden || !layerVisible(piece.layerId) || layerLocked(piece.layerId)) continue;
      const tf = pieceTransform(piece, points, pieceShrinkageScale(currentPattern, piece));
      for (const pt of piece.piecePoints ?? []) {
        const cp = toCanvas(tf(pt));
        if (Math.hypot(cp.x - cx, cp.y - cy) <= HOVER_THRESHOLD) {
          return { id: pt.id, invert: pieceInverseTransform(piece, points) };
        }
      }
    }
    return null;
  }

  /** Rich edge hit-test for the seam tools: nearest PiecePath plus the arc-length ratio `t` of the
   *  click projection (drives reversed inference) and whether the MIRRORED half was hit. In seam
   *  mode, mirrored halves AND internal paths (pockets/yokes sew to internal lines) are candidates. */
  function hitTestSeamEdge(pos: Vec2, seamMode = false): { id: string; t: number; mirrored: boolean } | null {
    const paths = indexPaths(currentPattern);
    const points = indexPoints(currentPattern);
    const world = toPattern(pos.x, pos.y);
    const tol = 10 / baseScale();
    let best: { id: string; t: number; mirrored: boolean } | null = null;
    let bestD = tol;
    const testPoly = (poly: Vec2[], id: string, mirrored: boolean) => {
      let hitSeg = -1, hitT = 0;
      for (let i = 1; i < poly.length; i++) {
        const d = distToSeg(world, poly[i - 1], poly[i]);
        if (d < bestD) { bestD = d; hitSeg = i; hitT = projOnSeg(world, poly[i - 1], poly[i]); }
      }
      if (hitSeg < 0) return;
      // arc-length ratio of the projection along the whole polyline
      let total = 0, upto = 0;
      for (let i = 1; i < poly.length; i++) {
        const l = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
        if (i < hitSeg) upto += l;
        else if (i === hitSeg) upto += l * hitT;
        total += l;
      }
      best = { id, t: total > 0 ? upto / total : 0, mirrored };
    };
    for (const piece of currentPattern.pieces) {
      if (piece.hidden || !layerVisible(piece.layerId) || layerLocked(piece.layerId)) continue;
      const tf = pieceTransform(piece, points, pieceShrinkageScale(currentPattern, piece));
      const axis = seamMode ? pieceMirrorAxis(piece, points) : null;
      const candidates = seamMode ? [...piece.mainPaths, ...piece.internalPaths] : piece.mainPaths;
      for (const pp of candidates) {
        const raw = piecePathPolyline(pp, paths, points, 4);
        testPoly(raw.map(tf), pp.id, false);
        if (axis && !pp.isMirrorLine) {
          testPoly(raw.map((p) => reflectAcrossLine(p, axis.a, axis.b)).map(tf), pp.id, true);
        }
      }
    }
    return best;
  }

  /** Hit-test a piece boundary edge (returns the PiecePath id), for edge selection. */
  function hitTestEdge(pos: Vec2): string | null {
    return hitTestSeamEdge(pos)?.id ?? null;
  }
  function projOnSeg(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  }
  function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /** Closest projection of a drafting-space position onto any path within `tol` (the original's
   *  closeToPath + getClosestProjectedPoint). `exclude` skips paths (e.g. the point's own). */
  function nearestPathProjection(world: Vec2, tol: number, exclude?: (path: import('@seamer/pattern-model').ConstrainablePath) => boolean):
    { pathId: string; fraction: number; pos: Vec2; dist: number } | null {
    const points = indexPoints(currentPattern);
    let best: { pathId: string; fraction: number; pos: Vec2; dist: number } | null = null;
    let bestD = tol;
    for (const path of currentPattern.paths) {
      if (exclude?.(path)) continue;
      const poly = pathPolyline(path, points, 4);
      const cum = [0];
      for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
      const total = cum[cum.length - 1] || 1;
      for (let i = 1; i < poly.length; i++) {
        const d = distToSeg(world, poly[i - 1], poly[i]);
        if (d < bestD) {
          bestD = d;
          const f = projOnSeg(world, poly[i - 1], poly[i]);
          best = {
            pathId: path.id,
            fraction: (cum[i - 1] + (cum[i] - cum[i - 1]) * f) / total,
            pos: { x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * f, y: poly[i - 1].y + (poly[i].y - poly[i - 1].y) * f },
            dist: d
          };
        }
      }
    }
    return best;
  }

  /** Where a new point should land near existing geometry (the original's getPickedPoint): on the
   *  closest path, or midway between two overlapping paths (then it belongs to neither — no slide). */
  function projectPlacement(world: Vec2, excludePathId?: string | null): { pos: Vec2; slide: { pathId: string; fraction: number } | null } | null {
    const tol = 6 / baseScale();
    const a = nearestPathProjection(world, tol, (path) => path.id === excludePathId);
    if (!a) return null;
    const b = nearestPathProjection(world, tol, (path) => path.id === excludePathId || path.id === a.pathId);
    if (b) return { pos: { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 }, slide: null };
    return { pos: a.pos, slide: { pathId: a.pathId, fraction: Math.round(a.fraction * 1000) / 1000 } };
  }

  /** Resolve a click into a seam pick: edge id + orientation inferred from the click position
   *  (nearer the path's end ⇒ reversed, the original computeReverseForPoint) + mirrored-half flag. */
  function seamPickAt(pos: Vec2): SeamPick | null {
    const hit = hitTestSeamEdge(pos, true);
    if (!hit) return null;
    return { id: hit.id, reversed: hit.t > 0.5, mirrored: hit.mirrored };
  }

  function commitSeam(from: SeamPick[], to: SeamPick[]) {
    const p = $state.snapshot(currentPattern) as Pattern;
    const seam = {
      id: uid('Seam'), name: '',
      fromPaths: from.map((r) => ({ ...r })),
      toPaths: to.map((r) => ({ ...r }))
    };
    onchange({ ...p, seams: [...p.seams, seam], hasChanged: true }, 'Add seam');
    selectedSeamId.set(seam.id); // the original selects the seam it just created
    resetSeamTool();
  }

  function resetSeamTool() {
    seamTool.set(EMPTY_SEAM_TOOL);
    seamHover = null;
  }

  /** Route a pick through the shared tool state machine; commit when it completes a seam. */
  function routeSeamPick(kind: 'single' | 'multi', pick: SeamPick) {
    const res = applySeamPick(kind, { from: seamFromPicks, to: seamToPicks, phase: seamPhase }, pick);
    if (res.commit) commitSeam(res.commit.from, res.commit.to);
    else seamTool.set(res.state);
    render();
  }

  function seamClick(pos: Vec2) {
    const pick = seamPickAt(pos);
    if (pick) routeSeamPick('single', pick);
  }

  /** Multi-seam, two-phase (like the original MultiSeamTool): select any number of "from" segments,
   *  Enter/Next, then the matching "to" segments, Enter/Finish. Clicking a picked segment deselects. */
  function seamMultiClick(pos: Vec2) {
    const pick = seamPickAt(pos);
    if (pick) routeSeamPick('multi', pick);
  }
  function advanceSeamPhase() {
    const res = advanceSeamToolPhase({ from: seamFromPicks, to: seamToPicks, phase: seamPhase });
    if (res.commit) commitSeam(res.commit.from, res.commit.to);
    else seamTool.set(res.state);
    if (res.message) toast(res.message);
    render();
  }
  function finishMultiSeam() {
    if (seamFromPicks.length > 0 && seamToPicks.length > 0) commitSeam(seamFromPicks, seamToPicks);
    else resetSeamTool();
    render();
  }

  /** World polyline for a seam pick/ref: mirrored reflection + piece transform + reversed applied. */
  function seamPickPoly(
    pick: { id: string; reversed?: boolean; mirrored?: boolean },
    paths = indexPaths(currentPattern),
    points = indexPoints(currentPattern)
  ): Vec2[] | null {
    const owner = pieceOwnerOf(pick.id);
    if (!owner) return null;
    const tf = pieceTransform(owner.piece, points, pieceShrinkageScale(currentPattern, owner.piece));
    let raw = piecePathPolyline(owner.pp, paths, points, 4);
    if (pick.mirrored) {
      const ax = pieceMirrorAxis(owner.piece, points);
      if (ax) raw = raw.map((p) => reflectAcrossLine(p, ax.a, ax.b));
    }
    let poly = raw.map(tf);
    if (pick.reversed) poly = poly.slice().reverse();
    return poly.length >= 2 ? poly : null;
  }

  /** Mid-path direction arrow (the original's PathDirectionOverlay): a small triangle at the
   *  polyline's arc-length midpoint pointing along its (possibly reversed) direction. */
  function drawDirectionArrow(c: CanvasRenderingContext2D, polyWorld: Vec2[], color: string) {
    if (polyWorld.length < 2) return;
    let total = 0;
    for (let i = 1; i < polyWorld.length; i++) total += Math.hypot(polyWorld[i].x - polyWorld[i - 1].x, polyWorld[i].y - polyWorld[i - 1].y);
    if (total <= 0) return;
    let upto = 0, j = 1;
    const half = total / 2;
    for (; j < polyWorld.length; j++) {
      const l = Math.hypot(polyWorld[j].x - polyWorld[j - 1].x, polyWorld[j].y - polyWorld[j - 1].y);
      if (upto + l >= half) break;
      upto += l;
    }
    j = Math.min(j, polyWorld.length - 1);
    const a = toCanvas(polyWorld[j - 1]);
    const b = toCanvas(polyWorld[j]);
    const segLenW = Math.hypot(polyWorld[j].x - polyWorld[j - 1].x, polyWorld[j].y - polyWorld[j - 1].y) || 1;
    const f = Math.max(0, Math.min(1, (half - upto) / segLenW));
    const mx = a.x + (b.x - a.x) * f, my = a.y + (b.y - a.y) * f;
    const dl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dx = (b.x - a.x) / dl, dy = (b.y - a.y) / dl;
    const s = 9; // px
    c.save();
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(mx + dx * s, my + dy * s);
    c.lineTo(mx - dx * s * 0.6 - dy * s * 0.6, my - dy * s * 0.6 + dx * s * 0.6);
    c.lineTo(mx - dx * s * 0.6 + dy * s * 0.6, my - dy * s * 0.6 - dx * s * 0.6);
    c.closePath();
    c.fill();
    c.restore();
  }

  /** Live preview "rungs" between the candidate from/to sides while the seam tool is active —
   *  the original's calculateSeamPreviewConnections (includes the hovered, not-yet-clicked edge). */
  function drawSeamPreviewRungs(
    c: CanvasRenderingContext2D,
    paths = indexPaths(currentPattern),
    points = indexPoints(currentPattern)
  ) {
    if (seamFromPicks.length === 0) return;
    let toSide: SeamPick[];
    if ($selectedTool === 'seam-multi') {
      toSide = [...seamToPicks];
      if (seamPhase === 'to' && seamHover &&
          !seamFromPicks.some((r) => samePick(r, seamHover!)) &&
          !seamToPicks.some((r) => samePick(r, seamHover!))) toSide.push(seamHover);
    } else {
      toSide = seamHover && !samePick(seamFromPicks[0], seamHover) ? [seamHover] : [];
    }
    if (toSide.length === 0) return;
    const composite = (picks: SeamPick[]): Vec2[] => {
      const out: Vec2[] = [];
      for (const pk of picks) {
        const poly = seamPickPoly(pk, paths, points);
        if (!poly) continue;
        if (out.length) out.push(...poly.slice(1)); else out.push(...poly);
      }
      return out;
    };
    const fromC = composite(seamFromPicks);
    const toC = composite(toSide);
    if (fromC.length < 2 || toC.length < 2) return;
    const n = Math.max(2, Math.min(12, Math.round(Math.max(
      fromC.reduce((s, p, i) => i ? s + Math.hypot(p.x - fromC[i - 1].x, p.y - fromC[i - 1].y) : 0, 0),
      toC.reduce((s, p, i) => i ? s + Math.hypot(p.x - toC[i - 1].x, p.y - toC[i - 1].y) : 0, 0)
    ) / 40)));
    const a = resamplePolyline(fromC, n);
    const b = resamplePolyline(toC, n);
    c.save();
    c.strokeStyle = isDark ? 'rgba(226,232,240,0.5)' : 'rgba(51,65,85,0.45)';
    c.lineWidth = 1;
    c.setLineDash([4, 4]);
    for (let i = 0; i < n; i++) {
      const pa = toCanvas(a[i]), pb = toCanvas(b[i]);
      c.beginPath(); c.moveTo(pa.x, pa.y); c.lineTo(pb.x, pb.y); c.stroke();
    }
    c.restore();
  }

  // ---- Measure tool: persistent distance + angle measurements ------------------------------------
  /** Within this tolerance of the target a measurement label reads green, otherwise red. */
  const MEASURE_TOL_MM = 1;
  const MEASURE_TOL_DEG = 0.5;
  let selectedMeasurementId = $state<string | null>(null);
  /** distance: click two points; angle: click A, then the vertex, then B */
  let measureMode = $state<'distance' | 'angle'>('distance');
  let measureChain = $state<string[]>([]);

  /** mm → the pattern's display unit. */
  const mmToUnit = (mm: number) =>
    currentPattern.lengthUnit === 'inch' ? mm / 25.4 : currentPattern.lengthUnit === 'cm' ? mm / 10 : mm;
  /** the pattern's display unit → mm. */
  const unitToMm = (v: number) =>
    currentPattern.lengthUnit === 'inch' ? v * 25.4 : currentPattern.lengthUnit === 'cm' ? v * 10 : v;

  function saveMeasurement(m: Omit<Measurement, 'id' | 'name'>) {
    const p = $state.snapshot(currentPattern) as Pattern;
    const full: Measurement = { id: uid('Measurement'), name: `Measure ${(p.measurements ?? []).length + 1}`, ...m };
    onchange({ ...p, measurements: [...(p.measurements ?? []), full], hasChanged: true }, 'Add measurement');
    selectedMeasurementId = full.id;
  }

  /** Measure tool click: distance arms one point then saves on the second; angle chains A → vertex → B. */
  function measureClick(pos: Vec2) {
    const hit = hitTestPoint(pos.x, pos.y);
    if (!hit) { measureFrom = null; measureChain = []; render(); return; }
    if (measureMode === 'angle') {
      if (measureChain.includes(hit)) { render(); return; }
      const chain = [...measureChain, hit];
      if (chain.length === 3) {
        saveMeasurement({ kind: 'angle', fromPointId: chain[0], viaPointId: chain[1], toPointId: chain[2], targetMm: null });
        measureChain = [];
      } else {
        measureChain = chain;
      }
      render();
      return;
    }
    if (measureFrom && hit !== measureFrom) {
      saveMeasurement({ kind: 'distance', fromPointId: measureFrom, toPointId: hit, targetMm: null });
      measureFrom = null;
    } else {
      measureFrom = hit;
    }
    render();
  }

  /** Inner angle (degrees, 0..180) at `v` between rays v→a and v→b. */
  function angleAtDeg(a: Vec2, v: Vec2, b: Vec2): number {
    const a1 = Math.atan2(a.y - v.y, a.x - v.x);
    const a2 = Math.atan2(b.y - v.y, b.x - v.x);
    let d = Math.abs(a1 - a2) * (180 / Math.PI);
    if (d > 180) d = 360 - d;
    return d;
  }

  /** Current world endpoints of a measurement, or null when an endpoint no longer exists. */
  function measurementEndpoints(m: Measurement): { a: Vec2; v: Vec2 | null; b: Vec2 } | null {
    const placed = editorPlacedPoints(currentPattern, indexPoints(currentPattern));
    const a = placed.find((p) => p.pointId === m.fromPointId)?.world;
    const b = placed.find((p) => p.pointId === m.toPointId)?.world;
    const v = m.viaPointId ? placed.find((p) => p.pointId === m.viaPointId)?.world ?? null : null;
    if (!a || !b || (m.kind === 'angle' && !v)) return null;
    return { a, v, b };
  }
  /** Measured value: mm for distance measurements, degrees for angle measurements. */
  const measuredValue = (m: Measurement): number | null => {
    const e = measurementEndpoints(m);
    if (!e) return null;
    return m.kind === 'angle' ? angleAtDeg(e.a, e.v!, e.b) : Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
  };
  const measureTol = (m: Measurement) => (m.kind === 'angle' ? MEASURE_TOL_DEG : MEASURE_TOL_MM);

  function updateMeasurement(id: string, patch: Partial<Measurement>, label = 'Edit measurement') {
    const p = $state.snapshot(currentPattern) as Pattern;
    onchange({ ...p, measurements: (p.measurements ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)), hasChanged: true }, label);
  }
  function deleteMeasurement(id: string) {
    const p = $state.snapshot(currentPattern) as Pattern;
    onchange({ ...p, measurements: (p.measurements ?? []).filter((m) => m.id !== id), hasChanged: true }, 'Delete measurement');
    if (selectedMeasurementId === id) selectedMeasurementId = null;
  }

  /** Centre + zoom the 2D view on a measurement (the source's zoomToMeasurement). */
  function zoomToMeasurement(m: Measurement) {
    const e = measurementEndpoints(m);
    if (!e) return;
    selectedMeasurementId = m.id;
    const pts = e.v ? [e.a, e.v, e.b] : [e.a, e.b];
    const minX = Math.min(...pts.map((q) => q.x)), maxX = Math.max(...pts.map((q) => q.x));
    const minY = Math.min(...pts.map((q) => q.y)), maxY = Math.max(...pts.map((q) => q.y));
    viewOffset = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const dist = Math.max(20, maxX - minX, maxY - minY);
    zoom.set(Math.max(0.05, Math.min(20, (Math.min(canvasW, canvasH) * 0.6) / (dist * currentPattern.graphicsScale))));
    panOffset.set({ x: 0, y: 0 });
    render();
  }

  /** Saved measurement lines + labels, plus the measure tool's live rubber-band preview. */
  function drawMeasurements(c: CanvasRenderingContext2D, points: Map<string, import('@seamer/pattern-model').ConstrainablePoint>) {
    const list = currentPattern.measurements ?? [];
    const toolActive = $selectedTool === 'measure';
    const show = currentPattern.showMeasurements !== false || toolActive;
    if (!show || (list.length === 0 && !measureFrom && measureChain.length === 0)) return;
    const placed = editorPlacedPoints(currentPattern, points);
    const byId = new Map(placed.map((p) => [p.pointId, p.world]));
    const u = currentPattern.lengthUnit;
    c.save();
    c.font = 'bold 11px sans-serif';
    c.textAlign = 'left';
    const drawLabel = (label: string, mx: number, my: number, color: string) => {
      const tw = c.measureText(label).width;
      c.fillStyle = isDark ? 'rgba(15,23,42,0.85)' : 'rgba(255,255,255,0.85)';
      c.fillRect(mx - 3, my - 11, tw + 6, 14);
      c.fillStyle = color;
      c.fillText(label, mx, my);
    };
    for (const m of list) {
      const e = measurementEndpoints(m);
      if (!e) continue; // an endpoint was deleted
      const selected = m.id === selectedMeasurementId;
      c.strokeStyle = '#f97316';
      c.lineWidth = selected ? 2.25 : 1.25;
      if (m.kind === 'angle' && e.v) {
        const cv = toCanvas(e.v), ca = toCanvas(e.a), cb = toCanvas(e.b);
        c.setLineDash([5, 3]);
        c.beginPath(); c.moveTo(cv.x, cv.y); c.lineTo(ca.x, ca.y); c.stroke();
        c.beginPath(); c.moveTo(cv.x, cv.y); c.lineTo(cb.x, cb.y); c.stroke();
        c.setLineDash([]);
        // arc at the vertex spanning the inner angle (canvas y is flipped, so negate angles)
        const r = Math.min(28, Math.hypot(ca.x - cv.x, ca.y - cv.y) * 0.5, Math.hypot(cb.x - cv.x, cb.y - cv.y) * 0.5);
        let t1 = Math.atan2(ca.y - cv.y, ca.x - cv.x);
        let t2 = Math.atan2(cb.y - cv.y, cb.x - cv.x);
        let sweep = t2 - t1;
        while (sweep > Math.PI) sweep -= Math.PI * 2;
        while (sweep < -Math.PI) sweep += Math.PI * 2;
        c.beginPath(); c.arc(cv.x, cv.y, r, t1, t1 + sweep, sweep < 0); c.stroke();
        c.fillStyle = '#f97316';
        for (const p of [ca, cv, cb]) { c.beginPath(); c.arc(p.x, p.y, 2.5, 0, Math.PI * 2); c.fill(); }
        const deg = angleAtDeg(e.a, e.v, e.b);
        const err = m.targetMm != null ? deg - m.targetMm : 0;
        const label = `${m.name}: ${deg.toFixed(1)}°` + (m.targetMm != null ? ` (${err >= 0 ? '+' : ''}${err.toFixed(1)}°)` : '');
        drawLabel(label, cv.x + r + 6, cv.y - 6, m.targetMm != null ? (Math.abs(err) <= MEASURE_TOL_DEG ? '#16a34a' : '#dc2626') : '#f97316');
        continue;
      }
      const ca = toCanvas(e.a), cb = toCanvas(e.b);
      c.setLineDash([5, 3]);
      c.beginPath(); c.moveTo(ca.x, ca.y); c.lineTo(cb.x, cb.y); c.stroke();
      c.setLineDash([]);
      c.fillStyle = '#f97316';
      for (const p of [ca, cb]) { c.beginPath(); c.arc(p.x, p.y, 2.5, 0, Math.PI * 2); c.fill(); }
      const dmm = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
      const err = m.targetMm != null ? dmm - m.targetMm : 0;
      const label = `${m.name}: ${mmToUnit(dmm).toFixed(2)} ${u}` +
        (m.targetMm != null ? ` (${err >= 0 ? '+' : ''}${mmToUnit(err).toFixed(2)})` : '');
      drawLabel(label, (ca.x + cb.x) / 2 + 6, (ca.y + cb.y) / 2 - 6, m.targetMm != null ? (Math.abs(err) <= MEASURE_TOL_MM ? '#16a34a' : '#dc2626') : '#f97316');
    }
    // live preview: distance rubber-band, or the angle chain so far
    if (toolActive && measureMode === 'distance' && measureFrom) {
      const a = byId.get(measureFrom);
      const b = hoveredPointId ? byId.get(hoveredPointId) : undefined;
      if (a) {
        const ca = toCanvas(a);
        const cb = b ? toCanvas(b) : cursorPos;
        c.strokeStyle = '#f97316';
        c.setLineDash([4, 3]);
        c.beginPath(); c.moveTo(ca.x, ca.y); c.lineTo(cb.x, cb.y); c.stroke();
        c.setLineDash([]);
        if (b) {
          c.fillStyle = '#f97316';
          c.font = 'bold 12px sans-serif';
          c.fillText(`${mmToUnit(Math.hypot(b.x - a.x, b.y - a.y)).toFixed(2)} ${u}`, (ca.x + cb.x) / 2 + 6, (ca.y + cb.y) / 2 - 6);
        }
      }
    }
    if (toolActive && measureMode === 'angle' && measureChain.length > 0) {
      const pts = measureChain.map((id) => byId.get(id)).filter(Boolean) as Vec2[];
      c.strokeStyle = '#f97316';
      c.setLineDash([4, 3]);
      c.beginPath();
      const p0 = toCanvas(pts[0]);
      c.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) { const q = toCanvas(pts[i]); c.lineTo(q.x, q.y); }
      c.lineTo(cursorPos.x, cursorPos.y);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = '#f97316';
      for (const p of pts) { const q = toCanvas(p); c.beginPath(); c.arc(q.x, q.y, 2.5, 0, Math.PI * 2); c.fill(); }
    }
    c.restore();
  }

  // ---- Auto-scroll: pan the view while a drag approaches the canvas edge --------------------------
  const AUTO_EDGE = 28; // px band at each edge that triggers scrolling
  const AUTO_SPEED = 14; // max px/frame at the very edge
  let autoScrollVec: Vec2 | null = null;
  let autoScrollRaf = 0;

  function updateAutoScroll(pos: Vec2) {
    const active = isDragging || isMarquee || penDragging || !!gizmoDrag || !!$pendingPaste;
    let vx = 0, vy = 0;
    if (active) {
      if (pos.x < AUTO_EDGE) vx = -(AUTO_EDGE - pos.x) / AUTO_EDGE;
      else if (pos.x > canvasW - AUTO_EDGE) vx = (pos.x - (canvasW - AUTO_EDGE)) / AUTO_EDGE;
      if (pos.y < AUTO_EDGE) vy = -(AUTO_EDGE - pos.y) / AUTO_EDGE;
      else if (pos.y > canvasH - AUTO_EDGE) vy = (pos.y - (canvasH - AUTO_EDGE)) / AUTO_EDGE;
    }
    if (vx === 0 && vy === 0) { autoScrollVec = null; return; }
    autoScrollVec = { x: vx, y: vy };
    if (!autoScrollRaf) autoScrollRaf = requestAnimationFrame(autoScrollTick);
  }
  function autoScrollTick() {
    autoScrollRaf = 0;
    if (!autoScrollVec) return;
    // pan so the content under the cursor scrolls into view (content moves opposite the push)
    panOffset.set({ x: currentPanX - autoScrollVec.x * AUTO_SPEED, y: currentPanY - autoScrollVec.y * AUTO_SPEED });
    autoScrollRaf = requestAnimationFrame(autoScrollTick);
  }
  function stopAutoScroll() {
    autoScrollVec = null;
    if (autoScrollRaf) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = 0; }
  }

  // ---- Selection transform gizmo: rotate + scale handles on the multi-point selection bbox --------
  let gizmoDrag: {
    kind: 'rotate' | 'scale';
    center: Vec2; // centroid of the points' raw drafting coords (selectionRotate semantics)
    startAngle: number;
    startDist: number;
    orig: { id: string; x: number; y: number }[];
  } | null = null;

  /** Canvas-space gizmo geometry for the current multi-point selection (null = no gizmo). */
  function selectionGizmo(): { min: Vec2; max: Vec2; rotate: Vec2; scale: Vec2 } | null {
    if ($selectedTool !== 'select' || pointIds.size < 2) return null;
    const sel = pointIds;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let n = 0;
    for (const pp of editorPlacedPoints(currentPattern)) {
      if (!sel.has(pp.pointId)) continue;
      const cp = toCanvas(pp.world);
      minX = Math.min(minX, cp.x); maxX = Math.max(maxX, cp.x);
      minY = Math.min(minY, cp.y); maxY = Math.max(maxY, cp.y);
      n++;
    }
    if (n < 2) return null;
    const pad = 12;
    const min = { x: minX - pad, y: minY - pad }, max = { x: maxX + pad, y: maxY + pad };
    return { min, max, rotate: { x: (min.x + max.x) / 2, y: min.y - 22 }, scale: { x: max.x, y: max.y } };
  }

  /** Begin a gizmo drag if the press hit the rotate/scale handle. */
  function gizmoMouseDown(pos: Vec2): boolean {
    const g = selectionGizmo();
    if (!g) return false;
    const near = (h: Vec2) => Math.hypot(pos.x - h.x, pos.y - h.y) < 10;
    const kind = near(g.rotate) ? 'rotate' : near(g.scale) ? 'scale' : null;
    if (!kind) return false;
    const orig = currentPattern.points
      .filter((q) => pointIds.has(q.id))
      .map((q) => ({ id: q.id, x: q.x, y: q.y }));
    const center = {
      x: orig.reduce((s, q) => s + q.x, 0) / orig.length,
      y: orig.reduce((s, q) => s + q.y, 0) / orig.length
    };
    const cur = toPattern(pos.x, pos.y);
    gizmoDrag = {
      kind,
      center,
      startAngle: Math.atan2(cur.y - center.y, cur.x - center.x),
      startDist: Math.max(1e-6, Math.hypot(cur.x - center.x, cur.y - center.y)),
      orig
    };
    return true;
  }

  /** Apply the live gizmo transform for the current cursor position. */
  function gizmoMouseMove(pos: Vec2, shift: boolean) {
    if (!gizmoDrag) return;
    const { kind, center, orig } = gizmoDrag;
    const cur = toPattern(pos.x, pos.y);
    let map: Map<string, Vec2>;
    if (kind === 'rotate') {
      let ang = Math.atan2(cur.y - center.y, cur.x - center.x) - gizmoDrag.startAngle;
      if (shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12); // 15° steps
      const cos = Math.cos(ang), sin = Math.sin(ang);
      map = new Map(orig.map((q) => [q.id, {
        x: center.x + (q.x - center.x) * cos - (q.y - center.y) * sin,
        y: center.y + (q.x - center.x) * sin + (q.y - center.y) * cos
      }]));
    } else {
      let f = Math.hypot(cur.x - center.x, cur.y - center.y) / gizmoDrag.startDist;
      f = Math.max(0.05, Math.min(20, f));
      if (shift) f = Math.round(f * 20) / 20; // 5% steps
      map = new Map(orig.map((q) => [q.id, { x: center.x + (q.x - center.x) * f, y: center.y + (q.y - center.y) * f }]));
    }
    const points = currentPattern.points.map((p) => (map.has(p.id) ? { ...p, ...map.get(p.id)! } : p));
    onchange({ ...currentPattern, points, hasChanged: true });
  }

  /** Dashed selection bbox + rotate/scale handles (select tool, ≥2 points). */
  function drawSelectionGizmo(c: CanvasRenderingContext2D) {
    const g = selectionGizmo();
    if (!g) return;
    c.save();
    c.strokeStyle = '#2563eb';
    c.lineWidth = 1;
    c.setLineDash([4, 3]);
    c.strokeRect(g.min.x, g.min.y, g.max.x - g.min.x, g.max.y - g.min.y);
    c.setLineDash([]);
    // rotate handle: stem + circle above the top edge
    c.beginPath(); c.moveTo((g.min.x + g.max.x) / 2, g.min.y); c.lineTo(g.rotate.x, g.rotate.y + 6); c.stroke();
    c.beginPath(); c.arc(g.rotate.x, g.rotate.y, 6, 0, Math.PI * 2);
    c.fillStyle = '#fff'; c.fill(); c.stroke();
    c.beginPath(); c.arc(g.rotate.x, g.rotate.y, 2.4, 0, Math.PI * 2); c.fillStyle = '#2563eb'; c.fill();
    // scale handle: square at the bottom-right corner
    c.fillStyle = '#fff';
    c.fillRect(g.scale.x - 5, g.scale.y - 5, 10, 10);
    c.strokeRect(g.scale.x - 5, g.scale.y - 5, 10, 10);
    c.restore();
  }

  // ---- Paste with click placement (the source's PasteTool) ----------------------------------------
  function pasteAnchor(pp: PendingPaste): Vec2 {
    const pts = pp.kind === 'pieces' ? pp.items.map((i) => i.position)
      : pp.kind === 'paths' ? pp.items.flatMap((i) => i.points.map((q) => ({ x: q.x, y: q.y })))
      : pp.items.map((i) => ({ x: i.x, y: i.y }));
    if (pts.length === 0) return { x: 0, y: 0 };
    return { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length };
  }

  /** Commit the armed clipboard at the clicked world position (selection moves to the copies). */
  function commitPaste(world: Vec2) {
    const pp = $pendingPaste;
    if (!pp || pp.items.length === 0) return;
    const anchor = pasteAnchor(pp);
    const dx = world.x - anchor.x, dy = world.y - anchor.y;
    const p = $state.snapshot(currentPattern) as Pattern;
    if (pp.kind === 'pieces') {
      const clones = pp.items.map((src) => {
        const c = structuredClone(src) as Piece;
        c.id = uid('Piece');
        c.name = `Copy of ${src.name}`;
        c.position = { x: src.position.x + dx, y: src.position.y + dy };
        for (const e of [...c.mainPaths, ...c.internalPaths]) e.id = uid('PiecePath');
        return c;
      });
      onchange({ ...p, pieces: [...p.pieces, ...clones], hasChanged: true }, 'Paste');
      setPieceIds(clones.map((c) => c.id));
    } else if (pp.kind === 'paths') {
      // Plain paste REUSES surviving anchor points (a referencing copy that follows them);
      // "Paste as copy" duplicates the points so the new path is fully independent.
      const existing = new Set(p.points.map((q) => q.id));
      const newPoints: typeof p.points = [];
      const newPaths: typeof p.paths = [];
      for (const item of pp.items) {
        const idMap = new Map<string, string>();
        for (const src of item.points) {
          if (!pp.asCopy && existing.has(src.id)) { idMap.set(src.id, src.id); continue; }
          const id = uid('ConstrainablePoint');
          idMap.set(src.id, id);
          newPoints.push({ ...structuredClone(src), id, name: `${src.name}'`, x: src.x + dx, y: src.y + dy, constraint: undefined });
        }
        const path = structuredClone(item.path);
        path.id = uid('ConstrainablePath');
        path.name = `Copy of ${item.path.name || 'path'}`;
        path.pathPoints = path.pathPoints.map((q) => ({ ...q, id: idMap.get(q.id) ?? q.id }));
        newPaths.push(path);
      }
      onchange({ ...p, points: [...p.points, ...newPoints], paths: [...p.paths, ...newPaths], hasChanged: true }, 'Paste');
      setPathIds(newPaths.map((q) => q.id));
    } else {
      const prefix = p.pointPrefix || 'A';
      let n = p.points.length;
      const names = new Set(p.points.map((q) => q.name));
      const nextName = () => { while (names.has(`${prefix}${n}`)) n++; const nm = `${prefix}${n}`; names.add(nm); return nm; };
      const clones = pp.items.map((src) => ({ ...structuredClone(src), id: uid('ConstrainablePoint'), name: nextName(), x: src.x + dx, y: src.y + dy }));
      onchange({ ...p, points: [...p.points, ...clones], hasChanged: true }, 'Paste');
      setPointIds(clones.map((c) => c.id));
    }
    pendingPaste.set(null);
    toast(`Pasted ${pp.items.length === 1 ? '1 item' : `${pp.items.length} items`}`, 'success');
    render();
  }

  /** Translucent preview of the armed clipboard under the cursor. */
  function drawPasteGhost(c: CanvasRenderingContext2D) {
    const pp = $pendingPaste;
    if (!pp || pp.items.length === 0) return;
    const world = toPattern(cursorPos.x, cursorPos.y);
    const anchor = pasteAnchor(pp);
    const dx = world.x - anchor.x, dy = world.y - anchor.y;
    c.save();
    c.globalAlpha = 0.55;
    c.strokeStyle = '#2563eb';
    c.setLineDash([5, 4]);
    c.lineWidth = 1.5;
    if (pp.kind === 'pieces') {
      const paths = indexPaths(currentPattern);
      const points = indexPoints(currentPattern);
      for (const item of pp.items) {
        const ghost = { ...item, position: { x: item.position.x + dx, y: item.position.y + dy } } as Piece;
        const outline = pieceDisplayOutline(currentPattern, ghost, paths, points, 4);
        if (outline.length >= 2) { tracePoly(c, outline, true); c.stroke(); }
      }
    } else if (pp.kind === 'paths') {
      for (const item of pp.items) {
        const byId = new Map(item.points.map((q) => [q.id, q]));
        const poly = item.path.pathPoints
          .map((q) => byId.get(q.id))
          .filter((q): q is NonNullable<typeof q> => !!q)
          .map((q) => toCanvas({ x: q.x + dx, y: q.y + dy }));
        if (poly.length >= 2) {
          c.beginPath();
          c.moveTo(poly[0].x, poly[0].y);
          for (let i = 1; i < poly.length; i++) c.lineTo(poly[i].x, poly[i].y);
          c.stroke();
        }
      }
    } else {
      c.setLineDash([]);
      c.fillStyle = '#2563eb';
      for (const item of pp.items) {
        const q = toCanvas({ x: item.x + dx, y: item.y + dy });
        c.beginPath(); c.arc(q.x, q.y, 3.5, 0, Math.PI * 2); c.fill();
      }
    }
    c.restore();
  }

  /** Parametric-arc upkeep after points moved: an arc follows its centre point; dragging one of an
   *  arc's own anchors detaches the metadata (the path is hand-edited from then on). */
  function afterPointsMoved(next: Pattern, movedIds: string[]): Pattern {
    let out = next;
    for (const id of movedIds) {
      out = detachArcsTouchingAnchor(out, id);
      for (const ap of arcPathsCenteredOn(out, id)) {
        if (!ap.arc) continue;
        const rb = rebakeArc(out, ap.id, ap.arc, uid);
        if (rb) out = rb;
      }
    }
    return out;
  }

  /** Snap a drafting-space coordinate to the grid and/or other points' guides. */
  // alignment-guide matches from the last snapDraft (drawn as dashed guide lines while dragging)
  let guideMatch: { xPointId: string | null; yPointId: string | null } = { xPointId: null, yPointId: null };

  function snapDraft(d: Vec2, excludeId?: string, bypass = false): Vec2 {
    let x = d.x, y = d.y;
    guideMatch = { xPointId: null, yPointId: null };
    if (bypass) return { x, y }; // Alt/Ctrl/Cmd held: raw position (the original's modifier bypass)
    if (currentPattern.snapToGrid) {
      x = Math.round(x / GRID_SNAP_MM) * GRID_SNAP_MM;
      y = Math.round(y / GRID_SNAP_MM) * GRID_SNAP_MM;
    }
    if (currentPattern.snapToGuides) {
      const tol = 8 / baseScale();
      for (const p of currentPattern.points) {
        if (p.id === excludeId) continue;
        if (Math.abs(p.x - x) < tol) { x = p.x; guideMatch.xPointId = p.id; }
        if (Math.abs(p.y - y) < tol) { y = p.y; guideMatch.yPointId = p.id; }
      }
    }
    return { x, y };
  }

  /** Shift snapping for point drags (the original's getSnappedAngle): snap the drag direction to
   *  90° steps — absolute, or relative to the direction of a straight path through the point —
   *  when the cursor's angle falls in the same 10° bucket. Returns the snapped draft position. */
  function snapAngleDraft(cur: Vec2, origin: Vec2, pointId: string): Vec2 | null {
    const len = Math.hypot(cur.x - origin.x, cur.y - origin.y);
    if (len < 1e-6) return null;
    const h = (Math.atan2(cur.y - origin.y, cur.x - origin.x) * 180) / Math.PI;
    const u = 10; // tolerance bucket (degrees)
    const at = (deg: number): Vec2 => ({ x: origin.x + Math.cos((deg * Math.PI) / 180) * len, y: origin.y + Math.sin((deg * Math.PI) / 180) * len });
    const f = 90 * Math.round(h / 90);
    if (Math.round(f / u) === Math.round(h / u)) return at(f);
    // relative to the first connected straight path's direction
    for (const pa of currentPattern.paths) {
      if (pa.pathType !== 'line') continue;
      const idx = pa.pathPoints.findIndex((pp) => pp.id === pointId);
      if (idx < 0) continue;
      const adjId = pa.pathPoints[idx + 1]?.id ?? pa.pathPoints[idx - 1]?.id;
      const adj = adjId ? currentPattern.points.find((q) => q.id === adjId) : undefined;
      if (!adj) continue;
      const s = (Math.atan2(adj.y - origin.y, adj.x - origin.x) * 180) / Math.PI;
      const g = 90 * Math.round((h - s) / 90) + s;
      return Math.round(g / u) === Math.round(h / u) ? at(g) : null;
    }
    return null;
  }

  /** Dashed alignment guide lines through the snapped-to points (the original's guideLines). */
  function drawGuideLines(c: CanvasRenderingContext2D) {
    if (!isDragging || (!guideMatch.xPointId && !guideMatch.yPointId)) return;
    const placed = editorPlacedPoints(currentPattern);
    const find = (id: string | null) => (id ? placed.find((pp) => pp.pointId === id) : undefined);
    c.save();
    c.strokeStyle = 'rgba(14,165,233,0.7)';
    c.lineWidth = 1;
    c.setLineDash([6, 6]);
    const xm = find(guideMatch.xPointId);
    if (xm) {
      const cp = toCanvas(xm.world);
      c.beginPath(); c.moveTo(cp.x, 0); c.lineTo(cp.x, canvasH); c.stroke();
    }
    const ym = find(guideMatch.yPointId);
    if (ym) {
      const cp = toCanvas(ym.world);
      c.beginPath(); c.moveTo(0, cp.y); c.lineTo(canvasW, cp.y); c.stroke();
    }
    c.restore();
  }

  function handleMouseDown(e: MouseEvent) {
    const pos = getPos(e);
    dragStartX = pos.x; dragStartY = pos.y;
    if ($pathPickRequest && e.button === 0) {
      // modal path picking (the original's SelectPathTool): resolve the click into the request
      const hit = hitTestAnyPath(pos);
      if (hit) {
        const req = $pathPickRequest;
        pathPickRequest.set(null);
        req.onPick(hit);
        render();
      }
      return;
    }
    if ($pendingPaste && e.button === 0) { commitPaste(toPattern(pos.x, pos.y)); return; }
    if (calibrating && bgImage && e.button === 0) {
      const world = toPattern(pos.x, pos.y);
      if (!calibrating.src) {
        const px = worldToImgPx(world);
        if (px.x < 0 || px.y < 0 || px.x > bgImage.naturalWidth || px.y > bgImage.naturalHeight) {
          toast('Click a feature on the scanned image first', 'error');
          return;
        }
        calibrating = { src: px };
      } else {
        matchPairs = [...matchPairs, { srcPx: calibrating.src, dst: world }];
        calibrating = null;
        if (matchPairs.length >= 1) warpEnabled = true;
        toast('Match point added', 'success');
      }
      render();
      return;
    }
    const tool = $selectedTool;
    if (tool === 'pan' || e.button === 1 || e.metaKey || e.ctrlKey || e.altKey) { isPanning = true; return; }
    if (tool === 'measure') { measureClick(pos); return; }
    if (tool === 'point') {
      // place on a nearby path (or midway between two), like the original's getPickedPoint;
      // a point landing on a single path becomes a sliding point so it follows the path
      const world = toPattern(pos.x, pos.y);
      const proj = projectPlacement(world);
      const r = withNewPoint($state.snapshot(currentPattern) as Pattern, proj?.pos ?? world);
      if (proj?.slide) {
        const slide = proj.slide;
        r.p = { ...r.p, points: r.p.points.map((q) => (q.id === r.id ? { ...q, constraint: { type: 'sliding' as const, path: slide.pathId, fraction: slide.fraction } } : q)) };
        toast('Point placed on the path — it slides along it', 'success');
      }
      onchange({ ...r.p, hasChanged: true });
      return;
    }
    if (tool === 'pen' || tool === 'piece' || tool === 'internal') {
      penOrPieceClick(pos);
      // arm drag-for-curve on the just-placed point (pen + internal draw lines/curves)
      if (tool === 'pen' || tool === 'internal') { penDragging = true; penDragPointId = penDraft[penDraft.length - 1] ?? null; dragStartX = pos.x; dragStartY = pos.y; }
      return;
    }
    if (tool === 'text') { insertTextAt(pos); return; }
    if (tool === 'image') { insertImageAt(pos); return; }
    if (tool === 'trace') { traceClick(pos); return; }
    if (tool === 'piece-point') { piecePointClick(pos); return; }
    if (tool === 'seam' || tool === 'seam-single') { seamClick(pos); return; }
    if (tool === 'seam-multi') { seamMultiClick(pos); return; }
    if (tool === 'circle' || tool === 'arc-center' || tool === 'arc-3pt') { arcClick(pos); return; }
    if (tool === 'arc') return;

    // gizmo handles (rotate/scale on the multi-selection bbox) win over everything below
    if (gizmoMouseDown(pos)) { isDragging = true; return; }

    // bezier-handle drag takes priority over anchor selection (handles sit on top of anchors)
    const hHit = hitTestHandle(pos.x, pos.y);
    if (hHit) { dragHandle = hHit; isDragging = true; return; }

    // piece-local construction points are draggable like anchors
    const ppt = hitTestPiecePoint(pos.x, pos.y);
    if (ppt) { dragPiecePt = ppt; isDragging = true; return; }

    const hit = hitTestPlaced(pos.x, pos.y);
    if (hit) {
      const cur = new Set(pointIds);
      const wasSelected = cur.has(hit.pointId);
      if (e.shiftKey) {
        // shift-click toggles the point in the selection
        if (cur.has(hit.pointId)) cur.delete(hit.pointId); else cur.add(hit.pointId);
        setPointIds(cur);
      } else if (!wasSelected) {
        setPointIds([hit.pointId]);
        setPathIds([]);
        setPieceIds([]);
      }
      // Safe (select first) mode: a drag starting on an unselected point only selects it —
      // moving requires starting the drag on an already-selected point.
      if ($interactionMode === 'safe' && !wasSelected) { render(); return; }
      // begin dragging (single or the whole selected set)
      dragPointId = hit.pointId;
      dragInvert = hit.invert;
      dragStartWorld = { ...hit.world };
      dragDraftStart = hit.invert(toPattern(pos.x, pos.y));
      const origPt = currentPattern.points.find((q) => q.id === hit.pointId);
      dragOrigDraft = origPt ? { x: origPt.x, y: origPt.y } : null;
      const sel = pointIds;
      multiDrag = sel.size > 1
        ? currentPattern.points.filter((p) => sel.has(p.id)).map((p) => ({ id: p.id, x: p.x, y: p.y }))
        : null;
      isDragging = true;
    } else {
      // prefer selecting a boundary edge (its path) so we can show that line's
      // measurement + handles only — matching the source ("press on the line").
      const edgePP = hitTestEdge(pos);
      if (edgePP) {
        const owner = pieceOwnerOf(edgePP);
        if (owner) {
          setPieceIds([owner.piece.id]);
          setPathIds([owner.pp.path]);
          setPointIds([]);
          render();
          return;
        }
      }
      const rawPathHit = hitTestAnyPath(pos);
      if (rawPathHit) {
        setPointIds([]);
        setPieceIds([]);
        setPathIds([rawPathHit]);
        render();
        return;
      }
      const pat = toPattern(pos.x, pos.y);
      const paths = indexPaths(currentPattern);
      const points = indexPoints(currentPattern);
      let hitPiece: string | null = null;
      for (const piece of currentPattern.pieces) {
        if (piece.hidden || !layerVisible(piece.layerId) || layerLocked(piece.layerId)) continue;
        if (pointInPolygon(pat, pieceDisplayOutline(currentPattern, piece, paths, points, 6))) { hitPiece = piece.id; break; }
      }
      if (hitPiece) {
        setPointIds([]);
        setPathIds([]);
        setPieceIds([hitPiece]);
      } else {
        // empty space → start a marquee (rubber-band) selection
        isMarquee = true;
        marqueeStart = { ...pos };
        marqueeCur = { ...pos };
        if (!e.shiftKey) { setPointIds([]); setPathIds([]); setPieceIds([]); }
      }
    }
    render();
  }

  function handleMouseMove(e: MouseEvent) {
    const pos = getPos(e);
    cursorPos = pos;
    cursorMm.set(toPattern(pos.x, pos.y)); // live drafting-mm readout for the status bar
    updateAutoScroll(pos);
    if ($pendingPaste) { render(); return; } // ghost follows the cursor
    if (gizmoDrag) { gizmoMouseMove(pos, e.shiftKey); return; }
    if (isPanning) {
      panOffset.set({ x: currentPanX + (pos.x - dragStartX), y: currentPanY + (pos.y - dragStartY) });
      dragStartX = pos.x; dragStartY = pos.y;
      return;
    }
    if (isMarquee) { marqueeCur = { ...pos }; render(); return; }
    if (penDragging && penDragPointId && draftPathId) {
      // drag out a bezier tangent on the just-placed pen point ("hold to create a curve")
      if (Math.hypot(pos.x - dragStartX, pos.y - dragStartY) > 3) {
        const world = toPattern(pos.x, pos.y);
        const anchor = currentPattern.points.find((p) => p.id === penDragPointId);
        if (anchor) {
          const v2 = { x: world.x - anchor.x, y: world.y - anchor.y };
          const v1 = { x: -v2.x, y: -v2.y };
          const paths = currentPattern.paths.map((pa) => pa.id === draftPathId
            ? { ...pa, pathType: 'curve', pathPoints: pa.pathPoints.map((pp) => pp.id === penDragPointId ? { id: pp.id, handle: mkHandle(v1, v2) } : pp) }
            : pa);
          onchange({ ...currentPattern, paths, hasChanged: true });
        }
      }
      return;
    }
    if (dragHandle) {
      // drag a bezier tangent handle: map cursor → draft space, set the new anchor-relative vector,
      // and mirror the opposite handle per the point's sameLength/sameAngle constraints.
      const draft = (dragHandle.invert ?? ((w: Vec2) => w))(toPattern(pos.x, pos.y));
      const newV = { x: draft.x - dragHandle.anchor.x, y: draft.y - dragHandle.anchor.y };
      const paths = currentPattern.paths.map((pa) => pa.id !== dragHandle!.pathId ? pa : {
        ...pa,
        pathPoints: pa.pathPoints.map((pp) => (pp.id === dragHandle!.pointId && pp.handle ? { ...pp, handle: ops.applyHandleConstraint(pp.handle, dragHandle!.which, newV) } : pp))
      });
      onchange({ ...currentPattern, paths, hasChanged: true });
      return;
    }
    if (isDragging && dragPiecePt) {
      const draft = dragPiecePt.invert(toPattern(pos.x, pos.y));
      onchange(piecePointUpdate($state.snapshot(currentPattern) as Pattern, dragPiecePt.id, { x: draft.x, y: draft.y }), 'Move piece point');
      return;
    }
    if (isDragging && dragPointId) {
      // map the cursor (world) back into the dragged point's drafting space
      const world = toPattern(pos.x, pos.y);
      const raw = dragInvert ? dragInvert(world) : world;
      // Shift constrains the drag direction (single-point drags); Alt/Ctrl/Cmd bypasses guide+grid snapping
      const angled = e.shiftKey && !multiDrag && dragOrigDraft ? snapAngleDraft(raw, dragOrigDraft, dragPointId) : null;
      if (angled) guideMatch = { xPointId: null, yPointId: null };
      const draft = angled ?? snapDraft(raw, dragPointId, e.altKey || e.ctrlKey || e.metaKey);
      if (multiDrag && dragDraftStart) {
        // move the whole selected set by the same drafting-space delta
        const dx = draft.x - dragDraftStart.x, dy = draft.y - dragDraftStart.y;
        const moved = new Map(multiDrag.map((m) => [m.id, { x: m.x + dx, y: m.y + dy }]));
        const points = currentPattern.points.map((p) => (moved.has(p.id) ? { ...p, ...moved.get(p.id)! } : p));
        onchange(afterPointsMoved({ ...currentPattern, points, hasChanged: true }, [...moved.keys()]));
      } else {
        const points = currentPattern.points.map((p) => (p.id === dragPointId ? { ...p, x: draft.x, y: draft.y } : p));
        onchange(afterPointsMoved({ ...currentPattern, points, hasChanged: true }, [dragPointId]));
      }
      return;
    }
    if (isSeamToolActive()) {
      const next = seamPickAt(pos);
      const cur = seamHover;
      if (!!next !== !!cur || (next && cur && (!samePick(next, cur) || next.reversed !== cur.reversed))) {
        seamHover = next;
      }
    } else if (seamHover) {
      seamHover = null;
    }
    hoveredPointId = hitTestPoint(pos.x, pos.y);
    render();
  }

  function handleMouseUp() {
    // Drag-onto-path: dropping an unconstrained loose point onto a path converts it to a sliding
    // point on that path (the original's "Maybe add sliding point"). Structural piece corners are
    // exempt — sliding a boundary endpoint would tear the piece.
    if (isDragging && dragPointId) {
      const dropped = currentPattern.points.find((q) => q.id === dragPointId);
      const isCorner = currentPattern.pieces.some((pc) =>
        [...pc.mainPaths, ...pc.internalPaths].some((pp) => pp.from === dragPointId || pp.to === dragPointId));
      if (dropped && !dropped.constraint && !isCorner) {
        const world = toPattern(cursorPos.x, cursorPos.y);
        const best = nearestPathProjection(world, 6 / baseScale(),
          (path) => path.pathPoints.some((pp) => pp.id === dragPointId)); // skip its own path
        if (best) {
          const p = $state.snapshot(currentPattern) as Pattern;
          const pts = p.points.map((q) => (q.id === dragPointId
            ? { ...q, constraint: { type: 'sliding' as const, path: best.pathId, fraction: Math.round(best.fraction * 1000) / 1000 } }
            : q));
          onchange({ ...p, points: pts, hasChanged: true }, 'Add sliding point');
          toast('Converted to a sliding point — it now follows the path', 'success');
        }
      }
    }
    if (isMarquee) {
      const x0 = Math.min(marqueeStart.x, marqueeCur.x), x1 = Math.max(marqueeStart.x, marqueeCur.x);
      const y0 = Math.min(marqueeStart.y, marqueeCur.y), y1 = Math.max(marqueeStart.y, marqueeCur.y);
      if (x1 - x0 > 3 || y1 - y0 > 3) {
        const sel = new Set(pointIds); // shift-drag adds to the existing selection
        for (const pp of editorPlacedPoints(currentPattern)) {
          const cp = toCanvas(pp.world);
          if (cp.x >= x0 && cp.x <= x1 && cp.y >= y0 && cp.y <= y1) sel.add(pp.pointId);
        }
        setPointIds(sel);
        if (sel.size) { setPieceIds([]); setPathIds([]); }
      }
      isMarquee = false;
    }
    isDragging = false;
    dragPointId = null;
    dragHandle = null;
    dragPiecePt = null;
    dragInvert = null;
    dragStartWorld = null;
    dragDraftStart = null;
    dragOrigDraft = null;
    multiDrag = null;
    penDragging = false;
    penDragPointId = null;
    isPanning = false;
    gizmoDrag = null;
    guideMatch = { xPointId: null, yPointId: null };
    stopAutoScroll();
    render();
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    zoom.update((v) => Math.max(0.02, Math.min(20, v * (e.deltaY > 0 ? 0.9 : 1.1))));
  }
</script>

<canvas
  bind:this={canvasEl}
  data-testid="pattern-canvas-2d"
  width={canvasW}
  height={canvasH}
  class="w-full h-full block"
  onmousedown={handleMouseDown}
  onmousemove={handleMouseMove}
  onmouseup={handleMouseUp}
  onmouseleave={() => { cursorMm.set(null); handleMouseUp(); }}
  onwheel={handleWheel}
  oncontextmenu={handleContextMenu}
  style="cursor: {$selectedTool === 'pan' ? 'grab' : 'crosshair'}; touch-action: none;"
></canvas>

{#if $selectedTool === 'seam-multi' && (seamFromPicks.length > 0 || seamPhase === 'to')}
  <!-- multi-seam phase helper: Next/Finish mirrors the Enter key (the original's tap targets) -->
  <div class="absolute bottom-14 left-1/2 -translate-x-1/2 z-10 bg-base-200/95 rounded-box shadow px-3 py-1.5 text-xs flex items-center gap-2">
    <span>
      {seamPhase === 'from'
        ? `Selecting "from" segments (${seamFromPicks.length})`
        : `Selecting "to" segments (${seamToPicks.length})`}
    </span>
    <button
      class="btn btn-xs btn-primary"
      onclick={advanceSeamPhase}
      disabled={seamPhase === 'from' ? seamFromPicks.length === 0 : seamToPicks.length === 0}
    >{seamPhase === 'from' ? 'Next' : 'Finish'}</button>
    <button class="btn btn-xs btn-ghost" onclick={() => { resetSeamTool(); render(); }}>Cancel</button>
  </div>
{/if}

{#if contextMenu}
  <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onclose={() => (contextMenu = null)} />
{/if}

<div class="absolute top-2 left-2 flex gap-1">
  <button
    class="btn btn-xs"
    class:btn-active={showSeams}
    title="Toggle seam connections — shows which piece edges are sewn together"
    onclick={() => { showSeams = !showSeams; render(); }}
  >Seams</button>
  <button
    class="btn btn-xs"
    class:btn-active={showBody}
    title="Toggle the avatar body silhouette"
    onclick={() => { showBody = !showBody; render(); }}
  >Body</button>
  <button
    class="btn btn-xs"
    class:btn-active={currentPattern.showConstruction !== false}
    title="Toggle canonical drafting and helper geometry"
    onclick={() => onchange({ ...$state.snapshot(currentPattern) as Pattern, showConstruction: currentPattern.showConstruction === false, hasChanged: true })}
  >Construction</button>
  <button class="btn btn-xs btn-ghost" title="Fit pieces to view" onclick={() => { fitView(); render(); }}>Fit</button>
  <button class="btn btn-xs" class:btn-active={!!bgImage || !!hpglPolys || showBgControls} title="Trace over a reference image or HPGL file" onclick={() => (showBgControls = !showBgControls)}>Trace</button>
  <button class="btn btn-xs" class:btn-active={!!frozenGeometry || showSnapshotControls} title="Freeze a snapshot of the current geometry as a ghost reference" onclick={() => (showSnapshotControls = !showSnapshotControls)}>Snapshot</button>
</div>

{#if showSnapshotControls}
  <div class="absolute top-10 left-56 z-10 bg-base-100/95 backdrop-blur rounded-lg shadow-lg border border-base-300 p-2 text-xs space-y-1 w-52" use:draggablePanel={{ handle: '[data-drag-handle]' }}>
    <div class="flex items-center justify-between" data-drag-handle><span class="font-bold">Frozen snapshot</span>
      <button class="btn btn-ghost btn-xs btn-circle" aria-label="Close" onclick={() => (showSnapshotControls = false)}>✕</button>
    </div>
    <button class="btn btn-xs w-full" onclick={freezeSnapshot}>Freeze snapshot</button>
    {#if frozenGeometry}
      <label class="flex flex-col gap-0.5"><span class="flex justify-between"><span>Frozen snapshot opacity</span><span class="opacity-60">{$frozenSnapshotOpacity.toFixed(2)}</span></span>
        <input type="range" class="range range-xs" min="0.05" max="1" step="0.05" value={$frozenSnapshotOpacity} oninput={(e) => { frozenSnapshotOpacity.set(parseFloat(e.currentTarget.value)); render(); }} /></label>
      <button class="btn btn-xs btn-ghost w-full" onclick={removeFrozenSnapshot}>Remove frozen snapshot</button>
    {:else}
      <p class="opacity-50 leading-tight">Freeze the current pieces as a ghost reference under the live pattern while you edit.</p>
    {/if}
  </div>
{/if}

{#if showBgControls}
  <div class="absolute top-10 left-2 z-10 bg-base-100/95 backdrop-blur rounded-lg shadow-lg border border-base-300 p-2 text-xs space-y-1 w-52" use:draggablePanel={{ handle: '[data-drag-handle]' }}>
    <div class="flex items-center justify-between" data-drag-handle><span class="font-bold">Trace overlay</span>
      <button class="btn btn-ghost btn-xs btn-circle" aria-label="Close" onclick={() => (showBgControls = false)}>✕</button>
    </div>
    <div class="flex gap-1">
      <label class="btn btn-xs flex-1">Image…
        <input type="file" accept="image/*" class="hidden" onchange={loadBgImage} /></label>
      <label class="btn btn-xs flex-1">HPGL…
        <input type="file" accept=".hpgl,.plt,.hp,text/plain" class="hidden" onchange={loadHpgl} /></label>
    </div>
    {#if bgImage || hpglPolys}
      <label class="flex flex-col gap-0.5"><span class="flex justify-between"><span>Opacity</span><span class="opacity-60">{bgOpacity.toFixed(2)}</span></span>
        <input type="range" class="range range-xs" min="0.05" max="1" step="0.05" value={bgOpacity} oninput={(e) => { bgOpacity = parseFloat(e.currentTarget.value); render(); }} /></label>
      {#if bgImage}
        <label class="flex items-center justify-between gap-2">Width (mm)
          <input type="number" step="10" class="input input-bordered input-xs w-20" value={bgWidthMm} oninput={(e) => { bgWidthMm = parseFloat(e.currentTarget.value) || 1; render(); }} /></label>
      {/if}
      <div class="grid grid-cols-2 gap-1">
        <label class="flex items-center gap-1">X<input type="number" step="5" class="input input-bordered input-xs w-full" value={bgX} oninput={(e) => { bgX = parseFloat(e.currentTarget.value) || 0; render(); }} /></label>
        <label class="flex items-center gap-1">Y<input type="number" step="5" class="input input-bordered input-xs w-full" value={bgY} oninput={(e) => { bgY = parseFloat(e.currentTarget.value) || 0; render(); }} /></label>
      </div>

      {#if bgImage}
        <div class="border-t border-base-300 pt-1 space-y-1">
          <span class="font-semibold opacity-70">Filters</span>
          <label class="flex flex-col gap-0.5"><span class="flex justify-between"><span>Brightness</span><span class="opacity-60">{bgBrightness}</span></span>
            <input type="range" class="range range-xs" min="-100" max="100" step="1" value={bgBrightness} oninput={(e) => { bgBrightness = parseInt(e.currentTarget.value); render(); }} /></label>
          <label class="flex flex-col gap-0.5"><span class="flex justify-between"><span>Contrast</span><span class="opacity-60">{bgContrast}</span></span>
            <input type="range" class="range range-xs" min="-100" max="100" step="1" value={bgContrast} oninput={(e) => { bgContrast = parseInt(e.currentTarget.value); render(); }} /></label>
          <div class="flex items-center gap-2">
            <label class="flex items-center gap-1"><input type="checkbox" class="checkbox checkbox-xs" checked={bgGrayscale} onchange={(e) => { bgGrayscale = e.currentTarget.checked; render(); }} /> Grayscale</label>
            <label class="flex items-center gap-1"><input type="checkbox" class="checkbox checkbox-xs" checked={bgThreshold != null} onchange={(e) => { bgThreshold = e.currentTarget.checked ? 128 : null; render(); }} /> Threshold</label>
          </div>
          {#if bgThreshold != null}
            <label class="flex flex-col gap-0.5"><span class="flex justify-between"><span>Threshold level</span><span class="opacity-60">{bgThreshold}</span></span>
              <input type="range" class="range range-xs" min="0" max="255" step="1" value={bgThreshold} oninput={(e) => { bgThreshold = parseInt(e.currentTarget.value); render(); }} /></label>
          {/if}
          {#if bgBrightness !== 0 || bgContrast !== 0 || bgGrayscale || bgThreshold != null}
            <button class="btn btn-xs btn-ghost w-full" onclick={() => { bgBrightness = 0; bgContrast = 0; bgGrayscale = false; bgThreshold = null; render(); }}>Reset filters</button>
          {/if}
        </div>

        <div class="border-t border-base-300 pt-1 space-y-1">
          <span class="font-semibold opacity-70" title="Mark known features on the scan and their true drafting positions; the image is warped (thin-plate spline) to match — dewarps and true-scales scanned paper patterns.">Calibrate (match points)</span>
          <button class="btn btn-xs w-full" class:btn-accent={!!calibrating} onclick={() => { calibrating = calibrating ? null : { src: null }; render(); }}>
            {calibrating ? (calibrating.src ? 'Now click the TRUE position…' : 'Click a feature on the image…') : '+ Add match point'}
          </button>
          {#if matchPairs.length > 0}
            <label class="flex items-center gap-1"><input type="checkbox" class="checkbox checkbox-xs" checked={warpEnabled} onchange={(e) => { warpEnabled = e.currentTarget.checked; render(); }} /> Apply warp ({matchPairs.length} point{matchPairs.length === 1 ? '' : 's'})</label>
            <div class="max-h-24 overflow-y-auto space-y-0.5">
              {#each matchPairs as pair, i (i)}
                <div class="flex items-center gap-1 text-[11px]">
                  <span class="flex-1 truncate opacity-70">#{i + 1} → {pair.dst.x.toFixed(0)}, {pair.dst.y.toFixed(0)} mm</span>
                  <button class="btn btn-ghost btn-xs px-0.5 text-error" title="Remove match point" onclick={() => { matchPairs = matchPairs.filter((_, j) => j !== i); render(); }}>&times;</button>
                </div>
              {/each}
            </div>
            <button class="btn btn-xs btn-ghost w-full" onclick={() => { matchPairs = []; warpEnabled = false; render(); }}>Clear match points</button>
            <p class="opacity-50 leading-tight">1 point moves, 2 scale + rotate, 3+ dewarp (thin-plate spline). Tracing uses the calibrated image.</p>
          {/if}
        </div>
      {/if}

      <div class="flex gap-1">
        {#if bgImage}<button class="btn btn-xs btn-ghost flex-1" onclick={clearBgImage}>Remove image</button>{/if}
        {#if hpglPolys}<button class="btn btn-xs btn-ghost flex-1" onclick={clearHpgl}>Remove HPGL</button>{/if}
      </div>
    {:else}
      <p class="opacity-50 leading-tight">Trace over a reference photo/sketch or an HPGL/.plt plotter file. Not saved with the pattern.</p>
    {/if}
  </div>
{/if}

{#if $selectedTool === 'measure'}
  <!-- Measurements panel: saved Measure-tool annotations with live values, targets and zoom-to -->
  <div class="absolute top-10 right-14 z-10 bg-base-100/95 backdrop-blur rounded-lg shadow-lg border border-base-300 p-2 text-xs space-y-1 w-72" use:draggablePanel={{ handle: '[data-drag-handle]' }}>
    <div class="flex items-center justify-between" data-drag-handle>
      <span class="font-bold">Measurements</span>
      <label class="flex items-center gap-1 cursor-pointer" title="Show measurements on the canvas">
        <input
          type="checkbox"
          class="checkbox checkbox-xs"
          checked={currentPattern.showMeasurements !== false}
          onchange={() => onchange({ ...($state.snapshot(currentPattern) as Pattern), showMeasurements: currentPattern.showMeasurements === false, hasChanged: true }, 'Toggle measurements')}
        />
        <span>Show</span>
      </label>
    </div>
    <div class="join w-full">
      <button class="join-item btn btn-xs flex-1" class:btn-active={measureMode === 'distance'} onclick={() => { measureMode = 'distance'; measureChain = []; render(); }}>Distance</button>
      <button class="join-item btn btn-xs flex-1" class:btn-active={measureMode === 'angle'} onclick={() => { measureMode = 'angle'; measureFrom = null; render(); }}>Angle</button>
    </div>
    {#if (currentPattern.measurements ?? []).length === 0}
      <p class="opacity-50 leading-tight">
        {measureMode === 'angle'
          ? 'Click three points (arm, vertex, arm) to save an angle measurement.'
          : `Click two points to save a measurement. Set a target to track a length while you edit (green = within ±${mmToUnit(MEASURE_TOL_MM).toFixed(2)} ${currentPattern.lengthUnit}).`}
      </p>
    {:else}
      <div class="max-h-64 overflow-y-auto space-y-1">
        {#each currentPattern.measurements ?? [] as m (m.id)}
          {@const actual = measuredValue(m)}
          {@const isAngle = m.kind === 'angle'}
          <div class="rounded border p-1 space-y-1 {m.id === selectedMeasurementId ? 'border-warning' : 'border-base-300'}">
            <div class="flex items-center gap-1">
              {#if isAngle}<span class="material-symbols-rounded notranslate opacity-50" style="font-size:13px" title="Angle measurement">architecture</span>{/if}
              <input
                class="input input-bordered input-xs flex-1 min-w-0"
                value={m.name}
                onchange={(e) => updateMeasurement(m.id, { name: e.currentTarget.value }, 'Rename measurement')}
              />
              <button class="btn btn-ghost btn-xs px-1" title="Zoom to measurement" aria-label="Zoom to measurement" onclick={() => zoomToMeasurement(m)}>
                <span class="material-symbols-rounded notranslate" style="font-size:14px">center_focus_strong</span>
              </button>
              <button class="btn btn-ghost btn-xs px-1 text-error" title="Delete measurement" aria-label="Delete measurement" onclick={() => deleteMeasurement(m.id)}>✕</button>
            </div>
            <div class="flex items-center gap-1">
              <span class="tabular-nums {actual != null && m.targetMm != null ? (Math.abs(actual - m.targetMm) <= measureTol(m) ? 'text-success' : 'text-error') : ''}">
                {actual == null ? 'point missing' : isAngle ? `${actual.toFixed(1)}°` : `${mmToUnit(actual).toFixed(2)} ${currentPattern.lengthUnit}`}
              </span>
              <span class="flex-1"></span>
              <label class="flex items-center gap-1">
                <span class="opacity-60">target{isAngle ? ' °' : ''}</span>
                <input
                  type="number"
                  step="0.1"
                  class="input input-bordered input-xs w-16"
                  value={m.targetMm != null ? Number((isAngle ? m.targetMm : mmToUnit(m.targetMm)).toFixed(2)) : ''}
                  onchange={(e) => {
                    const v = parseFloat(e.currentTarget.value);
                    updateMeasurement(m.id, { targetMm: Number.isFinite(v) ? (isAngle ? v : unitToMm(v)) : null }, 'Set measurement target');
                  }}
                />
              </label>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<DrawingTools {editor} />

{#if toolStatus}
  <!-- active-tool status bar (matches the source's "Click to place text" popup) -->
  <div class="bg-base-100 w-full absolute bottom-0 left-0 z-10 p-2 text-sm flex flex-col gap-2 border-t border-base-300 md:flex-row md:items-center md:px-4" role="status" aria-live="polite">
    <span class="w-auto min-w-0">{toolStatus}</span>
    <button class="btn btn-sm btn-error self-start md:ml-auto" onclick={cancelOperation}>Cancel operation (Esc or V)</button>
  </div>
{/if}
