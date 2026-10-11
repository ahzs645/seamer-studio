import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyPattern } from '@seamer/pattern-model';
vi.mock('$app/environment', () => ({ browser: false }));
// The standalone unit config omits Svelte transforms. Compile this actual rune helper,
// rather than substituting a plain-object clone that would miss reactive proxy failures.
vi.mock('$lib/utils/automationSnapshot.svelte', async () => {
  const { readFileSync } = await import('node:fs');
  const { transpileModule, ModuleKind } = await import('typescript');
  const { compileModule } = await import('svelte/compiler');
  // @ts-expect-error Svelte's compiler-generated runtime entry has no public declarations.
  const runtime = await import('svelte/internal/server');
  const source = readFileSync(new URL('../utils/automationSnapshot.svelte.ts', import.meta.url), 'utf8');
  const compiled = compileModule(transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext } }).outputText, { filename: 'automationSnapshot.svelte.ts', generate: 'server' }).js.code;
  const executable = compiled.replace(/^import .*;\s*$/m, '').replace('export function', 'function');
  return new Function('$', `${executable}\nreturn { automationSnapshot };`)(runtime);
});
import { automationSnapshot } from '$lib/utils/automationSnapshot.svelte';
import { adoptPatternSnapshot, getPatternEditor, installSeamerAutomation, resetHistory, restoreHistory, setDocumentMutationLock } from './pattern';
beforeEach(() => { setDocumentMutationLock(null); adoptPatternSnapshot(createEmptyPattern()); resetHistory(); });
afterEach(() => { setDocumentMutationLock(null); });
describe('canonical transaction admission', () => {
  it('snapshots reactive proxies while preserving undefined fields and isolated typed arrays', () => {
    const nested = new Proxy({ name: 'Reactive layer' }, {});
    const original = new Proxy({ nested, optional: undefined, checkpoint: new Float32Array([1, 2, 3]) }, {});
    expect(() => structuredClone(original)).toThrow();
    const snapshot = automationSnapshot(original);
    expect(snapshot).toEqual({ nested: { name: 'Reactive layer' }, optional: undefined, checkpoint: new Float32Array([1, 2, 3]) });
    expect(Object.hasOwn(snapshot, 'optional')).toBe(true);
    snapshot.nested.name = 'Changed'; snapshot.checkpoint[0] = 7;
    expect(original.nested.name).toBe('Reactive layer'); expect(original.checkpoint[0]).toBe(1);
  });
  it('rejects a transaction that was executed before a viewer or frozen lock', () => {
    const editor = getPatternEditor(), original = editor.content;
    const transaction = editor.transaction('Pending edit');
    expect(transaction.execute('layer.rename', { layerId: original.layers[0].id, name: 'Unauthorized pending change' }).ok).toBe(true);
    setDocumentMutationLock('Read-only document');
    expect(transaction.commit()).toBe(false);
    expect(editor.content).toBe(original); expect(editor.canUndo).toBe(false);
  });
  it('rejects a stale transaction after an authorized same-document remote snapshot', () => {
    const editor = getPatternEditor(), original = editor.content;
    const transaction = editor.transaction('Pending edit');
    transaction.execute('layer.rename', { layerId: original.layers[0].id, name: 'Stale local layer' });
    adoptPatternSnapshot({ ...original, name: 'New server revision' });
    expect(transaction.commit()).toBe(false);
    expect(editor.content.name).toBe('New server revision'); expect(editor.content.layers[0].name).toBe(original.layers[0].name);
  });
  it('rejects a dormant editor transaction after authoritative adoption replaces the editor', () => {
    const editor = getPatternEditor(), transaction = editor.transaction('Dormant transaction');
    transaction.execute('layer.rename', { layerId: editor.content.layers[0].id, name: 'Dormant edit' });
    adoptPatternSnapshot({ ...editor.content, name: 'Authoritative revision' }, { clearHistory: true });
    expect(getPatternEditor()).not.toBe(editor); expect(transaction.commit()).toBe(false);
    expect(getPatternEditor().content.name).toBe('Authoritative revision');
  });
  it('clears earlier snapshot undo when a clean peer revision arrives, preserving the peer fields', () => {
    const editor = getPatternEditor(); editor.execute('layer.rename', { layerId: editor.content.layers[0].id, name: 'Own edit' });
    expect(editor.canUndo).toBe(true);
    adoptPatternSnapshot({ ...editor.content, name: 'Peer revision', description: 'Peer changes' }, { clearHistory: true });
    expect(getPatternEditor().undo()).toBe(false); expect(getPatternEditor().content.description).toBe('Peer changes');
  });
  it('refuses to restore a different document history onto the current editor', async () => {
    const editor = getPatternEditor(); editor.execute('layer.rename', { layerId: editor.content.layers[0].id, name: 'Current document edit' });
    expect(await restoreHistory('superseded-document-id')).toBe(false);
    expect(getPatternEditor()).toBe(editor); expect(editor.content.layers[0].name).toBe('Current document edit'); expect(editor.canUndo).toBe(true);
  });
  it('returns defensive automation snapshots whose nested edits cannot bypass a viewer lock', () => {
    const dispose = installSeamerAutomation();
    try {
      const api = (globalThis as unknown as { seamer: { getPattern: () => ReturnType<typeof createEmptyPattern>; getContent: () => ReturnType<typeof createEmptyPattern>; getDoc: () => { content: ReturnType<typeof createEmptyPattern>; meta: { id: string } } } }).seamer;
      const original = getPatternEditor().content;
      setDocumentMutationLock('Viewer document');
      const snapshot = api.getPattern(); snapshot.name = 'Bypass'; snapshot.layers[0].name = 'Nested bypass'; snapshot.points.push({ id: 'bad', name: 'Injected', x: 0, y: 0 });
      const content = api.getContent(); content.description = 'Content bypass';
      const document = api.getDoc(); document.content.layers[0].name = 'Doc bypass'; document.meta.id = 'Changed document ID';
      expect(getPatternEditor().content).toBe(original); expect(original.name).not.toBe('Bypass'); expect(original.layers[0].name).not.toBe('Nested bypass'); expect(original.points).toHaveLength(0); expect(original.description).not.toBe('Content bypass');
      expect(api.getPattern()).not.toBe(original); expect(api.getContent()).not.toBe(content);
      expect(getPatternEditor().doc.meta.id).not.toBe('Changed document ID'); expect(api.getDoc()).not.toBe(document);
    } finally { dispose(); }
  });
  it('allows an unchanged canonical transaction and records its normal history', () => {
    const editor = getPatternEditor();
    const transaction = editor.transaction('Allowed edit');
    transaction.execute('layer.rename', { layerId: editor.content.layers[0].id, name: 'Allowed layer' });
    expect(transaction.commit()).toBe(true); expect(editor.content.layers[0].name).toBe('Allowed layer'); expect(editor.canUndo).toBe(true);
  });
});
