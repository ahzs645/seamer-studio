import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { get } from 'svelte/store';
import type { Pattern } from '@seamer/pattern-model';

vi.mock('$app/paths', () => ({ base: '' }));
vi.mock('$lib/stores/toast', () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));

import {
  configureMcpSession, disableMcpSession, enableMcpSession,
  mcpSessionError, mcpSessionId, mcpSessionPending, mcpSessionUnavailable
} from './mcpSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 201, headers: { 'content-type': 'application/json' }
});

let dispose: () => void;
let applyPattern: Mock<(next: Pattern) => void>;

beforeEach(() => {
  mcpSessionUnavailable.set(false);
  mcpSessionError.set(null);
  applyPattern = vi.fn();
  dispose = configureMcpSession({
    getPattern: () => ({ id: 'test-pattern' }) as Pattern,
    applyPattern,
    executeCommand: vi.fn()
  });
});

afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
});

describe('MCP session startup', () => {
  it('allows only one start while pending and enables a valid server session', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(json({ ops: [] }));
    vi.stubGlobal('fetch', fetch);
    const start = enableMcpSession();
    expect(get(mcpSessionPending)).toBe(true);
    await enableMcpSession();
    expect(fetch).toHaveBeenCalledTimes(1);
    pending.resolve(json({ id: 'session-1' }));
    await start;
    expect(get(mcpSessionId)).toBe('session-1');
    expect(get(mcpSessionPending)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2); // initial snapshot sync
  });

  it.each([
    ['missing API', () => new Response('', { status: 404 })],
    ['unsupported POST', () => new Response('', { status: 405 })],
    ['static HTML fallback', () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })]
  ])('explains unavailable hosting for %s and prevents repeated requests', async (_name, response) => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetch);
    await enableMcpSession();
    expect(get(mcpSessionUnavailable)).toBe(true);
    expect(get(mcpSessionError)).toMatch(/server-enabled deployment/);
    expect(get(mcpSessionId)).toBeNull();
    expect(get(mcpSessionPending)).toBe(false);
    await enableMcpSession();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('permits retry after a transient server failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await enableMcpSession();
    expect(get(mcpSessionUnavailable)).toBe(false);
    expect(get(mcpSessionError)).toContain('503');
    expect(get(mcpSessionPending)).toBe(false);
  });

  it('rejects invalid session IDs without starting polling', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: null }));
    vi.stubGlobal('fetch', fetch);
    await enableMcpSession();
    expect(get(mcpSessionId)).toBeNull();
    expect(get(mcpSessionError)).toContain('invalid session ID');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a session disabled while its creation request is pending', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const start = enableMcpSession();
    await disableMcpSession();
    pending.resolve(json({ id: 'cancelled-session' }));
    await start;
    expect(get(mcpSessionId)).toBeNull();
    expect(get(mcpSessionPending)).toBe(false);
    expect(fetch).toHaveBeenLastCalledWith('/api/mcp-session/cancelled-session', { method: 'DELETE' });
  });

  it('ignores external edits from an in-flight sync after disabling', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(json({ id: 'session-1' }))
      .mockReturnValueOnce(pending.promise).mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await enableMcpSession();
    await disableMcpSession();
    pending.resolve(json({ ops: [{ kind: 'pattern', pattern: { id: 'external' } }] }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(applyPattern).not.toHaveBeenCalled();
  });
});
