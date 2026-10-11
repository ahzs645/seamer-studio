import { writable, derived, type Writable } from 'svelte/store';
import { browser } from '$app/environment';
import { synchronizeLinkedDraft } from '$lib/utils/draftingSync';
import { automationSnapshot } from '$lib/utils/automationSnapshot.svelte';
import type { Pattern, Piece, ConstrainablePoint, ConstrainablePath } from '@seamer/pattern-model';
import {
  COMMAND_LIST,
  EMPTY_PATTERN,
  EMPTY_SEAM_TOOL,
  createPatternRegistry,
  validateDocumentExtensions,
  type SeamToolState
} from '@seamer/pattern-model';
import {
  CommandRegistry,
  Editor,
  IndexedDbHistoryPersistence,
  Selection,
  createDoc,
  installAutomationApi,
  type CommandDef,
  type CommandContext,
  type CommandResult
} from '@atelier/core';

interface ReplaceParams {
  pattern: Pattern;
}

let documentMutationLock: string | null = null;
let adoptingDocument = false;

/** Shared documents and frozen observations guard commands, transactions and history alike. */
export function setDocumentMutationLock(reason: string | null): void {
  documentMutationLock = reason;
}

const replaceSilent: CommandDef<Pattern, ReplaceParams> = {
  type: 'studio.replaceSilent',
  category: 'studio',
  summary: 'Replace the pattern without recording history.',
  inputs: ['pattern'],
  mutating: false,
  run: (_content, params) => {
    validateDocumentExtensions(params.pattern);
    return params.pattern;
  }
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

// Fresh authoritative snapshots retain future history persistence without loading obsolete
// on-device snapshots into a server document's newly reset undo stack.
const freshHistoryPersistence = {
  save: historyPersistence.save.bind(historyPersistence),
  load: async () => null,
  delete: historyPersistence.delete.bind(historyPersistence)
};

function registry(): CommandRegistry<Pattern> {
  const result = createPatternRegistry()
    .register(replaceSilent)
    .register(replaceWithHistory);
  for (const command of result.list()) {
    const original = command.run as unknown as (content: Pattern, params: unknown, context: CommandContext<Pattern>) => Pattern;
    result.register<unknown>({ ...command, run: (content, params, context) => {
      if (documentMutationLock && !(adoptingDocument && command.type === 'studio.replaceSilent')) throw new Error(documentMutationLock);
      const next = original(content, params, context);
      return command.type.startsWith('studio.') || command.type === 'transaction.commit' ? next : synchronizeLinkedDraft(content, next);
    } });
  }
  return result;
}

function makeEditor(content: Pattern, docId = content.id, freshHistory = false): Editor<Pattern> {
  validateDocumentExtensions(content);
  const editor = new Editor(createDoc(content, { id: docId, name: content.name }), {
    registry: registry(),
    history: {
      limit: 100,
      coalesceMs: 800,
      persist: freshHistory ? freshHistoryPersistence : historyPersistence,
      persistLimit: 30
    }
  });
  const beginTransaction = editor.transaction.bind(editor);
  editor.transaction = (label) => {
    const baseDocument = editor.doc;
    const transaction = beginTransaction(label), commit = transaction.commit.bind(transaction);
    transaction.commit = () => {
      // Executing a command can precede a role change or a remote snapshot. Engine commit
      // applies its working snapshot directly, so guard it here as well as in the registry.
      if (documentMutationLock || activeEditor !== editor || editor.doc !== baseDocument) { transaction.rollback(); return false; }
      return commit();
    };
    return transaction;
  };
  const undo = editor.undo.bind(editor), redo = editor.redo.bind(editor);
  editor.undo = () => !documentMutationLock && undo();
  editor.redo = () => !documentMutationLock && redo();
  return editor;
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
  commands?: () => Array<{
    type: string;
    category: string;
    summary: string;
    inputs: string[];
    example: Record<string, unknown> | null;
    replayable: boolean;
  }>;
  execute: (type: string, params?: unknown) => CommandResult;
  getContent: () => Pattern;
  getDoc?: () => ReturnType<typeof createDoc<Pattern>>;
  getPattern?: () => Pattern;
  getSelection: () => unknown;
}

declare global {
  interface Window {
    seamer?: InstalledAutomation;
  }
}

function patchAutomationSurface(): void {
  const target = globalThis as typeof globalThis & { seamer?: InstalledAutomation };
  const api = target.seamer;
  if (!api) return;
  api.commands = () => COMMAND_LIST.map((command) => ({
    type: command.type,
    category: command.category,
    summary: command.summary,
    inputs: [...command.inputs],
    example: command.example ?? null,
    replayable: command.replayable ?? true
  }));
  const getSelection = (): Selection => activeEditor.selection;
  api.getContent = () => automationSnapshot(activeEditor.content);
  api.getDoc = () => automationSnapshot(activeEditor.doc);
  api.getPattern = api.getContent;
  api.getSelection = () => ({
    pointIds: [...getSelection().get('point')],
    pathIds: [...getSelection().get('path')],
    pieceIds: [...getSelection().get('piece')],
    seamIds: [...getSelection().get('seam')],
    textIds: [...getSelection().get('text')]
  });
}

function replaceEditor(content: Pattern, docId = content.id, freshHistory = false): void {
  for (const dispose of disposeEditorEvents) dispose();
  disposeEditorEvents = [];
  activeEditor.dispose();
  activeEditor = makeEditor(content, docId, freshHistory);
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

function setPattern(next: Pattern): void {
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
    adoptingDocument = true;
    try { activeEditor.execute('studio.replaceSilent', { pattern: next }); }
    finally { adoptingDocument = false; }
  }
}

export const pattern: Writable<Pattern> = {
  subscribe: patternValue.subscribe,
  set: setPattern,
  update: (fn) => setPattern(fn(activeEditor.content))
};

/** Authorized remote snapshots must arrive even while viewer mutation/history is locked. */
export function adoptPatternSnapshot(next: Pattern, options: { clearHistory?: boolean } = {}): void {
  pendingHistoryLabel = null;
  if (options.clearHistory) {
    // The fresh adapter skips load synchronously; clearing disk history cannot race a restore.
    void historyPersistence.save(next.id, [], []).catch(() => {});
    replaceEditor(next, next.id, true);
  } else setPattern(next);
}

export const selectedTool = writable<string>('select');

export const zoom = writable<number>(1);

export const panOffset = writable<{ x: number; y: number }>({ x: 0, y: 0 });

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

/** Compatibility surface for the 3D scene; seam selection lives only in the canonical Editor.
 * Existing editor selection events notify patternValue through syncEditorState. */
const canonicalSeamId = derived(patternValue, () => [...activeEditor.selection.get('seam')][0] ?? null);
function selectCanonicalSeam(id: string | null): void {
  activeEditor.setSelection(Selection.empty().replace('seam', id ? [id] : []));
}
export const selectedSeamId: Writable<string | null> = {
  subscribe: canonicalSeamId.subscribe,
  set: selectCanonicalSeam,
  update: (updater) => selectCanonicalSeam(updater([...activeEditor.selection.get('seam')][0] ?? null))
};

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
/** "Anchor to saved drape": ON by default because the approximate local solver needs the gentle
 *  0.08 hold to preserve a restored source equilibrium. Grabbed regions release the hold locally,
 *  so the cloth remains interactive. OFF is available for intentionally free-running a garment.
 *  The versioned key corrects browsers that persisted the short-lived v2=false default. */
export const simAnchors = persisted<boolean>('seamer.simAnchors.v3', true);

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
  if (patternId !== activeEditor.content.id) return false;
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
