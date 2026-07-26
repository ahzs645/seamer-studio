export const prerender = false;
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { Pattern } from '@seamer/pattern-model';
import { deletePattern, getPattern, putPattern } from '$lib/server/patternStore';

export const GET: RequestHandler = async ({ params }) => {
  const pattern = getPattern(params.id);
  if (!pattern) return json({ error: 'Not found' }, { status: 404 });
  return json(pattern);
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const pattern: Pattern = await request.json();
  putPattern({ ...pattern, id: params.id });
  return json(pattern);
};

export const DELETE: RequestHandler = async ({ params }) => {
  deletePattern(params.id);
  return json({ success: true });
};
