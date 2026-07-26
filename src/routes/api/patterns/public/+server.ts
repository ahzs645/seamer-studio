export const prerender = false;
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listPatterns } from '$lib/server/patternStore';

export const GET: RequestHandler = async () => {
  return json(listPatterns((p) => p.isPublic));
};
