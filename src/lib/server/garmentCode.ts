import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { GARMENTCODE_PRESETS, type GarmentCodeRequest } from '$lib/data/garmentCode';

export class GarmentCodeError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseGarmentCodeRequest(value: unknown): GarmentCodeRequest {
  if (!isRecord(value) || Object.keys(value).some(key => !['preset', 'body', 'design'].includes(key))) {
    throw new GarmentCodeError('Provide a garment preset, body measurements, and design options.', 400);
  }
  if (!GARMENTCODE_PRESETS.some(preset => preset.id === value.preset)) {
    throw new GarmentCodeError('Choose a supported garment preset.', 400);
  }
  const body = value.body ?? {};
  const design = value.design ?? {};
  if (!isRecord(body) || Object.entries(body).some(([key, measurement]) =>
    !/^[a-z][a-z_]*$/.test(key) || typeof measurement !== 'number' || !Number.isFinite(measurement))) {
    throw new GarmentCodeError('Body measurements must be finite numbers.', 400);
  }
  if (!isRecord(design)) throw new GarmentCodeError('Design options must be an object.', 400);
  return { preset: value.preset, body, design } as GarmentCodeRequest;
}

let running = 0;
const MAX_OUTPUT = 8 * 1024 * 1024;

type GarmentCodeGenerationOptions = {
  root?: string;
  python?: string;
  bridge?: string;
  timeoutMs?: number;
};

/** Keep the parsed-object API for callers that need to inspect the specification. */
export async function generateGarmentCode(request: GarmentCodeRequest, options: GarmentCodeGenerationOptions): Promise<unknown> {
  return (await runGarmentCode(request, options)).specification;
}

/** Validated original JSON retains IEEE-754 signed zero and source panel order.
 * Re-serializing a parsed specification would invalidate its generation evidence. */
export async function generateGarmentCodeJSON(request: GarmentCodeRequest, options: GarmentCodeGenerationOptions): Promise<string> {
  return (await runGarmentCode(request, options)).json;
}

async function runGarmentCode(request: GarmentCodeRequest, options: GarmentCodeGenerationOptions): Promise<{ specification: unknown; json: string }> {
  if (!options.root) throw new GarmentCodeError('Garment generation is unavailable on this host. You can open an example or import a GarmentCode JSON file.', 503);
  if (running >= 2) throw new GarmentCodeError('The generator is busy. Please try again shortly.', 429);
  running += 1;
  try {
    return await new Promise((fulfill, reject) => {
      const child = spawn(options.python || 'python3', [options.bridge || resolve('scripts/garmentcode/generate.py')], {
        shell: false,
        env: { ...process.env, GARMENTCODE_ROOT: options.root, MPLBACKEND: 'Agg' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let output = '', diagnostics = '', bytes = 0;
      const outputDecoder = new StringDecoder('utf8');
      let failure: GarmentCodeError | null = null;
      const timer = setTimeout(() => {
        failure = new GarmentCodeError('Garment generation took too long. Try a simpler design.', 504);
        child.kill('SIGKILL');
      }, options.timeoutMs ?? 60_000);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) {
          failure = new GarmentCodeError('The generated garment exceeds the supported size. Try a simpler design.');
          child.kill('SIGKILL');
        } else output += outputDecoder.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-16_384); });
      child.stdin.on('error', () => { /* close/error reports a process that exited before reading */ });
      child.on('error', () => {
        clearTimeout(timer);
        reject(new GarmentCodeError('The garment generator could not start. Check the server setup.', 503));
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (failure) { reject(failure); return; }
        if (code !== 0) {
          const detail = diagnostics.split('\n').findLast(line => line.startsWith('GarmentCode generation failed'));
          reject(new GarmentCodeError(detail?.slice(0, 500) || 'The generator could not build this garment. Check the measurements and design options.', code === 2 ? 422 : 503));
          return;
        }
        try {
          output += outputDecoder.end();
          const spec = JSON.parse(output);
          if (!isRecord(spec) || !isRecord(spec.pattern) || !isRecord(spec.pattern.panels)) throw new Error('Missing panels');
          fulfill({ specification: spec, json: output });
        } catch { reject(new GarmentCodeError('The generator returned an invalid pattern.', 502)); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  } finally { running -= 1; }
}
