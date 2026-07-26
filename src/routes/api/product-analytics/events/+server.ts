export const prerender = false;
import { json } from '@sveltejs/kit';

// Local-first build: accept analytics events but record nothing.
export async function POST() {
  return json({ ok: true, skipped: true });
}
