import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertGarmentCodePattern } from '$lib/utils/importGarmentCode';
import { PINNED_GATHER_PROGRAMS } from '$lib/utils/pinnedGatherPrograms';
import { approveGeneratedGather, canonicalSha256 } from '$lib/utils/sourceGatherEvidence';
import { generateGarmentCode, generateGarmentCodeJSON } from './garmentCode';
import { POST } from '../../routes/api/garmentcode/+server';

const deployment = vi.hoisted(() => ({ env: { GARMENTCODE_ROOT: '/trusted-fixture', GARMENTCODE_PYTHON: process.execPath, GARMENTCODE_BRIDGE: '' } }));
vi.mock('$env/dynamic/private', () => deployment);
let directory: string, raw: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'seamer-source-transport-'));
  raw = await readFile(new URL('./fixtures/garmentcode-signed-zero.json', import.meta.url), 'utf8');
  deployment.env.GARMENTCODE_BRIDGE = join(directory, 'bridge.mjs');
  await writeFile(deployment.env.GARMENTCODE_BRIDGE, `process.stdin.resume(); process.stdout.write(${JSON.stringify(raw)});`);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const input = { preset: 'skirt', body: { height: 170, waist: 84 }, design: {} } as const;
const options = () => ({ root: deployment.env.GARMENTCODE_ROOT, python: process.execPath, bridge: deployment.env.GARMENTCODE_BRIDGE });
const request = () => new Request('http://localhost/api/garmentcode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });

// Actual captured Python source, including four negative-zero rotations and its signed hash.
// This is generation/transport evidence, not a simulated garment or fit certificate.
describe('generation source JSON transport', () => {
  it('returns the validated original child-process JSON without changing numeric tokens or order', async () => {
    const output = await generateGarmentCodeJSON(input, options());
    expect(output).toBe(raw);
    expect(createHash('sha256').update(output).digest('hex')).toBe('11d130efb1afa3056c6b573802f6a75bbf2ddec968cb18f534f8aad360fee856');
  });

  it('preserves all four actual numeric negative zeros and the source digest through the real POST response', async () => {
    const response = await POST({ request: request() } as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.clone().text()).toBe(raw);
    const actual = await response.json();
    for (const name of ['skirt_back', 'skirt_front', 'wb_front', 'wb_back']) {
      expect(typeof actual.pattern.panels[name].rotation[0]).toBe('number');
      expect(Object.is(actual.pattern.panels[name].rotation[0], -0)).toBe(true);
    }
    expect(await canonicalSha256(actual.pattern)).toBe(actual.properties.garmentcode_gather_evidence.sourcePatternSha256);
    const approval = await approveGeneratedGather(actual, convertGarmentCodePattern(actual), { origin: 'trusted-generator-response', ...PINNED_GATHER_PROGRAMS });
    expect(approval.scope.enabled).toBe(true);
    expect(approval.provenance?.sourcePatternSha256).toBe(actual.properties.garmentcode_gather_evidence.sourcePatternSha256);
    const lossy = JSON.parse(JSON.stringify(actual));
    expect(await canonicalSha256(lossy.pattern)).not.toBe(actual.properties.garmentcode_gather_evidence.sourcePatternSha256);
    await expect(approveGeneratedGather(lossy, convertGarmentCodePattern(lossy), { origin: 'trusted-generator-response', ...PINNED_GATHER_PROGRAMS })).rejects.toThrow('source cuts or stitches changed');
  });

  it('keeps the existing object API and ordinary unannotated generator responses unchanged', async () => {
    const object = await generateGarmentCode(input, options());
    expect(object).toEqual(JSON.parse(raw));
    const originalBridge = deployment.env.GARMENTCODE_BRIDGE;
    try {
      deployment.env.GARMENTCODE_BRIDGE = join(directory, 'ordinary.mjs');
      const ordinary = '{"pattern":{"panels":{"ordinary":{}}},"text":"numeric-looking -0 remains a string"}';
      await writeFile(deployment.env.GARMENTCODE_BRIDGE, `process.stdin.resume(); process.stdout.write(${JSON.stringify(ordinary)});`);
      const response = await POST({ request: request() } as Parameters<typeof POST>[0]);
      expect(await response.json()).toEqual(JSON.parse(ordinary));
    } finally { deployment.env.GARMENTCODE_BRIDGE = originalBridge; }
  });

  it('preserves real child UTF-8 bytes split inside accented letters, emoji and three-byte characters', async () => {
    const originalBridge = deployment.env.GARMENTCODE_BRIDGE;
    const unicodeJSON = '{"pattern":{"panels":{"pièce 🧵 衣":{}}},"text":"préférence 🧵 衣服 -0","value":-0}';
    try {
      deployment.env.GARMENTCODE_BRIDGE = join(directory, 'chunked-unicode.mjs');
      await writeFile(deployment.env.GARMENTCODE_BRIDGE, `
        process.stdin.resume();
        const bytes = Buffer.from(${JSON.stringify(unicodeJSON)}, 'utf8');
        let cursor = 0;
        function next() {
          if (cursor === bytes.length) return;
          process.stdout.write(bytes.subarray(cursor, ++cursor), () => setTimeout(next, 3));
        }
        next();
      `);
      const response = await POST({ request: request() } as Parameters<typeof POST>[0]);
      expect(response.status).toBe(200);
      expect(await response.clone().text()).toBe(unicodeJSON);
      const actual = await response.json();
      expect(actual.text).toBe('préférence 🧵 衣服 -0');
      expect(Object.keys(actual.pattern.panels)).toEqual(['pièce 🧵 衣']);
      expect(Object.is(actual.value, -0)).toBe(true);
      expect(await generateGarmentCode(input, options())).toEqual(JSON.parse(unicodeJSON));
    } finally { deployment.env.GARMENTCODE_BRIDGE = originalBridge; }
  });

  it('counts UTF-8 output bytes rather than decoded characters against the unchanged 8 MiB limit', async () => {
    const originalBridge = deployment.env.GARMENTCODE_BRIDGE;
    try {
      deployment.env.GARMENTCODE_BRIDGE = join(directory, 'oversized-unicode.mjs');
      await writeFile(deployment.env.GARMENTCODE_BRIDGE, `
        process.stdin.resume();
        process.stdout.write('{"pattern":{"panels":{}},"text":"' + '衣'.repeat(3 * 1024 * 1024) + '"}');
        setInterval(() => {}, 1000);
      `);
      await expect(generateGarmentCodeJSON(input, options())).rejects.toMatchObject({
        status: 422, message: expect.stringContaining('exceeds the supported size')
      });
    } finally { deployment.env.GARMENTCODE_BRIDGE = originalBridge; }
  });

  it('still rejects malformed generator JSON before any raw API response can be published', async () => {
    const originalBridge = deployment.env.GARMENTCODE_BRIDGE;
    try {
      deployment.env.GARMENTCODE_BRIDGE = join(directory, 'invalid.mjs');
      await writeFile(deployment.env.GARMENTCODE_BRIDGE, `process.stdin.resume(); process.stdout.write('{"pattern":{"panels":{}}} trailing');`);
      const response = await POST({ request: request() } as Parameters<typeof POST>[0]);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'The generator returned an invalid pattern.' });
    } finally { deployment.env.GARMENTCODE_BRIDGE = originalBridge; }
  });
});
