<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from 'svelte';
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
  import { PatternRenderer, type DrapeDebugState, type DrapeFailureDiagnostics, type RendererStatus, type SceneMode } from '$lib/scene/scene3d';
  import type { FrozenAppRenderRequest, FrozenAppRenderReceipt } from '$lib/scene/frozenAppRender';
  import { compatibleSourceBodyCheckpoint } from '$lib/scene/sourceBodyCheckpoint';
  import AssemblyTimeline from '$lib/components/AssemblyTimeline.svelte';
  import { createSeamerAoPass } from '$lib/scene/n8aoPost';
  import type { SimConfig } from '@seamer/cloth-sim';
  import { isDarkTheme, toggleTheme, applyStoredTheme, onThemeChange } from '$lib/utils/theme';
  import { show3dStats, simAnchors, selectedTool, seamTool, selectedSeamId, bodyZoomRequest } from '$lib/stores/pattern';
  import { get } from 'svelte/store';
  import { isAppShortcutBlocked, isDocumentKeyboardTarget } from '$lib/utils/keyboard';
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
    onfrozendiagnosticchange?: (active: boolean) => void;
    selectedPieceId?: string | null;
    onpieceselect?: (id: string | null) => void;
    labelDisplay?: 'off' | 'billboard' | 'flat';
    onlabeldisplaychange?: (value: 'off' | 'billboard' | 'flat') => void;
    /** Fired when a user-run drape settles, with per-piece settled savedPositions to persist. */
    ondrapesettled?: (savedByPiece: Record<string, number[]>, sourceStretchPolicy: ReturnType<PatternRenderer['getSourceStretchPolicy']>, sourceAssemblyComplete: boolean | null, sourceGatherPolicy?: ReturnType<PatternRenderer['getSourceGatherCacheMarker']>, sourceGatherIntent?: 'manual') => void;
    /** Undo-aware pattern update (arrangement-point snaps, freeze toggle). */
    onpatternupdate?: (p: Pattern, label?: string) => void;
    /** Non-undo camera write-back so the view survives a reload. */
    oncamerachange?: (pos: [number, number, number], target: [number, number, number], fov: number) => void;
  }

  let { currentPattern, selectedPieceId = null, onpieceselect, labelDisplay = 'flat', onlabeldisplaychange, ondrapesettled, onpatternupdate, oncamerachange, onfrozendiagnosticchange }: Props = $props();

  const docMmToWorld = (mm: number): number => docToWorld({ x: mm, y: 0 }).x;
  const worldToDocMm = (metres: number): number =>
    metres / docToWorld({ x: 1, y: 0 }).x;

  let viewportInstance: Viewport | null = null;
  let renderer: PatternRenderer | null = null;
  let sceneShell: HTMLDivElement;

  /** File imports can replace a document while retaining its id. */
  export function beginCameraDocument() { renderer?.beginCameraDocument(); }

  /** Stable project-export checkpoint. Current particle positions are captured even while the
   *  solver is running; import resumes from this geometry with zero velocity. */
  export function captureProjectState() {
    if (!renderer || frozenReadOnly) return null;
    const camera = renderer.getCameraState();
    let previewDataUrl: string | null = null;
    try { previewDataUrl = renderer.captureImage(); } catch { /* 2D preview remains the fallback */ }
    return {
      savedByPiece: renderer.extractSavedPositions(),
      sourceStretchPolicy: renderer.getSourceStretchPolicy(),
      sourceAssemblyComplete: renderer.getSourceAssemblyComplete(),
      sourceGatherPolicy: renderer.getSourceGatherCacheMarker(),
      sourceGatherIntent: renderer.getSourceGatherIntent(),
      cameraPosition: camera.position,
      controlsTarget: camera.target,
      cameraFov: camera.fov,
      lightingMode,
      previewDataUrl
    };
  }
  let frozenReadOnly = $state(false);
  let frozenUiRevision = 0;
  let frozenReceipt = $state<FrozenAppRenderReceipt | null>(null);
  async function presentFrozenCheckpoint(request: FrozenAppRenderRequest) {
    if (!import.meta.env.DEV || !renderer || frozenReadOnly) throw new Error('A ready development 3D view is required.');
    const target = renderer, document = currentPattern, requestRevision = ++frozenUiRevision;
    frozenReadOnly = true; onfrozendiagnosticchange?.(true);
    clearTimeout(rebuildTimer);
    try {
      // Flush the genuine pending document build; frozen data cannot create or approve preparation.
      if (!await target.setPattern(document) || currentPattern !== document || renderer !== target || requestRevision !== frozenUiRevision) throw new Error('The source document changed during preparation.');
      builtSigs = pieceSigs(document); lastKey = patternKey(document); lastDrapeKey = drapeKey(document);
      const receipt = await target.presentFrozenCheckpoint(request);
      if (requestRevision !== frozenUiRevision) throw new Error('Frozen inspection was cancelled.');
      frozenReceipt = receipt; mobileControlsOpen = false; showSimPanel = false;
      await tick();
      return receipt;
    } catch (error) { if (requestRevision === frozenUiRevision) { frozenReadOnly = false; onfrozendiagnosticchange?.(false); } throw error; }
  }
  function exitFrozenCheckpoint() {
    ++frozenUiRevision;
    renderer?.exitFrozenCheckpoint(); frozenReceipt = null; frozenReadOnly = false; onfrozendiagnosticchange?.(false);
  }
  type DrapeDebugApi = { getState: () => DrapeDebugState | null; getFailureDiagnostics: () => DrapeFailureDiagnostics | null;
    getCameraState: () => ReturnType<PatternRenderer['getCameraState']> | null;
    presentFrozenCheckpoint: typeof presentFrozenCheckpoint; exitFrozenCheckpoint: typeof exitFrozenCheckpoint;
    getFrozenRenderedGeometry: () => ReturnType<PatternRenderer['getFrozenRenderedGeometry']> | null };
  type DrapeDebugWindow = Window & { __seamerWebgpuDrape?: DrapeDebugApi };
  let drapeDebugApi: DrapeDebugApi | null = null;
  let refinedReassemblyNotice = $state(false);
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
      parts.push(pc.id, sp.length, Math.round(sum * 1e3), pc.settings3d.savedDrapeState ?? '', pc.settings3d.savedBodyFitRevision ?? '', pc.settings3d.savedAssemblyRevision ?? '', pc.settings3d.savedSourceStretchPolicy ?? '', String(pc.settings3d.savedSourceAssemblyComplete ?? ''), JSON.stringify(pc.settings3d.savedSourceGatherPolicy ?? null), String(pc.settings3d.savedSourceGatherIntent ?? ''));
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
      pieces: p.pieces.map((pc) => ({ id: pc.id, material: pc.materialId, g: sigs.get(pc.id), a: pc.settings3d.arrangement, f: pc.settings3d.frozen, h: pc.hidden, fn: pc.settings3d.flipNormals, cl: pc.settings3d.collisionLayer, fc: pc.settings3d.filterExternalCollisionsByClothNormal })),
      seams: p.seams,
      // texture-map urls can be multi-MB data URLs — sign with length + tail instead of the full string
      mats: p.materials.map((m) => {
        const slotSig = (t: typeof m.frontTexture) => t && {
          c: t.color, s: t.scale, u: t.url.length, ut: t.url.slice(-24),
          n: t.normalUrl.length, ns: t.normalMapScale, o: t.opacityUrl.length, os: t.opacityMapScale
        };
        return {
          id: m.id, ft: slotSig(m.frontTexture), bt: m.useSeparateBackSide ? slotSig(m.backTexture) : null, sb: m.useSeparateBackSide,
          sw: m.stretchWarpValue, wf: m.stretchWeftValue, b: m.bendValue, w: m.weight, th: m.thickness, shell: m.visualizationThickness,
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
      drapeDebugApi = { getState: () => renderer?.getDrapeDebugState() ?? null,
        getFailureDiagnostics: () => renderer?.getDrapeFailureDiagnostics() ?? null,
        getCameraState: () => renderer?.getCameraState() ?? null,
        presentFrozenCheckpoint, exitFrozenCheckpoint, getFrozenRenderedGeometry: () => renderer?.getFrozenRenderedGeometry() ?? null };
      target.__seamerWebgpuDrape = drapeDebugApi;
    }
    webgpu = renderer.webgpuAvailable();
    renderer.onStatus = (s, msg) => {
      status = s; statusMessage = msg ?? '';
      refinedReassemblyNotice = !!renderer?.getSourceGatherCacheMarker();
      if (s === 'ready' || s === 'simulating') syncSimulationControls();
      if (s === 'ready') {
        stretchError = renderer?.getStretchError() ?? null;
        syncPoses();
      }
    };
    renderer.onModeChange = (m, piece, kind) => { sceneMode = m; selectedPiece = piece; arrangeKind = kind ?? null; };
    renderer.onSelectPiece = (id) => { onpieceselect?.(id); };
    renderer.onCameraChanged = (pos, target, fov) => { if (!frozenReadOnly) oncamerachange?.(pos, target, fov); };
    renderer.onArrangementPointHover = (name) => { hoveredArrangementPoint = name; };
    renderer.onArrangementPointPicked = ({ pieceId, name, cylinderName, uDegrees, v }) => {
      // bind the selected piece's arrangement to the clicked named point (rebuild re-seats it)
      const pieces = currentPattern.pieces.map((p) => (p.id !== pieceId ? p : {
        ...p,
        settings3d: {
          ...p.settings3d,
          savedPositions: [],
          savedDrapeState: undefined,
          savedSourceAssemblyComplete: undefined, savedSourceGatherPolicy: undefined, savedSourceGatherIntent: undefined,
          savedMeshSnapshot: undefined,
          arrangement: { ...p.settings3d.arrangement, sourcePlacement: undefined, cylinderName, uDegrees, v, uOffsetMm: 0, vOffsetMm: 0, use2DPosition: false, positionChanged: false }
        }
      }));
      onpatternupdate?.({ ...currentPattern, pieces, hasChanged: true }, `Arrange on ${name}`);
    };
    renderer.onDrapeSettled = (savedByPiece) => {
      ondrapesettled?.(savedByPiece, renderer?.getSourceStretchPolicy() ?? null, renderer?.getSourceAssemblyComplete() ?? null, renderer?.getSourceGatherCacheMarker(), renderer?.getSourceGatherIntent());
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
      syncPoses();
      syncSimulationControls();
      renderer?.setHighlightedPiece(selectedPieceId);
      applyLabelDisplay();
      renderer?.setShowSeams(currentPattern.settings3d.showSeams ?? false);
    });
  });

  function handleViewportReady(viewport: Viewport): void {
    viewportInstance = viewport;
  }

  onDestroy(() => {
    ++frozenUiRevision;
    if (frozenReadOnly) onfrozendiagnosticchange?.(false);
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
    if (frozenReadOnly) return;
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
        syncPoses();
        syncSimulationControls();
        renderer?.setHighlightedPiece(selectedPieceId);
        applyLabelDisplay();
        renderer?.setShowSeams(snapshot.settings3d.showSeams ?? false);
      });
    }, 350);
  });

  // Prints update only the existing surface maps. Keeping them out of patternKey is deliberate:
  // an appearance edit must not restart the worker or replace the garment's current drape.
  $effect(() => {
    if (frozenReadOnly) return;
    renderer?.setArtwork({ id: currentPattern.id, artwork: currentPattern.artwork });
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
    const visible = s.avatarEnabled !== false && s.showAvatar;
    showAvatar = visible;
    renderer?.setAvatarVisible(visible);
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
    // Camera framing uses explicit fresh-source intent; native/saved camera settings stay exact.
    void s.cameraPosition; void s.controlsTarget; void s.cameraFov; void s.sourceCameraFraming;
    untrack(() => renderer?.applyCameraSettings(currentPattern));
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
  function canReset() { return status === 'ready' || status === 'simulating' || status === 'invalid' || status === 'error'; }
  async function reset() {
    if (!renderer || !canReset()) return;
    const accepted = await confirm({
      title: 'Reset all simulations?',
      message: 'Are you sure you want to reset all simulations? This will discard all simulated positions.',
      confirmLabel: 'Reset'
    });
    if (!accepted) return;
    renderer.resetSimulation();
    if (currentPattern.pieces.some((piece) => piece.settings3d.savedPositions.length > 0 || piece.settings3d.savedDrapeState !== undefined)) {
      const pieces = currentPattern.pieces.map((piece) => ({
        ...piece,
        settings3d: { ...piece.settings3d, savedPositions: [], savedDrapeState: undefined, savedSourceAssemblyComplete: undefined, savedSourceGatherPolicy: undefined, savedSourceGatherIntent: undefined }
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
  function syncPoses() {
    poses = renderer?.poseNames() ?? [];
    currentPose = renderer?.poseName() ?? '';
  }
  async function setPose(p: string) {
    const currentRenderer = renderer;
    if (!currentRenderer) return;
    const previousPose = currentPose;
    try {
      await currentRenderer.setPose(p);
    } catch (error) {
      if (renderer === currentRenderer) {
        toastError(error instanceof Error ? error.message : 'Could not update body pose');
      }
    } finally {
      if (renderer === currentRenderer) currentPose = currentRenderer.poseName() ?? previousPose;
    }
  }
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

  /**
   * One button, three states: every badge, outside only, none. Inside a closed form the reverse-side
   * badges are visible through the openings and read as litter on the far wall, so "outside only" is
   * the state that actually gets used on a lantern — and it is not reachable by a plain on/off.
   */
  let showInnerLabels = $state(true);
  const labelState = $derived(
    labelDisplay === 'off' ? 'none' : showInnerLabels ? 'all' : 'outside'
  );
  function cycleLabels() {
    if (labelState === 'all') {
      showInnerLabels = false;
      renderer?.setShowInnerLabels(false);
    } else if (labelState === 'outside') {
      onlabeldisplaychange?.('off');
    } else {
      showInnerLabels = true;
      renderer?.setShowInnerLabels(true);
      onlabeldisplaychange?.('flat');
    }
  }
  $effect(() => { void labelDisplay; renderer?.setShowInnerLabels(showInnerLabels); });

  // apply the piece-label display setting (driven from the Properties panel)
  function applyLabelDisplay() {
    renderer?.setShowLabels(labelDisplay !== 'off');
    renderer?.setLabelMode(labelDisplay === 'flat' ? 'flat' : 'billboard');
  }
  $effect(() => { void labelDisplay; applyLabelDisplay(); });
  // live-apply the "Show seams (3D)" toggle from the Properties panel
  $effect(() => { const on = currentPattern.settings3d.showSeams ?? false; renderer?.setShowSeams(on); });
  function zoomToGarment() { renderer?.zoomToGarment(); }
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
  let mobileControlsOpen = $state(false);
  let isNarrowPane = $state(false);
  let mobileControlsTrigger = $state<HTMLButtonElement | undefined>();
  let mobileControlsClose = $state<HTMLButtonElement | undefined>();
  const mobileControlsId = $props.id();

  $effect(() => {
    void mobileControlsOpen; void showSimPanel; void poses.length; void needsSourceReassembly; void refinedReassemblyNotice; void status;
    void tick().then(() => renderer?.refreshSourceCameraFit());
  });

  onMount(() => {
    const resize = new ResizeObserver(([entry]) => {
      isNarrowPane = entry.contentRect.width < 480 || entry.contentRect.height < 320;
      if (!isNarrowPane && mobileControlsOpen) {
        mobileControlsOpen = false;
        if (sceneShell.contains(document.activeElement)) sceneShell.focus({ preventScroll: true });
      }
    });
    resize.observe(sceneShell);
    return () => resize.disconnect();
  });

  function closeMobileControls() {
    mobileControlsOpen = false;
    mobileControlsTrigger?.focus({ preventScroll: true });
  }
  function runMobileControl(action: () => void) {
    closeMobileControls();
    // Fit measures the available canvas after the drawer has actually closed.
    void tick().then(action);
  }

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
  let bodyCollisionCheckbox = $state<HTMLInputElement>();
  $effect(() => {
    if (bodyCollisionCheckbox && simCfg)
      bodyCollisionCheckbox.indeterminate = simCfg.handleExternalCollisions !== simCfg.handleExternalSurfaceCollisions;
  });
  let cameraFov = $state(54);
  function syncSimulationControls() {
    if (showSimPanel && renderer) simCfg = renderer.getSimConfig();
  }
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
    const currentRenderer = renderer;
    void currentRenderer.setSimConfig(patch).then(() => {
      if (renderer === currentRenderer) syncSimulationControls();
    }).catch((error) => {
      if (renderer !== currentRenderer) return;
      syncSimulationControls();
      toastError(error instanceof Error ? error.message : 'Could not update simulation controls');
    });
  }
  // gravity is stored as a vector; the slider edits its magnitude (m/s²).
  function setGravity(g: number) { setSim({ gravity: [0, -g, 0] }); }

  const sourceCheckpoint = $derived(!!currentPattern.garmentCodeSource);
  const needsSourceReassembly = $derived(compatibleSourceBodyCheckpoint(currentPattern) !== currentPattern);
  const cachedPieces = $derived(currentPattern.pieces.filter((piece) => piece.settings3d.savedPositions.length > 0));
  const holdsSavedCheckpoint = $derived(!needsSourceReassembly && cachedPieces.length > 0 && cachedPieces.every((piece) => piece.settings3d.savedDrapeState === 'held') && $simAnchors);
  function setCheckpointHold(held: boolean) {
    simAnchors.set(held);
    if (!sourceCheckpoint) return;
    const pieces = currentPattern.pieces.map((piece) => piece.settings3d.savedPositions.length === 0 ? piece : {
      ...piece,
      settings3d: { ...piece.settings3d, savedDrapeState: held ? 'held' as const : 'checkpoint' as const }
    });
    onpatternupdate?.({ ...currentPattern, pieces, hasChanged: true }, held ? 'Hold saved checkpoint' : 'Release saved checkpoint');
  }

  // Frozen snapshot: a translucent ghost of the current drape, kept as a visual reference.
  let hasSnap = $state(false);
  let snapOpacity = $state(0.35);
  function freezeSnapshot() { renderer?.freezeSnapshot(snapOpacity); hasSnap = !!renderer?.hasSnapshot(); }
  function clearSnapshot() { renderer?.clearSnapshot(); hasSnap = false; }
  function setSnapOpacity(o: number) { snapOpacity = o; renderer?.setSnapshotOpacity(o); }

  // 'A' toggles arrange mode, Space starts/stops the simulation (matches the source's shortcuts).
  // The listener is window-level, so only claim these plain keys while the pointer is over the 3D
  // pane (or focus is inside it) — otherwise M/A/Space belong to the 2D side (mirror selection,
  // measure tool, …) and would double-fire.
  let paneHovered = $state(false);
  let paneFocused = $state(false);
  function handleKey(e: KeyboardEvent) {
    if (frozenReadOnly) return;
    if (!paneHovered && !paneFocused) return;
    if (e.key === 'Escape' && mobileControlsOpen) {
      e.preventDefault();
      closeMobileControls();
      return;
    }
    // Typing or using buttons inside the drawer must not trigger viewport shortcuts.
    if (mobileControlsOpen) return;
    if (isAppShortcutBlocked(e) || isDocumentKeyboardTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === 'a' || e.key === 'A') { e.preventDefault(); toggleArrangeMode(); }
    if (e.key === 'm' || e.key === 'M') {
      // like the 2D toolbar, M defers to "mirror selection" while a piece is selected outside arrange mode
      if (sceneMode !== 'arrange' && selectedPieceId) return;
      e.preventDefault(); toggleManipulateMode();
    }
    if (e.key === ' ') { e.preventDefault(); toggleSimulate(); }
  }

  // Right-side 3D control rail — Material Symbols icons + hover-to-expand labels, mirroring the
  // original studio. `sep` inserts a spacer before the button; `shortcut` shows a kbd on hover.
  interface Tool { label: string; icon: string; onClick: () => void; active?: () => boolean; disabled?: () => boolean; sep?: boolean; shortcut?: string }
  const tools = $derived<Tool[]>([
    { label: status === 'simulating' ? 'Pause simulation' : 'Start simulation', icon: status === 'simulating' ? 'pause' : 'play_arrow', onClick: toggleSimulate, active: () => status === 'simulating', disabled: () => status !== 'ready' && status !== 'simulating' },
    { label: 'Reset simulation', icon: 'refresh', onClick: () => void reset(), disabled: () => !canReset() },
    { label: 'Show triangles', icon: 'change_history', onClick: toggleTriangles, active: () => showTriangles, sep: true },
    { label: bodyEnabled ? 'Hide avatar' : 'Draft on a body', icon: 'person', onClick: bodyEnabled ? toggleAvatar : togglePerson, active: () => bodyEnabled && showAvatar },
    { label: bodyEnabled ? 'Remove the body' : 'No body — lantern, bag, shade', icon: bodyEnabled ? 'person_off' : 'deployed_code', onClick: togglePerson, active: () => !bodyEnabled },
    {
      label: labelState === 'all' ? 'Piece labels: everywhere' : labelState === 'outside' ? 'Piece labels: outside only' : 'Piece labels: off',
      icon: labelState === 'none' ? 'label_off' : 'label',
      onClick: cycleLabels,
      active: () => labelState !== 'none'
    },
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

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -- focus owns the viewport keyboard shortcuts -->
<div
  bind:this={sceneShell}
  class="scene-shell w-full h-full relative"
  class:frozen-view={frozenReadOnly}
  data-testid="pattern-scene-3d"
  role="region"
  aria-label="3D pattern view"
  tabindex="0"
  data-status={status}
  onpointerenter={() => (paneHovered = true)}
  onpointerleave={() => (paneHovered = false)}
  onfocusin={() => (paneFocused = true)}
  onfocusout={() => (paneFocused = false)}
>
  {#if frozenReadOnly}
    <div class="scene-status-notice frozen-notice" role="status" aria-live="polite" data-testid="frozen-diagnostic-notice"
      aria-label={`${frozenReceipt?.visibleNotice ?? 'Verifying frozen checkpoint…'} Read-only diagnostic. Simulation, editing, saving and export are unavailable.`}
      title={`${frozenReceipt?.visibleNotice ?? 'Verifying frozen checkpoint…'} Read-only diagnostic. Simulation, editing, saving and export are unavailable.`}>
      <span aria-hidden="true">{frozenReceipt ? `Frame ${frozenReceipt.frame} · read-only · garment fit not accepted` : 'Verifying read-only checkpoint…'}</span>
    </div>
  {/if}
  <div
    class="scene-viewport w-full h-full"
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
  {#if !frozenReadOnly && needsSourceReassembly && status === 'ready'}
    <div class="scene-status-notice scene-reassembly-info absolute top-12 left-1/2 -translate-x-1/2 z-10 bg-base-100/95 text-base-content text-xs rounded px-3 py-2 shadow max-w-sm text-center" role="status">
      <span class="source-reassembly-full">Garment fit updated. Start simulation to reassemble the garment.</span>
      <span class="source-reassembly-compact" aria-hidden="true">Start simulation to reassemble</span>
    </div>
  {/if}
  {#if !frozenReadOnly && refinedReassemblyNotice && status === 'ready' && !needsSourceReassembly}
    <div class="scene-status-notice scene-reassembly-info absolute top-12 left-1/2 -translate-x-1/2 z-10 bg-base-100/95 text-base-content text-xs rounded px-3 py-2 shadow max-w-sm text-center" role="status">
      <span class="source-reassembly-full">This garment reassembles when reopened. Start simulation to drape it.</span>
      <span class="source-reassembly-compact" aria-hidden="true">Start simulation to reassemble</span>
    </div>
  {/if}
  {#if status === 'loading'}
    <div class="absolute inset-0 flex flex-col gap-2 items-center justify-center z-10 pointer-events-none" role="status" aria-live="polite">
      <span class="loading loading-spinner loading-md opacity-70"></span>
      <span class="rounded bg-base-100/85 px-3 py-1 text-xs shadow backdrop-blur-sm">Preparing 3D garment…</span>
    </div>
  {/if}

  {#if frozenReadOnly}
      <div class="scene-mobile-primary frozen-camera" role="group" aria-label="Frozen checkpoint camera">
        <button disabled={!frozenReceipt} class="btn btn-sm" onclick={() => setView('front')}>Front</button>
        <button disabled={!frozenReceipt} class="btn btn-sm" onclick={() => setView('back')}>Back</button>
        <button disabled={!frozenReceipt} class="btn btn-sm" onclick={() => setView('reset')}>Fit</button>
        <button type="button" disabled={!frozenReceipt} class="btn btn-sm" aria-label="Zoom to garment" title="Zoom to garment" onclick={zoomToGarment}>Zoom</button>
        <button class="btn btn-sm" onclick={exitFrozenCheckpoint}>Exit diagnostic</button>
      </div>
  {:else}
  <!-- Right-side control toolbar (mirrors the original studio) -->
  <div class="scene-controls scene-desktop-controls flex flex-col mt-3 absolute right-2 top-[6rem] z-10" data-tour-id={isNarrowPane ? undefined : 'tour-3d-controls'} role="group" aria-label="3D controls">
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

  <!-- Narrow panes keep only the simulation actions over the garment. The remaining
       controls are disclosed together, with labels instead of a long icon rail. -->
  <div class="scene-mobile-primary" data-tour-id={isNarrowPane ? 'tour-3d-controls' : undefined} role="group" aria-label="Primary 3D controls">
    {#each tools.slice(0, 2) as tool}
      <button type="button" class="btn btn-sm" class:btn-accent={tool.active?.()}
        title={tool.label} aria-label={tool.label} disabled={tool.disabled?.()} onclick={tool.onClick}>
        <span class="material-symbols-rounded notranslate" aria-hidden="true">{tool.icon}</span>
        {tool.icon === 'refresh' ? 'Reset' : status === 'simulating' ? 'Pause' : 'Start'}
      </button>
    {/each}
    {#if currentPattern.garmentCodeSource && bodyEnabled}
      <button type="button" class="btn btn-sm scene-garment-zoom" title="Zoom to garment" aria-label="Zoom to garment"
        onclick={() => runMobileControl(zoomToGarment)}>
        <span class="material-symbols-rounded notranslate" aria-hidden="true">zoom_in</span>
        Zoom
      </button>
    {/if}
    <button type="button" class="btn btn-sm" bind:this={mobileControlsTrigger}
      aria-label={mobileControlsOpen ? 'Collapse 3D controls' : 'Expand 3D controls'}
      aria-expanded={mobileControlsOpen} aria-controls={mobileControlsId}
      onclick={() => {
        if (mobileControlsOpen) closeMobileControls();
        else { mobileControlsOpen = true; queueMicrotask(() => mobileControlsClose?.focus({ preventScroll: true })); }
      }}>
      <span class="material-symbols-rounded notranslate" aria-hidden="true">tune</span>
      Controls
    </button>
  </div>
  {#if mobileControlsOpen}
    <div id={mobileControlsId} class="scene-mobile-drawer" role="group" aria-label="3D controls">
      <div class="scene-mobile-drawer-heading">
        <strong>3D controls</strong>
        <button type="button" class="btn btn-sm btn-ghost" aria-label="Close 3D controls"
          bind:this={mobileControlsClose} onclick={closeMobileControls}>
          Close <span aria-hidden="true">✕</span>
        </button>
      </div>
      <div class="scene-mobile-tools">
        {#each tools.slice(2) as tool}
          <button type="button" class="btn btn-sm justify-start" aria-label={tool.label}
            class:btn-accent={tool.active?.()} disabled={tool.disabled?.()}
            onclick={() => runMobileControl(tool.onClick)}>
            <span class="material-symbols-rounded notranslate" aria-hidden="true">{tool.icon}</span>
            {tool.label}
          </button>
        {/each}
      </div>
      <div class="scene-mobile-section" role="group" aria-label="Camera views">
        <strong>Camera views</strong>
        <div class="scene-mobile-options">
          {#each [['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top']] as [v, label]}
            <button type="button" class="btn btn-sm" title={`${label} view`}
              onclick={() => runMobileControl(() => setView(v as 'front'))}>{label}</button>
          {/each}
          <button type="button" class="btn btn-sm" aria-label="Reset view"
            onclick={() => runMobileControl(() => setView('reset'))}>Reset view</button>
        </div>
      </div>
      {#if poses.length && bodyEnabled}
        <div class="scene-mobile-section" role="group" aria-label="Body poses">
          <strong>Body poses</strong>
          <div class="scene-mobile-options">
            {#each poses as p}
              <button type="button" class="btn btn-sm" class:btn-active={currentPose === p}
                onclick={() => runMobileControl(() => setPose(p))}>{p}</button>
            {/each}
          </div>
        </div>
      {/if}
      <div class="scene-mobile-section" role="group" aria-label="Lighting and image export">
        <strong>Lighting</strong>
        <div class="scene-mobile-options">
          {#each lightingTabs as tab}
            <button type="button" class="btn btn-sm" class:btn-active={lightingMode === tab.id}
              onclick={() => runMobileControl(() => setLighting(tab.id))}>{tab.label}</button>
          {/each}
          <button type="button" class="btn btn-sm" onclick={() => runMobileControl(saveImage)}>Save Image</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Piece-edit panel: select a piece, move/rotate it with the gizmo, then drape/settle -->
  {#if sceneMode === 'arrange'}
    <div class="scene-status-notice absolute top-12 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1">
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
    <div class="scene-sim-panel absolute top-12 right-2 z-10 w-60 bg-base-200/95 backdrop-blur rounded-lg shadow-lg p-3 text-xs space-y-2 max-h-[70vh] overflow-y-auto">
      <div class="flex items-center justify-between"><span class="font-bold">Simulation controls</span>
        <button class="btn btn-ghost btn-xs btn-circle" onclick={() => {
          showSimPanel = false;
          if (isNarrowPane) mobileControlsTrigger?.focus({ preventScroll: true });
        }} aria-label="Close">✕</button>
      </div>
      {#if stretchError !== null}
        <div class="flex items-center justify-between opacity-80" title="RMS deviation of every cloth edge from its rest length at the last settled drape">
          <span>RMS stretch error</span><span class="tabular-nums">{(stretchError * 100).toFixed(1)}%</span>
        </div>
      {/if}
      <label class="flex items-center justify-between gap-2"><span>Self-collision</span>
        <input type="checkbox" class="toggle toggle-xs" checked={simCfg.handleSelfCollisions} onchange={(e) => setSim({ handleSelfCollisions: e.currentTarget.checked })} /></label>
      <label class="flex items-center justify-between gap-2"><span>Body collision</span>
        <input bind:this={bodyCollisionCheckbox} type="checkbox" class="toggle toggle-xs" checked={simCfg.handleExternalCollisions && simCfg.handleExternalSurfaceCollisions}
          onchange={(e) => setSim({ handleExternalCollisions: e.currentTarget.checked, handleExternalSurfaceCollisions: e.currentTarget.checked })} /></label>
      <label class="flex items-center justify-between gap-2"><span>Use bending</span>
        <input type="checkbox" class="toggle toggle-xs" checked={simCfg.useBending} onchange={(e) => setSim({ useBending: e.currentTarget.checked })} /></label>
      <label class="flex items-center justify-between gap-2" title={sourceCheckpoint ? 'Explicitly hold this saved shape. Leave off to let an imported checkpoint continue assembling.' : 'ON: softly preserve the saved drape while remaining interactive. OFF: fully free-run the local solver.'}>
        <span>{sourceCheckpoint ? 'Hold saved checkpoint' : 'Anchor to saved drape'}</span>
        <input type="checkbox" class="toggle toggle-xs" checked={sourceCheckpoint ? holdsSavedCheckpoint : $simAnchors}
          disabled={sourceCheckpoint && (cachedPieces.length === 0 || needsSourceReassembly)} onchange={(e) => setCheckpointHold(e.currentTarget.checked)} /></label>
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
        { key: 'seamIterations', label: 'Seam iterations', min: 1, max: 8, step: 1, get: () => simCfg!.seamIterations, set: (v: number) => setSim({ seamIterations: v }), fmt: (v: number) => v.toFixed(0) },
        { key: 'substepContactIterations', label: 'Contact passes per substep', min: 1, max: 16, step: 1, get: () => simCfg!.substepContactIterations ?? 1, set: (v: number) => setSim({ substepContactIterations: v }), fmt: (v: number) => v.toFixed(0) },
        { key: 'finalContactIterations', label: 'Final contact passes', min: 1, max: 16, step: 1, get: () => simCfg!.finalContactIterations ?? 1, set: (v: number) => setSim({ finalContactIterations: v }), fmt: (v: number) => v.toFixed(0) }
      ] as ctl (ctl.key)}
        <label class="flex flex-col gap-0.5">
          <span class="flex justify-between"><span>{ctl.label}</span><span class="opacity-60">{ctl.fmt(ctl.get())}</span></span>
          <input type="range" class="range range-xs" min={ctl.min} max={ctl.max} step={ctl.step} value={ctl.get()} oninput={(e) => ctl.set(parseFloat(e.currentTarget.value))} />
        </label>
      {/each}
      <p class="opacity-50 leading-tight pt-1">{sourceCheckpoint ? 'Changes update simulation. Unfinished garments may reassemble.' : 'Changes apply immediately; the drape is preserved.'}</p>
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
  <div class="scene-camera absolute top-2 right-2 z-10 join join-horizontal bg-base-200/85 backdrop-blur rounded-lg shadow" role="group" aria-label="Camera views">
    {#each [['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top']] as [v, label]}
      <button class="join-item btn btn-xs" title={`${label} view`} aria-label={`${label} view`} onclick={() => setView(v as 'front')}>{label}</button>
    {/each}
    {#if currentPattern.garmentCodeSource && bodyEnabled}
      <button class="join-item btn btn-xs" title="Zoom to garment" aria-label="Zoom to garment" onclick={zoomToGarment}>
        <span class="material-symbols-rounded text-sm" aria-hidden="true">zoom_in</span>
      </button>
    {/if}
    <button class="join-item btn btn-xs" title="Reset view" onclick={() => setView('reset')} aria-label="Reset view"><span class="material-symbols-rounded text-sm">refresh</span></button>
  </div>

  <!-- Lighting-mode tabs + Save Image (mirrors the source's bottom bar) -->
  <div class="scene-lighting absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2" role="group" aria-label="Lighting and image export"
    onfocusin={(event) => { if (event.target instanceof HTMLButtonElement) event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }}>
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
    <div class="scene-poses absolute bottom-11 left-1/2 -translate-x-1/2 z-10" role="group" aria-label="Body poses">
      <div class="join join-horizontal bg-base-200/85 backdrop-blur rounded-lg shadow">
        {#each poses as p}
          <button class="join-item btn btn-xs" class:btn-active={currentPose === p} onclick={() => setPose(p)}>{p}</button>
        {/each}
      </div>
    </div>
  {/if}

  {/if}
  <div class="scene-info absolute top-2 left-2 z-10 text-xs opacity-60 bg-base-200/80 rounded px-2 py-1">
    {#if bodyEnabled}{currentPattern.body.gender} · {/if}{currentPattern.pieces.length} pieces
  </div>
</div>

<style>
  .scene-shell.frozen-view { display: flex; flex-direction: column; }
  .frozen-view > .scene-viewport { flex: 1; min-height: 0; height: auto; }
  .frozen-notice { flex-shrink: 0; background: var(--color-base-200, #ddd); padding: 0.25rem 0.5rem; border-radius: 0.5rem; font-size: 0.75rem; line-height: 1rem; text-align: center; }
  .frozen-notice span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .scene-mobile-primary.frozen-camera { display: flex; position: absolute; bottom: 0.5rem; right: 0.5rem; z-index: 30; flex-wrap: wrap; max-width: calc(100% - 1rem); gap: 0.25rem; }
  .frozen-camera button { min-height: 44px; min-width: 44px; animation: none !important; transform: none !important; scale: 1 !important; }
  .scene-shell { container: pattern-scene / size; }
  .source-reassembly-compact { display: none; }
  @media (pointer: coarse) and (orientation: landscape) and (max-height: 500px) {
    @container pattern-scene (width < 480px) or (height < 320px) {
      /* Informational source-cache notices keep their full accessible message,
         while leaving more of a short touch viewport for the garment. */
      .scene-reassembly-info {
        top: 0.5rem;
        max-width: calc(100% - 1rem);
        padding: 0.25rem 0.5rem;
        line-height: 1rem;
      }
      .scene-reassembly-info .source-reassembly-full {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
      }
      .scene-reassembly-info .source-reassembly-compact {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }
  .scene-mobile-primary, .scene-mobile-drawer { display: none; }
  .scene-controls {
    max-height: calc(100% - 7.5rem);
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }
  .scene-controls > :global(*) { flex-shrink: 0; }

  @media (max-width: 1023px) {
    .scene-controls > :global(button) { height: 44px; min-height: 44px; min-width: 44px; max-width: 44px; }
    .scene-controls > :global(button) > :global(span:first-child) { display: none; }
    .scene-camera > :global(button) { height: 44px; min-height: 44px; min-width: 44px; }
    .scene-lighting :global(button), .scene-poses :global(button) { height: 32px; min-height: 32px; min-width: 32px; }
  }

  /* Size follows the actual pane, including a short landscape split view. */
  @container pattern-scene (width < 480px) or (height < 320px) {
    .scene-desktop-controls, .scene-camera, .scene-lighting, .scene-poses { display: none; }
    .scene-mobile-primary {
      display: flex;
      position: absolute;
      bottom: 0.5rem;
      right: 0.5rem;
      z-index: 20;
      gap: 0.25rem;
      max-width: calc(100% - 1rem);
      padding: 0.25rem;
      background: oklch(var(--b2) / 0.9);
      border-radius: 0.75rem;
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.15);
    }
    .scene-mobile-primary > button, .scene-mobile-drawer button { min-height: 44px; height: auto; }
    .scene-mobile-primary > button { padding: 0 0.5rem; gap: 0.25rem; }
    .scene-mobile-primary .material-symbols-rounded { font-size: 20px; }
    .scene-garment-zoom { min-width: 44px; animation: none !important; transform: none !important; scale: 1 !important; }
    .scene-mobile-drawer {
      display: block;
      position: absolute;
      top: 0.5rem;
      bottom: 4.25rem;
      right: 0.5rem;
      z-index: 20;
      width: min(22rem, calc(100% - 1rem));
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      background: oklch(var(--b2) / 0.98);
      border-radius: 0.75rem;
      padding: 0 0.5rem 0.5rem;
      box-shadow: 0 2px 12px rgb(0 0 0 / 0.2);
      font-size: 0.75rem;
    }
    .scene-mobile-drawer-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 0.25rem 0;
      background: oklch(var(--b2));
    }
    .scene-mobile-tools { display: grid; gap: 0.25rem; }
    .scene-mobile-tools > button { white-space: normal; text-align: left; padding: 0.5rem; }
    .scene-mobile-section { border-top: 1px solid oklch(var(--b3)); margin-top: 0.5rem; padding-top: 0.5rem; }
    .scene-mobile-options { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.25rem; }
    .scene-sim-panel { top: 0.5rem; bottom: 4.25rem; max-height: none; width: min(20rem, calc(100% - 1rem)); }
    .scene-sim-panel input[type="range"] { min-height: 44px; height: 44px; }
    .scene-sim-panel input[type="number"] { min-height: 44px; height: 44px; font-size: 16px; }
    .scene-sim-panel > div:first-child { position: sticky; top: -0.75rem; background: oklch(var(--b2)); z-index: 1; }
    .scene-sim-panel > div:first-child > button { min-height: 44px; min-width: 44px; }
    .scene-info { display: none; }
  }

  @container pattern-scene (height < 320px) {
    .scene-controls { top: 3.5rem; bottom: 2.5rem; margin-top: 0; max-height: none; }
    .scene-camera { top: 0.25rem; }
    .scene-info { display: none; }
  }
  @container pattern-scene (height < 240px) {
    /* In a very short split pane, the expanded drawer temporarily covers the
       compact bar so its sticky Close and a full touch target can both fit. */
    .scene-mobile-drawer, .scene-sim-panel { bottom: 0.5rem; z-index: 30; }
  }
</style>
