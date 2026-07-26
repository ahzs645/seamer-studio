export const prerender = false;
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSession } from '$lib/server/mcpSessionStore';

export const POST: RequestHandler = async () => {
  const session = createSession();
  return json({ id: session.id }, { status: 201 });
};
