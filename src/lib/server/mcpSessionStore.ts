import type { Pattern } from '@seamer/pattern-model';

// MCP pattern sessions — the local-first bridge between the studio and an external agent
// (an MCP server, script, curl…). The studio polls /sync: it pushes its latest pattern snapshot
// and drains the inbox of ops the agent queued. The agent reads the snapshot via GET and queues
// ops via POST /ops. No auth: knowing the (unguessable) session id is the capability.

/** An operation queued by an external agent for the studio to apply. */
export type McpOp =
  | { kind: 'pattern'; pattern: Pattern }
  | { kind: 'command'; name: string; payload?: Record<string, unknown> };

export interface McpSession {
  id: string;
  createdAt: string;
  /** Latest pattern snapshot pushed by the studio (null until the first /sync). */
  pattern: Pattern | null;
  /** External ops queued for the studio, drained on the next /sync. */
  inbox: McpOp[];
  lastSeenByStudio: number;
  lastSeenByAgent: number;
}

const IDLE_EXPIRY_MS = 30 * 60 * 1000;

// Single in-memory store shared by all /api/mcp-session* endpoints.
const sessions = new Map<string, McpSession>();

/** Drop sessions neither side has touched for 30 minutes. Runs on every access. */
function expireIdle(now = Date.now()): void {
  for (const [id, s] of sessions) {
    if (now - Math.max(s.lastSeenByStudio, s.lastSeenByAgent) > IDLE_EXPIRY_MS) sessions.delete(id);
  }
}

export function createSession(): McpSession {
  expireIdle();
  const now = Date.now();
  const session: McpSession = {
    id: crypto.randomUUID(),
    createdAt: new Date(now).toISOString(),
    pattern: null,
    inbox: [],
    lastSeenByStudio: now,
    lastSeenByAgent: now
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): McpSession | undefined {
  expireIdle();
  return sessions.get(id);
}

/** Agent → studio: queue ops for the studio's next /sync. Returns false on unknown session. */
export function enqueueOps(id: string, ops: McpOp[]): boolean {
  const session = getSession(id);
  if (!session) return false;
  session.inbox.push(...ops);
  session.lastSeenByAgent = Date.now();
  return true;
}

/** Agent read: latest studio snapshot + queue depth. Counts as agent activity. */
export function readSession(id: string): McpSession | undefined {
  const session = getSession(id);
  if (session) session.lastSeenByAgent = Date.now();
  return session;
}

/** Studio /sync: store the latest snapshot and drain the inbox. Undefined on unknown session. */
export function syncStudio(id: string, pattern: Pattern | null): McpOp[] | undefined {
  const session = getSession(id);
  if (!session) return undefined;
  if (pattern) session.pattern = pattern;
  session.lastSeenByStudio = Date.now();
  return session.inbox.splice(0, session.inbox.length);
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}
