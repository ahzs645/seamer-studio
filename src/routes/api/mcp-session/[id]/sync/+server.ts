export const prerender = false;
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { syncStudio } from '$lib/server/mcpSessionStore';
import type { Pattern } from '@seamer/pattern-model';

export const POST: RequestHandler = async ({ params, request }) => {
  const body: { pattern?: Pattern | null } = await request.json();
  const ops = syncStudio(params.id, body.pattern ?? null);
  if (!ops) return json({ error: 'Not found' }, { status: 404 });
  return json({ ops });
};
