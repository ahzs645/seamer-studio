import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEmptyPattern } from '@seamer/pattern-model';
import { createSession, getSession, readSession, enqueueOps, syncStudio, deleteSession, type McpOp } from './mcpSessionStore';

const commandOp = (name: string): McpOp => ({ kind: 'command', name, payload: { dx: 1 } });

describe('mcpSessionStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates sessions with a uuid id and empty state', () => {
    const s = createSession();
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.pattern).toBeNull();
    expect(s.inbox).toEqual([]);
    expect(getSession(s.id)).toBe(s);
  });

  it('enqueues ops and drains them on the next studio sync', () => {
    const s = createSession();
    expect(enqueueOps(s.id, [commandOp('selection.move')])).toBe(true);
    expect(enqueueOps(s.id, [commandOp('selection.rotate')])).toBe(true);
    const pattern = createEmptyPattern();
    const ops = syncStudio(s.id, pattern)!;
    expect(ops.map((o) => (o.kind === 'command' ? o.name : o.kind))).toEqual(['selection.move', 'selection.rotate']);
    expect(s.inbox).toEqual([]); // drained
    expect(s.pattern).toBe(pattern); // snapshot stored for agent reads
    expect(syncStudio(s.id, null)).toEqual([]); // null keeps the previous snapshot
    expect(s.pattern).toBe(pattern);
  });

  it('returns undefined/false for unknown sessions', () => {
    expect(getSession('nope')).toBeUndefined();
    expect(readSession('nope')).toBeUndefined();
    expect(enqueueOps('nope', [commandOp('x')])).toBe(false);
    expect(syncStudio('nope', null)).toBeUndefined();
    expect(deleteSession('nope')).toBe(false);
  });

  it('deletes sessions explicitly', () => {
    const s = createSession();
    expect(deleteSession(s.id)).toBe(true);
    expect(getSession(s.id)).toBeUndefined();
  });

  it('expires sessions idle for more than 30 minutes on access', () => {
    const s = createSession();
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(getSession(s.id)).toBeDefined(); // not idle long enough
    vi.advanceTimersByTime(2 * 60 * 1000); // 31 min since last touch
    expect(getSession(s.id)).toBeUndefined();
  });

  it('activity from either side keeps a session alive', () => {
    const s = createSession();
    vi.advanceTimersByTime(20 * 60 * 1000);
    syncStudio(s.id, null); // studio heartbeat
    vi.advanceTimersByTime(20 * 60 * 1000);
    enqueueOps(s.id, [commandOp('x')]); // agent activity
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(getSession(s.id)).toBeDefined(); // never 30 min fully idle
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(getSession(s.id)).toBeUndefined();
  });
});
