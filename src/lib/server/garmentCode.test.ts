import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateGarmentCode, parseGarmentCodeRequest } from './garmentCode';

const request = { preset: 't-shirt', body: { bust: 104 }, design: {} } as const;
let directory: string;
let nextScript = 0;

beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'seamer-garmentcode-test-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

/** A real child process exercises streams, exit codes, timers, and cleanup. */
async function fixture(source: string) {
  const bridge = join(directory, `bridge-${nextScript++}.mjs`);
  await writeFile(bridge, source);
  return { python: process.execPath, bridge, root: '/trusted/garment-code-fixture', timeoutMs: 5_000 };
}

describe('GarmentCode request boundary', () => {
  it('accepts supported presets and optional measurement/design objects', () => {
    expect(parseGarmentCodeRequest({ preset: 'pants' })).toEqual({ preset: 'pants', body: {}, design: {} });
    expect(parseGarmentCodeRequest(request)).toEqual(request);
  });

  it('rejects executable paths, unknown presets, malformed bodies and non-finite values', () => {
    const invalid = [
      null, [], { preset: 'fake' }, { preset: ['t-shirt'] },
      { ...request, python: '/tmp/arbitrary' }, { ...request, root: '/tmp/arbitrary' },
      { ...request, body: [] }, { ...request, body: { _leg_length: 1 } },
      { ...request, body: { bust: '100' } }, { ...request, body: { bust: Number.POSITIVE_INFINITY } },
      { ...request, design: [] }
    ];
    for (const input of invalid) expect(() => parseGarmentCodeRequest(input)).toThrow();
  });
});

describe('GarmentCode child-process boundary', () => {
  it('explains unavailable static-only hosts without starting a process', async () => {
    await expect(generateGarmentCode(request, {})).rejects.toMatchObject({ status: 503, message: expect.stringContaining('import a GarmentCode JSON') });
  });

  it('passes JSON input and only deployment-owned interpreter/root/bridge configuration', async () => {
    const options = await fixture(`
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ pattern: { panels: { fixture: {} } }, request: JSON.parse(input), root: process.env.GARMENTCODE_ROOT }));
      });
    `);
    await expect(generateGarmentCode(request, options)).resolves.toMatchObject({
      request, root: options.root, pattern: { panels: { fixture: {} } }
    });
  });

  it('maps a missing interpreter to a clear configuration failure and frees its slot', async () => {
    const options = await fixture('process.stdin.resume();');
    await expect(generateGarmentCode(request, { ...options, python: join(directory, 'missing-python') }))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining('could not start') });
    const valid = await fixture(`process.stdin.resume(); process.stdout.write('{"pattern":{"panels":{}}}');`);
    await expect(generateGarmentCode(request, valid)).resolves.toMatchObject({ pattern: { panels: {} } });
  });

  it('returns a concise bridge error for rejected measurements', async () => {
    const options = await fixture(`
      process.stdin.resume();
      process.stderr.write('unrelated warning\\nGarmentCode generation failed (InputError): body.bust must be positive\\n');
      process.exitCode = 2;
    `);
    await expect(generateGarmentCode(request, options)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('body.bust') });
  });

  it('does not expose unrelated diagnostics from a crashed generator', async () => {
    const options = await fixture(`process.stdin.resume(); process.stderr.write('private deployment diagnostic'); process.exitCode = 1;`);
    await expect(generateGarmentCode(request, options)).rejects.toMatchObject({ status: 503, message: expect.not.stringContaining('private deployment') });
  });

  it('rejects malformed stdout and JSON lacking pattern panels', async () => {
    for (const output of ['upstream debug line\n{}', JSON.stringify({ pattern: [] }), JSON.stringify({ pattern: { panels: [] } })]) {
      const options = await fixture(`process.stdin.resume(); process.stdout.write(${JSON.stringify(output)});`);
      await expect(generateGarmentCode(request, options)).rejects.toMatchObject({ status: 502 });
    }
  });

  it('terminates stalled geometry generation at the execution deadline', async () => {
    const options = await fixture('process.stdin.resume(); setInterval(() => {}, 1000);');
    await expect(generateGarmentCode(request, { ...options, timeoutMs: 50 })).rejects.toMatchObject({ status: 504 });
    const valid = await fixture(`process.stdin.resume(); process.stdout.write('{"pattern":{"panels":{}}}');`);
    await expect(generateGarmentCode(request, valid)).resolves.toMatchObject({ pattern: { panels: {} } });
  });

  it('terminates excessive stdout rather than importing a truncated garment', async () => {
    const options = await fixture(`
      process.stdin.resume();
      process.stdout.write('x'.repeat(9 * 1024 * 1024));
      setInterval(() => {}, 1000);
    `);
    await expect(generateGarmentCode(request, options)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('exceeds the supported size') });
  });

  it('allows two active requests and rejects a third without leaking slots', async () => {
    const options = await fixture(`
      process.stdin.resume();
      setTimeout(() => process.stdout.write('{"pattern":{"panels":{}}}'), 100);
    `);
    const first = generateGarmentCode(request, options);
    const second = generateGarmentCode(request, options);
    await expect(generateGarmentCode(request, options)).rejects.toMatchObject({ status: 429 });
    await Promise.all([first, second]);
    await expect(generateGarmentCode(request, options)).resolves.toMatchObject({ pattern: { panels: {} } });
  });
});
