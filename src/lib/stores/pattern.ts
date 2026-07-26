import { writable, derived, type Writable } from 'svelte/store';
import { browser } from '$app/environment';
import type { Pattern, Piece, ConstrainablePoint, ConstrainablePath } from '@seamer/pattern-model';
import { EMPTY_PATTERN, createPatternRegistry } from '@seamer/pattern-model';
import {
  CommandRegistry,
  Editor,
  IndexedDbHistoryPersistence,
  Selection,
  createDoc,
  installAutomationApi,
  type CommandDef
} from '@atelier/core';
import { EMPTY_SEAM_TOOL, type SeamToolState } from '$lib/utils/seamTool';

interface ReplaceParams {
  pattern: Pattern;
}

const replaceSilent: CommandDef<Pattern, ReplaceParams> = {
  type: 'studio.replaceSilent',
  category: 'studio',
  summary: 'Replace the pattern without recording history.',
  inputs: ['pattern'],
  mutating: false,
  run: (_content, params) => params.pattern
};

const replaceWithHistory: CommandDef<Pattern, ReplaceParams> = {
  ...replaceSilent,
  type: 'studio.replaceWithHistory',
  summary: 'Replace the pattern and record history.',
  mutating: true
};

const historyPersistence = new IndexedDbHistoryPersistence<Pattern>({
  dbName: 'seamer-studio',
  storeName: 'history',
  version: 1
});

function registry(): CommandRegistry<Pattern> {
  return createPatternRegistry()
    .register(replaceSilent)
    .register(replaceWithHistory);
}

function makeEditor(content: Pattern, docId = content.id): Editor<Pattern> {
  return new Editor(createDoc(content, { id: docId, name: content.name }), {
    registry: registry(),
    history: {
      limit: 100,
      coalesceMs: 800,
      persist: historyPersistence,
      persistLimit: 30
    }
  });
}

let activeEditor = makeEditor(structuredClone(EMPTY_PATTERN));
const editorValue = writable(activeEditor);
let pendingHistoryLabel: string | null = null;
let disposeEditorEvents: (() => void)[] = [];
let automationName: string | null = null;
let disposeAutomation: (() => void) | null = null;

const patternValue = writable<Pattern>(activeEditor.content);
const undoLabelValue = writable<string | null>(null);
const redoLabelValue = writable<string | null>(null);
const historyLabelsValue = writable<string[]>([]);

function syncEditorState(): void {
  patternValue.set(activeEditor.content);
  undoLabelValue.set(activeEditor.undoLabel);
  redoLabelValue.set(activeEditor.redoLabel);
  historyLabelsValue.set([...activeEditor.historyLabels]);
  selectedPointIdsValue.set(new Set(activeEditor.selection.get('point')));
  selectedPathIdsValue.set(new Set(activeEditor.selection.get('path')));
  selectedPieceIdsValue.set(new Set(activeEditor.selection.get('piece')));
}

function connectEditor(): void {
  for (const dispose of disposeEditorEvents) dispose();
  disposeEditorEvents = [
    activeEditor.on('doc', syncEditorState),
    activeEditor.on('history', syncEditorState),
    activeEditor.on('selection', syncEditorState)
  ];
  if (automationName) {
    disposeAutomation?.();
    disposeAutomation = installAutomationApi(activeEditor, automationName);
    patchAutomationSurface();
  }
  syncEditorState();
}

interface InstalledAutomation {
  getContent: () => Pattern;
  getPattern?: () => Pattern;
  getSelection: () => unknown;
}

function patchAutomationSurface(): void {
  const target = globalThis as typeof globalThis & { seamer?: InstalledAutomation };
  const api = target.seamer;
  if (!api) return;
  const getSelection = (): Selection => activeEditor.selection;
  api.getPattern = api.getContent;
  api.getSelection = () => ({
    pointIds: [...getSelection().get('point')],
    pathIds: [...getSelection().get('path')],
    pieceIds: [...getSelection().get('piece')],
    seamIds: [...getSelection().get('seam')],
    textIds: [...getSelection().get('text')]
  });
}

function replaceEditor(content: Pattern, docId = content.id): void {
  for (const dispose of disposeEditorEvents) dispose();
  disposeEditorEvents = [];
  activeEditor.dispose();
  activeEditor = makeEditor(content, docId);
  editorValue.set(activeEditor);
  pendingHistoryLabel = null;
  connectEditor();
}

export function getPatternEditor(): Editor<Pattern> {
  return activeEditor;
}

/** Active editor identity; changes only when a different pattern id is opened. */
export const patternEditor = { subscribe: editorValue.subscribe };

/** Keep the byte-compatible `window.seamer` shape while delegating to the current Editor instance. */
export function installSeamerAutomation(): () => void {
  automationName = 'seamer';
  disposeAutomation?.();
  disposeAutomation = installAutomationApi(activeEditor, automationName);
  patchAutomationSurface();
  return () => {
    disposeAutomation?.();
    disposeAutomation = null;
    automationName = null;
  };
}

export const pattern: Writable<Pattern> = {
  subscribe: patternValue.subscribe,
  set(next) {
    if (next === activeEditor.content || JSON.stringify(next) === JSON.stringify(activeEditor.content)) {
      pendingHistoryLabel = null;
      return;
    }
    const label = pendingHistoryLabel;
    pendingHistoryLabel = null;
    if (label) {
      const transaction = activeEditor.transaction(label);
      const result = transaction.execute('studio.replaceWithHistory', { pattern: next });
      if (result.ok) transaction.commit();
      else transaction.rollback();
    } else {
      activeEditor.execute('studio.replaceSilent', { pattern: next });
    }
  },
  update(fn) {
    this.set(fn(activeEditor.content));
  }
};

export const selectedTool = writable<string>('select');

export const zoom = writable<number>(1);

export const panOffset = writable<{ x: number; y: number }>({ x: 0, y: 0 });

const selectedPointIdsValue = writable<Set<string>>(new Set());
const selectedPathIdsValue = writable<Set<string>>(new Set());
const selectedPieceIdsValue = writable<Set<string>>(new Set());

function selectionStore(
  kind: 'point' | 'path' | 'piece',
  value: Writable<Set<string>>
): Writable<Set<string>> {
  return {
    subscribe: value.subscribe,
    set(ids) {
      activeEditor.setSelection(activeEditor.selection.replace(kind, ids));
    },
    update(fn) {
      this.set(fn(new Set(activeEditor.selection.get(kind))));
    }
  };
}

/** Compatibility views; Atelier's single immutable Selection is the canonical state. */
export const selectedPointIds = selectionStore('point', selectedPointIdsValue);
export const selectedPathIds = selectionStore('path', selectedPathIdsValue);
export const selectedPieceIds = selectionStore('piece', selectedPieceIdsValue);

export const showGrid = writable<boolean>(true);

export const snapToGrid = writable<boolean>(false);

/** Live cursor position in drafting millimetres (set by the 2D canvas), for the status bar. Null when
 *  the pointer is outside the canvas. */
export const cursorMm = writable<{ x: number; y: number } | null>(null);

/** Clipboard payload awaiting click-placement on the 2D canvas (the source's PasteTool flow). A
 *  Ctrl+V arms this; the canvas ghosts the content under the cursor and commits on click.
 *  Paths paste with their points: plain paste REUSES existing anchor points where they still
 *  exist (a referencing copy); `asCopy` (Ctrl+Shift+V, "Paste as copy") duplicates everything. */
export type PendingPaste =
  | { kind: 'pieces'; items: Piece[] }
  | { kind: 'points'; items: ConstrainablePoint[] }
  | { kind: 'paths'; items: { path: ConstrainablePath; points: ConstrainablePoint[] }[]; asCopy?: boolean };
export const pendingPaste = writable<PendingPaste | null>(null);

/** One-shot request to open a PropertyPanel pattern section (e.g. Shift+V → 'sizes' for variables).
 *  The panel consumes it and resets the store to null. */
export const panelRequest = writable<{ section: string } | null>(null);

/** The seam highlighted across views (SeamPanel/ObjectBrowser row → 2D emphasis + direction arrows,
 *  3D display even when "Show seams" is off — the original's shouldDisplaySeams behavior). */
export const selectedSeamId = writable<string | null>(null);

/** In-progress seam tool selection, shared by the 2D canvas and the 3D viewport (both can pick
 *  edges for the same seam, like the original's 2D/3D seam tools). */
export const seamTool = writable<SeamToolState>(EMPTY_SEAM_TOOL);

/** One-shot request to fly the 3D camera to a body measurement (BodyPanel → PatternScene3D). */
export const bodyZoomRequest = writable<string | null>(null);

/** Modal "click a path on the canvas" request (the original's SelectPathTool): the 2D canvas
 *  resolves the next path click into onPick and clears the request; Esc cancels. */
export const pathPickRequest = writable<{ label: string; onPick: (pathId: string) => void } | null>(null);

/** Writable store mirrored to localStorage (browser only) — shared persistence helper. */
export function persisted<T>(key: string, initial: T) {
  let start = initial;
  // Browser-only: guard with SvelteKit's `browser` AND a try/catch, since some SSR runtimes expose a
  // `localStorage` global whose methods throw.
  if (browser) {
    try { const raw = localStorage.getItem(key); if (raw != null) start = JSON.parse(raw) as T; } catch { /* ignore */ }
  }
  const store = writable<T>(start);
  if (browser) store.subscribe((v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } });
  return store;
}
export const autoSaveSeconds = persisted<number>('seamer.autosaveSeconds', 5);
export const show3dStats = persisted<boolean>('seamer.show3dStats', false);
/** Pointer interaction mode: 'safe' = a drag only moves already-selected items (click selects first);
 *  'fast' = dragging an element moves it immediately. */
export const interactionMode = persisted<'fast' | 'safe'>('seamer.interactionMode', 'fast');
/** Opacity of the frozen-snapshot ghost rendered under the live pattern in the 2D canvas. */
export const frozenSnapshotOpacity = persisted<number>('seamer.frozenSnapshotOpacity', 0.35);
/** Show the live cursor / selection coordinate readout in the status bar. */
export const showCoordinates = persisted<boolean>('seamer.showCoordinates', true);
/** "Anchor to saved drape": OFF (default) is the source-parity free-run — while simulating, the
 *  garment is held together only by seams/stretch like the original, so dragging pulls the whole
 *  connected garment. ON softly holds the cached drape (anchor scale 0.08) for extra stability.
 *  Key is versioned: the old 'seamer.simAnchors' default (true) was already persisted in browsers. */
export const simAnchors = persisted<boolean>('seamer.simAnchors.v2', false);

// --- Labeled engine history ---------------------------------------------------

export const undoLabel = { subscribe: undoLabelValue.subscribe };
export const redoLabel = { subscribe: redoLabelValue.subscribe };
export const historyLabels = { subscribe: historyLabelsValue.subscribe };

/** The next compatibility-store write becomes one labeled engine transaction. */
export function pushUndo(_pattern: Pattern, label = 'Edit'): void {
  pendingHistoryLabel = label;
}

export function undo(_current: Pattern): Pattern | null {
  return activeEditor.undo() ? activeEditor.content : null;
}

export function redo(_current: Pattern): Pattern | null {
  return activeEditor.redo() ? activeEditor.content : null;
}

/** Recreate the editor with the same document id and an empty history. */
export function resetHistory(): void {
  const content = activeEditor.content;
  const docId = activeEditor.doc.meta.id;
  void historyPersistence.delete(docId).catch(() => {
    // History clearing is best-effort when storage is unavailable.
  });
  replaceEditor(content, docId);
}

/** Open a pattern-specific engine history. Restoration completes asynchronously inside Editor. */
export async function restoreHistory(patternId: string): Promise<boolean> {
  replaceEditor(activeEditor.content, patternId);
  return typeof indexedDB !== 'undefined';
}

export async function clearPersistedHistory(patternId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await historyPersistence.delete(patternId);
}

export const canUndo = derived(undoLabel, ($label) => $label !== null);
export const canRedo = derived(redoLabel, ($label) => $label !== null);

connectEditor();
