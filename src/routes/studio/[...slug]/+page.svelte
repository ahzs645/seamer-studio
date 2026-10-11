<script lang="ts">
  import { sourceGatherRegistry, type SourceGatherCacheMarker } from "$lib/utils/sourceGatherPreparation";
  import { encodeOriginalGatherDocument } from "$lib/utils/sourceGatherEvidence";
  import { PINNED_GATHER_PROGRAMS } from "$lib/utils/pinnedGatherPrograms";
  import { base } from '$app/paths';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { replaceState } from '$app/navigation';
  import PatternCanvas2D from '$lib/components/PatternCanvas2D.svelte';
  import { frozenReadOnlyAutomation } from '$lib/scene/frozenAppRender';
  import PatternScene3D from '$lib/components/PatternScene3D.svelte';
  import WorkspaceSplit from '$lib/components/WorkspaceSplit.svelte';
  import WorkspaceDock from '$lib/components/WorkspaceDock.svelte';
  import { layoutPanes, layoutViewMode, normalizeWorkspaceLayout, workspacePreset } from '$lib/utils/workspaceLayout';
  import SpecsPanel from '$lib/components/SpecsPanel.svelte';
  import ContextualSelectionToolbar from '$lib/components/ContextualSelectionToolbar.svelte';
  import GlobeLanternDialog from '$lib/components/GlobeLanternDialog.svelte';
  import GarmentCodeDialog from '$lib/components/GarmentCodeDialog.svelte';
  import StudioToolbar from '$lib/components/StudioToolbar.svelte';
  import PropertyPanel from '$lib/components/PropertyPanel.svelte';
  import LayerPanel from '$lib/components/LayerPanel.svelte';
  import BodyPanel from '$lib/components/BodyPanel.svelte';
  import MaterialPanel from '$lib/components/MaterialPanel.svelte';
  import ColorwayPanel from '$lib/components/ColorwayPanel.svelte';
  import ArtworkPanel from '$lib/components/ArtworkPanel.svelte';
  import SeamPanel from '$lib/components/SeamPanel.svelte';
  import ObjectBrowser from '$lib/components/ObjectBrowser.svelte';
  import { pattern, patternEditor, pushUndo, undo, redo, undoLabel, redoLabel, restoreHistory, clearPersistedHistory, pendingPaste, panelRequest, installSeamerAutomation, getPatternEditor, setDocumentMutationLock, adoptPatternSnapshot } from '$lib/stores/pattern';
  import EditorStateBridge from '$lib/components/EditorStateBridge.svelte';
  import type { Selection } from '@atelier/core';
  import type { EditorState } from '@atelier/svelte';
  import { loadPattern, savePattern as saveToDB } from '$lib/stores/localDB';
  import { createDocumentSaver } from '$lib/utils/documentSave';
  import {importExplicitSourceGather} from '$lib/utils/explicitSourceGatherImport';
  import { convertGarmentCodePattern, isGarmentCodeFormat } from '$lib/utils/importGarmentCode';
  import { GARMENTCODE_EXAMPLES, GARMENTCODE_PRESETS, type GarmentCodeRequest } from '$lib/data/garmentCode';
  import { attachGarmentCodeBody, unitKind } from '@seamer/avatar';
  import { compatibleSourceBodyCheckpoint, capturedSourceStretchPolicy, capturedSourceAssemblyComplete, SOURCE_BODY_FIT_REVISION, GARMENT_CODE_ASSEMBLY_REVISION } from '$lib/scene/sourceBodyCheckpoint';
  import { isAppShortcutBlocked, isDocumentKeyboardTarget, scene3dOwnsKeyboard } from '$lib/utils/keyboard';
  import {
    EMPTY_PATTERN,
    deletePath,
    deletePiece,
    deletePoint,
    syncLinkedPaths,
    validateDocumentExtensions,
    type Pattern,
    type WorkspaceLayout,
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
  import CommandPalette, { type WorkspaceAction } from '$lib/components/CommandPalette.svelte';
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
  import PatternLibrary from '$lib/components/PatternLibrary.svelte';
  import TaskWorkflowBar from '$lib/components/TaskWorkflowBar.svelte';
  import SidebarTabs from '$lib/components/SidebarTabs.svelte';
  import { studioTaskPreset, STUDIO_TASKS, type StudioTask, type StudioSidebar } from '$lib/utils/studioTasks';
  import { matchesShortcut } from '$lib/utils/shortcuts';
  import RangePlanPanel from '$lib/components/RangePlanPanel.svelte';
  import SharePanel from '$lib/components/SharePanel.svelte';
  import DetachedPaneControls from '$lib/components/DetachedPaneControls.svelte';
  import { createDocumentOperationGuard } from '$lib/utils/documentOperationGuard';
  import { syncLinkedMirrorPlacements } from '$lib/utils/linkedMirror';
  import { draftingFingerprint, synchronizeLinkedDraft } from '$lib/utils/draftingSync';

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
  let showGarmentCode = $state(false);
  let showTour = $state(false);
  let activeTask = $state<StudioTask | null>(null);
  let showSharing = $state(false);
  let collaborationRole = $state<'owner' | 'editor' | 'viewer' | null>(null);
  const initialSharedDocumentId = $page.url.searchParams.get('shared');
  let activeSharedDocumentId = $state<string | null>(initialSharedDocumentId && /^[a-f\d-]{36}$/.test(initialSharedDocumentId) ? initialSharedDocumentId : null);
  let frozenDiagnosticActive = $state(false);
  const mutationDisabled = $derived(frozenDiagnosticActive || collaborationRole === 'viewer');
  $effect(() => {
    setDocumentMutationLock(frozenDiagnosticActive ? 'Exit the read-only diagnostic before editing.' : collaborationRole === 'viewer' ? 'This shared document is read-only.' : null);
    return () => setDocumentMutationLock(null);
  });
  /** successful saves this session — drives the review prompt */
  let saveCount = $state(0);

  let restoreFrozenAutomation: (() => void) | null = null;
  function handleFrozenDiagnostic(active: boolean) {
    frozenDiagnosticActive = active;
    restoreFrozenAutomation?.(); restoreFrozenAutomation = null;
    if (import.meta.env.DEV && active && window.seamer) {
      const original = window.seamer, readonly = frozenReadOnlyAutomation(original);
      window.seamer = readonly;
      restoreFrozenAutomation = () => { if (window.seamer === readonly) window.seamer = original; };
    }
  }
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
  let documentLoading = $state(true);
  let documentRevision = 0;
  const documentSaver = createDocumentSaver<Pattern>(saveToDB);
  let autosaving = false;
  let autosaveErrorShown = false;
  const savedDocumentOperations = createDocumentOperationGuard(() => ({
    identity: getPatternEditor(), fingerprint: JSON.stringify($state.snapshot(currentPattern)),
    context: `${collaborationRole ?? 'local'}/${activeSharedDocumentId ?? ''}`, blocked: frozenDiagnosticActive || documentLoading
  }));

  function markUnsaved() {
    documentRevision += 1;
    saved = false;
  }

  async function persistCurrentPattern() {
    if (frozenDiagnosticActive) throw new Error('Exit the read-only diagnostic before saving.');
    const receipt = await documentSaver.save($state.snapshot(currentPattern) as Pattern, documentRevision);
    if (receipt.isCurrent(currentPattern.id, documentRevision)) {
      saved = true;
      syncPatternRoute(receipt.documentId);
    }
    autosaveErrorShown = false;
    return receipt;
  }
  type WorkspaceView = NonNullable<Pattern['viewMode']>;
  let viewMode = $state<WorkspaceView>('both');
  let viewerViewOverride = $state(false);
  const customWorkspace = $derived(collaborationRole === 'viewer' && viewerViewOverride ? null : normalizeWorkspaceLayout(currentPattern.workspaceLayout));
  const workspacePanes = $derived(customWorkspace ? layoutPanes(customWorkspace) : layoutPanes(workspacePreset(viewMode)));
  const draftVisible = $derived(workspacePanes.includes('2d'));
  const specsOnly = $derived(workspacePanes.length === 1 && workspacePanes[0] === 'specs');
  let specsRequest = $state<{ tab: 'measurements' | 'bom' | 'techpack' | 'automation'; revision: number }>();
  let specsRequestRevision = 0;
  type Project3DCapture = {
    sourceStretchPolicy: Parameters<typeof capturedSourceStretchPolicy>[1];
    sourceAssemblyComplete: boolean | null;
    sourceGatherPolicy?: SourceGatherCacheMarker;
    sourceGatherIntent?: 'manual';
    savedByPiece: Record<string, number[]>;
    cameraPosition: [number, number, number];
    controlsTarget: [number, number, number];
    cameraFov: number;
    lightingMode: string;
    previewDataUrl: string | null;
  };
  let scene3d = $state<{ captureProjectState: () => Project3DCapture | null; beginCameraDocument: () => void } | null>(null);
  let leftTab = $state<StudioSidebar | 'collection'>('layers');
  let showRightPanel = $state(true);
  let showLeftPanel = $state(true);
  let workspaceWidth = $state(1280);
  const narrowWorkspace = $derived(workspaceWidth < 1024);
  let mobilePanel = $state<'left' | 'right' | null>(null);
  let showMoreActions = $state(false);
  let moreActionsTrigger: HTMLButtonElement;
  let moreActionsElement: HTMLDivElement;
  let showImportMenu = $state(false);
  let importMenuElement: HTMLDivElement;
  let importMenuTrigger: HTMLButtonElement;
  let showExportMenu = $state(false);
  let exportMenuElement: HTMLDivElement;
  let exportMenuTrigger: HTMLButtonElement;
  function finishExportActions() {
    showExportMenu = false;
    if (showMoreActions) closeMoreActions(true);
    else exportMenuTrigger?.focus({ preventScroll: true });
  }
  function closeMoreActions(restoreFocus = false) {
    showMoreActions = false;
    showExportMenu = false;
    if (moreActionsElement) moreActionsElement.scrollTop = 0;
    if (restoreFocus) moreActionsTrigger?.focus({ preventScroll: true });
  }
  let panelsBeforeFocus: { left: boolean; right: boolean } | null = null;
  let panelTrigger: HTMLElement | null = null;
  let leftPanelElement = $state<HTMLElement | null>(null);
  let rightPanelElement = $state<HTMLElement | null>(null);

  function openWorkspacePanel(side: 'left' | 'right') {
    if (narrowWorkspace) {
      if (showMoreActions && moreActionsElement.contains(document.activeElement)) {
        panelTrigger = moreActionsTrigger;
        closeMoreActions();
      } else panelTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      mobilePanel = side;
    } else if (side === 'left') showLeftPanel = true;
    else showRightPanel = true;
  }

  function closeWorkspacePanel(side?: 'left' | 'right') {
    if (narrowWorkspace) {
      mobilePanel = null;
      panelTrigger?.focus();
    } else if (side === 'left') showLeftPanel = false;
    else if (side === 'right') showRightPanel = false;
  }

  function toggleWorkspacePanel(side: 'left' | 'right') {
    if (narrowWorkspace) {
      if (mobilePanel === side) closeWorkspacePanel();
      else openWorkspacePanel(side);
    } else if (side === 'left') showLeftPanel = !showLeftPanel;
    else showRightPanel = !showRightPanel;
  }

  function handleWorkspacePanelKeydown(event: KeyboardEvent) {
    if (!narrowWorkspace || !mobilePanel) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeWorkspacePanel();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = mobilePanel === 'left' ? leftPanelElement : rightPanelElement;
    const controls = Array.from(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]') ?? [])
      .filter((control) => control.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  }

  $effect(() => {
    const panel = mobilePanel === 'left' ? leftPanelElement : mobilePanel === 'right' ? rightPanelElement : null;
    if (narrowWorkspace && panel) panel.querySelector<HTMLElement>('button, [tabindex="0"]')?.focus();
    if (!narrowWorkspace && mobilePanel) mobilePanel = null;
  });

  function applyWorkspaceView(mode: WorkspaceView) {
    const focused = (v: WorkspaceView) => v === '3d' || v === 'specs' || v === 'all';
    if (focused(mode) && !focused(viewMode)) {
      panelsBeforeFocus = { left: showLeftPanel, right: showRightPanel };
      showLeftPanel = false;
      showRightPanel = false;
    } else if (!focused(mode) && focused(viewMode) && panelsBeforeFocus) {
      showLeftPanel = panelsBeforeFocus.left;
      showRightPanel = panelsBeforeFocus.right;
      panelsBeforeFocus = null;
    }
    mobilePanel = null;
    viewMode = mode;
  }
  let patternName = $state('New Pattern');
  let labelDisplay = $state<'off' | 'billboard' | 'flat'>('flat'); // projected-on-fabric, like the source
  let showObjectBrowser = $state(false);
  let showShortcuts = $state(false);
  let showGrading = $state(false);
  let showAlterations = $state(false);

  function setViewMode(mode: WorkspaceView) {
    activeTask = null;
    applyWorkspaceView(mode);
    if (collaborationRole === 'viewer') { viewerViewOverride = true; return; }
    if (currentPattern.viewMode !== mode || currentPattern.workspaceLayout) {
      const updated = { ...($state.snapshot(currentPattern) as Pattern), viewMode: mode, workspaceLayout: undefined, hasChanged: true };
      if (currentPattern.workspaceLayout) pushUndo($state.snapshot(currentPattern) as Pattern, 'Choose workspace preset');
      currentPattern = updated;
      pattern.set(currentPattern);
      markUnsaved();
    }
  }

  function selectStudioTask(task: StudioTask) {
    if (frozenDiagnosticActive || documentLoading) return;
    const preset = studioTaskPreset(task);
    setViewMode(preset.view);
    leftTab = preset.sidebar;
    activeTask = task;
    if (task === 'cutting') showCuttingRoom = true;
    else if (task === 'production') specsRequest = { tab: 'techpack', revision: ++specsRequestRevision };
    else openWorkspacePanel('left');
  }

  const sidebarTabs = [
    { id: 'layers', label: 'Layers' }, { id: 'body', label: 'Body' },
    { id: 'materials', label: 'Fabric' }, { id: 'seams', label: 'Seams' },
    { id: 'colorways', label: 'Colorways' }, { id: 'artwork', label: 'Artwork' },
    { id: 'collection', label: 'Collection' }
  ] as const;

  function handleWorkspaceLayout(layout: WorkspaceLayout) {
    const valid = normalizeWorkspaceLayout(layout);
    if (!valid || mutationDisabled || documentLoading) return;
    const mode = layoutViewMode(valid);
    applyWorkspaceView(mode);
    handleDocumentUpdate({ ...($state.snapshot(currentPattern) as Pattern), workspaceLayout: valid, viewMode: mode }, 'Arrange workspace panes');
  }
  function openWorkspaceLayout() {
    if (frozenDiagnosticActive || documentLoading) return;
    handleWorkspaceLayout(customWorkspace ?? workspacePreset(viewMode));
    closeMoreActions();
  }
  function openTechPack() {
    setViewMode('specs');
    specsRequest = { tab: 'techpack', revision: ++specsRequestRevision };
    finishExportActions();
  }

  const workspaceActions: WorkspaceAction[] = [
    ...STUDIO_TASKS.map((task) => ({ id: `task.${task.id}`, label: `Open ${task.label} workflow`, keywords: [task.id, 'task'], run: () => selectStudioTask(task.id) })),
    { id: 'sharing.open', label: 'Open sharing and collaboration', keywords: ['share', 'chat', 'accounts'], run: () => { showSharing = true; } },
    { id: 'view.2d', label: 'Show 2D pattern view', keywords: ['draft', 'workspace'], run: () => setViewMode('2d') },
    { id: 'view.both', label: 'Show 2D and 3D together', keywords: ['both', 'split', 'workspace'], run: () => setViewMode('both') },
    { id: 'view.3d', label: 'Show 3D garment view', keywords: ['fit', 'workspace'], run: () => setViewMode('3d') },
    { id: 'view.specs', label: 'Show production Specs', keywords: ['measurements', 'bom', 'techpack'], run: () => setViewMode('specs') },
    { id: 'view.all', label: 'Show 2D, 3D and Specs together', keywords: ['all', 'workspace', 'techpack'], run: () => setViewMode('all') },
    { id: 'workspace.layout', label: 'Arrange workspace panes', keywords: ['dock', 'layout', 'move', 'workspace'], run: openWorkspaceLayout },
    { id: 'production.techpack', label: 'Open Tech Pack and production export', keywords: ['production', 'specifications', 'costing', 'pdf', 'csv'], run: openTechPack },
    { id: 'production.automation', label: 'Open production grading and approvals', keywords: ['grade', 'body chart', 'consumption', 'surface'], run: () => { setViewMode('specs'); specsRequest = { tab: 'automation', revision: ++specsRequestRevision }; } },
    ...(['layers', 'body', 'materials', 'seams', 'colorways', 'artwork', 'collection'] as const).map((tab) => ({
      id: `panel.${tab}`,
      label: `Open ${tab === 'materials' ? 'Fabric' : tab.charAt(0).toUpperCase() + tab.slice(1)} panel`,
      keywords: tab === 'materials' ? ['materials', 'texture'] : [tab],
      run: () => { leftTab = tab; openWorkspacePanel('left'); }
    })),
    { id: 'panel.properties', label: 'Open Properties panel', keywords: ['selection', 'inspector'], run: () => openWorkspacePanel('right') },
    { id: 'help.shortcuts', label: 'Show keyboard shortcuts', keywords: ['help', 'keys'], run: () => { showShortcuts = true; } }
  ];

  function restoreWorkspace(patternData: Pattern) {
    viewerViewOverride = false;
    const layout = normalizeWorkspaceLayout(patternData.workspaceLayout);
    applyWorkspaceView(layout ? layoutViewMode(layout) : patternData.viewMode ?? 'both');
    // A pattern that turns piece names off means it in 3D too — names baked across the cloth are
    // an aid on a garment and clutter on a lantern.
    labelDisplay = patternData.showPieceNames === false ? 'off' : 'flat';
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
    markUnsaved();
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
    markUnsaved();
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
    currentPattern = next; markUnsaved(); pattern.set(next);
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
    if ($page.url.searchParams.has('shared')) showSharing = true;
    const disposeCommandApi = installSeamerAutomation();
    const unsubscribeEditor = pattern.subscribe((next) => {
      if (JSON.stringify(next) !== JSON.stringify(currentPattern)) {
        if (next.viewMode !== currentPattern.viewMode || JSON.stringify(next.workspaceLayout) !== JSON.stringify(currentPattern.workspaceLayout)) restoreWorkspace(next);
        currentPattern = next;
        patternName = next.name;
        markUnsaved();
      }
    });
    // MCP pattern session: external agents read the snapshot we push on each /sync and queue ops —
    // full-pattern replacements land in the undo history as 'External edit', command ops run through
    // the same command bus as the palette / window.seamer.
    const disposeMcpSession = configureMcpSession({
      getPattern: getPatternSnapshot,
      applyPattern: (next) => handlePatternUpdate(next, 'External edit'),
      executeCommand: (name, payload) => { if (frozenDiagnosticActive) throw new Error('Exit the read-only diagnostic before editing.'); getPatternEditor().execute(name, payload); }
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
          validateDocumentExtensions(loaded);
          documentRevision += 1;
          currentPattern = loaded; patternName = loaded.name; restoreWorkspace(loaded);
          saved = true;
          pattern.set(currentPattern);
          // Editor restores this pattern's persisted undo/redo asynchronously.
          await restoreHistory(id);
        } else {
          toastError('Pattern not found');
        }
      } else {
        await loadTemplate(DEFAULT_STUDIO_TEMPLATE);
      }
    })().catch((error) => { toastError(error instanceof Error ? error.message : 'Could not open the document.'); }).finally(() => { documentLoading = false; });

    const startAutosave = (seconds: number) => {
      clearInterval(autoSaveTimer);
      autoSaveTimer = setInterval(async () => {
        if (saved || autosaving || mutationDisabled) return;
        autosaving = true;
        try {
          await persistCurrentPattern();
        } catch {
          if (!autosaveErrorShown) toastError('Autosave failed. Your edits are still unsaved; try Save again.');
          autosaveErrorShown = true;
        } finally {
          autosaving = false;
        }
      }, Math.max(2, seconds) * 1000);
    };
    startAutosave(get(autoSaveSeconds));
    const unsubAutosave = autoSaveSeconds.subscribe((s) => startAutosave(s));

    const handler = (e: BeforeUnloadEvent) => { if (!saved) e.preventDefault(); };
    window.addEventListener('beforeunload', handler);

    return () => { clearInterval(autoSaveTimer); unsubAutosave(); unsubscribeEditor(); window.removeEventListener('beforeunload', handler); disposeCommandApi(); disposeMcpSession(); };
  });

  function handlePatternUpdate(updated: Pattern, label = 'Edit') {
    if (mutationDisabled || documentLoading) return;
    validateDocumentExtensions(updated);
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
    if (!alterationEdit) updated = syncLinkedMirrorPlacements(syncLinkedPaths(updated));
    currentPattern = updated; markUnsaved(); pattern.set(updated);
  }

  /** Appearance and production edits preserve the drafting graph and its solved metadata. */
  function handleDocumentUpdate(updated: Pattern, label = 'Edit document') {
    if (mutationDisabled || documentLoading) return;
    try {
      const snapshot = synchronizeLinkedDraft($state.snapshot(currentPattern) as Pattern, $state.snapshot(updated) as Pattern);
      validateDocumentExtensions(snapshot);
      if (JSON.stringify(getPatternEditor().content) === JSON.stringify(snapshot)) return;
      pushUndo($state.snapshot(currentPattern) as Pattern, label);
      pattern.set({ ...snapshot, hasChanged: true });
    } catch (error) { toastError(error instanceof Error ? error.message : 'Could not apply this document edit.'); }
  }

  function receiveSharedDocument(updated: Pattern, source = 'remote') {
    if (frozenDiagnosticActive || documentLoading) return false;
    const snapshot = normalizePattern($state.snapshot(updated) as Pattern);
    assertPatternBuildable3d(snapshot);
    const changedDocument = snapshot.id !== currentPattern.id;
    if (changedDocument) scene3d?.beginCameraDocument();
    adoptPatternSnapshot(snapshot, { clearHistory: source !== 'local' });
    patternName = snapshot.name;
    restoreWorkspace(snapshot);
    if (changedDocument) syncPatternRoute(snapshot.id);
    return true;
  }

  function handleDetachedUpdate(updated: Pattern, label = 'Edit detached document') {
    if (draftingFingerprint(updated) !== draftingFingerprint(currentPattern)) handlePatternUpdate(updated, label);
    else handleDocumentUpdate(updated, label);
  }

  async function openSavedPattern(id: string) {
    if (frozenDiagnosticActive || documentLoading) return;
    const operation = savedDocumentOperations.begin();
    try {
      if (!saved && collaborationRole !== 'viewer') await persistCurrentPattern();
      if (!operation.isCurrent()) return;
      const loaded = await loadPattern(id);
      if (!operation.isCurrent()) return;
      if (!loaded) throw new Error('Saved pattern no longer exists on this device.');
      if (!receiveSharedDocument(loaded, 'local')) return;
      collaborationRole = null;
      handleSharedDocumentIdentity(null);
      const restoring = restoreHistory(id);
      const finishCurrent = operation.captureCurrent();
      await restoring;
      if (!finishCurrent()) return;
      syncPatternRoute(id);
      saved = true;
    } catch (error) { if (operation.isCurrent()) toastError(error instanceof Error ? error.message : 'Could not open saved pattern.'); }
  }

  function captureConstructionView() {
    const dataUrl = scene3d?.captureProjectState()?.previewDataUrl;
    return dataUrl ? { dataUrl, label: '3D garment view' } : null;
  }

  // Cache the latest user-run drape for reopening. A saved checkpoint does not certify fit
  // or seam closure. Not an undo-able user edit, so
  // no pushUndo; savedPositions isn't in the 3D patternKey, so this won't trigger a re-drape. Mark
  // unsaved and let the 5s autosave (or an explicit save) write it.
  function handleDrapeSettled(savedByPiece: Record<string, number[]>, sourceStretchPolicy: Parameters<typeof capturedSourceStretchPolicy>[1], sourceAssemblyComplete: boolean | null, sourceGatherPolicy?: SourceGatherCacheMarker, sourceGatherIntent?: 'manual') {
    if (mutationDisabled || documentLoading) return;
    let changed = false;
    const compatible = compatibleSourceBodyCheckpoint(currentPattern);
    const pieces = currentPattern.pieces.map((p, index) => {
      const sp = savedByPiece[p.id];
      if (!sp) return p;
      changed = true;
      return { ...p, settings3d: { ...p.settings3d, savedPositions: sp,
        ...(currentPattern.garmentCodeSource ? { savedDrapeState: compatible.pieces[index].settings3d.savedDrapeState === 'held' ? 'held' as const : 'checkpoint' as const,
          savedBodyFitRevision: SOURCE_BODY_FIT_REVISION, savedAssemblyRevision: GARMENT_CODE_ASSEMBLY_REVISION,
          savedSourceStretchPolicy: capturedSourceStretchPolicy(p.id, sourceStretchPolicy),
          savedSourceGatherPolicy: sourceGatherPolicy, savedSourceGatherIntent: sourceGatherIntent, savedSourceAssemblyComplete: capturedSourceAssemblyComplete(p.id, sourceStretchPolicy, sourceAssemblyComplete) } : {}) } };
    });
    if (!changed) return;
    currentPattern = { ...currentPattern, pieces };
    pattern.set(currentPattern);
    markUnsaved();
  }

  // Camera write-back from the 3D view (debounced upstream). Not an undo-able edit — like a
  // settled drape, it just persists so reload restores the same view.
  function handleCameraChange(pos: [number, number, number], target: [number, number, number], fov: number) {
    if (mutationDisabled) return;
    currentPattern = { ...currentPattern, settings3d: { ...currentPattern.settings3d, cameraPosition: pos, controlsTarget: target, cameraFov: fov, sourceCameraFraming: undefined } };
    pattern.set(currentPattern);
    markUnsaved();
  }

  async function handleSave() {
    if (mutationDisabled) return;
    const camera = currentPattern.settings3d.sourceCameraFraming ? scene3d?.captureProjectState() : null;
    if (camera) currentPattern = { ...currentPattern, settings3d: { ...currentPattern.settings3d,
      cameraPosition: camera.cameraPosition, controlsTarget: camera.controlsTarget,
      cameraFov: camera.cameraFov, sourceCameraFraming: undefined } };
    // refresh the list thumbnail from the live 2D geometry (best effort — null keeps the old one)
    const thumb = patternThumbnail($state.snapshot(currentPattern) as Pattern);
    currentPattern = { ...currentPattern, name: patternName, thumbnailUrl: thumb ?? currentPattern.thumbnailUrl ?? null };
    pattern.set(currentPattern);
    markUnsaved();
    try {
      const receipt = await persistCurrentPattern();
      saveCount += 1;
      if (receipt.isCurrent(currentPattern.id, documentRevision)) toastSuccess('Pattern saved');
    } catch {
      toastError('Could not save the pattern. Your edits are still unsaved.');
    }
  }

  /** Keep refresh/deep links attached to the document currently shown in the editor. */
  function syncPatternRoute(patternId: string) {
    const url = new URL($page.url);
    if ($page.params.slug?.split('/')[0] !== patternId) url.pathname = `${base}/studio/${encodeURIComponent(patternId)}`;
    if (activeSharedDocumentId) url.searchParams.set('shared', activeSharedDocumentId);
    else url.searchParams.delete('shared');
    if (url.href !== $page.url.href) replaceState(`${url.pathname}${url.search}${url.hash}`, {});
  }
  function handleSharedDocumentIdentity(id: string | null) {
    activeSharedDocumentId = id;
    syncPatternRoute(currentPattern.id);
  }
  function leaveSharedDocument() {
    savedDocumentOperations.invalidate();
    collaborationRole = null;
    if (!frozenDiagnosticActive) setDocumentMutationLock(null);
    handleSharedDocumentIdentity(null);
  }

  async function handleExport() {
    if (frozenDiagnosticActive) return;
    const blob = new Blob([JSON.stringify(currentPattern, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `${patternName.replace(/\s+/g, '_')}.seamer.json`; a.click(); URL.revokeObjectURL(url);
    finishExportActions();
  }

  function exportAs(fmt: 'svg' | 'svg2' | 'dxf' | 'csv') {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    if (fmt === 'svg') downloadText(`${base}.svg`, patternToSVG(currentPattern), 'image/svg+xml');
    else if (fmt === 'svg2') downloadText(`${base}.svg`, patternToSVG2(currentPattern), 'image/svg+xml');
    else if (fmt === 'dxf') downloadText(`${base}.dxf`, patternToDXF(currentPattern), 'application/dxf');
    else downloadText(`${base}.csv`, patternToCSV(currentPattern), 'text/csv');
    finishExportActions();
    toastSuccess(`Exported ${fmt === 'svg2' ? 'SVG 2' : fmt.toUpperCase()}`);
  }

  async function exportPNG() {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    const blob = await patternToPNG(currentPattern);
    if (!blob) { toastError('Nothing to export'); return; }
    downloadBlob(`${base}.png`, blob);
    finishExportActions();
    toastSuccess('Exported PNG');
  }
  async function exportHPGL() {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    try {
      downloadText(`${base}.hpgl`, await patternToHPGL(currentPattern), 'application/vnd.hp-hpgl');
      finishExportActions();
      toastSuccess('Exported HPGL');
    } catch (e) { toastError('HPGL export failed'); }
  }
  // Body measurements as SeamlyMe individual measurements (open in SeamlyMe / Seamly2D).
  async function exportSeamlyMe() {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    try {
      downloadText(`${base}.smis`, await bodyToSeamlyMe(currentPattern.body), 'application/xml');
      finishExportActions();
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
    finishExportActions();
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

  async function convertImportedJson(raw: unknown, name?: string): Promise<Pattern> {
    validateDocumentExtensions(raw);
    if (isGarmentCodeFormat(raw)) return convertGarmentCodePattern(raw, name);
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
    return convertImportedJson(raw, name);
  }

  async function loadGarmentCodeExample(file: string, label: string, signal?: AbortSignal) {
    const response = await fetch(`${base}/examples/garmentcode/${file}`, { signal });
    if (!response.ok) throw new Error('The GarmentCode example is unavailable.');
    const specification = await response.json();
    if (signal?.aborted) return;
    await applyImported(convertGarmentCodePattern(specification, label));
  }

  async function applyGeneratedGarmentCode(specification: unknown, request: GarmentCodeRequest) {
    const label = GARMENTCODE_PRESETS.find(preset => preset.id === request.preset)?.label ?? request.preset;
    const generated = convertGarmentCodePattern(specification, `GarmentCode ${label}`);
    if (generated.garmentCodeSource) generated.garmentCodeSource.generation = structuredClone(request);
    const imperial = currentPattern.body.unitType !== 'metric';
    const fields = Object.fromEntries(Object.entries(currentPattern.body.fields).map(([key, value]) => [key,
      imperial && unitKind(key) === 'weight' ? value * 0.453592 : imperial && unitKind(key) === 'length' ? value * 2.54 : value
    ]));
    const sourceMeasurements = generated.body.garmentCodeBody?.measurementsCm;
    const mappings = { height: 'height', bust: 'chestGirth', waist: 'waistGirth', hips: 'hipGirth', arm_length: 'armLength' };
    for (const [key, target] of Object.entries(mappings)) {
      const value = sourceMeasurements?.[key] ?? request.body[key];
      if (Number.isFinite(value)) fields[target] = value;
    }
    const body = { ...currentPattern.body, unitType: 'metric', fields, useLegacyDefaultAvatar: false, garmentCodeBody: undefined };
    generated.body = sourceMeasurements ? attachGarmentCodeBody(body, sourceMeasurements) : body;
    const gatherProvenance = await sourceGatherRegistry.register(specification, generated, {
      origin: 'trusted-generator-response', ...PINNED_GATHER_PROGRAMS
    });
    if (gatherProvenance && generated.garmentCodeSource) {
      generated.garmentCodeSource.gatherProvenance = gatherProvenance;
      generated.garmentCodeSource.gatherSourceDocument = encodeOriginalGatherDocument(specification);
    }
    await applyImported(generated);
  }

  async function applyImported(data: Pattern) {
    if (frozenDiagnosticActive) return;
    validateDocumentExtensions(data);
    // Build the candidate cloth topology before touching canonical editor state. A failed import
    // therefore leaves both the 2D document and the renderer on the same last-valid pattern.
    assertPatternBuildable3d(data);
    if (!documentLoading) leaveSharedDocument();
    scene3d?.beginCameraDocument();
    currentPattern = data;
    patternName = data.name;
    restoreWorkspace(data);
    pattern.set(data);
    markUnsaved();
    syncPatternRoute(data.id);
    toastSuccess(`Imported "${data.name}"`);
    if (showImportMenu) {
      showImportMenu = false;
      importMenuTrigger?.focus({ preventScroll: true });
    }

    // An import opens/replaces a document; it must not inherit the previous document's undo stack.
    // Clearing an existing stack for the same id is important when re-importing a corrected legacy
    // project, otherwise the old local history can restore data that the new import replaced.
    await clearPersistedHistory(data.id);
    if (currentPattern.id === data.id) await restoreHistory(data.id);
  }

  function applyRestoredVersion(data: Pattern) {
    validateDocumentExtensions(data);
    // A version restore stays in the same document and should be undoable; unlike a file import it
    // neither changes the route nor discards the document's history.
    assertPatternBuildable3d(data);
    patternName = data.name;
    restoreWorkspace(data);
    handlePatternUpdate(data, 'Restore version');
  }

  let rawSourceImportRevision=0;
  function handleImport() {
    const revision=++rawSourceImportRevision,capturedDocument=currentPattern,documentBefore=JSON.stringify($state.snapshot(currentPattern));
    const stillCurrent=()=>revision===rawSourceImportRevision&&!frozenDiagnosticActive&&currentPattern===capturedDocument&&JSON.stringify($state.snapshot(currentPattern))===documentBefore;
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
        let imported:Pattern|null=await parseImport(text, ext, name),explicitGatherImport=false;
        if(!['dxf','svg','cut','val','sm2d','xml'].includes(ext??'')) {
          const raw=JSON.parse(text);
          explicitGatherImport=isGarmentCodeFormat(raw)&&raw.properties?.garmentcode_gather_evidence!==undefined;
          imported=await importExplicitSourceGather(raw,imported,{stillCurrent,confirmImport:confirm});
        }
        if(imported){
          if(explicitGatherImport&&!stillCurrent())throw Error('The document changed during source import. Choose the file again.');
          await applyImported(imported);
        }
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
          currentPattern = next; pushUndo($state.snapshot(currentPattern) as Pattern, 'Import background image'); pattern.set(next); markUnsaved();
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
    if (frozenDiagnosticActive) return;
    try {
      let project = structuredClone($state.snapshot(currentPattern) as Pattern);
      const capture = scene3d?.captureProjectState() ?? null;
      if (capture) {
        const compatible = compatibleSourceBodyCheckpoint(project);
        project = {
          ...project,
          pieces: project.pieces.map((piece, index) => ({
            ...piece,
            settings3d: {
              ...piece.settings3d,
              savedPositions: capture.savedByPiece[piece.id] ?? piece.settings3d.savedPositions,
              ...(project.garmentCodeSource && capture.savedByPiece[piece.id] ? { savedDrapeState: compatible.pieces[index].settings3d.savedDrapeState === 'held' ? 'held' as const : 'checkpoint' as const,
                savedBodyFitRevision: SOURCE_BODY_FIT_REVISION, savedAssemblyRevision: GARMENT_CODE_ASSEMBLY_REVISION,
                savedSourceStretchPolicy: capturedSourceStretchPolicy(piece.id, capture.sourceStretchPolicy),
                savedSourceGatherPolicy: capture.sourceGatherPolicy, savedSourceGatherIntent: capture.sourceGatherIntent, savedSourceAssemblyComplete: capturedSourceAssemblyComplete(piece.id, capture.sourceStretchPolicy, capture.sourceAssemblyComplete) } : {})
            }
          })),
          settings3d: {
            ...project.settings3d,
            cameraPosition: capture.cameraPosition,
            controlsTarget: capture.controlsTarget,
            cameraFov: capture.cameraFov,
            sourceCameraFraming: undefined,
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
      finishExportActions();
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
    leaveSharedDocument();
    pushUndo($state.snapshot(currentPattern) as Pattern, 'New pattern');
    currentPattern = { ...structuredClone(EMPTY_PATTERN), id: crypto.randomUUID(), versionId: crypto.randomUUID() }; patternName = 'New Pattern'; restoreWorkspace(currentPattern); pattern.set(currentPattern); markUnsaved();
    toastSuccess('Scene cleared');
  }

  /** Fill any arrays/fields a template may omit, so all components can render it safely. */
  function normalizePattern(data: Pattern): Pattern {
    validateDocumentExtensions(data);
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
    leaveSharedDocument();
    currentPattern = data;
    patternName = data.name;
    restoreWorkspace(data);
    pattern.set(data);
    await restoreHistory(data.id);
    markUnsaved();
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
      if (!documentLoading) leaveSharedDocument();
      currentPattern = data; patternName = tpl.name || data.name; restoreWorkspace(data); pattern.set(data); markUnsaved(); await restoreHistory(data.id);
    } catch {
      if (!documentLoading) leaveSharedDocument();
      currentPattern = { ...structuredClone(EMPTY_PATTERN), id: crypto.randomUUID(), versionId: crypto.randomUUID(), name: tpl.name, description: tpl.description, enable3d: true, viewMode: 'both' };
      patternName = tpl.name; restoreWorkspace(currentPattern); pattern.set(currentPattern); markUnsaved(); await restoreHistory(currentPattern.id);
    }
  }

  function handlePieceSelect(id: string | null) {
    // Avoid redundant 3D highlight work when this is already the exact cross-view selection.
    const cur = pieceIds;
    if ((id ? cur.size === 1 && cur.has(id) : cur.size === 0) && pointIds.size === 0 && pathIds.size === 0 && selection.get('seam').size === 0 && selection.get('text').size === 0) return;
    setSelection((current) => current.replace('piece', id ? [id] : []).clear('point').clear('path').clear('seam').clear('text'));
  }

  function handleUndo() { const prev = undo($state.snapshot(currentPattern) as Pattern); if (prev) { currentPattern = prev; patternName = prev.name; restoreWorkspace(prev); pattern.set(prev); markUnsaved(); } }
  function handleRedo() { const next = redo($state.snapshot(currentPattern) as Pattern); if (next) { currentPattern = next; patternName = next.name; restoreWorkspace(next); pattern.set(next); markUnsaved(); } }

  function handleKeydown(e: KeyboardEvent) {
    if (mutationDisabled || documentLoading) return;
    if (isAppShortcutBlocked(e)) return;
    if (matchesShortcut(e, 'undo')) { e.preventDefault(); handleUndo(); }
    if (matchesShortcut(e, 'redo')) { e.preventDefault(); handleRedo(); }
    if (matchesShortcut(e, 'save')) { e.preventDefault(); handleSave(); }
    if (matchesShortcut(e, 'palette')) { e.preventDefault(); showCommandPalette = !showCommandPalette; }
    if (matchesShortcut(e, 'properties')) { e.preventDefault(); toggleWorkspacePanel('right'); }
    if (matchesShortcut(e, 'layers')) {
      e.preventDefault();
      if ((narrowWorkspace ? mobilePanel === 'left' : showLeftPanel) && leftTab === 'layers') closeWorkspacePanel('left');
      else { openWorkspacePanel('left'); leftTab = 'layers'; }
    }
    if (matchesShortcut(e, 'variables')) {
      e.preventDefault(); openWorkspacePanel('right'); panelRequest.set({ section: 'sizes' });
    }
    if (matchesShortcut(e, 'help')) { e.preventDefault(); showShortcuts = !showShortcuts; }
    if (specsOnly || isDocumentKeyboardTarget(e.target)) return;
    if (matchesShortcut(e, 'duplicate')) { e.preventDefault(); duplicateSelectedPiece(); }
    if (matchesShortcut(e, 'copy')) { e.preventDefault(); handleCopy(); }
    if (matchesShortcut(e, 'paste') || matchesShortcut(e, 'pasteCopy')) { e.preventDefault(); handlePaste(e.shiftKey); }
    // The scene handles its own keys. It leaves M unconsumed for a selected
    // pattern's mirror command when it is not arranging pieces.
    const selectedMirror = (matchesShortcut(e, 'mirrorX') || matchesShortcut(e, 'mirrorY')) && (pointIds.size || pathIds.size || pieceIds.size);
    if (!e.metaKey && !e.ctrlKey && scene3dOwnsKeyboard() && !selectedMirror) return;
    // Selection batch transforms (no modifier): arrows nudge, [ ] rotate, < > scale, M mirror.
    {
      const hasSel = pointIds.size || pathIds.size || pieceIds.size;
      if (hasSel && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const step = e.shiftKey ? 10 : 1;
        const move = (dx: number, dy: number) => { e.preventDefault(); window.seamer?.execute('selection.move', { dx, dy }); };
        if (matchesShortcut(e, 'nudgeLeft') || matchesShortcut(e, 'nudgeLeftLarge')) move(-step, 0);
        else if (matchesShortcut(e, 'nudgeRight') || matchesShortcut(e, 'nudgeRightLarge')) move(step, 0);
        else if (matchesShortcut(e, 'nudgeUp') || matchesShortcut(e, 'nudgeUpLarge')) move(0, -step);
        else if (matchesShortcut(e, 'nudgeDown') || matchesShortcut(e, 'nudgeDownLarge')) move(0, step);
        else if (matchesShortcut(e, 'rotateLeft')) { e.preventDefault(); window.seamer?.execute('selection.rotate', { degrees: -15 }); }
        else if (matchesShortcut(e, 'rotateRight')) { e.preventDefault(); window.seamer?.execute('selection.rotate', { degrees: 15 }); }
        else if (matchesShortcut(e, 'mirrorX') || matchesShortcut(e, 'mirrorY')) { e.preventDefault(); window.seamer?.execute('selection.mirror', { axis: e.shiftKey ? 'y' : 'x' }); }
      }
    }
    if (matchesShortcut(e, 'remove')) {
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

<svelte:window bind:innerWidth={workspaceWidth}
  onpointerdown={(event) => {
    if (!(event.target instanceof Element)) return;
    if (showExportMenu && !exportMenuElement.contains(event.target)) showExportMenu = false;
    if (showImportMenu && !importMenuElement.contains(event.target)) showImportMenu = false;
    if (!narrowWorkspace || !showMoreActions) return;
    if (!moreActionsElement.contains(event.target) && !moreActionsTrigger.contains(event.target)
      && !event.target.closest('dialog, [role="dialog"]')) closeMoreActions();
  }}
  onkeydown={(event) => {
    if (showImportMenu && event.key === 'Escape') {
      event.preventDefault(); showImportMenu = false; importMenuTrigger?.focus({ preventScroll: true });
    } else if (showExportMenu && event.key === 'Escape') {
      event.preventDefault(); showExportMenu = false; exportMenuTrigger?.focus({ preventScroll: true });
    } else if (narrowWorkspace && showMoreActions && event.key === 'Escape' && event.target instanceof Node
      && (moreActionsElement.contains(event.target) || event.target === moreActionsTrigger)) {
      event.preventDefault(); closeMoreActions(true);
    }
    handleWorkspacePanelKeydown(event); if (!event.defaultPrevented) handleKeydown(event);
  }} />

{#snippet draftView()}
  <div class="studio-canvas flex-1 min-w-0 min-h-0 relative" data-tour-id="tour-canvas-2d" inert={mutationDisabled}>{#key $patternEditor}<PatternCanvas2D {currentPattern} editor={$patternEditor} onchange={handlePatternUpdate} ondocumentchange={handleDocumentUpdate} />{/key}</div>
{/snippet}
{#snippet garmentView()}
  <div class="studio-canvas flex-1 min-w-0 min-h-0 relative" data-tour-id="tour-canvas-3d"><PatternScene3D readOnly={collaborationRole === 'viewer'} onfrozendiagnosticchange={handleFrozenDiagnostic} bind:this={scene3d} {currentPattern} selectedPieceId={[...pieceIds][0] ?? null} onpieceselect={handlePieceSelect} ondrapesettled={handleDrapeSettled} onpatternupdate={handlePatternUpdate} ondocumentchange={handleDocumentUpdate} oncamerachange={handleCameraChange} {labelDisplay} onlabeldisplaychange={(v) => (labelDisplay = v)} /></div>
{/snippet}
{#snippet specsView()}
  <div class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden" inert={frozenDiagnosticActive}>
    {#if specsOnly}<div class="px-2 py-1 border-b"><button class="btn btn-ghost btn-xs" onclick={() => setViewMode('all')}>Show 2D + 3D + Specs</button></div>{/if}
    <div class="flex-1 min-h-0"><SpecsPanel pattern={currentPattern} readOnly={collaborationRole === 'viewer'} onchange={handleDocumentUpdate} request={specsRequest} captureView={workspacePanes.includes('3d') ? captureConstructionView : undefined} /></div>
  </div>
{/snippet}
{#snippet designViews()}
  <WorkspaceSplit disabled={frozenDiagnosticActive}>
    {#snippet first()}{@render draftView()}{/snippet}
    {#snippet second()}{@render garmentView()}{/snippet}
  </WorkspaceSplit>
{/snippet}

<div class="studio-shell flex flex-col h-screen overflow-hidden" inert={documentLoading} aria-busy={documentLoading} data-testid="studio-workspace">
  <div inert={frozenDiagnosticActive} class="studio-topbar flex items-center justify-between px-3 py-1.5 bg-base-200 border-b shrink-0">
    <div class="studio-home flex items-center gap-2">
      <a href="{base}/" class="btn btn-ghost btn-xs" aria-label="Back to patterns">&larr;</a>
      <span class="text-sm font-lexend font-semibold hidden lg:inline">Pattern Studio</span>
    </div>
    <div class="studio-document flex items-center gap-2">
      <input disabled={mutationDisabled} type="text" aria-label="Pattern name" class="input input-bordered input-xs w-40 lg:w-56" placeholder="Pattern name..." bind:value={patternName}
        oninput={(e) => { currentPattern = { ...currentPattern, name: e.currentTarget.value }; pattern.set(currentPattern); markUnsaved(); }}
        data-testid="pattern-name-input" />
      <PatternLibrary {draftingTemplates} ontemplate={(key) => { void loadTemplate(key); }}
        ongarmentcode={() => (showGarmentCode = true)} onglobe={() => (showGlobeLantern = true)}
        onexample={async (file, label) => {
          try { await loadGarmentCodeExample(file, label); }
          catch (error) { toastError(error instanceof Error ? error.message : 'Could not open the garment.'); }
        }}
        onopenpattern={(id) => { void openSavedPattern(id); }}
        oncollection={() => { leftTab = 'collection'; openWorkspacePanel('left'); }}
        onfabric={() => { leftTab = 'materials'; openWorkspacePanel('left'); }} />
      <div class="studio-view-mode join join-horizontal" role="group" aria-label="Workspace view" data-tour-id="tour-view-mode">
        <button class="join-item btn btn-xs" class:btn-active={viewMode === '2d'} aria-pressed={viewMode === '2d'} onclick={() => setViewMode('2d')}>2D</button>
        <button class="join-item btn btn-xs" class:btn-active={viewMode === 'both'} aria-pressed={viewMode === 'both'} onclick={() => setViewMode('both')}>Both</button>
        <button class="join-item btn btn-xs" class:btn-active={viewMode === '3d'} aria-pressed={viewMode === '3d'} onclick={() => setViewMode('3d')}>3D</button>
        <button class="join-item btn btn-xs" class:btn-active={viewMode === 'specs'} aria-pressed={viewMode === 'specs'} onclick={() => setViewMode('specs')}>Specs</button>
        <button class="join-item btn btn-xs hidden sm:inline-flex" class:btn-active={viewMode === 'all'} aria-pressed={viewMode === 'all'} onclick={() => setViewMode('all')}>All</button>
      </div>
    </div>
    <div class="studio-actions flex items-center gap-1">
      <div class="dropdown dropdown-end" bind:this={importMenuElement} class:dropdown-open={showImportMenu}
        onfocusout={(event) => { if (event.relatedTarget instanceof Node && !importMenuElement.contains(event.relatedTarget)) showImportMenu = false; }}>
        <button class="btn btn-ghost btn-xs" data-testid="import-menu-trigger" bind:this={importMenuTrigger}
          aria-expanded={showImportMenu} aria-controls="studio-import-menu" onclick={() => showImportMenu = !showImportMenu}>Import</button>
        {#if showImportMenu}
        <ul id="studio-import-menu" class="dropdown-content menu bg-base-200 rounded-box z-50 w-60 p-2 shadow text-sm">
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
          <li class="menu-title pt-2">GarmentCode examples</li>
          {#each GARMENTCODE_EXAMPLES as example}
            <li><button data-testid={`garmentcode-example-${example.file}`} onclick={async () => {
              try { await loadGarmentCodeExample(example.file, example.label); }
              catch (error) { toastError(error instanceof Error ? error.message : 'Could not open the garment.'); }
            }}>{example.label}</button></li>
          {/each}
        </ul>
        {/if}
      </div>
      <button disabled={mutationDisabled} class="btn btn-xs" class:btn-accent={!saved} class:btn-ghost={saved} onclick={handleSave} data-tour-id="tour-save">{saved ? 'Saved' : 'Save'}</button>
      <button class="btn btn-ghost btn-xs" onclick={(e) => { e.currentTarget.focus(); toggleWorkspacePanel('left'); }} title="Toggle layers and body panel" aria-label="Layers and body panel" aria-expanded={(narrowWorkspace ? mobilePanel === 'left' : showLeftPanel) ? 'true' : 'false'} aria-controls="studio-left-panel"><span class="studio-desktop-label" aria-hidden="true">&#x2630;</span><span class="studio-mobile-label">Panels</span></button>
      <button class="studio-fabric-toggle btn btn-ghost btn-xs" aria-label="Fabric" onclick={(event) => { event.currentTarget.focus(); leftTab = 'materials'; openWorkspacePanel('left'); }}>Fabric</button>
      <button class="studio-more-toggle btn btn-ghost btn-xs" bind:this={moreActionsTrigger} aria-expanded={showMoreActions} aria-controls="studio-more-actions" onclick={() => showMoreActions = !showMoreActions}>More</button>
      <div id="studio-more-actions" class="studio-more-actions" bind:this={moreActionsElement} class:expanded={showMoreActions}>
      <div class="studio-mobile-actions-heading"><strong>Studio actions</strong><button class="btn btn-ghost btn-xs" aria-label="Close studio actions" onclick={() => closeMoreActions(true)}>Close ✕</button></div>
      <div class="studio-landscape-actions">
        <button class="btn btn-ghost btn-xs" aria-label="Layers and body panel" aria-controls="studio-left-panel"
          aria-expanded={mobilePanel === 'left'} onclick={(event) => { event.currentTarget.focus(); toggleWorkspacePanel('left'); }}>Panels</button>
        <button class="btn btn-ghost btn-xs" aria-label="Fabric" onclick={(event) => { event.currentTarget.focus(); leftTab = 'materials'; openWorkspacePanel('left'); }}>Fabric</button>
      </div>
      <TaskWorkflowBar placement="menu" active={activeTask} disabled={frozenDiagnosticActive} onselect={(task) => {
        selectStudioTask(task);
        if (showMoreActions) closeMoreActions(true);
      }} />
      <button class="btn btn-ghost btn-xs" aria-label="Undo" onclick={handleUndo} disabled={mutationDisabled || !$undoLabel} title={$undoLabel ? `Undo ${$undoLabel} (Ctrl+Z)` : 'Nothing to undo'}>&#x21A9;</button>
      <button class="btn btn-ghost btn-xs" aria-label="Redo" onclick={handleRedo} disabled={mutationDisabled || !$redoLabel} title={$redoLabel ? `Redo ${$redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}>&#x21AA;</button>
      <div class="dropdown dropdown-end" bind:this={exportMenuElement} class:dropdown-open={showExportMenu}
        onfocusout={(event) => { if (!(event.relatedTarget instanceof Node) || !exportMenuElement.contains(event.relatedTarget)) showExportMenu = false; }}>
        <button class="btn btn-ghost btn-xs" bind:this={exportMenuTrigger} aria-expanded={showExportMenu}
          aria-controls="studio-export-menu" onclick={() => showExportMenu = !showExportMenu}>Export</button>
        {#if showExportMenu}
        <ul id="studio-export-menu" class="dropdown-content menu bg-base-200 rounded-box z-50 w-72 p-2 shadow text-sm">
          <li><button onclick={handleExport}>JSON (.seamer.json)</button></li>
          <li><button onclick={exportSSP}>Seamer Project — 2D + 3D (.ssp)</button></li>
          <li><button onclick={openTechPack}>Tech Pack…</button></li>
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
        {/if}
      </div>
      <button class="btn btn-ghost btn-xs" onclick={handleNew}>New</button>
      <button class="btn btn-ghost btn-xs" onclick={openWorkspaceLayout} aria-label="Workspace layout">Layout</button>
      <button class="btn btn-ghost btn-xs" onclick={(e) => { e.currentTarget.focus(); toggleWorkspacePanel('right'); }} title="Toggle properties panel" aria-label="Properties panel" aria-expanded={(narrowWorkspace ? mobilePanel === 'right' : showRightPanel) ? 'true' : 'false'} aria-controls="studio-right-panel"><span class="studio-desktop-label" aria-hidden="true">&#x25B6;</span><span class="studio-mobile-label">Properties</span></button>

      <button class="btn btn-xs" aria-label="Object browser" class:btn-active={showObjectBrowser} onclick={() => showObjectBrowser = !showObjectBrowser} title="Toggle object browser" data-testid="object-browser-toggle">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">view_list</span>
      </button>
      {#key $patternEditor}<ErrorsPanel {currentPattern} editor={$patternEditor} />{/key}
      <HistoryMenu onundo={(n) => { for (let i = 0; i < n; i++) handleUndo(); }} onredo={handleRedo} />
      <button class="btn btn-ghost btn-xs" onclick={() => showVersions = true} title="Version history" aria-label="Version history">
        <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">history</span>
      </button>
      <ThemeToggle size="xs" />
      <button class="btn btn-ghost btn-xs" onclick={(e) => { e.currentTarget.focus(); showSettings = true; }} title="Settings" aria-label="Settings">
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
      <button class="btn btn-ghost btn-xs" onclick={() => { showSharing = true; closeMoreActions(); }} aria-label="Share document">Share</button>
      <DetachedPaneControls pattern={currentPattern} readonly={mutationDisabled} onchange={handleDetachedUpdate} onundo={handleUndo} onredo={handleRedo} />
      </div>
    </div>
  </div>

  <TaskWorkflowBar active={activeTask} disabled={frozenDiagnosticActive} onselect={selectStudioTask} />
  <div class="studio-workspace flex-1 flex overflow-hidden">
    {#if narrowWorkspace && mobilePanel}
      <button class="studio-panel-backdrop" aria-label="Close panel" tabindex="-1" onclick={() => closeWorkspacePanel()}></button>
    {/if}
    {#if showLeftPanel || mobilePanel === 'left'}
      <aside inert={frozenDiagnosticActive} id="studio-left-panel" bind:this={leftPanelElement} class="studio-left-panel w-56 border-r bg-base-100 flex flex-col shrink-0 overflow-hidden" class:mobile-open={mobilePanel === 'left'} role={narrowWorkspace ? 'dialog' : undefined} aria-modal={narrowWorkspace && mobilePanel === 'left' ? true : undefined} aria-label="Layers, body, fabric and seams" data-tour-id="tour-left-panel">
        <div class="studio-drawer-header border-b px-2 bg-base-200">
          <span class="font-semibold text-sm">Pattern panels</span>
          <button class="btn btn-ghost btn-xs" aria-label="Close pattern panels" onclick={() => closeWorkspacePanel('left')}>✕</button>
        </div>
        <SidebarTabs tabs={sidebarTabs} active={leftTab} onchange={(tab) => { leftTab = tab as typeof leftTab; }} />
        <div inert={mutationDisabled} class="flex-1 overflow-y-auto p-2" role="tabpanel" id={`studio-sidebar-panel-${leftTab}`} aria-labelledby={`studio-sidebar-tab-${leftTab}`} tabindex="0">
          {#if leftTab === 'layers'}<LayerPanel {currentPattern} onchange={handlePatternUpdate} />
          {:else if leftTab === 'body'}<BodyPanel {currentPattern} onchange={handlePatternUpdate} />
          {:else if leftTab === 'materials'}<MaterialPanel {currentPattern} selectedPieceIds={[...pieceIds]} onchange={handleDocumentUpdate} />
          {:else if leftTab === 'seams'}{#key $patternEditor}<SeamPanel {currentPattern} editor={$patternEditor} onchange={handlePatternUpdate} />{/key}
          {:else if leftTab === 'colorways'}<ColorwayPanel {currentPattern} selectedPieceIds={[...pieceIds]} onchange={handleDocumentUpdate} />
          {:else if leftTab === 'artwork'}<ArtworkPanel {currentPattern} selectedPieceIds={[...pieceIds]} onchange={handleDocumentUpdate} />
          {:else if leftTab === 'collection'}<RangePlanPanel {currentPattern} onchange={handleDocumentUpdate} onopenpattern={(id) => { void openSavedPattern(id); }} />
          {/if}
        </div>
      </aside>
    {/if}

    <div class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
      {#if !specsOnly}
        {#key $patternEditor}<ContextualSelectionToolbar {currentPattern} editor={$patternEditor} disabled={mutationDisabled}
          onduplicate={duplicateSelectedPiece} onproperties={(kind) => {
            if (kind === 'seam') { leftTab = 'seams'; openWorkspacePanel('left'); }
            else {
              if (selection.get('text').size > 0) panelRequest.set({ section: 'texts' });
              openWorkspacePanel('right');
            }
          }} />{/key}
      {/if}
      <div class="studio-canvases flex-1 min-w-0 flex overflow-hidden" class:split-view={viewMode === 'both' || viewMode === 'all'}>
        {#if customWorkspace}
          <WorkspaceDock layout={customWorkspace} onchange={handleWorkspaceLayout} disabled={frozenDiagnosticActive}
            draft={draftView} garment={garmentView} specs={specsView} />
        {:else if viewMode === 'all'}
          <WorkspaceSplit disabled={frozenDiagnosticActive} firstLabel="Design" secondLabel="Specs"
            firstId="studio-design-view" secondId="studio-specs-view" preferenceKey="seamer.workspaceSpecSplit" defaultPercentage={70}>
            {#snippet first()}<div class="flex-1 min-w-0 min-h-0 flex">{@render designViews()}</div>{/snippet}
            {#snippet second()}{@render specsView()}{/snippet}
          </WorkspaceSplit>
        {:else if viewMode === 'specs'}
          {@render specsView()}
        {:else if viewMode === 'both'}
          {@render designViews()}
        {:else if viewMode === '2d'}
          {@render draftView()}
        {:else}
          {@render garmentView()}
        {/if}
      </div>
    </div>

    {#if showRightPanel || mobilePanel === 'right'}
      <aside inert={frozenDiagnosticActive} id="studio-right-panel" bind:this={rightPanelElement} class="studio-right-panel" class:mobile-open={mobilePanel === 'right'} role={narrowWorkspace ? 'dialog' : undefined} aria-modal={narrowWorkspace && mobilePanel === 'right' ? true : undefined} aria-label="Properties">
      {#key $patternEditor}<PropertyPanel {currentPattern} editor={$patternEditor} onchange={handlePatternUpdate} onclose={() => closeWorkspacePanel('right')} {labelDisplay} onlabeldisplaychange={(v) => (labelDisplay = v)} ongrading={() => (showGrading = true)} onalterations={() => (showAlterations = true)} />{/key}
      </aside>
    {/if}
  </div>

  {#if draftVisible}
    <div class="studio-toolbar h-10 border-t bg-base-200 shrink-0" data-tour-id="tour-toolbar">
      <div inert={frozenDiagnosticActive}>{#key $patternEditor}<StudioToolbar {currentPattern} editor={$patternEditor} onchange={handlePatternUpdate} />{/key}</div>
    </div>
  {/if}

  <div class="studio-status">{#key $patternEditor}<StatusBar {currentPattern} {saved} editor={$patternEditor} />{/key}</div>

  {#if showObjectBrowser}
    <div inert={frozenDiagnosticActive}>{#key $patternEditor}<ObjectBrowser {currentPattern} editor={$patternEditor} onchange={handlePatternUpdate} bind:open={showObjectBrowser} />{/key}</div>
  {/if}
</div>

<KeyboardShortcuts bind:open={showShortcuts} />
<WelcomeModal onshowshortcuts={() => (showShortcuts = true)} onstarttour={() => (showTour = true)} />
{#if showTour}<StudioTour onclose={() => (showTour = false)} />{/if}
<WhatsNewModal />
<ReviewPromptDialog {saveCount} />
{#if showCommandPalette}<CommandPalette actions={workspaceActions} onclose={() => (showCommandPalette = false)} />{/if}
{#if !documentLoading}<SharePanel pattern={currentPattern} visible={showSharing} mutationPaused={frozenDiagnosticActive || documentLoading} sharedDocumentId={activeSharedDocumentId} onchange={receiveSharedDocument} onload={receiveSharedDocument} onrestore={handleDocumentUpdate} onrolechange={(role) => { collaborationRole = role; }} onsharedchange={handleSharedDocumentIdentity} onclose={() => { showSharing = false; }} />{/if}
{#if showBugReport}<BugReportModal {currentPattern} onclose={() => (showBugReport = false)} />{/if}
{#if showCuttingRoom}<CuttingRoomModal {currentPattern} onchange={handlePatternUpdate} onclose={() => (showCuttingRoom = false)} />{/if}
{#if showVersions}<VersionsModal {currentPattern} onrestore={applyRestoredVersion} onchange={handlePatternUpdate} onclose={() => (showVersions = false)} />{/if}
{#if showSettings}<SettingsModal {currentPattern} onchange={handlePatternUpdate} onclose={() => (showSettings = false)} />{/if}
{#if showGarmentCode}<GarmentCodeDialog {currentPattern} ongenerate={applyGeneratedGarmentCode} onexample={loadGarmentCodeExample} onclose={() => (showGarmentCode = false)} />{/if}
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


<style>
  .studio-shell { height: 100dvh; min-width: 0; }
  .studio-topbar { gap: 0.5rem; flex-wrap: wrap; }
  .studio-topbar :global(.dropdown-content) { max-height: calc(100dvh - 7rem); overflow-y: auto; flex-wrap: nowrap; }
  .studio-actions :global(.dropdown-content) { left: 0; right: auto; }
  .studio-document { min-width: 0; }
  .studio-actions, .studio-more-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem; }
  .studio-more-toggle, .studio-drawer-header, .studio-mobile-label, .studio-mobile-actions-heading, .studio-fabric-toggle { display: none; }
  .studio-landscape-actions { display: none; }
  .studio-workspace { position: relative; min-height: 0; }
  .studio-canvases, .studio-canvas { min-height: 0; }
  .studio-right-panel { display: flex; min-height: 0; flex-shrink: 0; }
  .studio-status { min-width: 0; overflow-x: auto; overflow-y: hidden; flex-shrink: 0; }
  .studio-status :global(> div) { min-width: max-content; }
  .studio-panel-backdrop { position: absolute; inset: 0; z-index: 30; background: rgb(0 0 0 / 0.35); cursor: default; }

  @media (max-width: 1023px) {
    .studio-topbar { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 0.25rem 0.5rem; padding: 0.25rem 0.5rem; }
    .studio-home { align-self: start; }
    .studio-document { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.25rem; }
    .studio-document > input { grid-column: 1 / -1; width: 100%; min-width: 0; height: 44px; }
    .studio-view-mode { grid-column: 2; justify-self: end; }
    .studio-actions { grid-column: 1 / -1; }
    .studio-topbar :global(.btn), .studio-topbar :global([role="button"]) { min-height: 44px; height: auto; min-width: 44px; }
    .studio-topbar :global(.dropdown-content) { position: fixed; left: 0.5rem; right: 0.5rem; top: 96px; width: auto; max-height: calc(100dvh - 112px); overflow-y: auto; }
    .studio-more-toggle, .studio-fabric-toggle { display: inline-flex; }
    .studio-actions { justify-content: space-between; flex-wrap: nowrap; }
    .studio-actions > :global(.btn), .studio-actions > :global(.dropdown) > :global(.btn) { padding-inline: 0.5rem; }
    .studio-more-actions { display: none; }
    .studio-more-actions.expanded { display: flex; position: fixed; top: 152px; left: 0.5rem; right: 0.5rem; z-index: 60; max-height: calc(100dvh - 168px); overflow-y: auto; overscroll-behavior: contain; padding: 0.5rem; background: oklch(var(--b2)); border-radius: 0.75rem; box-shadow: 0 4px 16px rgb(0 0 0 / 0.2); }
    .studio-more-actions :global(button[aria-label]:not([aria-label="Properties panel"]):not([aria-label="Close studio actions"]))::after { content: attr(aria-label); font-size: 0.75rem; }
    .studio-more-actions :global(.btn-square) { width: auto; max-width: 100%; aspect-ratio: auto; }
    .studio-more-actions :global(button[title="Pattern errors & warnings"])::after { content: attr(title); font-size: 0.75rem; }
    .studio-mobile-actions-heading { display: flex; align-items: center; justify-content: space-between; flex-basis: 100%; position: sticky; top: -0.5rem; background: oklch(var(--b2)); z-index: 1; padding-block: 0.25rem; }
    .studio-mobile-label { display: inline; }
    .studio-desktop-label { display: none; }
    .studio-left-panel, .studio-right-panel { display: none; }
    .studio-left-panel.mobile-open, .studio-right-panel.mobile-open { display: flex; position: absolute; top: 0; bottom: 0; z-index: 40; width: min(340px, calc(100% - 32px)); box-shadow: 0 8px 24px rgb(0 0 0 / 0.2); }
    .studio-left-panel.mobile-open { left: 0; }
    .studio-right-panel.mobile-open { right: 0; }
    .studio-right-panel :global(> div) { width: 100%; min-width: 0; }
    .studio-right-panel :global(button[aria-label="Close properties"]) { min-height: 44px; min-width: 44px; padding: 0; }
    .studio-drawer-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    .studio-drawer-header :global(button), .studio-left-panel :global(.tab) { min-height: 44px; min-width: 44px; }
    .studio-toolbar { height: 48px; }
    .studio-toolbar :global(button) { min-height: 44px; min-width: 44px; }
  }

  /* Short screens need two rows rather than a portrait header above a small canvas. */
  @media (max-width: 1023px) and (max-height: 500px) and (orientation: landscape) {
    .studio-topbar { grid-template-columns: 44px minmax(0, 1fr) auto; }
    .studio-home { grid-row: 1; grid-column: 1; }
    .studio-document { display: contents; }
    .studio-document > input { grid-row: 1; grid-column: 2; }
    .studio-view-mode { grid-row: 1; grid-column: 3; }
    .studio-document :global(.library-dropdown) { grid-row: 2; grid-column: 1 / 3; justify-self: start; }
    .studio-actions { grid-row: 2; grid-column: 2 / 4; justify-content: flex-end; gap: 0.5rem; }
    .studio-actions > button[aria-label="Layers and body panel"], .studio-actions > .studio-fabric-toggle { display: none; }
    .studio-landscape-actions { display: flex; flex-wrap: wrap; gap: 0.25rem; flex-basis: 100%; }
    .studio-more-actions.expanded { top: 104px; max-height: calc(100dvh - 120px); }
  }

  /* One row where short screens have room for every existing primary action.
     Narrower landscape screens retain the two-row layout above. */
  @media (min-width: 660px) and (max-width: 1023px) and (max-height: 500px) and (orientation: landscape) {
    .studio-topbar { grid-template-columns: 44px auto minmax(64px, 1fr) auto auto; column-gap: 0.25rem; }
    .studio-home { grid-row: 1; grid-column: 1; }
    .studio-document :global(.library-dropdown) { grid-row: 1; grid-column: 2; }
    .studio-document > input { grid-row: 1; grid-column: 3; }
    .studio-view-mode { grid-row: 1; grid-column: 4; }
    .studio-actions { grid-row: 1; grid-column: 5; gap: 0.25rem; }
    .studio-topbar .studio-actions :global(.dropdown-content),
    .studio-topbar .studio-document :global(.library-panel) { top: 56px; }
    .studio-more-actions.expanded { top: 56px; max-height: calc(100dvh - 72px); }
  }
</style>
