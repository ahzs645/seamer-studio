// MCP pattern session — studio-side controller.
//
// When enabled, the studio creates a server session (/api/mcp-session) and polls /sync every ~2s:
// it pushes its current pattern snapshot (so external agents can read it) and applies any ops the
// agent queued — full-pattern replacements through the studio's undo-aware update path, command ops
// through the same command bus the palette / window.seamer uses. Local-first, no auth: the
// session id is the capability. The studio page wires the host in onMount via configureMcpSession().

import { writable, get } from 'svelte/store';
import { base } from '$app/paths';
import type { Pattern } from '@seamer/pattern-model';
import type { McpOp } from '$lib/server/mcpSessionStore';
import { toastSuccess, toastError } from '$lib/stores/toast';

export interface McpSessionHost {
  /** Snapshot of the current pattern (pushed to the server on every sync). */
  getPattern: () => Pattern;
  /** Commit a full external pattern replacement (studio wires this to handlePatternUpdate). */
  applyPattern: (next: Pattern) => void;
  /** Run a command through the studio's command bus (same surface as window.seamer.execute). */
  executeCommand: (name: string, payload?: Record<string, unknown>) => void;
}

/** Active session id, or null when no MCP session is enabled. */
export const mcpSessionId = writable<string | null>(null);
export const mcpSessionPending = writable(false);
export const mcpSessionUnavailable = writable(false);
export const mcpSessionError = writable<string | null>(null);

const SERVER_REQUIRED = 'MCP sessions are unavailable on this host. A server-enabled deployment is required.';

const POLL_MS = 2000;
const MAX_FAILURES = 3;

let host: McpSessionHost | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let failures = 0;
let syncing = false;
let sessionGeneration = 0;

/** Install the studio host. Returns a disposer that stops polling (without deleting the session). */
export function configureMcpSession(h: McpSessionHost): () => void {
  host = h;
  return () => {
    if (host !== h) return;
    sessionGeneration++;
    stopPolling();
    mcpSessionId.set(null);
    mcpSessionPending.set(false);
    host = null;
  };
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  failures = 0;
}

async function deleteSession(id: string): Promise<void> {
  try { await fetch(`${base}/api/mcp-session/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  catch { /* session expires server-side */ }
}

export async function enableMcpSession(): Promise<void> {
  if (!host || get(mcpSessionId) || get(mcpSessionPending) || get(mcpSessionUnavailable)) return;
  const generation = ++sessionGeneration;
  const sessionHost = host;
  mcpSessionPending.set(true);
  mcpSessionError.set(null);
  try {
    const res = await fetch(`${base}/api/mcp-session`, { method: 'POST' });
    const contentType = res.headers.get('content-type') ?? '';
    if (res.status === 404 || res.status === 405 || (res.ok && !contentType.includes('application/json'))) {
      if (generation === sessionGeneration) mcpSessionUnavailable.set(true);
      throw new Error(SERVER_REQUIRED);
    }
    if (!res.ok) throw new Error(`Could not start MCP session (HTTP ${res.status}).`);
    const { id } = await res.json();
    if (typeof id !== 'string' || !id.trim()) throw new Error('The MCP server returned an invalid session ID.');
    // Leaving the editor or disabling while POST is in flight must not resurrect a session.
    if (generation !== sessionGeneration || host !== sessionHost) {
      await deleteSession(id);
      return;
    }
    mcpSessionId.set(id);
    failures = 0;
    timer = setInterval(() => void sync(), POLL_MS);
    void sync(); // push the first snapshot immediately so agents can read right away
    toastSuccess('MCP pattern session enabled');
  } catch (error) {
    if (generation !== sessionGeneration) return;
    const message = error instanceof Error ? error.message : 'Could not start MCP session.';
    mcpSessionError.set(message);
    toastError(message);
  } finally {
    if (generation === sessionGeneration) mcpSessionPending.set(false);
  }
}

export async function disableMcpSession(): Promise<void> {
  const id = get(mcpSessionId);
  sessionGeneration++;
  stopPolling();
  mcpSessionId.set(null);
  mcpSessionPending.set(false);
  mcpSessionError.set(null);
  if (!id) return;
  await deleteSession(id);
  toastSuccess('MCP pattern session disabled');
}

function dropDisconnected() {
  stopPolling();
  mcpSessionId.set(null);
  mcpSessionError.set('MCP pattern session disconnected. Enable it again to reconnect.');
  toastError('MCP pattern session disconnected');
}

/** One poll cycle: push the studio snapshot, drain + apply queued external ops. */
async function sync(): Promise<void> {
  const id = get(mcpSessionId);
  if (!id || !host || syncing) return;
  syncing = true;
  const sessionHost = host;
  const generation = sessionGeneration;
  try {
    const res = await fetch(`${base}/api/mcp-session/${id}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: sessionHost.getPattern() })
    });
    if (generation !== sessionGeneration || host !== sessionHost) return;
    if (res.status === 404) { dropDisconnected(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    failures = 0;
    const { ops } = (await res.json()) as { ops: McpOp[] };
    if (generation !== sessionGeneration || host !== sessionHost || !ops?.length) return;
    let applied = 0;
    for (const op of ops) {
      if (op.kind === 'pattern') { sessionHost.applyPattern(op.pattern); applied++; }
      else if (op.kind === 'command') { sessionHost.executeCommand(op.name, op.payload); applied++; }
    }
    if (applied) toastSuccess('External pattern changes applied.');
  } catch {
    if (generation !== sessionGeneration || host !== sessionHost) return;
    failures += 1;
    if (failures >= MAX_FAILURES) dropDisconnected();
  } finally {
    syncing = false;
  }
}

export async function copyMcpSessionId(): Promise<void> {
  const id = get(mcpSessionId);
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    toastSuccess('MCP session ID copied');
  } catch {
    toastError('Could not copy session ID');
  }
}
