export const prerender = false;
import { json } from '@sveltejs/kit';

let promptState: { dismissedAt?: string; reviewedAt?: string } = {};

export async function GET() {
  return json({ ok: true, ...promptState });
}

export async function POST({ request }: { request: Request }) {
  const body = await request.json().catch(() => ({}));
  promptState = { ...promptState, ...body };
  return json({ ok: true });
}
