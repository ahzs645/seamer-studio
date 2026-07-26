export const prerender = false;
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enqueueOps, type McpOp } from '$lib/server/mcpSessionStore';

const isOp = (o: unknown): o is McpOp => {
  if (!o || typeof o !== 'object') return false;
  const op = o as Record<string, unknown>;
  if (op.kind === 'pattern') return !!op.pattern && typeof op.pattern === 'object';
  if (op.kind === 'command') return typeof op.name === 'string' && op.name.length > 0;
  return false;
};

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json();
  const ops: unknown[] = Array.isArray(body) ? body : (body?.ops ?? []);
  if (!ops.length || !ops.every(isOp)) {
    return json({ error: 'Expected ops: [{ kind: "pattern", pattern } | { kind: "command", name, payload? }]' }, { status: 400 });
  }
  if (!enqueueOps(params.id, ops)) return json({ error: 'Not found' }, { status: 404 });
  return json({ queued: ops.length });
};
