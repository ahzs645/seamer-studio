<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { viewport as viewportAction } from '@atelier/svelte';
  import { docToWorld, type Viewport } from '@atelier/viewport';
  import {
    applySeamPick,
    indexPoints,
    pieceGeometrySignature,
    placedPoints,
    type Pattern,
    type SeamPick
  } from '@seamer/pattern-model';
  import { PatternRenderer, type DrapeDebugState, type RendererStatus, type SceneMode } from '$lib/scene/scene3d';
  import AssemblyTimeline from '$lib/components/AssemblyTimeline.svelte';
  import { createSeamerAoPass } from '$lib/scene/n8aoPost';
  import type { SimConfig } from '@seamer/cloth-sim';
  import { isDarkTheme, toggleTheme, applyStoredTheme, onThemeChange } from '$lib/utils/theme';
  import { show3dStats, simAnchors, selectedTool, seamTool, selectedSeamId, bodyZoomRequest } from '$lib/stores/pattern';
  import { get } from 'svelte/store';
  import { downloadBlob, sceneToGLTF } from '$lib/utils/exporters';
  import { toast, toastError, toastSuccess } from '$lib/stores/toast';
  import { confirm } from '$lib/stores/confirm';

  // lightweight FPS meter for the optional stats overlay (Settings → 3D stats)
  let fps = $state(0);
  onMount(() => {
    let raf = 0, frames = 0, last = performance.now();
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 500) { fps = Math.round((frames * 1000) / (now - last)); frames = 0; last = now; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  interface Props {
    currentPattern: Pattern;
    selectedPieceId?: string | null;
    onpieceselect?: (id: string | null) => void;
    labelDisplay?: 'off' | 'billboard' | 'flat';
    onlabeldisplaychange?: (value: 'off' | 'billboard' | 'flat') => void;
    /** Fired when a user-run drape settles, with per-piece settled savedPositions to persist. */
    ondrapesettled?: (savedByPiece: Record<string, number[]>) => void;
    /** Undo-aware pattern update (arrangement-point snaps, freeze toggle). */
    onpatternupdate?: (p: Pattern, label?: string) => void;
    /** Non-undo camera write-back so the view survives a reload. */
    oncamerachange?: (pos: [number, number, number], target: [number, number, number], fov: number) => void;
  }

  let { currentPattern, selectedPieceId = null, onpieceselect, labelDisplay = 'flat', onlabeldisplaychange, ondrapesettled, onpatternupdate, oncamerachange }: Props = $props();

  const docMmToWorld = (mm: number): number => docToWorld({ x: mm, y: 0 }).x;
  const worldToDocMm = (metres: number): number =>
    metres / docToWorld({ x: 1, y: 0 }).x;

  let viewportInstance: Viewport | null = null;
  let renderer: PatternRenderer | null = null;

  /** Stable project-export checkpoint. Current particle positions are captured even while the
   *  solver is running; import resumes from this geometry with zero velocity. */
  export function captureProjectState() {
    if (!renderer) return null;
    const camera = renderer.getCameraState();
    let previewDataUrl: string | null = null;
    try { previewDataUrl = renderer.captureImage(); } catch { /* 2D preview remains the fallback */ }
    return {
      savedByPiece: renderer.extractSavedPositions(),
      cameraPosition: camera.position,
      controlsTarget: camera.target,
      cameraFov: camera.fov,
      lightingMode,
      previewDataUrl
    };
  }
  type DrapeDebugApi = { getState: () => DrapeDebugState | null };
  type DrapeDebugWindow = Window & { __seamerWebgpuDrape?: DrapeDebugApi };
  let drapeDebugApi: DrapeDebugApi | null = null;
  let status = $state<RendererStatus>('idle');
  let statusMessage = $state('');
  let poses = $state<string[]>([]);
  let currentPose = $state('');
  let webgpu = $state(true);
  let showTriangles = $state(false);
  let showAvatar = $state(true);
  let sceneMode = $state<SceneMode>('view');
  // Which piece-edit tool is active while sceneMode === 'arrange': the flat-layout "Arrange" tool, or
  // the in-place "Move pieces" tool that drags the draped pieces and eases them back on Drape.
  let arrangeKind = $state<'arrange' | 'manipulate' | null>(null);
  let selectedPiece = $state<string | null>(null);
  let gizmoMode = $state<'translate' | 'rotate'>('translate');
  let lightingMode = $state<string>('flat');
  let dark = $state(false);
  let unsubscribeTheme: (() => void) | null = null;
  const lightingTabs = [
    { id: 'flat', label: 'Flat' },
    { id: 'studio1', label: 'Studio 1' },
    { id: 'studio2', label: 'Studio 2' },
    { id: 'sunset', label: 'Sunset' }
  ];

  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let lastKey = '';
  // Signature of the cached drapes (savedPositions) at the last accepted state. Watched separately
  // from the geometry key so EXTERNAL drape changes (version restore, undo, MCP pattern push) refresh
  // the 3D view — while the view's own drape-settle write is accepted without a rebuild (no loop).
  let lastDrapeKey = '';
  // Per-piece resolved-geometry signature at the last ACTUAL rebuild. Diffing the live pattern against
  // this tells us which pieces' shapes were edited, so only those re-triangulate from live geometry.
  let builtSigs = new Map<string, string>();

  /** Cheap signature of every piece's savedPositions: length + strided checksum (arrays are large). */
  function drapeKey(p: Pattern): string {
    const parts: (string | number)[] = [];
    for (const pc of p.pieces) {
      const sp = pc.settings3d.savedPositions;
      let sum = 0;
      for (let i = 0; i < sp.length; i += 7) sum += sp[i];
      parts.push(pc.id, sp.length, Math.round(sum * 1e3));
    }
    return parts.join(',');
  }

  function pieceSigs(p: Pattern): Map<string, string> {
    const m = new Map<string, string>();
    // The per-piece particle-distance override changes the triangulation, so fold it into the
    // signature: editing it marks the piece "changed" and forces a re-mesh at the new resolution.
    for (const pc of p.pieces) m.set(pc.id, `${pieceGeometrySignature(p, pc)}|pd:${pc.settings3d.particleDistance ?? ''}`);
    return m;
  }

  /** The rebuild trigger. Includes each piece's RESOLVED geometry signature (not just path/point
   *  counts) so reshaping a piece in the 2D editor — moving a point, dragging a bézier handle —
   *  changes the key and forces a 3D rebuild. */
  function patternKey(p: Pattern, sigs = pieceSigs(p)): string {
    return JSON.stringify({
      body: p.body,
      sim3d: {
        particleDistance: p.settings3d.globalParticleDistanceOverride,
        fixTop: p.settings3d.fixTop,
        mirrored: p.settings3d.drapeMirroredPieces
      },
      pieces: p.pieces.map((pc) => ({ id: pc.id, g: sigs.get(pc.id), a: pc.settings3d.arrangement, f: pc.settings3d.frozen, h: pc.hidden, fn: pc.settings3d.flipNormals, cl: pc.settings3d.collisionLayer, fc: pc.settings3d.filterExternalCollisionsByClothNormal })),
      seams: p.seams.length,
      // texture-map urls can be multi-MB data URLs — sign with length + tail instead of the full string
      mats: p.materials.map((m) => {
        const slotSig = (t: typeof m.frontTexture) => t && {
          c: t.color, s: t.scale, u: t.url.length, ut: t.url.slice(-24),
          n: t.normalUrl.length, ns: t.normalMapScale, o: t.opacityUrl.length, os: t.opacityMapScale
        };
        return {
          id: m.id, ft: slotSig(m.frontTexture), bt: m.useSeparateBackSide ? slotSig(m.backTexture) : null, sb: m.useSeparateBackSide,
          sw: m.stretchWarpValue, wf: m.stretchWeftValue, b: m.bendValue, w: m.weight, th: m.thickness,
          r: m.roughness, mt: m.metalness, sp: m.specularIntensity, op: m.opacity, nsc: m.normalScale, ac: m.alphaCutoff
        };
      })
    });
  }

  onMount(() => {
    applyStoredTheme();
    dark = isDarkTheme();
    unsubscribeTheme = onThemeChange(() => (dark = isDarkTheme()));
    if (!viewportInstance) {
      status = 'error';
      statusMessage = '3D viewport failed to initialize';
      return;
    }
    renderer = new PatternRenderer(viewportInstance);
    if (import.meta.env.DEV) {
      const target = window as DrapeDebugWindow;
      drapeDebugApi = { getState: () => renderer?.getDrapeDebugState() ?? null };
      target.__seamerWebgpuDrape = drapeDebugApi;
    }
    webgpu = renderer.webgpuAvailable();
    renderer.onStatus = (s, msg) => {
      status = s; statusMessage = msg ?? '';
      if (s === 'ready') stretchError = renderer?.getStretchError() ?? null;
    };
    renderer.onModeChange = (m, piece, kind) => { sceneMode = m; selectedPiece = piece; arrangeKind = kind ?? null; };
    renderer.onSelectPiece = (id) => { onpieceselect?.(id); };
    renderer.onCameraChanged = (pos, target, fov) => { oncamerachange?.(pos, target, fov); };
    renderer.onArrangementPointHover = (name) => { hoveredArrangementPoint = name; };
    renderer.onArrangementPointPicked = ({ pieceId, name, cylinderName, uDegrees, v }) => {
      // bind the selected piece's arrangement to the clicked named point (rebuild re-seats it)
      const pieces = currentPattern.pieces.map((p) => (p.id !== pieceId ? p : {
        ...p,
        settings3d: {
          ...p.settings3d,
          arrangement: { ...p.settings3d.arrangement, cylinderName, uDegrees, v, uOffsetMm: 0, vOffsetMm: 0, use2DPosition: false, positionChanged: false }
        }
      }));
      onpatternupdate?.({ ...currentPattern, pieces, hasChanged: true }, `Arrange on ${name}`);
    };
    renderer.onDrapeSettled = (savedByPiece) => {
      ondrapesettled?.(savedByPiece);
      // the parent has now written savedPositions back into the pattern (synchronously); accept our
      // own echo so the drape watcher below doesn't rebuild what we just settled
      lastDrapeKey = drapeKey(currentPattern);
    };
    // 3D seam tool: edge clicks on the draped garment route through the shared tool state
    renderer.onSeamEdgePick = (pick: SeamPick) => {
      const kind = get(selectedTool) === 'seam-multi' ? 'multi' : 'single';
      const res = applySeamPick(kind, get(seamTool), pick);
      if (res.commit) {
        const seam = {
          id: 'Seam_' + crypto.randomUUID().replace(/-/g, '').slice(0, 9),
          name: '',
          fromPaths: res.commit.from.map((r) => ({ ...r })),
          toPaths: res.commit.to.map((r) => ({ ...r }))
        };
        onpatternupdate?.({ ...currentPattern, seams: [...currentPattern.seams, seam], hasChanged: true }, 'Add seam');
        selectedSeamId.set(seam.id);
        seamTool.set(res.state);
        toast('Seam created', 'success');
      } else {
        seamTool.set(res.state);
      }
    };
    builtSigs = pieceSigs(currentPattern);
    lastKey = patternKey(currentPattern, builtSigs);
    lastDrapeKey = drapeKey(currentPattern);
    lightingMode = currentPattern.settings3d.lightingMode || 'flat';
    renderer.setPattern(currentPattern).then((built) => {
      if (!built) return;
      poses = renderer?.poseNames() ?? [];
      renderer?.setHighlightedPiece(selectedPieceId);
      applyLabelDisplay();
      renderer?.setShowSeams(currentPattern.settings3d.showSeams ?? false);
    });
  });

  function handleViewportReady(viewport: Viewport): void {
    viewportInstance = viewport;
  }

  onDestroy(() => {
    clearTimeout(rebuildTimer);
    unsubscribeTheme?.();
    unsubscribeTheme = null;
    // onDestroy also runs during SSR, where window is undefined
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      const target = window as DrapeDebugWindow;
      if (target.__seamerWebgpuDrape === drapeDebugApi) delete target.__seamerWebgpuDrape;
      drapeDebugApi = null;
    }
    renderer?.dispose();
    renderer = null;
  });

  $effect(() => {
    const key = patternKey(currentPattern);
    const dKey = drapeKey(currentPattern);
    if ((key === lastKey && dKey === lastDrapeKey) || !renderer) return;
    lastKey = key;
    lastDrapeKey = dKey;
    clearTimeout(rebuildTimer);
    const snapshot = currentPattern;
    rebuildTimer = setTimeout(() => {
      // Diff the about-to-build pattern against the last ACTUAL build to find which pieces' shapes
      // were edited (robust across several edits within the debounce window). Those rebuild from live
      // geometry; the rest keep their cached drape. builtSigs advances only here, when a build runs.
      const sigs = pieceSigs(snapshot);
      const changed = new Set<string>();
      for (const [id, sig] of sigs) if (builtSigs.has(id) && builtSigs.get(id) !== sig) changed.add(id);
      renderer?.setPattern(snapshot, changed).then((built) => {
        if (!built) return;
        builtSigs = sigs;
        poses = renderer?.poseNames() ?? [];
        renderer?.setHighlightedPiece(selectedPieceId);
        applyLabelDisplay();
        renderer?.setShowSeams(snapshot.settings3d.showSeams ?? false);
      });
    }, 350);
  });

  // push external (2D) selection into the 3D view
  $effect(() => {
    const id = selectedPieceId;
    renderer?.setHighlightedPiece(id ?? null);
  });

  // "Anchor to saved drape" toggle (persisted): ON preserves imported/source equilibria; grabbed
  // regions release it locally, while OFF opts into a fully free-running solve.
  $effect(() => { renderer?.setAnchorsEnabled($simAnchors); });

  // seam tool active? push the shared selection into the 3D overlay (tubes + direction cones)
  $effect(() => {
    const tool = $selectedTool;
    const state = $seamTool;
    const active = tool === 'seam' || tool === 'seam-single' || tool === 'seam-multi';
    renderer?.setSeamToolState(active ? state : null, tool === 'seam-multi' ? 'multi' : 'single');
  });

  // a seam selected in the SeamPanel/ObjectBrowser displays in 3D even with "Show seams" off
  $effect(() => { renderer?.setSelectedSeam($selectedSeamId); });

  // BodyPanel measurement clicks: fly the camera to the measurement's framing AND draw its
  // on-mesh segment (clicking the same one again hides it).
  $effect(() => {
    const name = $bodyZoomRequest;
    if (!name || !renderer) return;
    if (renderer.showBodyMeasurement(name)) renderer.zoomToBodyMeasurement(name);
    bodyZoomRequest.set(null);
  });

  let hoveredArrangementPoint = $state<string | null>(null);

  // freeze/unfreeze the active piece (3D selection first, falling back to the 2D selection)
  const activePieceId = $derived(selectedPiece ?? selectedPieceId ?? null);
  const frozenSelected = $derived.by(() => {
    const id = activePieceId;
    return !!id && (currentPattern.pieces.find((p) => p.id === id)?.settings3d.frozen ?? false);
  });
  function toggleFreezeSelected() {
    const id = activePieceId;
    if (!id) return;
    const pieces = currentPattern.pieces.map((p) =>
      p.id === id ? { ...p, settings3d: { ...p.settings3d, frozen: !p.settings3d.frozen } } : p
    );
    const next = pieces.find((p) => p.id === id)?.settings3d.frozen;
    onpatternupdate?.({ ...currentPattern, pieces, hasChanged: true }, next ? 'Freeze piece' : 'Unfreeze piece');
  }

  // post-processing settings (AO + depth of field) applied live from the pattern
  $effect(() => {
    const s = currentPattern.settings3d;
    renderer?.applyPostSettings({
      aoEnabled: s.n8aoEnabled,
      aoIntensity: s.n8aoIntensity,
      aoRadius: s.n8aoRadius,
      aoFalloff: s.n8aoDistanceFalloff,
      bokehFStop: s.bokehFStop
    });
  });

  // arrangement-point overlay toggle
  $effect(() => { renderer?.setShowArrangementPoints(currentPattern.settings3d.showArrangementPoints ?? false); });

  // Persisted scene switches remain live when changed outside this component (PropertyPanel,
  // undo/redo, document restore, or automation).
  $effect(() => {
    const s = currentPattern.settings3d;
    showAvatar = s.avatarEnabled !== false && s.showAvatar;
    renderer?.setAvatarVisible(showAvatar);
  });
  $effect(() => {
    const next = currentPattern.settings3d.showTriangles;
    showTriangles = next;
    renderer?.setShowTriangles(next);
  });
  $effect(() => {
    lightingMode = currentPattern.settings3d.lightingMode || 'flat';
    renderer?.setLightingMode(lightingMode);
  });
  $effect(() => {
    const s = currentPattern.settings3d;
    renderer?.setCameraState(s.cameraPosition, s.controlsTarget, s.cameraFov);
  });
  $effect(() => {
    const s = currentPattern.settings3d;
    void renderer?.setSimConfig({
      gravity: [...s.gravity],
      handleSelfCollisions: s.handleSelfCollisions
    });
  });
  $effect(() => {
    renderer?.setDebugFocusPoint(currentPattern.settings3d.debugFocusPoint);
  });

  // render quality: SMAA supersample scale + "Force low-performance mode"
  $effect(() => {
    const s = currentPattern.settings3d;
    renderer?.setRenderQualityOptions({ forceLowEnd: s.forceLowEndHardware, smaaScale: s.smaaScale });
  });

  // 3D measurements: mirror the 2D Measure tool's distance measurements onto the draped garment
  $effect(() => {
    const show = currentPattern.showMeasurements !== false;
    const points = indexPoints(currentPattern);
    const placed = placedPoints(currentPattern, points);
    const world = (id: string) => placed.find((q) => q.pointId === id)?.world ?? null;
    const defs = show
      ? (currentPattern.measurements ?? [])
          .filter((m) => m.kind !== 'angle')
          .map((m) => {
            const a = world(m.fromPointId);
            const b = world(m.toPointId);
            return a && b ? { id: m.id, name: m.name, a, b, unit: currentPattern.lengthUnit } : null;
          })
          .filter((m): m is NonNullable<typeof m> => !!m)
      : [];
    renderer?.setMeasurements(defs);
  });

  function toggleSimulate() {
    if (!renderer) return;
    if (status === 'simulating') renderer.pauseSimulation();
    else if (status === 'ready') renderer.simulate();
  }
  async function reset() {
    if (!renderer || (status !== 'ready' && status !== 'simulating')) return;
    const accepted = await confirm({
      title: 'Reset all simulations?',
      message: 'Are you sure you want to reset all simulations? This will discard all simulated positions.',
      confirmLabel: 'Reset'
    });
    if (!accepted) return;
    renderer.resetSimulation();
    if (currentPattern.pieces.some((piece) => piece.settings3d.savedPositions.length > 0)) {
      const pieces = currentPattern.pieces.map((piece) => ({
        ...piece,
        settings3d: { ...piece.settings3d, savedPositions: [] }
      }));
      onpatternupdate?.({ ...currentPattern, pieces, hasChanged: true }, 'Reset simulation');
    }
  }
  // arrangeKind is kept in sync by renderer.onModeChange, so these just toggle/switch the tool.
  function toggleArrangeMode() {
    if (!renderer) return;
    if (sceneMode === 'arrange' && arrangeKind === 'arrange') { renderer.exitArrangeMode(); return; }
    if (sceneMode === 'arrange') renderer.exitArrangeMode(); // switching from the Move tool
    renderer.enterArrangeMode();
  }
  function toggleManipulateMode() {
    if (!renderer) return;
    if (sceneMode === 'arrange' && arrangeKind === 'manipulate') { renderer.exitArrangeMode(); return; }
    if (sceneMode === 'arrange') renderer.exitArrangeMode(); // switching from the Arrange tool
    renderer.enterManipulateMode();
  }
  function setGizmoMode(m: 'translate' | 'rotate') { gizmoMode = m; renderer?.setArrangeTransformMode(m); }
  function drapeFromArrangement() { renderer?.simulateFromArrangement(); }
  function setLighting(mode: string) {
    lightingMode = mode;
    renderer?.setLightingMode(mode);
    if (currentPattern.settings3d.lightingMode !== mode) {
      onpatternupdate?.({
        ...currentPattern,
        settings3d: { ...currentPattern.settings3d, lightingMode: mode },
        hasChanged: true
      }, `Use ${lightingTabs.find((tab) => tab.id === mode)?.label ?? mode} lighting`);
    }
  }
  // Dark mode flips the app's DaisyUI data-theme; both the 3D scene and the 2D canvas observe it and
  // re-theme themselves (see utils/theme), and all DaisyUI panels switch with it.
  function toggleDark() { dark = toggleTheme() === 'dark'; }
  function setPose(p: string) { currentPose = p; renderer?.setPose(p); }
  function toggleTriangles() {
    const next = !showTriangles;
    showTriangles = next;
    renderer?.setShowTriangles(next);
    if (currentPattern.settings3d.showTriangles !== next) {
      onpatternupdate?.({
        ...currentPattern,
        settings3d: { ...currentPattern.settings3d, showTriangles: next },
        hasChanged: true
      }, next ? 'Show triangles' : 'Hide triangles');
    }
  }
  /**
   * Whether this pattern is drafted on a body at all. A lantern, a bag, a lampshade — anything that
   * is not worn — has no person in it, and the avatar, its poses and the body chip are all noise.
   * This is a document setting, not a view toggle: it persists, and it undoes.
   */
  const bodyEnabled = $derived(currentPattern.settings3d.avatarEnabled !== false);

  function togglePerson() {
    const enabling = !bodyEnabled;
    onpatternupdate?.({
      ...currentPattern,
      settings3d: { ...currentPattern.settings3d, avatarEnabled: enabling, showAvatar: enabling },
      hasChanged: true
    }, enabling ? 'Draft on a body' : 'Remove the body');
  }

  function toggleAvatar() { showAvatar = !showAvatar; renderer?.setAvatarVisible(showAvatar); }
  function toggleLabels() { onlabeldisplaychange?.(labelDisplay === 'off' ? 'flat' : 'off'); }

  // apply the piece-label display setting (driven from the Properties panel)
  function applyLabelDisplay() {
    renderer?.setShowLabels(labelDisplay !== 'off');
    renderer?.setLabelMode(labelDisplay === 'flat' ? 'flat' : 'billboard');
  }
  $effect(() => { void labelDisplay; applyLabelDisplay(); });
  // live-apply the "Show seams (3D)" toggle from the Properties panel
  $effect(() => { const on = currentPattern.settings3d.showSeams ?? false; renderer?.setShowSeams(on); });
  function setView(v: 'front' | 'back' | 'left' | 'right' | 'top' | 'reset') { renderer?.setCameraView(v); }
  function downloadOBJ() {
    if (!renderer) return;
    const obj = renderer.exportOBJ();
    downloadFile(new Blob([obj], { type: 'text/plain' }), 'obj');
  }
  // Binary STL of the draped garment (+ avatar when shown) — for 3D printing / CAD handoff.
  async function downloadSTL() {
    if (!renderer) return;
    const stl = await renderer.exportSTL();
    const bytes = new Uint8Array(stl.buffer as ArrayBuffer, stl.byteOffset, stl.byteLength);
    downloadFile(new Blob([bytes], { type: 'model/stl' }), 'stl');
  }
  async function downloadGLTF() {
    if (!renderer) return;
    const base = currentPattern.name.replace(/\s+/g, '_') || 'garment';
    try {
      const gltf = await sceneToGLTF(renderer.exportScene());
      const blob = gltf instanceof ArrayBuffer
        ? new Blob([gltf], { type: 'model/gltf-binary' })
        : new Blob([JSON.stringify(gltf, null, 2)], { type: 'model/gltf+json' });
      downloadBlob(`${base}.${gltf instanceof ArrayBuffer ? 'glb' : 'gltf'}`, blob);
      toastSuccess('Exported glTF');
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'glTF export failed');
    }
  }
  function downloadFile(blob: Blob, ext: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentPattern.name.replace(/\s+/g, '_') || 'garment'}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }
  // Save Image: export the current 3D view as a PNG (matches the source's bottom-bar "Save Image").
  function saveImage() {
    if (!renderer) return;
    const a = document.createElement('a');
    a.href = renderer.captureImage();
    a.download = `${currentPattern.name.replace(/\s+/g, '_') || 'garment'}.png`;
    a.click();
  }

  // Simulation controls: expose the solver parameters (matches the source's "Simulation controls").
  let showSimPanel = $state(false);
  let showTimeline = $state(false);
  let showWires = $state(true);

  function toggleTimeline() {
    showTimeline = !showTimeline;
    // A recording drives the mesh directly; leaving the solver running would fight it for the buffer.
    if (showTimeline && status === 'simulating') renderer?.pauseSimulation();
  }
  function toggleWires() {
    showWires = !showWires;
    renderer?.setShowWires(showWires);
  }
  let stretchError = $state<number | null>(null);
  let simCfg = $state<SimConfig | null>(null);
  let cameraFov = $state(54);
  function toggleSimPanel() {
    showSimPanel = !showSimPanel;
    if (showSimPanel && renderer) { simCfg = renderer.getSimConfig(); cameraFov = renderer.getCameraFov(); }
  }
  function setFov(v: number) { cameraFov = v; renderer?.setCameraFov(v); }
  // 36mm-frame equivalent focal length for the current FOV (the original's Focal(mm) slider)
  const focalMm = $derived(18 / Math.tan(((cameraFov / 2) * Math.PI) / 180));
  function setSim(patch: Partial<SimConfig>) {
    if (!renderer || !simCfg) return;
    simCfg = { ...simCfg, ...patch };
    void renderer.setSimConfig(patch);
  }
  // gravity is stored as a vector; the slider edits its magnitude (m/s²).
  function setGravity(g: number) { setSim({ gravity: [0, -g, 0] }); }

  // Frozen snapshot: a translucent ghost of the current drape, kept as a visual reference.
  let hasSnap = $state(false);
  let snapOpacity = $state(0.35);
  function freezeSnapshot() { renderer?.freezeSnapshot(snapOpacity); hasSnap = !!renderer?.hasSnapshot(); }
  function clearSnapshot() { renderer?.clearSnapshot(); hasSnap = false; }
  function setSnapOpacity(o: number) { snapOpacity = o; renderer?.setSnapshotOpacity(o); }

  // 'A' toggles arrange mode, Space starts/stops the simulation (matches the source's shortcuts).
  function handleKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'a' || e.key === 'A') { e.preventDefault(); toggleArrangeMode(); }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleManipulateMode(); }
    if (e.key === ' ') { e.preventDefault(); toggleSimulate(); }
  }

  // Right-side 3D control rail — Material Symbols icons + hover-to-expand labels, mirroring the
  // original studio. `sep` inserts a spacer before the button; `shortcut` shows a kbd on hover.
  interface Tool { label: string; icon: string; onClick: () => void; active?: () => boolean; disabled?: () => boolean; sep?: boolean; shortcut?: string }
  const tools = $derived<Tool[]>([
    { label: status === 'simulating' ? 'Pause simulation' : 'Start simulation', icon: status === 'simulating' ? 'pause' : 'play_arrow', onClick: toggleSimulate, active: () => status === 'simulating', disabled: () => status !== 'ready' && status !== 'simulating' },
    { label: 'Reset simulation', icon: 'refresh', onClick: () => void reset(), disabled: () => status !== 'ready' && status !== 'simulating' },
    { label: 'Show triangles', icon: 'change_history', onClick: toggleTriangles, active: () => showTriangles, sep: true },
    { label: bodyEnabled ? 'Hide avatar' : 'Draft on a body', icon: 'person', onClick: bodyEnabled ? toggleAvatar : togglePerson, active: () => bodyEnabled && showAvatar },
    { label: bodyEnabled ? 'Remove the body' : 'No body — lantern, bag, shade', icon: bodyEnabled ? 'person_off' : 'deployed_code', onClick: togglePerson, active: () => !bodyEnabled },
    { label: labelDisplay === 'off' ? 'Show piece labels' : 'Hide piece labels', icon: labelDisplay === 'off' ? 'label_off' : 'label', onClick: toggleLabels, active: () => labelDisplay !== 'off' },
    { label: sceneMode === 'arrange' && arrangeKind === 'arrange' ? 'Exit arrange mode' : 'Arrange (A)', icon: 'scatter_plot', onClick: toggleArrangeMode, active: () => sceneMode === 'arrange' && arrangeKind === 'arrange', shortcut: 'A' },
    { label: sceneMode === 'arrange' && arrangeKind === 'manipulate' ? 'Exit move mode' : 'Move pieces (M)', icon: 'open_with', onClick: toggleManipulateMode, active: () => sceneMode === 'arrange' && arrangeKind === 'manipulate', shortcut: 'M' },
    { label: frozenSelected ? 'Unfreeze piece' : 'Freeze piece', icon: frozenSelected ? 'lock_open' : 'lock', onClick: toggleFreezeSelected, active: () => frozenSelected },
    { label: 'Simulation controls', icon: 'tune', onClick: toggleSimPanel, active: () => showSimPanel },
    { label: 'Assembly timeline', icon: 'linear_scale', onClick: toggleTimeline, active: () => showTimeline, sep: true },
    { label: showWires ? 'Hide wires' : 'Show wires', icon: 'cable', onClick: toggleWires, active: () => showWires },
    { label: dark ? 'Light mode' : 'Dark mode', icon: dark ? 'light_mode' : 'dark_mode', onClick: toggleDark, active: () => dark, sep: true },
    { label: 'Download as OBJ', icon: 'download', onClick: downloadOBJ },
    { label: 'Download as STL', icon: 'deployed_code', onClick: () => void downloadSTL() },
    { label: 'Download as glTF', icon: 'view_in_ar', onClick: () => void downloadGLTF() }
  ]);
</script>

<svelte:window onkeydown={handleKey} />

<div class="w-full h-full relative" data-testid="pattern-scene-3d" data-status={status}>
  <div
    class="w-full h-full"
    use:viewportAction={{
      projection: '3d',
      postProcessing: true,
      aoPassFactory: createSeamerAoPass,
      onReady: handleViewportReady
    }}
  ></div>
  {#if $show3dStats}
    <div class="absolute bottom-2 right-2 z-20 font-mono text-[11px] bg-black/60 text-green-300 rounded px-2 py-1 pointer-events-none">{fps} fps</div>
  {/if}
  {#if hoveredArrangementPoint}
    <div class="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 text-[11px] bg-base-100/90 border border-base-300 rounded px-2 py-1 pointer-events-none shadow">
      {hoveredArrangementPoint}{sceneMode === 'arrange' && selectedPiece ? ' — click to arrange the selected piece here' : ''}
    </div>
  {/if}

  {#if !webgpu}
    <div class="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-warning text-warning-content text-xs rounded px-3 py-1 shadow">
      WebGPU not available — avatar shown, but live draping needs Chrome/Edge.
    </div>
  {/if}
  {#if status === 'error'}
    <div class="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-error text-error-content text-xs rounded px-3 py-1 shadow max-w-md text-center">{statusMessage || 'Renderer error'}</div>
  {/if}
  {#if status === 'invalid'}
    <div class="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-warning text-warning-content text-xs rounded px-3 py-1 shadow max-w-md text-center">{statusMessage}</div>
  {/if}
  {#if status === 'loading'}
    <div class="absolute inset-0 flex flex-col gap-2 items-center justify-center z-10 pointer-events-none" role="status" aria-live="polite">
      <span class="loading loading-spinner loading-md opacity-70"></span>
      <span class="rounded bg-base-100/85 px-3 py-1 text-xs shadow backdrop-blur-sm">Preparing 3D garment…</span>
    </div>
  {/if}

  <!-- Right-side control toolbar (mirrors the original studio) -->
  <div class="flex flex-col mt-3 absolute right-2 top-[6rem] z-10" data-tour-id="tour-3d-controls">
    {#each tools as tool}
      {#if tool.sep}<div class="h-8 mx-2"></div>{/if}
      <button
        type="button"
        title={tool.label}
        aria-label={tool.label}
        class="group relative flex items-center h-8 md:h-10 justify-center btn p-0 my-0.5 ml-1 mr-0 md:mr-1 max-w-[calc(100vw-3rem)] overflow-hidden transition-all self-end text-center hover:aspect-auto aspect-square shadow"
        class:btn-accent={tool.active?.()}
        class:btn-primary={!tool.active?.()}
        disabled={tool.disabled?.()}
        onclick={tool.onClick}
      >
        <span class="min-w-0 flex-1 p-0 hidden group-hover:inline">
          <span class="max-w-[9rem] overflow-hidden text-ellipsis text-xs pl-2 pr-1 whitespace-nowrap inline-flex items-center gap-1" style="line-height: 2">
            {tool.label}
            {#if tool.shortcut}<span class="kbd kbd-xs">{tool.shortcut}</span>{/if}
          </span>
        </span>
        <span class="block aspect-square h-full flex items-center justify-center">
          <span class="material-symbols-rounded notranslate" aria-hidden="true">{tool.icon}</span>
        </span>
      </button>
    {/each}
  </div>

  <!-- Piece-edit panel: select a piece, move/rotate it with the gizmo, then drape/settle -->
  {#if sceneMode === 'arrange'}
    <div class="absolute top-12 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1">
      <div class="bg-base-200/90 backdrop-blur rounded-lg shadow px-3 py-2 flex items-center gap-2">
        <span class="text-xs opacity-70">{selectedPiece ? 'Piece selected' : 'Click a piece to select'}</span>
        <div class="join">
          <button class="join-item btn btn-xs" class:btn-active={gizmoMode === 'translate'} onclick={() => setGizmoMode('translate')}>Move</button>
          <button class="join-item btn btn-xs" class:btn-active={gizmoMode === 'rotate'} onclick={() => setGizmoMode('rotate')}>Rotate</button>
        </div>
        <button class="btn btn-xs btn-primary" onclick={drapeFromArrangement}>{arrangeKind === 'manipulate' ? 'Settle ▶' : 'Drape ▶'}</button>
        <button class="btn btn-xs btn-ghost" onclick={() => renderer?.exitArrangeMode()}>Cancel</button>
      </div>
      {#if arrangeKind === 'manipulate'}
        <span class="text-[10px] opacity-60 bg-base-200/70 rounded px-2 py-0.5">Drag a piece off the body — Settle eases it back into place</span>
      {/if}
    </div>
  {/if}

  <!-- Assembly timeline: record the garment sewing itself, then scrub the recording -->
  {#if showTimeline}
    <!-- clears the pose and lighting bars that already own the bottom centre -->
    <div class="absolute bottom-28 left-1/2 -translate-x-1/2 z-20">
      <AssemblyTimeline
        disabled={status !== 'ready' && status !== 'simulating'}
        record={(options) => renderer?.recordAssemblyTimeline(options) ?? Promise.resolve(null)}
        showFrame={(positions) => renderer?.showAssemblyFrame(positions)}
        onclose={() => (showTimeline = false)}
      />
    </div>
  {/if}

  <!-- Simulation controls panel (mirrors the source's "Simulation controls"/Simulator config) -->
  {#if showSimPanel && simCfg}
    <div class="absolute top-12 right-2 z-10 w-60 bg-base-200/95 backdrop-blur rounded-lg shadow-lg p-3 text-xs space-y-2 max-h-[70vh] overflow-y-auto">
      <div class="flex items-center justify-between"><span class="font-bold">Simulation controls</span>
        <button class="btn btn-ghost btn-xs btn-circle" onclick={() => (showSimPanel = false)} aria-label="Close">✕</button>
      </div>
      {#if stretchError !== null}
        <div class="flex items-center justify-between opacity-80" title="RMS deviation of every cloth edge from its rest length at the last settled drape">
          <span>RMS stretch error</span><span class="tabular-nums">{(stretchError * 100).toFixed(1)}%</span>
        </div>
      {/if}
      <label class="flex items-center justify-between gap-2"><span>Self-collision</span>
        <input type="checkbox" class="toggle toggle-xs" checked={simCfg.handleSelfCollisions} onchange={(e) => setSim({ handleSelfCollisions: e.currentTarget.checked })} /></label>
      <label class="flex items-center justify-between gap-2"><span>Body collision</span>
        <input type="checkbox" class="toggle toggle-xs" checked={simCfg.handleExternalCollisions} onchange={(e) => setSim({ handleExternalCollisions: e.currentTarget.checked })} /></label>
      <label class="flex items-center justify-between gap-2"><span>Use bending</span>
        <input type="checkbox" class="toggle toggle-xs" checked={simCfg.useBending} onchange={(e) => setSim({ useBending: e.currentTarget.checked })} /></label>
      <label class="flex items-center justify-between gap-2" title="ON: softly preserve the saved drape while remaining interactive. OFF: fully free-run the local solver."><span>Anchor to saved drape</span>
        <input type="checkbox" class="toggle toggle-xs" checked={$simAnchors} onchange={(e) => simAnchors.set(e.currentTarget.checked)} /></label>
      <label class="flex items-center justify-between gap-2"><span>Time step</span>
        <input type="number" class="input input-bordered input-xs w-20" min="0.001" max="1" step="0.001" value={simCfg.timeStep}
          onchange={(e) => { const v = parseFloat(e.currentTarget.value); if (Number.isFinite(v) && v > 0) setSim({ timeStep: Math.min(1, Math.max(0.001, v)) }); }} /></label>
      <label class="flex items-center justify-between gap-2"><span>Sub steps</span>
        <input type="number" class="input input-bordered input-xs w-20" min="1" max="1000" step="1" value={simCfg.subSteps}
          onchange={(e) => { const v = Math.round(parseFloat(e.currentTarget.value)); if (Number.isFinite(v) && v >= 1) setSim({ subSteps: Math.min(1000, v) }); }} /></label>
      {#each [
        { key: 'gravity', label: 'Gravity', min: 0, max: 20, step: 0.1, get: () => -simCfg!.gravity[1], set: setGravity, fmt: (v: number) => v.toFixed(1) },
        { key: 'maxVelocity', label: 'Max velocity (m/s)', min: 0, max: 10, step: 0.5, get: () => simCfg!.maxVelocity, set: (v: number) => setSim({ maxVelocity: v }), fmt: (v: number) => v.toFixed(1) },
        { key: 'minVelocity', label: 'Min velocity (m/s)', min: 0, max: 1, step: 0.001, get: () => simCfg!.minVelocity, set: (v: number) => setSim({ minVelocity: v }), fmt: (v: number) => v.toFixed(3) },
        { key: 'globalDamping', label: 'Global damping', min: 0, max: 1, step: 0.01, get: () => simCfg!.globalDamping, set: (v: number) => setSim({ globalDamping: v }), fmt: (v: number) => v.toFixed(2) },
        { key: 'localDamping', label: 'Local damping', min: 0, max: 1, step: 0.01, get: () => simCfg!.localDamping, set: (v: number) => setSim({ localDamping: v }), fmt: (v: number) => v.toFixed(2) },
        { key: 'nearDamping', label: 'Near damping', min: 0, max: 1, step: 0.01, get: () => simCfg!.nearDamping, set: (v: number) => setSim({ nearDamping: v }), fmt: (v: number) => v.toFixed(2) },
        { key: 'simulationThickness', label: 'Simulation thickness', min: 0, max: 20, step: 0.5, get: () => worldToDocMm(simCfg!.simulationThickness), set: (v: number) => setSim({ simulationThickness: docMmToWorld(v) }), fmt: (v: number) => `${v.toFixed(1)} mm` },
        { key: 'edgeThickness', label: 'Simulation edge thickness', min: 0, max: 20, step: 0.5, get: () => worldToDocMm(simCfg!.edgeThickness), set: (v: number) => setSim({ edgeThickness: docMmToWorld(v) }), fmt: (v: number) => `${v.toFixed(1)} mm` },
        { key: 'selfCollisionFriction', label: 'Self friction', min: 0, max: 1, step: 0.05, get: () => simCfg!.selfCollisionFriction, set: (v: number) => setSim({ selfCollisionFriction: v }), fmt: (v: number) => v.toFixed(2) },
        { key: 'externalCollisionFriction', label: 'Body friction', min: 0, max: 1, step: 0.05, get: () => simCfg!.externalCollisionFriction, set: (v: number) => setSim({ externalCollisionFriction: v }), fmt: (v: number) => v.toFixed(2) },
        { key: 'seamStrength', label: 'Seam strength', min: 0, max: 2, step: 0.1, get: () => simCfg!.seamStrength, set: (v: number) => setSim({ seamStrength: v }), fmt: (v: number) => v.toFixed(1) },
        { key: 'seamIterations', label: 'Seam iterations', min: 1, max: 8, step: 1, get: () => simCfg!.seamIterations, set: (v: number) => setSim({ seamIterations: v }), fmt: (v: number) => v.toFixed(0) }
      ] as ctl (ctl.key)}
        <label class="flex flex-col gap-0.5">
          <span class="flex justify-between"><span>{ctl.label}</span><span class="opacity-60">{ctl.fmt(ctl.get())}</span></span>
          <input type="range" class="range range-xs" min={ctl.min} max={ctl.max} step={ctl.step} value={ctl.get()} oninput={(e) => ctl.set(parseFloat(e.currentTarget.value))} />
        </label>
      {/each}
      <p class="opacity-50 leading-tight pt-1">Changes apply immediately; the drape is preserved.</p>
      <div class="border-t border-base-300 pt-2">
        <label class="flex flex-col gap-0.5">
          <span class="flex justify-between"><span>Camera FOV</span><span class="opacity-60">{cameraFov.toFixed(0)}°</span></span>
          <input type="range" class="range range-xs" min="20" max="90" step="1" value={cameraFov} oninput={(e) => setFov(parseFloat(e.currentTarget.value))} />
          <!-- photographic twin of the FOV slider: 36mm-equivalent focal length (drives DoF aperture) -->
          <span class="flex justify-between"><span>Focal length</span><span class="opacity-60">{focalMm.toFixed(0)} mm</span></span>
          <input type="range" class="range range-xs" min="24" max="200" step="1" value={focalMm}
            oninput={(e) => setFov((2 * Math.atan(18 / Math.max(24, parseFloat(e.currentTarget.value)))) * 180 / Math.PI)} />
        </label>
      </div>
      <div class="border-t border-base-300 pt-2 space-y-1">
        <span class="font-bold">Frozen snapshot</span>
        {#if hasSnap}
          <label class="flex flex-col gap-0.5">
            <span class="flex justify-between"><span>Opacity</span><span class="opacity-60">{snapOpacity.toFixed(2)}</span></span>
            <input type="range" class="range range-xs" min="0.05" max="1" step="0.05" value={snapOpacity} oninput={(e) => setSnapOpacity(parseFloat(e.currentTarget.value))} />
          </label>
          <div class="flex gap-1">
            <button class="btn btn-xs flex-1" onclick={freezeSnapshot}>Re-freeze</button>
            <button class="btn btn-xs btn-ghost flex-1" onclick={clearSnapshot}>Remove</button>
          </div>
        {:else}
          <button class="btn btn-xs btn-block" onclick={freezeSnapshot}>Freeze snapshot of drape</button>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Camera view presets -->
  <div class="absolute top-2 right-2 z-10 join join-horizontal bg-base-200/85 backdrop-blur rounded-lg shadow">
    {#each [['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top']] as [v, label]}
      <button class="join-item btn btn-xs" title={`${label} view`} onclick={() => setView(v as 'front')}>{label[0]}</button>
    {/each}
    <button class="join-item btn btn-xs" title="Reset view" onclick={() => setView('reset')} aria-label="Reset view"><span class="material-symbols-rounded text-sm">refresh</span></button>
  </div>

  <!-- Lighting-mode tabs + Save Image (mirrors the source's bottom bar) -->
  <div class="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
    <div class="join join-horizontal bg-base-200/85 backdrop-blur rounded-lg shadow">
      {#each lightingTabs as tab}
        <button class="join-item btn btn-xs" class:btn-active={lightingMode === tab.id} onclick={() => setLighting(tab.id)}>{tab.label}</button>
      {/each}
    </div>
    <button class="btn btn-xs gap-1 bg-base-200/85 backdrop-blur shadow" title="Save a PNG of the 3D view" onclick={saveImage}>
      <span class="material-symbols-rounded notranslate text-base" aria-hidden="true">photo_camera</span>
      Save Image
    </button>
  </div>

  <!-- Pose selector — only meaningful when the pattern is drafted on a body -->
  {#if poses.length && bodyEnabled}
    <div class="absolute bottom-11 left-1/2 -translate-x-1/2 z-10">
      <div class="join join-horizontal bg-base-200/85 backdrop-blur rounded-lg shadow">
        {#each poses as p}
          <button class="join-item btn btn-xs" class:btn-active={currentPose === p} onclick={() => setPose(p)}>{p}</button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="absolute top-2 left-2 z-10 text-xs opacity-60 bg-base-200/80 rounded px-2 py-1">
    {#if bodyEnabled}{currentPattern.body.gender} · {/if}{currentPattern.pieces.length} pieces
  </div>
</div>
