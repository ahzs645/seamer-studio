<script lang="ts">
  import { base } from '$app/paths';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { replaceState } from '$app/navigation';
  import PatternCanvas2D from '$lib/components/PatternCanvas2D.svelte';
  import PatternScene3D from '$lib/components/PatternScene3D.svelte';
  import GlobeLanternDialog from '$lib/components/GlobeLanternDialog.svelte';
  import StudioToolbar from '$lib/components/StudioToolbar.svelte';
  import PropertyPanel from '$lib/components/PropertyPanel.svelte';
  import LayerPanel from '$lib/components/LayerPanel.svelte';
  import BodyPanel from '$lib/components/BodyPanel.svelte';
  import MaterialPanel from '$lib/components/MaterialPanel.svelte';
  import SeamPanel from '$lib/components/SeamPanel.svelte';
  import ObjectBrowser from '$lib/components/ObjectBrowser.svelte';
  import { pattern, patternEditor, pushUndo, undo, redo, undoLabel, redoLabel, restoreHistory, clearPersistedHistory, pendingPaste, panelRequest, installSeamerAutomation, getPatternEditor } from '$lib/stores/pattern';
  import EditorStateBridge from '$lib/components/EditorStateBridge.svelte';
  import type { Selection } from '@atelier/core';
  import type { EditorState } from '@atelier/svelte';
  import { loadPattern, savePattern as saveToDB } from '$lib/stores/localDB';
  import {
    EMPTY_PATTERN,
    deletePath,
    deletePiece,
    deletePoint,
    syncLinkedPaths,
    type Pattern,
    type Piece,
    type ConstrainablePoint,
    type ConstrainablePath
  } from '@seamer/pattern-model';
  import type { PendingPaste } from '$lib/stores/pattern';
  import {
    assertPatternBuildable3d,
    convertSimplePattern,
    convertSimplePatternWithLegacyProject,
    isCanonicalPencilSkirtExport,
    isSimpleFormat
  } from '$lib/utils/importSimplePattern';
  import Toaster from '$lib/components/Toaster.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import GradingOverlay from '$lib/components/GradingOverlay.svelte';
  import { toast, toastSuccess, toastError } from '$lib/stores/toast';
  import { confirm } from '$lib/stores/confirm';
  import { patternToSVG, patternToSVG2, patternToDXF, patternToCSV, downloadText, patternToPNG, downloadBlob, printPattern, printMarkerTiled, patternToHPGL, createSSPArchive, sspToPattern } from '$lib/utils/exporters';
  import { patternThumbnail } from '$lib/utils/thumbnail';
  import { nestPieces, markerToSVG, type CutOffType } from '$lib/utils/markerLayout';
  import {
    dxfToPattern,
    svgToPattern,
    type DxfImportOptions,
    type SvgImportOptions
  } from '@seamer/pattern-model/utils/patternImport';
  import { parseRul, applyRulToPattern, type RulTable } from '$lib/utils/rulImport';
  import PrintDialog from '$lib/components/PrintDialog.svelte';
  import DxfImportDialog from '$lib/components/DxfImportDialog.svelte';
  import SvgImportDialog from '$lib/components/SvgImportDialog.svelte';
  import SizesDialog from '$lib/components/SizesDialog.svelte';
  import { cutToPattern } from '$lib/utils/cutImport';
  import { seamlyToPattern } from '$lib/utils/seamlyImport';
  import { bodyToSeamlyMe } from '$lib/utils/seamlyExport';
  import ErrorsPanel from '$lib/components/ErrorsPanel.svelte';
  import KeyboardShortcuts from '$lib/components/KeyboardShortcuts.svelte';
  import WelcomeModal from '$lib/components/WelcomeModal.svelte';
  import StudioTour from '$lib/components/StudioTour.svelte';
  import WhatsNewModal from '$lib/components/WhatsNewModal.svelte';
  import ReviewPromptDialog from '$lib/components/ReviewPromptDialog.svelte';
  import { redraft, hasConstraints, makeParametric, solvePoints, resolveVariables, captureAlterationDelta } from '@seamer/pattern-model/solver/solve';
  import AlterationsPanel from '$lib/components/AlterationsPanel.svelte';
  import type { AlterationTrack, BezierHandle } from '@seamer/pattern-model';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import BugReportModal from '$lib/components/BugReportModal.svelte';
  import CuttingRoomModal from '$lib/components/CuttingRoomModal.svelte';
  import VersionsModal from '$lib/components/VersionsModal.svelte';
  import SettingsModal from '$lib/components/SettingsModal.svelte';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import HistoryMenu from '$lib/components/HistoryMenu.svelte';
  import { configureMcpSession } from '$lib/stores/mcpSession';
  import { get } from 'svelte/store';
  import { autoSaveSeconds } from '$lib/stores/pattern';
  import { referenceSspTemplates } from '$lib/data/referenceSspTemplates';

  let showCommandPalette = $state(false);
  let showBugReport = $state(false);
  let showPrintDialog = $state(false);
  /** pending .dxf file text + name while the DXF import options dialog is open */
  let dxfPending = $state<{ text: string; name: string } | null>(null);
  /** pending .svg file text + name while the SVG import options dialog is open */
  let svgPending = $state<{ text: string; name: string } | null>(null);
  /** RUL grade-rule dialog: table parsed from a picked .rul file, or null for "pick a file" mode */
  let rulDialog = $state<{ table: RulTable | null } | null>(null);
  let showCuttingRoom = $state(false);
  let showVersions = $state(false);
  let showSettings = $state(false);
  let showTour = $state(false);
  /** successful saves this session — drives the review prompt */
  let saveCount = $state(0);

  let currentPattern = $state<Pattern>(structuredClone(EMPTY_PATTERN));
  let editorView = $state<EditorState<Pattern> | null>(null);
  const selection = $derived(editorView?.selection ?? getPatternEditor().selection);
  const pointIds = $derived(selection.get('point'));
  const pathIds = $derived(selection.get('path'));
  const pieceIds = $derived(selection.get('piece'));
  function setSelection(update: (current: Selection) => Selection): void {
    const editor = getPatternEditor();
    editor.setSelection(update(editor.selection));
  }
  let saved = $state(true);
  let viewMode = $state<'2d' | '3d' | 'both'>('both');
  type Project3DCapture = {
    savedByPiece: Record<string, number[]>;
    cameraPosition: [number, number, number];
    controlsTarget: [number, number, number];
    cameraFov: number;
    lightingMode: string;
    previewDataUrl: string | null;
  };
  let scene3d = $state<{ captureProjectState: () => Project3DCapture | null } | null>(null);
  let leftTab = $state<'layers' | 'body' | 'materials' | 'seams'>('layers');
  let showRightPanel = $state(true);
  let showLeftPanel = $state(true);
  let patternName = $state('New Pattern');
  let labelDisplay = $state<'off' | 'billboard' | 'flat'>('flat'); // projected-on-fabric, like the source
  let showObjectBrowser = $state(false);
  let showShortcuts = $state(false);
  let showGrading = $state(false);
  let showAlterations = $state(false);

  function setViewMode(mode: '2d' | '3d' | 'both') {
    viewMode = mode;
    if (currentPattern.viewMode !== mode) {
      currentPattern = { ...currentPattern, viewMode: mode, hasChanged: true };
      pattern.set(currentPattern);
      saved = false;
    }
    // Match the reference Studio's focused 3D workspace on entry. The top-bar panel toggles remain
    // available when someone explicitly wants properties or layers beside the garment.
    if (mode === '3d') {
      showLeftPanel = false;
      showRightPanel = false;
    }
  }

  function restoreWorkspace(patternData: Pattern) {
    viewMode = patternData.viewMode ?? 'both';
    // A pattern that turns piece names off means it in 3D too — names baked across the cloth are
    // an aid on a garment and clutter on a lantern.
    labelDisplay = patternData.showPieceNames === false ? 'off' : 'flat';
    if (viewMode === '3d') {
      showLeftPanel = false;
      showRightPanel = false;
    }
  }
  // Alteration edit mode: while active, the canvas shows the (driver-specific) formula BASE with
  // alterations suppressed and live re-drafting frozen, so dragging points sticks. Saving a sample
  // captures delta = edited − base; on exit we restore the base draft and re-apply via redraft.
  const SUPPRESS = '__alt_edit_suppress__';
  let alterationEdit = $state<{
    trackId: string; driverVariableId: string; driverValue: number;
    base: Record<string, { x: number; y: number }>;
    baseHandles: Record<string, BezierHandle>;
    canonicalPoints: Pattern['points']; canonicalPaths: Pattern['paths'];
  } | null>(null);

  function handleMap(p: Pattern): Map<string, BezierHandle> {
    const m = new Map<string, BezierHandle>();
    for (const pa of p.paths) for (const pp of pa.pathPoints) if (pp.handle) m.set(`${pa.id}:${pp.id}`, pp.handle);
    return m;
  }
  /** Formula base geometry at a driver value, with this pattern's alterations suppressed. */
  function baseAtDriver(p: Pattern, driverVariableId: string, driverValue: number) {
    const suppressed = { ...p, gradingProfile: { ...(p.gradingProfile ?? { sizes: [] }), previewAlterationTrackId: SUPPRESS } } as Pattern;
    const scope = resolveVariables(suppressed, driverVariableId ? { [driverVariableId]: driverValue } : {});
    return solvePoints(suppressed, scope);
  }
  function applyBaseToCanvas(driverValue: number) {
    if (!alterationEdit) return;
    const solved = baseAtDriver(currentPattern, alterationEdit.driverVariableId, driverValue);
    const base: Record<string, { x: number; y: number }> = {};
    for (const [id, pt] of solved) base[id] = { x: pt.x, y: pt.y };
    const points = currentPattern.points.map((p) => (base[p.id] ? { ...p, x: base[p.id].x, y: base[p.id].y } : p));
    alterationEdit = { ...alterationEdit, driverValue, base };
    currentPattern = { ...currentPattern, points };
    pattern.set(currentPattern);
  }
  function startAlterationEdit(trackId: string, driverValue: number) {
    const track = currentPattern.gradingProfile?.alterationTracks?.find((t) => t.id === trackId);
    if (!track?.driverVariableId) { toastError('Assign a driver variable first'); return; }
    const canonicalPoints = $state.snapshot(currentPattern).points as Pattern['points'];
    const canonicalPaths = $state.snapshot(currentPattern).paths as Pattern['paths'];
    const baseHandlesMap = handleMap(currentPattern);
    const baseHandles: Record<string, BezierHandle> = {};
    for (const [k, h] of baseHandlesMap) baseHandles[k] = structuredClone($state.snapshot(h)) as BezierHandle;
    // suppress alterations so the displayed base isn't double-counted, then show base@driver
    const gp = { ...(currentPattern.gradingProfile ?? { sizes: [] }), previewAlterationTrackId: SUPPRESS };
    currentPattern = { ...currentPattern, gradingProfile: gp };
    alterationEdit = { trackId, driverVariableId: track.driverVariableId, driverValue, base: {}, baseHandles, canonicalPoints, canonicalPaths };
    applyBaseToCanvas(driverValue);
  }
  function saveAlterationSample() {
    if (!alterationEdit) return;
    const { trackId, driverValue, base, baseHandles } = alterationEdit;
    if (Math.abs(driverValue) <= 1e-6) { toastError('Cannot save a sample at driver value 0'); return; }
    const baseMap = new Map(Object.entries(base));
    const editedMap = new Map(currentPattern.points.map((p) => [p.id, { x: p.x, y: p.y }]));
    const baseHandleMap = new Map(Object.entries(baseHandles));
    const delta = captureAlterationDelta(baseMap, editedMap, baseHandleMap, handleMap(currentPattern));
    if (!Object.keys(delta.points).length && !Object.keys(delta.handles).length) { toastError('No changes to capture — drag a point first'); return; }
    const tracks = (currentPattern.gradingProfile?.alterationTracks ?? []).map((t) => {
      if (t.id !== trackId) return t;
      const samples = t.samples.filter((s) => Math.abs(s.driverValue - driverValue) > 1e-6);
      samples.push({ id: `alt_sample_${crypto.randomUUID().slice(0, 8)}`, driverValue, deltaGeometry: delta });
      samples.sort((a, b) => a.driverValue - b.driverValue);
      return { ...t, samples };
    });
    currentPattern = { ...currentPattern, gradingProfile: { ...(currentPattern.gradingProfile ?? { sizes: [] }), alterationTracks: tracks } };
    pattern.set(currentPattern);
    const n = Object.keys(delta.points).length + Object.keys(delta.handles).length;
    toastSuccess(`Saved sample at ${driverValue} (${n} point${n === 1 ? '' : 's'})`);
    applyBaseToCanvas(driverValue); // reset canvas back to base so further edits are relative to base
  }
  function endAlterationEdit(cancel: boolean) {
    if (!alterationEdit) return;
    const { canonicalPoints, canonicalPaths } = alterationEdit;
    const tracks = cancel ? undefined : currentPattern.gradingProfile?.alterationTracks;
    const gp = { ...(currentPattern.gradingProfile ?? { sizes: [] }), previewAlterationTrackId: null, ...(tracks ? { alterationTracks: tracks } : {}) };
    let next = { ...currentPattern, points: canonicalPoints, paths: canonicalPaths, gradingProfile: gp, hasChanged: true } as Pattern;
    if (hasConstraints(next)) next = redraft(next);
    alterationEdit = null;
    currentPattern = next; saved = false; pattern.set(next);
  }

  const draftingTemplates = [
    {
      key: 'parametric-skirt',
      name: 'Parametric Skirt ✨',
      description: 'Native Seamer example that re-drafts from waist, hip, and length variables.',
      file: 'parametric-skirt.json'
    },
    {
      key: 'grundschnitt-rock',
      name: 'Skirt Block',
      description: 'Basic skirt block (Grundschnitt Rock).',
      file: 'grundschnitt-rock.json'
    }
  ] as const;
  const templatePatterns = Object.fromEntries(
    [...referenceSspTemplates, ...draftingTemplates].map((template) => [template.key, template])
  ) as Record<string, { name: string; description: string; file: string }>;
  const DEFAULT_STUDIO_TEMPLATE = 'pencil-skirt';

  let autoSaveTimer: ReturnType<typeof setInterval>;

  // Command-bus host: the unified command layer commits through the same undo-aware update path the
  // UI uses (handlePatternUpdate), reads the live selection, and is exposed to scripts/agents via
  // window.seamer. No login/network — every command runs in-page.
  const getPatternSnapshot = () => $state.snapshot(currentPattern) as Pattern;

  onMount(() => {
    const disposeCommandApi = installSeamerAutomation();
    const unsubscribeEditor = pattern.subscribe((next) => {
      if (JSON.stringify(next) !== JSON.stringify(currentPattern)) currentPattern = next;
    });
    // MCP pattern session: external agents read the snapshot we push on each /sync and queue ops —
    // full-pattern replacements land in the undo history as 'External edit', command ops run through
    // the same command bus as the palette / window.seamer.
    const disposeMcpSession = configureMcpSession({
      getPattern: getPatternSnapshot,
      applyPattern: (next) => handlePatternUpdate(next, 'External edit'),
      executeCommand: (name, payload) => { getPatternEditor().execute(name, payload); }
    });
    (async () => {
      // Pattern id lives in the URL path (/studio/<id>), with ?id= kept for older links.
      const id = $page.params.slug?.split('/')[0] || $page.url.searchParams.get('id');
      if (id) {
        let loaded = await loadPattern(id);
        if (!loaded) {
          try {
            const res = await fetch(`${base}/api/patterns/${id}`);
            if (res.ok) loaded = await res.json();
          } catch { /* offline — fall through to blank editor */ }
        }
        if (loaded) {
          currentPattern = loaded; patternName = loaded.name; restoreWorkspace(loaded);
          pattern.set(currentPattern);
          // Editor restores this pattern's persisted undo/redo asynchronously.
          await restoreHistory(id);
        } else {
          toastError('Pattern not found');
        }
      } else {
        await loadTemplate(DEFAULT_STUDIO_TEMPLATE);
      }
    })();

    const startAutosave = (seconds: number) => {
      clearInterval(autoSaveTimer);
      autoSaveTimer = setInterval(async () => {
        if (!saved) { await saveToDB(currentPattern); saved = true; }
      }, Math.max(2, seconds) * 1000);
    };
    startAutosave(get(autoSaveSeconds));
    const unsubAutosave = autoSaveSeconds.subscribe((s) => startAutosave(s));

    const handler = (e: BeforeUnloadEvent) => { if (!saved) e.preventDefault(); };
    window.addEventListener('beforeunload', handler);

    return () => { clearInterval(autoSaveTimer); unsubAutosave(); unsubscribeEditor(); window.removeEventListener('beforeunload', handler); disposeCommandApi(); disposeMcpSession(); };
  });

  function handlePatternUpdate(updated: Pattern, label = 'Edit') {
    if (JSON.stringify(currentPattern) !== JSON.stringify(updated)) pushUndo($state.snapshot(currentPattern) as Pattern, label);
    // live re-draft: recompute formula-constrained points from variables/measurements.
    // Frozen during alteration edit mode so manual point drags stick (they become the captured delta).
    if (hasConstraints(updated) && !alterationEdit) {
      const solved = redraft(updated);
      if (JSON.stringify(solved.points) !== JSON.stringify(updated.points) || JSON.stringify(solved.variables) !== JSON.stringify(updated.variables)) {
        updated = solved;
      }
    }
    // linked paths follow their source's shape (cheap no-op when the pattern has none)
    if (!alterationEdit) updated = syncLinkedPaths(updated);
    currentPattern = updated; saved = false; pattern.set(updated);
  }

  // A user-run drape settled: persist the freshly-settled per-piece savedPositions so re-opening shows
  // the result instantly and body re-fits chain off the latest drape. Not an undo-able user edit, so
  // no pushUndo; savedPositions isn't in the 3D patternKey, so this won't trigger a re-drape. Mark
  // unsaved and let the 5s autosave (or an explicit save) write it.
  function handleDrapeSettled(savedByPiece: Record<string, number[]>) {
    let changed = false;
    const pieces = currentPattern.pieces.map((p) => {
      const sp = savedByPiece[p.id];
      if (!sp) return p;
      changed = true;
      return { ...p, settings3d: { ...p.settings3d, savedPositions: sp } };
    });
    if (!changed) return;
    currentPattern = { ...currentPattern, pieces };
    pattern.set(currentPattern);
    saved = false;
  }

  // Camera write-back from the 3D view (debounced upstream). Not an undo-able edit — like a
  // settled drape, it just persists so reload restores the same view.
  function handleCameraChange(pos: [number, number, number], target: [number, number, number], fov: number) {
    currentPattern = { ...currentPattern, settings3d: { ...currentPattern.settings3d, cameraPosition: pos, controlsTarget: target, cameraFov: fov } };
    pattern.set(currentPattern);
    saved = false;
  }

  async function handleSave() {
    // refresh the list thumbnail from the live 2D geometry (best effort — null keeps the old one)
    const thumb = patternThumbnail($state.snapshot(currentPattern) as Pattern);
    currentPattern = { ...currentPattern, name: patternName, thumbnailUrl: thumb ?? currentPattern.thumbnailUrl ?? null };
    await saveToDB(currentPattern); saved = true; saveCount += 1;
    // keep the pattern id in the URL so a reload reopens this pattern
    syncPatternRoute(currentPattern.id);
    toastSuccess('Pattern saved');
  }

  /** Keep refresh/deep links attached to the document currently shown in the editor. */
  function syncPatternRoute(patternId: string) {
    if ($page.params.slug?.split('/')[0] !== patternId) {
      replaceState(`${base}/studio/${encodeURIComponent(patternId)}`, {});
    }
  }

  async function handleExport() {
    const blob = new Blob([JSON.stringify(currentPattern, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `${patternName.replace(/\s+/g, '_')}.seamer.json`; a.click(); URL.revokeObjectURL(url);
  }

  function exportAs(fmt: 'svg' | 'svg2' | 'dxf' | 'csv') {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    if (fmt === 'svg') downloadText(`${base}.svg`, patternToSVG(currentPattern), 'image/svg+xml');
    else if (fmt === 'svg2') downloadText(`${base}.svg`, patternToSVG2(currentPattern), 'image/svg+xml');
    else if (fmt === 'dxf') downloadText(`${base}.dxf`, patternToDXF(currentPattern), 'application/dxf');
    else downloadText(`${base}.csv`, patternToCSV(currentPattern), 'text/csv');
    toastSuccess(`Exported ${fmt === 'svg2' ? 'SVG 2' : fmt.toUpperCase()}`);
  }

  async function exportPNG() {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    const blob = await patternToPNG(currentPattern);
    if (!blob) { toastError('Nothing to export'); return; }
    downloadBlob(`${base}.png`, blob);
    toastSuccess('Exported PNG');
  }
  async function exportHPGL() {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    try {
      downloadText(`${base}.hpgl`, await patternToHPGL(currentPattern), 'application/vnd.hp-hpgl');
      toastSuccess('Exported HPGL');
    } catch (e) { toastError('HPGL export failed'); }
  }
  // Body measurements as SeamlyMe individual measurements (open in SeamlyMe / Seamly2D).
  async function exportSeamlyMe() {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    try {
      downloadText(`${base}.smis`, await bodyToSeamlyMe(currentPattern.body), 'application/xml');
      toastSuccess('Exported SeamlyMe measurements');
    } catch (e) { toastError((e as Error)?.message || 'SeamlyMe export failed'); }
  }

  function doPrint() { printPattern(currentPattern, patternName || 'Pattern'); }
  function exportMarker() {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    const widthStr = prompt('Fabric width (mm)?', '1400');
    if (widthStr === null) return;
    const layout = nestPieces(currentPattern, parseFloat(widthStr) || 1400);
    if (!layout.placements.length) { toastError('No pieces to nest'); return; }
    const coStr = (prompt('Cut-off boundary? none / box / convex / concave', 'none') || 'none').trim().toLowerCase();
    const cutOff: CutOffType = coStr.startsWith('box') ? 'boundingBox'
      : coStr.startsWith('convex') ? 'convexHull'
      : coStr.startsWith('concave') ? 'concaveHull' : 'none';
    downloadText(`${base}_marker.svg`, markerToSVG(layout, cutOff), 'image/svg+xml');
    toastSuccess(`Marker: ${layout.placements.length} pieces · ${Math.round(layout.usedLengthMm)}mm long`);
  }
  function doPrintMarker() {
    const widthStr = prompt('Fabric width (mm)?', '1400');
    if (widthStr === null) return;
    const layout = nestPieces(currentPattern, parseFloat(widthStr) || 1400);
    if (!layout.placements.length) { toastError('No pieces to nest'); return; }
    printMarkerTiled(layout, { title: (patternName || 'Pattern') + ' — marker' });
  }

  let canonicalPencilSkirtPromise: Promise<Pattern> | null = null;
  function loadCanonicalPencilSkirt(): Promise<Pattern> {
    canonicalPencilSkirtPromise ??= fetch(`${base}/templates/pencil-skirt.json`).then(async (response) => {
      if (!response.ok) throw new Error('The canonical pencil-skirt data is unavailable.');
      return await response.json() as Pattern;
    });
    return canonicalPencilSkirtPromise;
  }

  async function convertImportedJson(raw: unknown): Promise<Pattern> {
    if (!isSimpleFormat(raw)) return raw as Pattern;
    const canonical = isCanonicalPencilSkirtExport(raw) ? await loadCanonicalPencilSkirt() : undefined;
    return convertSimplePattern(raw, canonical);
  }

  /** Parse imported text by extension into a Pattern (shared by the file picker + sample loader). */
  async function parseImport(text: string, ext: string | undefined, name: string): Promise<Pattern> {
    if (ext === 'dxf') return dxfToPattern(text, name);
    if (ext === 'svg') return svgToPattern(text, name);
    if (ext === 'cut') return cutToPattern(text, name);
    if (ext === 'val' || ext === 'sm2d' || ext === 'xml') return seamlyToPattern(text, name);
    const raw = JSON.parse(text);
    return convertImportedJson(raw);
  }

  async function applyImported(data: Pattern) {
    // Build the candidate cloth topology before touching canonical editor state. A failed import
    // therefore leaves both the 2D document and the renderer on the same last-valid pattern.
    assertPatternBuildable3d(data);
    currentPattern = data;
    patternName = data.name;
    restoreWorkspace(data);
    pattern.set(data);
    saved = false;
    syncPatternRoute(data.id);
    toastSuccess(`Imported "${data.name}"`);

    // An import opens/replaces a document; it must not inherit the previous document's undo stack.
    // Clearing an existing stack for the same id is important when re-importing a corrected legacy
    // project, otherwise the old local history can restore data that the new import replaced.
    await clearPersistedHistory(data.id);
    if (currentPattern.id === data.id) await restoreHistory(data.id);
  }

  function applyRestoredVersion(data: Pattern) {
    // A version restore stays in the same document and should be undoable; unlike a file import it
    // neither changes the route nor discards the document's history.
    assertPatternBuildable3d(data);
    patternName = data.name;
    restoreWorkspace(data);
    handlePatternUpdate(data, 'Restore version');
  }

  function handleImport() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,.seamer.json,.ssp,.dxf,.svg,.cut,.val,.sm2d,.xml,.rul';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
      const ext = file.name.split('.').pop()?.toLowerCase();
      try {
        if (ext === 'ssp') { await applyImported(await sspToPattern(file)); return; } // gzip-compressed project
        const text = await file.text();
        const name = file.name.replace(/\.(dxf|svg|cut|val|sm2d|xml|json|rul|seamer\.json)$/i, '');
        if (ext === 'dxf') { dxfPending = { text, name }; return; } // import options dialog first
        if (ext === 'svg') { svgPending = { text, name }; return; } // import options dialog first
        if (ext === 'rul') { rulDialog = { table: parseRul(text) }; return; } // pick a size, then apply
        await applyImported(await parseImport(text, ext, name));
      } catch (err) { toastError((err as Error)?.message || 'Could not import file'); }
    };
    input.click();
  }

  /** SeamScape's Raw JSON contains the editable geometry while its legacy project contains the
   *  saved 3D arrangement, materials, and seam references. Import both to avoid dropping either
   *  half of the document during migration. */
  function handleLegacySourcePair() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.ssp,.json,application/json';
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      const projectFile = files.find((file) => file.name.toLowerCase().endsWith('.ssp'));
      const jsonFiles = files.filter((file) => file.name.toLowerCase().endsWith('.json'));
      try {
        if (!projectFile || jsonFiles.length !== 1) {
          throw new Error('Select exactly one SeamScape .ssp project and its matching Raw JSON file.');
        }
        const raw = JSON.parse(await jsonFiles[0].text()) as unknown;
        if (!isSimpleFormat(raw)) {
          throw new Error('The JSON file is not SeamScape Raw JSON. Select the matching raw export.');
        }
        const legacy = await sspToPattern(projectFile);
        const canonical = isCanonicalPencilSkirtExport(raw) ? await loadCanonicalPencilSkirt() : undefined;
        await applyImported(convertSimplePatternWithLegacyProject(raw, legacy, canonical));
      } catch (err) {
        toastError((err as Error)?.message || 'Could not import the SeamScape project pair');
      }
    };
    input.click();
  }

  type SourceImportKind = 'raw-json' | 'seamly' | 'cut' | 'hpgl' | 'svg' | 'dxf' | 'image';

  /** The source studio exposes one picker per importer. Keeping those entry points separate avoids
   *  ambiguous extension sniffing and lets each format show its own options/error message. */
  function handleSourceImport(kind: SourceImportKind) {
    const accepts: Record<SourceImportKind, string> = {
      'raw-json': '.json,application/json',
      seamly: '.val,.sm2d,.xml,application/xml,text/xml',
      cut: '.cut,text/plain',
      hpgl: '.plt,.hpgl,.hp,text/plain',
      svg: '.svg,image/svg+xml',
      dxf: '.dxf,application/dxf,text/plain',
      image: 'image/*'
    };
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accepts[kind];
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const name = file.name.replace(/\.(json|val|sm2d|xml|cut|plt|hpgl|hp|svg|dxf)$/i, '');
      try {
        if (kind === 'image') {
          const url = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('Could not read the image'));
            reader.onload = () => resolve(String(reader.result));
            reader.readAsDataURL(file);
          });
          const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
            const probe = new Image();
            probe.onerror = () => reject(new Error('The selected image is invalid'));
            probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
            probe.src = url;
          });
          const width = 300;
          const next = {
            ...$state.snapshot(currentPattern) as Pattern,
            images: [...currentPattern.images, {
              id: `Image_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`,
              url, x: 0, y: 0, width,
              height: width * (dimensions.height / Math.max(1, dimensions.width)),
              rotation: 0, opacity: 1
            }],
            hasChanged: true
          };
          currentPattern = next; pushUndo($state.snapshot(currentPattern) as Pattern, 'Import background image'); pattern.set(next); saved = false;
          toastSuccess(`Imported background image "${file.name}"`);
          return;
        }

        const text = await file.text();
        if (kind === 'raw-json') {
          const raw = JSON.parse(text) as unknown;
          if (!isSimpleFormat(raw)) throw new Error('This is not SeamScape Raw JSON. Use “Seamer project” for native project files.');
          await applyImported(await convertImportedJson(raw));
          return;
        }
        if (kind === 'dxf') { dxfPending = { text, name }; return; }
        if (kind === 'svg') { svgPending = { text, name }; return; }
        if (kind === 'cut') { await applyImported(cutToPattern(text, name)); return; }
        if (kind === 'seamly') { await applyImported(seamlyToPattern(text, name)); return; }

        // HPGL is an interchange drawing, so closed pen strokes become SVG loops and then pass
        // through the same well-tested outline importer as a native SVG file.
        const { parseHPGL } = await import('@atelier/io');
        const polylines = parseHPGL(text).filter((poly) => poly.length >= 3);
        if (!polylines.length) throw new Error('The HPGL/PLT file contains no drawable polylines.');
        const all = polylines.flat();
        const minX = Math.min(...all.map((point) => point.x));
        const minY = Math.min(...all.map((point) => point.y));
        const maxX = Math.max(...all.map((point) => point.x));
        const maxY = Math.max(...all.map((point) => point.y));
        const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY);
        const paths = polylines.map((poly) => {
          const first = poly[0], last = poly[poly.length - 1];
          const close = Math.hypot(first.x - last.x, first.y - last.y) < 1;
          return `<path d="M ${poly.map((point) => `${point.x} ${point.y}`).join(' L ')}${close ? ' Z' : ''}"/>`;
        }).join('');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="${minX} ${minY} ${width} ${height}"><g fill="none" stroke="black">${paths}</g></svg>`;
        await applyImported(svgToPattern(svg, name, { unitsOverride: 'mm' }));
      } catch (err) { toastError((err as Error)?.message || `Could not import ${file.name}`); }
    };
    input.click();
  }

  async function exportSSP() {
    try {
      let project = structuredClone($state.snapshot(currentPattern) as Pattern);
      const capture = scene3d?.captureProjectState() ?? null;
      if (capture) {
        project = {
          ...project,
          pieces: project.pieces.map((piece) => ({
            ...piece,
            settings3d: {
              ...piece.settings3d,
              savedPositions: capture.savedByPiece[piece.id] ?? piece.settings3d.savedPositions
            }
          })),
          settings3d: {
            ...project.settings3d,
            cameraPosition: capture.cameraPosition,
            controlsTarget: capture.controlsTarget,
            cameraFov: capture.cameraFov,
            lightingMode: capture.lightingMode
          },
          viewMode
        };
      } else {
        project.viewMode = viewMode;
      }
      const previewDataUrl = capture?.previewDataUrl ?? patternThumbnail(project);
      const { blob, manifest } = await createSSPArchive(project, { previewDataUrl, basePath: base });
      downloadBlob(`${patternName.replace(/\s+/g, '_') || 'pattern'}.ssp`, blob);
      if (manifest.unresolvedAssets.length) {
        toast(`Exported SSP v2 with ${manifest.unresolvedAssets.length} linked asset${manifest.unresolvedAssets.length === 1 ? '' : 's'} that could not be embedded`, 'info', 6000);
      } else {
        toastSuccess(`Exported Seamer project (.ssp) · ${manifest.assetCount} embedded asset${manifest.assetCount === 1 ? '' : 's'}`);
      }
    } catch (err) {
      toastError((err as Error)?.message || 'Could not export Seamer project');
    }
  }

  async function importDxfWithOptions(options: DxfImportOptions) {
    if (!dxfPending) return;
    try {
      await applyImported(dxfToPattern(dxfPending.text, dxfPending.name, options));
    } catch (err) { toastError((err as Error)?.message || 'Could not import file'); }
    dxfPending = null;
  }

  async function importSvgWithOptions(options: SvgImportOptions) {
    if (!svgPending) return;
    try {
      await applyImported(svgToPattern(svgPending.text, svgPending.name, options));
    } catch (err) { toastError((err as Error)?.message || 'Could not import file'); }
    svgPending = null;
  }

  function applyRul(table: RulTable, size: string) {
    try {
      const next = applyRulToPattern(structuredClone($state.snapshot(currentPattern)) as Pattern, table, { chosenSize: size });
      handlePatternUpdate(next, 'Apply grade rules');
      toastSuccess(`Applied grade rules "${table.name}" — ${table.sizes.length} sizes, base ${size}`);
    } catch (err) { toastError((err as Error)?.message || 'Could not apply grade rules'); }
    rulDialog = null;
  }

  // Bundled DXF/SVG fixtures (served from /samples) for one-click import testing.
  const importSamples: { file: string; label: string }[] = [
    { file: 'pocket-curved.svg', label: 'Pocket (curved, SVG)' },
    { file: 'two-pieces.svg', label: 'Two pieces (SVG)' },
    { file: 'rect-piece.dxf', label: 'Rectangle (DXF)' },
    { file: 'curved-hem.dxf', label: 'Curved hem (DXF bulge)' }
  ];

  async function importSample(file: string) {
    try {
      const res = await fetch(`${base}/samples/${file}`);
      if (!res.ok) throw new Error('not found');
      const ext = file.split('.').pop()?.toLowerCase();
      await applyImported(await parseImport(await res.text(), ext, file.replace(/\.(dxf|svg)$/i, '')));
    } catch { toastError(`Could not load sample "${file}"`); }
  }

  async function handleNew() {
    if (currentPattern.pieces.length > 0 || currentPattern.points.length > 0) {
      const ok = await confirm({
        title: 'Clear the scene?',
        message: 'Are you sure you want to clear the scene? This removes the current pattern from the canvas.',
        confirmLabel: 'Clear scene', danger: true
      });
      if (!ok) return;
    }
    pushUndo($state.snapshot(currentPattern) as Pattern, 'New pattern');
    currentPattern = structuredClone(EMPTY_PATTERN); patternName = 'New Pattern'; restoreWorkspace(currentPattern); pattern.set(currentPattern); saved = true;
    toastSuccess('Scene cleared');
  }

  /** Fill any arrays/fields a template may omit, so all components can render it safely. */
  function normalizePattern(data: Pattern): Pattern {
    return {
      ...EMPTY_PATTERN,
      ...data,
      points: data.points ?? [], paths: data.paths ?? [], pieces: data.pieces ?? [],
      seams: data.seams ?? [], variables: data.variables ?? [], materials: data.materials ?? [],
      texts: data.texts ?? [], images: data.images ?? [],
      layers: data.layers?.length ? data.layers : [{ id: 'default', name: 'Default', visible: true, locked: false, order: 0, style: null }],
      currentLayerId: data.currentLayerId ?? 'default',
      body: data.body ?? EMPTY_PATTERN.body,
      settings3d: data.settings3d ?? EMPTY_PATTERN.settings3d
    };
  }

  let showGlobeLantern = $state(false);

  /** Adopt a freshly generated pattern as the open document, exactly as a template load does. */
  async function adoptGeneratedPattern(generated: Pattern) {
    const data = normalizePattern({ ...generated, id: crypto.randomUUID(), versionId: crypto.randomUUID(), isPublic: false });
    currentPattern = data;
    patternName = data.name;
    restoreWorkspace(data);
    pattern.set(data);
    await restoreHistory(data.id);
    saved = false;
  }

  async function loadTemplate(key: string) {
    const tpl = templatePatterns[key];
    if (!tpl) return;
    try {
      const res = await fetch(`${base}/templates/${tpl.file}`);
      if (!res.ok) throw new Error('Not found');
      let data: Pattern;
      if (tpl.file.toLowerCase().endsWith('.ssp')) {
        data = await sspToPattern(await res.blob());
      } else {
        data = await convertImportedJson(await res.json());
      }
      data.id = crypto.randomUUID(); data.versionId = crypto.randomUUID(); data.isPublic = false;
      data = normalizePattern(data);
      // recover parametric constructions from the baked template (no-op if already constrained / not recoverable)
      data = makeParametric(data);
      currentPattern = data; patternName = tpl.name || data.name; restoreWorkspace(data); pattern.set(data); await restoreHistory(data.id); saved = true;
    } catch {
      currentPattern = { ...EMPTY_PATTERN, name: tpl.name, description: tpl.description, enable3d: true, viewMode: 'both' };
      patternName = tpl.name; restoreWorkspace(currentPattern); pattern.set(currentPattern); await restoreHistory(currentPattern.id); saved = true;
    }
  }

  function handlePieceSelect(id: string | null) {
    // Avoid redundant 3D highlight work when this is already the exact cross-view selection.
    const cur = pieceIds;
    if ((id ? cur.size === 1 && cur.has(id) : cur.size === 0) && pointIds.size === 0 && pathIds.size === 0) return;
    setSelection((current) => current.replace('piece', id ? [id] : []).clear('point').clear('path'));
  }

  function handleUndo() { const prev = undo($state.snapshot(currentPattern) as Pattern); if (prev) { currentPattern = prev; patternName = prev.name; restoreWorkspace(prev); pattern.set(prev); saved = false; } }
  function handleRedo() { const next = redo($state.snapshot(currentPattern) as Pattern); if (next) { currentPattern = next; patternName = next.name; restoreWorkspace(next); pattern.set(next); saved = false; } }

  function handleKeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? handleRedo() : handleUndo(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSave(); }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelectedPiece(); }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); handleCopy(); }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); handlePaste(e.shiftKey); } // Shift = "Paste as copy"
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); showCommandPalette = !showCommandPalette; }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); showRightPanel = !showRightPanel; }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      if (showLeftPanel && leftTab === 'layers') showLeftPanel = false;
      else { showLeftPanel = true; leftTab = 'layers'; }
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
      e.preventDefault(); showRightPanel = true; panelRequest.set({ section: 'sizes' });
    }
    if (e.key === '?' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); showShortcuts = !showShortcuts; }
    // Selection batch transforms (no modifier): arrows nudge, [ ] rotate, < > scale, M mirror.
    {
      const hasSel = pointIds.size || pathIds.size || pieceIds.size;
      if (hasSel && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const step = e.shiftKey ? 10 : 1;
        const move = (dx: number, dy: number) => { e.preventDefault(); window.seamer?.execute('selection.move', { dx, dy }); };
        if (e.key === 'ArrowLeft') move(-step, 0);
        else if (e.key === 'ArrowRight') move(step, 0);
        else if (e.key === 'ArrowUp') move(0, -step);
        else if (e.key === 'ArrowDown') move(0, step);
        else if (e.key === '[') { e.preventDefault(); window.seamer?.execute('selection.rotate', { degrees: -15 }); }
        else if (e.key === ']') { e.preventDefault(); window.seamer?.execute('selection.rotate', { degrees: 15 }); }
        else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); window.seamer?.execute('selection.mirror', { axis: e.shiftKey ? 'y' : 'x' }); }
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      let p = $pattern;
      let changed = false;
      // Cascading deletes via patternMutations: folding sequentially so deleting points + paths +
      // pieces in one keystroke accumulates into a single update (and removes dependent edges/seams).
      for (const id of pointIds) { p = deletePoint(p, id); changed = true; }
      for (const id of pathIds) { p = deletePath(p, id); changed = true; }
      for (const id of pieceIds) { p = deletePiece(p, id); changed = true; }
      if (changed) {
        handlePatternUpdate(p, 'Delete');
        setSelection((current) => current.clear('point').clear('path').clear('piece'));
        toastSuccess('Deleted');
      }
    }
  }

  const uidFor = (pre: string) => `${pre}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
  let clipboard: PendingPaste | null = null;
  const plural = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

  function handleCopy() {
    const p = $pattern;
    if (pieceIds.size > 0) {
      const items = p.pieces.filter(pc => pieceIds.has(pc.id)).map(pc => structuredClone($state.snapshot(pc)) as Piece);
      clipboard = { kind: 'pieces', items };
      toastSuccess(`${plural(items.length)} copied to clipboard`);
    } else if (pathIds.size > 0) {
      // paths copy with their anchor points (paste decides whether to reuse or duplicate them)
      const items = p.paths
        .filter(pa => pathIds.has(pa.id))
        .map(pa => ({
          path: structuredClone($state.snapshot(pa)) as ConstrainablePath,
          points: pa.pathPoints
            .map(pp => p.points.find(q => q.id === pp.id))
            .filter((q): q is ConstrainablePoint => !!q)
            .map(q => structuredClone($state.snapshot(q)) as ConstrainablePoint)
        }));
      clipboard = { kind: 'paths', items };
      toastSuccess(`${plural(items.length)} copied to clipboard`);
    } else if (pointIds.size > 0) {
      const items = p.points.filter(pt => pointIds.has(pt.id)).map(pt => structuredClone($state.snapshot(pt)) as ConstrainablePoint);
      clipboard = { kind: 'points', items };
      toastSuccess(`${plural(items.length)} copied to clipboard`);
    }
  }

  // Paste arms click-placement on the 2D canvas (the source's PasteTool): a ghost of the clipboard
  // follows the cursor and a click commits the copies there. Esc cancels. `asCopy` (Ctrl+Shift+V,
  // "Paste as copy") duplicates a path's anchor points instead of reusing them.
  function handlePaste(asCopy = false) {
    if (!clipboard) return;
    const payload = structuredClone(clipboard);
    if (payload.kind === 'paths') payload.asCopy = asCopy;
    pendingPaste.set(payload);
    toast('Select where you want to place the ' + (clipboard.items.length === 1 ? 'copy' : 'copies'));
  }

  function duplicateSelectedPiece() {
    if (pieceIds.size !== 1) return;
    const p = $pattern;
    const piece = p.pieces.find(pc => pieceIds.has(pc.id));
    if (!piece) return;
    const uid = (pre: string) => `${pre}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
    const clone = structuredClone($state.snapshot(piece));
    clone.id = uid('Piece');
    clone.name = `Copy of ${piece.name}`;
    clone.position = { x: piece.position.x + 50, y: piece.position.y - 50 };
    for (const pp of [...clone.mainPaths, ...clone.internalPaths]) pp.id = uid('PiecePath');
    handlePatternUpdate({ ...p, pieces: [...p.pieces, clone], hasChanged: true }, 'Duplicate piece');
    setSelection((current) => current.replace('piece', [clone.id]));
    toastSuccess(`Duplicated "${piece.name}"`);
  }
</script>

{#key $patternEditor}
  <EditorStateBridge editor={$patternEditor} onstate={(state) => (editorView = state)} />
{/key}

<svelte:window onkeydown={handleKeydown} />

<div class="flex flex-col h-screen overflow-hidden">
  <div class="flex items-center justify-between px-3 py-1.5 bg-base-200 border-b shrink-0">
    <div class="flex items-center gap-2">
      <a href="{base}/" class="btn btn-ghost btn-xs">&larr;</a>
      <span class="text-sm font-lexend font-semibold hidden lg:inline">Pattern Studio</span>
    </div>
    <div class="flex items-center gap-2">
      <input type="text" class="input input-bordered input-xs w-40 lg:w-56" placeholder="Pattern name..." bind:value={patternName} data-testid="pattern-name-input" />
      <div class="dropdown dropdown-end">
        <div role="button" tabindex="0" class="btn btn-xs btn-ghost" data-testid="templates-menu-trigger">Templates</div>
        <ul class="dropdown-content menu bg-base-200 rounded-box z-50 mt-1 max-h-[80vh] w-80 flex-nowrap overflow-y-auto p-2 shadow-xl">
          <li class="menu-title"><span>Complete SSP samples ({referenceSspTemplates.length})</span></li>
          {#each referenceSspTemplates as tpl}
            <li>
              <button
                class="w-full items-start gap-2 py-2 text-left"
                onclick={() => loadTemplate(tpl.key)}
                data-testid={`template-${tpl.key}`}
                title={`${tpl.description} By ${tpl.author}. ${tpl.pieces} pieces, ${tpl.seams} seams, ${tpl.materials} materials.`}
              >
                <span class={`badge badge-xs mt-0.5 shrink-0 ${tpl.dimension === '3D' ? 'badge-accent' : 'badge-ghost'}`}>{tpl.dimension}</span>
                <span class="min-w-0">
                  <span class="block truncate text-sm font-medium">{tpl.name}</span>
                  <span class="block truncate text-xs opacity-55">{tpl.author} · {tpl.pieces} pieces · {tpl.seams} seams</span>
                </span>
              </button>
            </li>
          {/each}
          <li class="menu-title pt-2"><span>Generators</span></li>
          <li>
            <button class="w-full text-left" onclick={() => (showGlobeLantern = true)} data-testid="template-globe-lantern">
              <span class="block truncate text-sm font-medium">Globe lantern…</span>
              <span class="block truncate text-xs opacity-55">Wire-in-seam sphere from a coiled strip — helix or stacked rings</span>
            </button>
          </li>
          <li class="menu-title pt-2"><span>Drafting examples</span></li>
          {#each draftingTemplates as tpl}
            <li>
              <button class="w-full text-left" onclick={() => loadTemplate(tpl.key)} data-testid={`template-${tpl.key}`}>
                <span class="block truncate text-sm font-medium">{tpl.name}</span>
                <span class="block truncate text-xs opacity-55">{tpl.description}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
      <div class="join join-horizontal" data-tour-id="tour-view-mode">
        <button class="join-item btn btn-xs" class:btn-active={viewMode === '2d'} onclick={() => setViewMode('2d')}>2D</button>
        <button class="join-item btn btn-xs" class:btn-active={viewMode === 'both'} onclick={() => setViewMode('both')}>Both</button>
        <button class="join-item btn btn-xs" class:btn-active={viewMode === '3d'} onclick={() => setViewMode('3d')}>3D</button>
      </div>
    </div>
    <div class="flex items-center gap-1">
      <button class="btn btn-ghost btn-xs" onclick={handleUndo} disabled={!$undoLabel} title={$undoLabel ? `Undo ${$undoLabel} (Ctrl+Z)` : 'Nothing to undo'}>&#x21A9;</button>
      <button class="btn btn-ghost btn-xs" onclick={handleRedo} disabled={!$redoLabel} title={$redoLabel ? `Redo ${$redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}>&#x21AA;</button>
      <div class="dropdown dropdown-end">
        <div role="button" tabindex="0" class="btn btn-ghost btn-xs" data-testid="import-menu-trigger">Import</div>
        <ul class="dropdown-content menu bg-base-200 rounded-box z-50 w-60 p-2 shadow text-sm">
          <li class="menu-title">SeamScape importers</li>
          <li><button onclick={handleLegacySourcePair}>Project + Raw JSON (complete)…</button></li>
          <li><button onclick={() => handleSourceImport('image')}>Background image…</button></li>
          <li><button onclick={() => handleSourceImport('seamly')}>Seamly… <span class="text-xs opacity-50">Experimental</span></button></li>
          <li><button onclick={() => handleSourceImport('cut')}>CUT (plot)…</button></li>
          <li><button onclick={() => handleSourceImport('hpgl')}>PLT / HPGL… <span class="text-xs opacity-50">Beta</span></button></li>
          <li><button onclick={() => handleSourceImport('svg')}>SVG…</button></li>
          <li><button onclick={() => handleSourceImport('dxf')}>DXF…</button></li>
          <li><button onclick={() => handleSourceImport('raw-json')}>Raw JSON (SeamScape)…</button></li>
          <li class="menu-title pt-2">Seamer</li>
          <li><button onclick={handleImport}>From file… (project or auto-detect)</button></li>
          <li><button onclick={() => (rulDialog = { table: null })}>RUL grade rules…</button></li>
          <li class="menu-title pt-2">Samples</li>
          {#each importSamples as s}
            <li><button onclick={() => importSample(s.file)} data-testid={`import-sample-${s.file}`}>{s.label}</button></li>
          {/each}
        </ul>
      </div>
      <div class="dropdown dropdown-end">
        <div role="button" tabindex="0" class="btn btn-ghost btn-xs">Export</div>
        <ul class="dropdown-content menu bg-base-200 rounded-box z-50 w-72 p-2 shadow text-sm">
          <li><button onclick={handleExport}>JSON (.seamer.json)</button></li>
          <li><button onclick={exportSSP}>Seamer Project — 2D + 3D (.ssp)</button></li>
          <li><button onclick={() => exportAs('svg')}>SVG</button></li>
          <li><button onclick={() => exportAs('svg2')}>Export SVG 2 (Beta)</button></li>
          <li><button onclick={() => exportAs('dxf')}>DXF</button></li>
          <li><button onclick={() => (showPrintDialog = true)}>PDF (vector, tiled)</button></li>
          <li><button onclick={exportHPGL}>HPGL (plotter)</button></li>
          <li><button onclick={exportPNG}>PNG</button></li>
          <li><button onclick={() => exportAs('csv')}>CSV (points)</button></li>
          <li><button onclick={exportSeamlyMe}>SeamlyMe measurements (.smis)</button></li>
          <li class="menu-title pt-2">Cutting</li>
          <li><button onclick={() => (showCuttingRoom = true)}>Cutting room…</button></li>
          <li><button onclick={exportMarker}>Marker / nest (SVG)</button></li>
          <li><button onclick={doPrintMarker}>Print marker (tiled)…</button></li>
          <li><button onclick={() => (showPrintDialog = true)}>Print pattern (tiled)…</button></li>
          <li><button onclick={doPrint}>Print (single page)…</button></li>
        </ul>
      </div>
      <button class="btn btn-ghost btn-xs" onclick={handleNew}>New</button>
      <button class="btn btn-xs" class:btn-accent={!saved} class:btn-ghost={saved} onclick={handleSave} data-tour-id="tour-save">{saved ? 'Saved' : 'Save'}</button>
      <button class="btn btn-ghost btn-xs" onclick={() => showLeftPanel = !showLeftPanel} title="Toggle left panel">&#x2630;</button>
      <button class="btn btn-ghost btn-xs" onclick={() => showRightPanel = !showRightPanel} title="Toggle right panel">&#x25B6;</button>
      <button class="btn btn-xs" class:btn-active={showObjectBrowser} onclick={() => showObjectBrowser = !showObjectBrowser} title="Toggle object browser" data-testid="object-browser-toggle">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">view_list</span>
      </button>
      {#key $patternEditor}<ErrorsPanel {currentPattern} editor={$patternEditor} />{/key}
      <HistoryMenu onundo={(n) => { for (let i = 0; i < n; i++) handleUndo(); }} onredo={handleRedo} />
      <button class="btn btn-ghost btn-xs" onclick={() => showVersions = true} title="Version history" aria-label="Version history">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">history</span>
      </button>
      <ThemeToggle size="xs" />
      <button class="btn btn-ghost btn-xs" onclick={() => showSettings = true} title="Settings" aria-label="Settings">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">settings</span>
      </button>
      <button class="btn btn-ghost btn-xs" onclick={() => showCommandPalette = true} title="Command palette (⌘K)" aria-label="Command palette">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">terminal</span>
      </button>
      <button class="btn btn-ghost btn-xs" onclick={() => showTour = true} title="Take tour" aria-label="Take tour">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">tour</span>
      </button>
      <button class="btn btn-ghost btn-xs" onclick={() => showBugReport = true} title="Send feedback" aria-label="Send feedback">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">feedback</span>
      </button>
      <button class="btn btn-ghost btn-xs" onclick={() => showShortcuts = true} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">keyboard</span>
      </button>
    </div>
  </div>

  <div class="flex-1 flex overflow-hidden">
    {#if showLeftPanel}
      <div class="w-56 border-r bg-base-100 flex flex-col shrink-0 overflow-hidden" data-tour-id="tour-left-panel">
        <div class="tabs tabs-boxed tabs-xs bg-base-200 px-1 pt-1">
          <button class="tab" class:tab-active={leftTab === 'layers'} onclick={() => leftTab = 'layers'}>Layers</button>
          <button class="tab" class:tab-active={leftTab === 'body'} onclick={() => leftTab = 'body'}>Body</button>
          <button class="tab" class:tab-active={leftTab === 'materials'} onclick={() => leftTab = 'materials'}>Fabric</button>
          <button class="tab" class:tab-active={leftTab === 'seams'} onclick={() => leftTab = 'seams'}>Seams</button>
        </div>
        <div class="flex-1 overflow-y-auto p-2">
          {#if leftTab === 'layers'}<LayerPanel {currentPattern} onchange={handlePatternUpdate} />
          {:else if leftTab === 'body'}<BodyPanel {currentPattern} onchange={handlePatternUpdate} />
          {:else if leftTab === 'materials'}<MaterialPanel {currentPattern} onchange={handlePatternUpdate} />
          {:else if leftTab === 'seams'}<SeamPanel {currentPattern} onchange={handlePatternUpdate} />
          {/if}
        </div>
      </div>
    {/if}

    <div class="flex-1 min-w-0 flex overflow-hidden">
      {#if viewMode === 'both'}
        <div class="w-1/2 min-w-0 border-r relative" data-tour-id="tour-canvas-2d">{#key $patternEditor}<PatternCanvas2D {currentPattern} editor={$patternEditor} onchange={handlePatternUpdate} />{/key}</div>
        <div class="w-1/2 min-w-0 relative" data-tour-id="tour-canvas-3d"><PatternScene3D bind:this={scene3d} {currentPattern} selectedPieceId={[...pieceIds][0] ?? null} onpieceselect={handlePieceSelect} ondrapesettled={handleDrapeSettled} onpatternupdate={handlePatternUpdate} oncamerachange={handleCameraChange} {labelDisplay} onlabeldisplaychange={(v) => (labelDisplay = v)} /></div>
      {:else if viewMode === '2d'}
        <div class="flex-1 min-w-0 relative" data-tour-id="tour-canvas-2d">{#key $patternEditor}<PatternCanvas2D {currentPattern} editor={$patternEditor} onchange={handlePatternUpdate} />{/key}</div>
      {:else}
        <div class="flex-1 min-w-0 relative" data-tour-id="tour-canvas-3d"><PatternScene3D bind:this={scene3d} {currentPattern} selectedPieceId={[...pieceIds][0] ?? null} onpieceselect={handlePieceSelect} ondrapesettled={handleDrapeSettled} onpatternupdate={handlePatternUpdate} oncamerachange={handleCameraChange} {labelDisplay} onlabeldisplaychange={(v) => (labelDisplay = v)} /></div>
      {/if}
    </div>

    {#if showRightPanel}
      {#key $patternEditor}<PropertyPanel {currentPattern} editor={$patternEditor} onchange={handlePatternUpdate} onclose={() => (showRightPanel = false)} {labelDisplay} onlabeldisplaychange={(v) => (labelDisplay = v)} ongrading={() => (showGrading = true)} onalterations={() => (showAlterations = true)} />{/key}
    {/if}
  </div>

  {#if viewMode !== '3d'}
    <div class="h-10 border-t bg-base-200 shrink-0" data-tour-id="tour-toolbar">
      {#key $patternEditor}<StudioToolbar {currentPattern} editor={$patternEditor} onchange={handlePatternUpdate} />{/key}
    </div>
  {/if}

  {#key $patternEditor}<StatusBar {currentPattern} {saved} editor={$patternEditor} />{/key}

  {#if showObjectBrowser}
    {#key $patternEditor}<ObjectBrowser {currentPattern} editor={$patternEditor} onchange={handlePatternUpdate} bind:open={showObjectBrowser} />{/key}
  {/if}
</div>

<KeyboardShortcuts bind:open={showShortcuts} />
<WelcomeModal onshowshortcuts={() => (showShortcuts = true)} onstarttour={() => (showTour = true)} />
{#if showTour}<StudioTour onclose={() => (showTour = false)} />{/if}
<WhatsNewModal />
<ReviewPromptDialog {saveCount} />
{#if showCommandPalette}<CommandPalette onclose={() => (showCommandPalette = false)} />{/if}
{#if showBugReport}<BugReportModal {currentPattern} onclose={() => (showBugReport = false)} />{/if}
{#if showCuttingRoom}<CuttingRoomModal {currentPattern} onchange={handlePatternUpdate} onclose={() => (showCuttingRoom = false)} />{/if}
{#if showVersions}<VersionsModal {currentPattern} onrestore={applyRestoredVersion} onchange={handlePatternUpdate} onclose={() => (showVersions = false)} />{/if}
{#if showSettings}<SettingsModal onclose={() => (showSettings = false)} />{/if}
<GlobeLanternDialog
  open={showGlobeLantern}
  ongenerate={(p) => void adoptGeneratedPattern(p)}
  onclose={() => (showGlobeLantern = false)}
/>
{#if showPrintDialog}<PrintDialog pattern={currentPattern} {patternName} onclose={() => (showPrintDialog = false)} />{/if}
{#if dxfPending}<DxfImportDialog filename={dxfPending.name} onapply={importDxfWithOptions} oncancel={() => (dxfPending = null)} />{/if}
{#if svgPending}<SvgImportDialog filename={svgPending.name} onapply={importSvgWithOptions} oncancel={() => (svgPending = null)} />{/if}
{#if rulDialog}<SizesDialog table={rulDialog.table} onapply={applyRul} oncancel={() => (rulDialog = null)} />{/if}

<Toaster />
<ConfirmDialog />
{#if showGrading}<GradingOverlay {currentPattern} onclose={() => (showGrading = false)} />{/if}
{#if showAlterations}
  <AlterationsPanel
    {currentPattern}
    onchange={handlePatternUpdate}
    editState={alterationEdit}
    onclose={() => (showAlterations = false)}
    onstartedit={startAlterationEdit}
    onsetdriver={applyBaseToCanvas}
    onsavesample={saveAlterationSample}
    onendedit={endAlterationEdit}
  />
{/if}
