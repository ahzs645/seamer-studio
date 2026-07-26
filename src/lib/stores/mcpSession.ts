// MCP pattern session — studio-side controller.
//
// When enabled, the studio creates a server session (/api/mcp-session) and polls /sync every ~2s:
// it pushes its current pattern snapshot (so external agents can read it) and applies any ops the
// agent queued — full-pattern replacements through the studio's undo-aware update path, command ops
// through the same command bus the palette / window.seamer uses. Local-first, no auth: the
// session id is the capability. The studio page wires the host in onMount via configureMcpSession().

import { writable, get } from 'svelte/store';
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

const POLL_MS = 2000;
const MAX_FAILURES = 3;

let host: McpSessionHost | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let failures = 0;
let syncing = false;

/** Install the studio host. Returns a disposer that stops polling (without deleting the session). */
export function configureMcpSession(h: McpSessionHost): () => void {
  host = h;
  return () => {
    stopPolling();
    mcpSessionId.set(null);
    host = null;
  };
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  failures = 0;
}

export async function enableMcpSession(): Promise<void> {
  if (!host || get(mcpSessionId)) return;
  try {
    const res = await fetch('/api/mcp-session', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { id } = await res.json();
    mcpSessionId.set(id);
    failures = 0;
    timer = setInterval(() => void sync(), POLL_MS);
    void sync(); // push the first snapshot immediately so agents can read right away
    toastSuccess('MCP pattern session enabled');
  } catch {
    toastError('Could not start MCP session');
  }
}

export async function disableMcpSession(): Promise<void> {
  const id = get(mcpSessionId);
  stopPolling();
  mcpSessionId.set(null);
  if (!id) return;
  try { await fetch(`/api/mcp-session/${id}`, { method: 'DELETE' }); } catch { /* session expires server-side */ }
  toastSuccess('MCP pattern session disabled');
}

function dropDisconnected() {
  stopPolling();
  mcpSessionId.set(null);
  toastError('MCP pattern session disconnected');
}

/** One poll cycle: push the studio snapshot, drain + apply queued external ops. */
async function sync(): Promise<void> {
  const id = get(mcpSessionId);
  if (!id || !host || syncing) return;
  syncing = true;
  try {
    const res = await fetch(`/api/mcp-session/${id}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: host.getPattern() })
    });
    if (res.status === 404) { dropDisconnected(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    failures = 0;
    const { ops } = (await res.json()) as { ops: McpOp[] };
    if (!ops?.length) return;
    let applied = 0;
    for (const op of ops) {
      if (op.kind === 'pattern') { host.applyPattern(op.pattern); applied++; }
      else if (op.kind === 'command') { host.executeCommand(op.name, op.payload); applied++; }
    }
    if (applied) toastSuccess('External pattern changes applied.');
  } catch {
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
