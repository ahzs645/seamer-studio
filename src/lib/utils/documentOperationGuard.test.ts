import { describe, expect, it } from 'vitest';
import { createDocumentOperationGuard } from './documentOperationGuard';
describe('asynchronous saved-document admission', () => {
  it('accepts only the latest open, even when earlier data arrives last', async () => {
    let state = { identity: {}, fingerprint: 'draft', context: 'local', blocked: false };
    const guard = createDocumentOperationGuard(() => state);
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = guard.begin();
    const pendingFirst = firstReady.then(() => { if (first.isCurrent()) state = { ...state, fingerprint: 'first saved project' }; });
    const second = guard.begin();
    expect(second.isCurrent()).toBe(true); state = { ...state, fingerprint: 'second saved project' };
    releaseFirst(); await pendingFirst; expect(state.fingerprint).toBe('second saved project');
  });
  it.each(['edit', 'remote', 'freeze', 'sharing'] as const)('rejects a pending open after %s changes its admission', async (change) => {
    const state = { identity: {}, fingerprint: 'same-id draft', context: 'owner/server-id', blocked: false };
    const guard = createDocumentOperationGuard(() => state); const pending = guard.begin();
    await Promise.resolve();
    if (change === 'edit') state.fingerprint = 'same-id edited draft';
    if (change === 'remote') state.identity = {};
    if (change === 'freeze') state.blocked = true;
    if (change === 'sharing') state.context = 'viewer/server-id';
    expect(pending.isCurrent()).toBe(false);
  });
  it('allows history restoration to finish only while the accepted new document remains current', async () => {
    const state = { identity: {}, fingerprint: 'old', context: 'local', blocked: false };
    const operation = createDocumentOperationGuard(() => state).begin();
    expect(operation.isCurrent()).toBe(true); state.identity = {}; state.fingerprint = 'accepted saved project';
    const finishCurrent = operation.captureCurrent(); expect(finishCurrent()).toBe(true);
    await Promise.resolve(); state.fingerprint = 'new edit after adoption'; expect(finishCurrent()).toBe(false);
  });
  it('rejects a pending open when a separate local-document intent supersedes it without changing content', () => {
    const state = { identity: {}, fingerprint: 'identical imported draft', context: 'local', blocked: false };
    const guard = createDocumentOperationGuard(() => state); const pending = guard.begin();
    guard.invalidate(); expect(pending.isCurrent()).toBe(false);
  });
});
