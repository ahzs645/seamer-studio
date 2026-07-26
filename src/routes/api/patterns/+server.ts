export const prerender = false;
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { Pattern } from '@seamer/pattern-model';
import { listPatterns, putPattern } from '$lib/server/patternStore';

export const GET: RequestHandler = async () => {
  return json(listPatterns());
};

export const POST: RequestHandler = async ({ request }) => {
  const pattern: Pattern = await request.json();
  putPattern(pattern);
  return json(pattern, { status: 201 });
};
