import { json, type RequestHandler } from '@sveltejs/kit';
import { collaborationStore as store, CollaborationError } from '$lib/server/collaborationStore';
export const prerender = false;
const cookieName = 'seamer_session';
const attempts = new Map<string, { count: number; reset: number }>();
const response = (value: unknown) => json(value, { headers: { 'Cache-Control': 'no-store' } });
export const GET: RequestHandler = async ({ params, cookies, url }) => {
  const token = cookies.get(cookieName) ?? '';
  const [action, id] = (params.action ?? '').split('/');
  try {
    if (action === 'status') return response({ available: true, storage: 'persistent', protocol: 1 });
    if (action === 'session') return response(await store.account(token));
    if (action === 'documents') {
      if (!id) return response(await store.list(token));
      const value = await store.get(token, id);
      return response(url.searchParams.get('since') === value.changeToken ? { unchanged: true } : value);
    }
    if (action === 'versions' && id) return response(await store.version(token, id, Number(url.searchParams.get('revision'))));
    throw new CollaborationError(404, 'Unknown collaboration endpoint.');
  } catch (error) { return failure(error); }
};
export const POST: RequestHandler = async ({ params, cookies, request, url, getClientAddress }) => {
  try {
    // Browsers always provide Origin on these JSON mutations. Reject cross-site and missing origins.
    if (request.headers.get('origin') !== url.origin) throw new CollaborationError(403, 'A same-origin request is required.');
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new CollaborationError(415, 'JSON is required.');
    const text = await limitedText(request);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CollaborationError(400, 'Invalid request.');
    const [action, id] = (params.action ?? '').split('/');
    const token = cookies.get(cookieName) ?? '';
    if (action === 'login' || action === 'register') {
      const address = getClientAddress();
      const limit = attempts.get(address);
      if (limit && limit.reset > Date.now() && limit.count >= 10) throw new CollaborationError(429, 'Too many sign-in attempts. Try again in one minute.');
      attempts.set(address, { count: (limit && limit.reset > Date.now() ? limit.count : 0) + 1, reset: limit && limit.reset > Date.now() ? limit.reset : Date.now() + 60_000 });
      if (attempts.size > 1000) for (const [key, value] of attempts) if (value.reset < Date.now()) attempts.delete(key);
      if (typeof body.email !== 'string' || typeof body.password !== 'string') throw new CollaborationError(400, 'Email and password are required.');
      const session = action === 'login' ? await store.login(body.email, body.password) : await store.register(body.email, body.password, String(body.name ?? ''));
      cookies.set(cookieName, session.token, { path: '/', httpOnly: true, sameSite: 'strict', secure: url.protocol === 'https:', maxAge: 7 * 86400 });
      return response(session.account);
    }
    if (action === 'logout') { await store.logout(token); cookies.delete(cookieName, { path: '/' }); return response({ ok: true }); }
    if (action === 'documents') {
      if (id) return response(await store.save(token, id, Number(body.revision), body.pattern as Parameters<typeof store.save>[3]));
      return response(await store.create(token, body.pattern as Parameters<typeof store.create>[1]));
    }
    if (action === 'members' && id) return response(await store.grant(token, id, String(body.email ?? ''), body.role as 'editor' | 'viewer' | 'remove'));
    if (action === 'chat' && id) return response(await store.chat(token, id, String(body.text ?? '')));
    throw new CollaborationError(404, 'Unknown collaboration endpoint.');
  } catch (error) { return failure(error); }
};
function failure(error: unknown) {
  const status = error instanceof CollaborationError ? error.status : error instanceof SyntaxError ? 400 : 500;
  return json({ error: error instanceof CollaborationError ? error.message : status === 400 ? 'Invalid JSON.' : 'The collaboration server could not complete this request.' }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function limitedText(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new CollaborationError(400, 'A JSON body is required.');
  const decoder = new TextDecoder(); let result = '', bytes = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
    if (bytes > 12_100_000) { await reader.cancel(); throw new CollaborationError(413, 'Request is too large.'); }
    result += decoder.decode(chunk.value, { stream: true });
  } } finally { reader.releaseLock(); }
  return result + decoder.decode();
}
