export const prerender = false;
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { GarmentCodeError, generateGarmentCodeJSON, parseGarmentCodeRequest } from '$lib/server/garmentCode';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const tooLarge = () => json({ error: 'The design request is too large.' }, { status: 413 });
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 64 * 1024) return tooLarge();
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 64 * 1024) {
            // Cancelling the Node request stream destroys its socket before the 413 can be sent.
            // Release our reader without buffering the remaining body and let the server respond.
            return tooLarge();
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { return json({ error: 'Provide valid JSON garment options.' }, { status: 400 }); }
    const input = parseGarmentCodeRequest(value);
    const specification = await generateGarmentCodeJSON(input, {
      root: env.GARMENTCODE_ROOT,
      python: env.GARMENTCODE_PYTHON,
      bridge: env.GARMENTCODE_BRIDGE
    });
    // Send validated generator bytes directly: JSON.stringify turns numeric -0 into 0.
    return new Response(specification, { headers: { 'content-type': 'application/json; charset=utf-8' } });
  } catch (error) {
    if (error instanceof GarmentCodeError) return json({ error: error.message }, { status: error.status });
    return json({ error: 'Garment generation failed. Please try again.' }, { status: 500 });
  }
};
