<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { replaceState } from '$app/navigation';
  import PatternCanvas2D from '$lib/components/PatternCanvas2D.svelte';
  import PatternScene3D from '$lib/components/PatternScene3D.svelte';
  import StudioToolbar from '$lib/components/StudioToolbar.svelte';
  import PropertyPanel from '$lib/components/PropertyPanel.svelte';
  import LayerPanel from '$lib/components/LayerPanel.svelte';
  import BodyPanel from '$lib/components/BodyPanel.svelte';
  import MaterialPanel from '$lib/components/MaterialPanel.svelte';
  import SeamPanel from '$lib/components/SeamPanel.svelte';
  import ObjectBrowser from '$lib/components/ObjectBrowser.svelte';
  import { pattern, patternEditor, selectedPointIds, selectedPathIds, selectedPieceIds, pushUndo, undo, redo, undoLabel, redoLabel, restoreHistory, pendingPaste, panelRequest, installSeamerAutomation, getPatternEditor } from '$lib/stores/pattern';
  import EditorStateBridge from '$lib/components/EditorStateBridge.svelte';
  import { loadPattern, savePattern as saveToDB } from '$lib/stores/localDB';
  import { EMPTY_PATTERN, type Pattern, type Piece, type ConstrainablePoint, type ConstrainablePath } from '@seamer/pattern-model';
  import type { PendingPaste } from '$lib/stores/pattern';
  import { isSimpleFormat, convertSimplePattern } from '$lib/utils/importSimplePattern';
  import { deletePoint, deletePath, deletePiece } from '$lib/utils/patternMutations';
  import Toaster from '$lib/components/Toaster.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import GradingOverlay from '$lib/components/GradingOverlay.svelte';
  import { toast, toastSuccess, toastError } from '$lib/stores/toast';
  import { confirm } from '$lib/stores/confirm';
  import { patternToSVG, patternToSVG2, patternToDXF, patternToCSV, downloadText, patternToPNG, downloadBlob, printPattern, printMarkerTiled, patternToHPGL, patternToSSP, sspToPattern } from '$lib/utils/exporters';
  import { patternThumbnail } from '$lib/utils/thumbnail';
  import { nestPieces, markerToSVG, type CutOffType } from '$lib/utils/markerLayout';
  import { dxfToPattern, svgToPattern, type DxfImportOptions } from '$lib/utils/patternImport';
  import { parseRul, applyRulToPattern, type RulTable } from '$lib/utils/rulImport';
  import PrintDialog from '$lib/components/PrintDialog.svelte';
  import DxfImportDialog from '$lib/components/DxfImportDialog.svelte';
  import SizesDialog from '$lib/components/SizesDialog.svelte';
  import { cutToPattern } from '$lib/utils/cutImport';
  import { seamlyToPattern } from '$lib/utils/seamlyImport';
  import { bodyToSeamlyMe } from '$lib/utils/seamlyExport';
  import { syncLinkedPaths } from '$lib/utils/linkedPaths';
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
  import StatusBar from '$lib/components/StatusBar.svelte';
  import HistoryMenu from '$lib/components/HistoryMenu.svelte';
  import { configureMcpSession } from '$lib/stores/mcpSession';
  import { get } from 'svelte/store';
  import { autoSaveSeconds } from '$lib/stores/pattern';

  let showCommandPalette = $state(false);
  let showBugReport = $state(false);
  let showPrintDialog = $state(false);
  /** pending .dxf file text + name while the DXF import options dialog is open */
  let dxfPending = $state<{ text: string; name: string } | null>(null);
  /** RUL grade-rule dialog: table parsed from a picked .rul file, or null for "pick a file" mode */
  let rulDialog = $state<{ table: RulTable | null } | null>(null);
  let showCuttingRoom = $state(false);
  let showVersions = $state(false);
  let showSettings = $state(false);
  let showTour = $state(false);
  /** successful saves this session — drives the review prompt */
  let saveCount = $state(0);

  let currentPattern = $state<Pattern>(structuredClone(EMPTY_PATTERN));
  let saved = $state(true);
  let viewMode = $state<'2d' | '3d' | 'both'>('both');
  let leftTab = $state<'layers' | 'body' | 'materials' | 'seams'>('layers');
  let showRightPanel = $state(true);
  let showLeftPanel = $state(true);
  let patternName = $state('New Pattern');
  let labelDisplay = $state<'off' | 'billboard' | 'flat'>('flat'); // projected-on-fabric, like the source
  let showObjectBrowser = $state(false);
  let showShortcuts = $state(false);
  let showGrading = $state(false);
  let showAlterations = $state(false);
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

  const templatePatterns: Record<string, { name: string; description: string; file: string }> = {
    'parametric-skirt': { name: 'Parametric Skirt ✨', description: 'Truly parametric: waist/hip/length variables re-draft the geometry; grades by size', file: 'parametric-skirt.json' },
    'simple-pants': { name: 'Trousers', description: 'Simple pants in 3D (full 3D data)', file: 'simple-pants-3d.json' },
    'flare-dress': { name: 'Fit & Flare Dress (imported)', description: 'Sleeveless fit and flare dress — converted from a 2D export', file: 'flare-dress.raw.json' },
    'pencil-skirt': { name: 'Pencil Skirt (3D)', description: 'Pencil skirt with waistband, multi-seam (full 3D data)', file: 'pencil-skirt.json' },
    'pencil-skirt-2d': { name: 'Pencil Skirt (2D)', description: '2D skirt block that updates with the body', file: 'pencil-skirt-2d-bodydouble.json' },
    'pencil-skirt-2d-tutorial': { name: 'Pencil Skirt (2D, tutorial)', description: '2D pencil skirt from the YouTube tutorial', file: 'pencil-skirt-2d-tutorial.json' },
    'grundschnitt-rock': { name: 'Skirt Block', description: 'Basic skirt block (Grundschnitt Rock)', file: 'grundschnitt-rock.json' },
    'panty-block': { name: 'Panty Block', description: 'Basic highwaisted panty block', file: 'panty-block.json' },
    'russ-pants': { name: 'Russ Pants', description: "Norwegian 'russ' party pants", file: 'russ-pants.json' },
    'tshirt-basic': { name: 'T-Shirt (Basic)', description: 'Front and back pieces with many variables', file: 'tshirt-basic.json' },
    'long-sleeve-shirt': { name: 'Long Sleeve Shirt', description: 'Long sleeve shirt with collar and cuffs', file: 'long-sleeve-shirt.json' },
    'parametric-shirt': { name: 'Parametric Shirt', description: 'Long sleeve shirt controlled by measurements', file: 'parametric-shirt.json' },
    'shirt-with-pocket': { name: 'Shirt with Pocket', description: 'Shirt with a front chest pocket', file: 'shirt-with-pocket.json' },
    'test-shirt-3d': { name: 'Test Shirt (3D)', description: 'Demo shirt in 3D', file: 'test-shirt-3d.json' },
    'tailored-shirt': { name: 'Tailored Shirt', description: "Sample pattern from Aldrich's book", file: 'tailored-shirt.json' },
    'womens-jacket': { name: "Women's Jacket", description: "Ladies' basic jacket with two-piece sleeves", file: 'womens-jacket.json' },
    'oversized-blazer': { name: 'Oversized Blazer', description: 'Oversized longline blazer base (WIP)', file: 'oversized-blazer.json' },
    'black-dress': { name: 'Black Dress', description: 'Little black dress, simple', file: 'black-dress.json' },
    'flared-midi-dress': { name: 'Flared Midi Dress', description: 'Snug at bust and waist with maxi flared lower part', file: 'flared-midi-dress.json' },
    'nightwing-logo': { name: 'Nightwing Logo', description: 'Nightwing chest logo applique', file: 'nightwing-logo.json' }
  };

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
            const res = await fetch(`/api/patterns/${id}`);
            if (res.ok) loaded = await res.json();
          } catch { /* offline — fall through to blank editor */ }
        }
        if (loaded) {
          currentPattern = loaded; patternName = loaded.name;
          pattern.set(currentPattern);
          // Editor restores this pattern's persisted undo/redo asynchronously.
          await restoreHistory(id);
        } else {
          toastError('Pattern not found');
        }
      } else {
        await loadTemplate('pencil-skirt');
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
    if ($page.params.slug?.split('/')[0] !== currentPattern.id) replaceState(`/studio/${currentPattern.id}`, {});
    toastSuccess('Pattern saved');
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

  /** Parse imported text by extension into a Pattern (shared by the file picker + sample loader). */
  function parseImport(text: string, ext: string | undefined, name: string): Pattern {
    if (ext === 'dxf') return dxfToPattern(text, name);
    if (ext === 'svg') return svgToPattern(text, name);
    if (ext === 'cut') return cutToPattern(text, name);
    if (ext === 'val' || ext === 'sm2d' || ext === 'xml') return seamlyToPattern(text, name);
    const raw = JSON.parse(text);
    return isSimpleFormat(raw) ? convertSimplePattern(raw) : (raw as Pattern);
  }

  function applyImported(data: Pattern) {
    currentPattern = data; patternName = data.name; pattern.set(data); pushUndo(structuredClone(data), 'Import pattern'); saved = true;
    toastSuccess(`Imported "${data.name}"`);
  }

  function handleImport() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,.seamer.json,.ssp,.dxf,.svg,.cut,.val,.sm2d,.xml,.rul';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
      const ext = file.name.split('.').pop()?.toLowerCase();
      try {
        if (ext === 'ssp') { applyImported(await sspToPattern(file)); return; } // gzip-compressed project
        const text = await file.text();
        const name = file.name.replace(/\.(dxf|svg|cut|val|sm2d|xml|json|rul|seamer\.json)$/i, '');
        if (ext === 'dxf') { dxfPending = { text, name }; return; } // import options dialog first
        if (ext === 'rul') { rulDialog = { table: parseRul(text) }; return; } // pick a size, then apply
        applyImported(parseImport(text, ext, name));
      } catch (err) { toastError((err as Error)?.message || 'Could not import file'); }
    };
    input.click();
  }

  async function exportSSP() {
    const blob = await patternToSSP($state.snapshot(currentPattern) as Pattern);
    downloadBlob(`${patternName.replace(/\s+/g, '_') || 'pattern'}.ssp`, blob);
    toastSuccess('Exported compressed project (.ssp)');
  }

  function importDxfWithOptions(options: DxfImportOptions) {
    if (!dxfPending) return;
    try {
      applyImported(dxfToPattern(dxfPending.text, dxfPending.name, options));
    } catch (err) { toastError((err as Error)?.message || 'Could not import file'); }
    dxfPending = null;
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
      const res = await fetch(`/samples/${file}`);
      if (!res.ok) throw new Error('not found');
      const ext = file.split('.').pop()?.toLowerCase();
      applyImported(parseImport(await res.text(), ext, file.replace(/\.(dxf|svg)$/i, '')));
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
    currentPattern = structuredClone(EMPTY_PATTERN); patternName = 'New Pattern'; pattern.set(currentPattern); saved = true;
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

  async function loadTemplate(key: string) {
    const tpl = templatePatterns[key];
    if (!tpl) return;
    try {
      const res = await fetch(`/templates/${tpl.file}`);
      if (!res.ok) throw new Error('Not found');
      const raw = await res.json();
      let data: Pattern = isSimpleFormat(raw) ? convertSimplePattern(raw) : (raw as Pattern);
      data.id = crypto.randomUUID(); data.versionId = crypto.randomUUID(); data.isPublic = false;
      data = normalizePattern(data);
      // recover parametric constructions from the baked template (no-op if already constrained / not recoverable)
      data = makeParametric(data);
      currentPattern = data; patternName = tpl.name || data.name; pattern.set(data); await restoreHistory(data.id); saved = true;
    } catch {
      currentPattern = { ...EMPTY_PATTERN, name: tpl.name, description: tpl.description, enable3d: true, viewMode: 'both' };
      patternName = tpl.name; pattern.set(currentPattern); await restoreHistory(currentPattern.id); saved = true;
    }
  }

  function handlePieceSelect(id: string | null) {
    // no-op when the selection is already exactly this piece: writing fresh Sets always
    // notifies subscribers, which can re-trigger the 3D highlight effect in a cycle
    const cur = get(selectedPieceIds);
    if ((id ? cur.size === 1 && cur.has(id) : cur.size === 0) && get(selectedPointIds).size === 0 && get(selectedPathIds).size === 0) return;
    selectedPieceIds.set(id ? new Set([id]) : new Set());
    selectedPointIds.set(new Set());
    selectedPathIds.set(new Set());
  }

  function handleUndo() { const prev = undo($state.snapshot(currentPattern) as Pattern); if (prev) { currentPattern = prev; patternName = prev.name; pattern.set(prev); saved = false; } }
  function handleRedo() { const next = redo($state.snapshot(currentPattern) as Pattern); if (next) { currentPattern = next; patternName = next.name; pattern.set(next); saved = false; } }

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
      const hasSel = $selectedPointIds.size || $selectedPathIds.size || $selectedPieceIds.size;
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
      for (const id of $selectedPointIds) { p = deletePoint(p, id); changed = true; }
      for (const id of $selectedPathIds) { p = deletePath(p, id); changed = true; }
      for (const id of $selectedPieceIds) { p = deletePiece(p, id); changed = true; }
      if (changed) {
        handlePatternUpdate(p, 'Delete');
        selectedPointIds.set(new Set());
        selectedPathIds.set(new Set());
        selectedPieceIds.set(new Set());
        toastSuccess('Deleted');
      }
    }
  }

  const uidFor = (pre: string) => `${pre}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
  let clipboard: PendingPaste | null = null;
  const plural = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

  function handleCopy() {
    const p = $pattern;
    if ($selectedPieceIds.size > 0) {
      const items = p.pieces.filter(pc => $selectedPieceIds.has(pc.id)).map(pc => structuredClone($state.snapshot(pc)) as Piece);
      clipboard = { kind: 'pieces', items };
      toastSuccess(`${plural(items.length)} copied to clipboard`);
    } else if ($selectedPathIds.size > 0) {
      // paths copy with their anchor points (paste decides whether to reuse or duplicate them)
      const items = p.paths
        .filter(pa => $selectedPathIds.has(pa.id))
        .map(pa => ({
          path: structuredClone($state.snapshot(pa)) as ConstrainablePath,
          points: pa.pathPoints
            .map(pp => p.points.find(q => q.id === pp.id))
            .filter((q): q is ConstrainablePoint => !!q)
            .map(q => structuredClone($state.snapshot(q)) as ConstrainablePoint)
        }));
      clipboard = { kind: 'paths', items };
      toastSuccess(`${plural(items.length)} copied to clipboard`);
    } else if ($selectedPointIds.size > 0) {
      const items = p.points.filter(pt => $selectedPointIds.has(pt.id)).map(pt => structuredClone($state.snapshot(pt)) as ConstrainablePoint);
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
    if ($selectedPieceIds.size !== 1) return;
    const p = $pattern;
    const piece = p.pieces.find(pc => $selectedPieceIds.has(pc.id));
    if (!piece) return;
    const uid = (pre: string) => `${pre}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
    const clone = structuredClone($state.snapshot(piece));
    clone.id = uid('Piece');
    clone.name = `Copy of ${piece.name}`;
    clone.position = { x: piece.position.x + 50, y: piece.position.y - 50 };
    for (const pp of [...clone.mainPaths, ...clone.internalPaths]) pp.id = uid('PiecePath');
    handlePatternUpdate({ ...p, pieces: [...p.pieces, clone], hasChanged: true }, 'Duplicate piece');
    selectedPieceIds.set(new Set([clone.id]));
    toastSuccess(`Duplicated "${piece.name}"`);
  }
</script>

{#key $patternEditor}
  <EditorStateBridge editor={$patternEditor} />
{/key}

<svelte:window onkeydown={handleKeydown} />

<div class="flex flex-col h-screen overflow-hidden">
  <div class="flex items-center justify-between px-3 py-1.5 bg-base-200 border-b shrink-0">
    <div class="flex items-center gap-2">
      <a href="/" class="btn btn-ghost btn-xs">&larr;</a>
      <span class="text-sm font-lexend font-semibold hidden lg:inline">Pattern Studio</span>
    </div>
    <div class="flex items-center gap-2">
      <input type="text" class="input input-bordered input-xs w-40 lg:w-56" placeholder="Pattern name..." bind:value={patternName} />
      <div class="dropdown dropdown-end">
        <div role="button" class="btn btn-xs btn-ghost">Templates</div>
        <ul class="dropdown-content menu bg-base-200 rounded-box z-50 w-56 p-2 shadow">
          {#each Object.entries(templatePatterns) as [key, tpl]}
            <li><button class="w-full text-left" onclick={() => loadTemplate(key)}>{tpl.name}<span class="text-xs opacity-50 ml-1">{tpl.description.substring(0, 40)}</span></button></li>
          {/each}
        </ul>
      </div>
      <div class="join join-horizontal" data-tour-id="tour-view-mode">
        <button class="join-item btn btn-xs" class:btn-active={viewMode === '2d'} onclick={() => viewMode = '2d'}>2D</button>
        <button class="join-item btn btn-xs" class:btn-active={viewMode === 'both'} onclick={() => viewMode = 'both'}>Both</button>
        <button class="join-item btn btn-xs" class:btn-active={viewMode === '3d'} onclick={() => viewMode = '3d'}>3D</button>
      </div>
    </div>
    <div class="flex items-center gap-1">
      <button class="btn btn-ghost btn-xs" onclick={handleUndo} disabled={!$undoLabel} title={$undoLabel ? `Undo ${$undoLabel} (Ctrl+Z)` : 'Nothing to undo'}>&#x21A9;</button>
      <button class="btn btn-ghost btn-xs" onclick={handleRedo} disabled={!$redoLabel} title={$redoLabel ? `Redo ${$redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}>&#x21AA;</button>
      <div class="dropdown dropdown-end">
        <div role="button" tabindex="0" class="btn btn-ghost btn-xs">Import</div>
        <ul class="dropdown-content menu bg-base-200 rounded-box z-50 w-52 p-2 shadow text-sm">
          <li><button onclick={handleImport}>From file… (JSON/DXF/SVG/CUT/Seamly)</button></li>
          <li><button onclick={() => (rulDialog = { table: null })}>RUL grade rules…</button></li>
          <li class="menu-title pt-2">Samples</li>
          {#each importSamples as s}
            <li><button onclick={() => importSample(s.file)}>{s.label}</button></li>
          {/each}
        </ul>
      </div>
      <div class="dropdown dropdown-end">
        <div role="button" tabindex="0" class="btn btn-ghost btn-xs">Export</div>
        <ul class="dropdown-content menu bg-base-200 rounded-box z-50 w-44 p-2 shadow text-sm">
          <li><button onclick={handleExport}>JSON (.seamer.json)</button></li>
          <li><button onclick={exportSSP}>Compressed project (.ssp)</button></li>
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
      <button class="btn btn-xs" class:btn-active={showObjectBrowser} onclick={() => showObjectBrowser = !showObjectBrowser} title="Toggle object browser">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">view_list</span>
      </button>
      <ErrorsPanel {currentPattern} />
      <HistoryMenu onundo={(n) => { for (let i = 0; i < n; i++) handleUndo(); }} onredo={handleRedo} />
      <button class="btn btn-ghost btn-xs" onclick={() => showVersions = true} title="Version history" aria-label="Version history">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">history</span>
      </button>
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

    <div class="flex-1 flex overflow-hidden">
      {#if viewMode === 'both'}
        <div class="w-1/2 border-r relative" data-tour-id="tour-canvas-2d"><PatternCanvas2D {currentPattern} onchange={handlePatternUpdate} /></div>
        <div class="w-1/2 relative" data-tour-id="tour-canvas-3d"><PatternScene3D {currentPattern} selectedPieceId={[...$selectedPieceIds][0] ?? null} onpieceselect={handlePieceSelect} ondrapesettled={handleDrapeSettled} onpatternupdate={handlePatternUpdate} oncamerachange={handleCameraChange} {labelDisplay} /></div>
      {:else if viewMode === '2d'}
        <div class="flex-1 relative" data-tour-id="tour-canvas-2d"><PatternCanvas2D {currentPattern} onchange={handlePatternUpdate} /></div>
      {:else}
        <div class="flex-1 relative" data-tour-id="tour-canvas-3d"><PatternScene3D {currentPattern} selectedPieceId={[...$selectedPieceIds][0] ?? null} onpieceselect={handlePieceSelect} ondrapesettled={handleDrapeSettled} onpatternupdate={handlePatternUpdate} oncamerachange={handleCameraChange} {labelDisplay} /></div>
      {/if}
    </div>

    {#if showRightPanel}
      <PropertyPanel {currentPattern} onchange={handlePatternUpdate} onclose={() => (showRightPanel = false)} {labelDisplay} onlabeldisplaychange={(v) => (labelDisplay = v)} ongrading={() => (showGrading = true)} onalterations={() => (showAlterations = true)} />
    {/if}
  </div>

  <div class="h-10 border-t bg-base-200 shrink-0" data-tour-id="tour-toolbar">
    <StudioToolbar {currentPattern} onchange={handlePatternUpdate} />
  </div>

  <StatusBar {currentPattern} {saved} />

  {#if showObjectBrowser}
    <ObjectBrowser {currentPattern} onchange={handlePatternUpdate} bind:open={showObjectBrowser} />
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
{#if showVersions}<VersionsModal {currentPattern} onrestore={applyImported} onchange={handlePatternUpdate} onclose={() => (showVersions = false)} />{/if}
{#if showSettings}<SettingsModal onclose={() => (showSettings = false)} />{/if}
{#if showPrintDialog}<PrintDialog pattern={currentPattern} {patternName} onclose={() => (showPrintDialog = false)} />{/if}
{#if dxfPending}<DxfImportDialog filename={dxfPending.name} onapply={importDxfWithOptions} oncancel={() => (dxfPending = null)} />{/if}
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
