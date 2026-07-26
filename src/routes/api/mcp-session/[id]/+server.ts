export const prerender = false;
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteSession, readSession } from '$lib/server/mcpSessionStore';

export const GET: RequestHandler = async ({ params }) => {
  const session = readSession(params.id);
  if (!session) return json({ error: 'Not found' }, { status: 404 });
  return json({
    id: session.id,
    createdAt: session.createdAt,
    queuedOps: session.inbox.length,
    pattern: session.pattern
  });
};

export const DELETE: RequestHandler = async ({ params }) => {
  if (!deleteSession(params.id)) return json({ error: 'Not found' }, { status: 404 });
  return json({ success: true });
};
