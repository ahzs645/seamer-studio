export const prerender = false;
import { json } from '@sveltejs/kit';
import { releaseNotes } from '$lib/server/releaseNotes';

export async function GET() {
  return json(releaseNotes);
}
