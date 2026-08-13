// Compile every WGSL kernel on a real WebGPU implementation and build its compute pipeline.
//
// The unit tests never touch the GPU, so a shader can be syntactically fine, typecheck fine, and
// still fail at runtime — which is the one failure mode that takes the whole drape with it. Two
// classes of problem show up only here:
//
//   * WGSL compile errors, which surface as `getCompilationInfo` messages.
//   * Binding-limit violations. WebGPU only GUARANTEES eight storage buffers per shader stage
//     (`maxStorageBuffersPerShaderStage`), and plenty of real hardware stops there even though the
//     software adapter used here allows ten. A ninth storage buffer compiles and then fails to make
//     a pipeline. Pipelines are therefore built with the BASELINE limits, not the adapter's, so this
//     check fails on the machine that can afford it rather than on a user's.
//
// Chromium's software WebGPU adapter is enough for both: no GPU required.
//
//   node scripts/check-wgsl.mjs

import { chromium } from '@playwright/test';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';

/** WebGPU's guaranteed floor. Anything above this is a device that may not exist for the user. */
const BASELINE_LIMITS = {
  maxStorageBuffersPerShaderStage: 8,
  maxUniformBuffersPerShaderStage: 12,
  maxStorageBufferBindingSize: 128 * 1024 * 1024
};

async function loadShaders() {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const config = await vite.ssrLoadModule('/packages/cloth-sim/src/config.ts');
    const shaders = await vite.ssrLoadModule('/packages/cloth-sim/src/webgpu/shaders.ts');
    const cfg = config.SIM_CONFIG;
    const HASH = 1024;
    return {
      integrate: shaders.integrateWGSL(cfg),
      distance: shaders.distanceConstraintWGSL(cfg),
      bending: shaders.bendingConstraintWGSL(cfg),
      seam: shaders.seamWGSL(cfg, config.seamMaxDisplacementSq(cfg)),
      initExternalCollision: shaders.initExternalCollisionWGSL(cfg, HASH),
      solveExternalCollision: shaders.solveExternalCollisionWGSL(cfg, 12),
      applyCorrections: shaders.applyCorrectionsWGSL(),
      resetCorrections: shaders.resetCorrectionsWGSL(),
      triangleCenters: shaders.triangleCentersWGSL(),
      clearU32: shaders.clearU32WGSL(),
      countHash: shaders.countHashWGSL(HASH, cfg.clothSpacing),
      prefixSum: shaders.prefixSumWGSL(HASH),
      fillHash: shaders.fillHashWGSL(HASH, cfg.clothSpacing),
      initSelfCollision: shaders.initSelfCollisionWGSL(cfg, HASH),
      solveSelfCollision: shaders.solveSelfCollisionWGSL(cfg),
      nearDamping: shaders.nearDampingWGSL(cfg),
      computeDampingState: shaders.computeDampingStateWGSL(),
      applyLocalDamping: shaders.applyLocalDampingWGSL(cfg),
      velocity: shaders.velocityWGSL(cfg)
    };
  } finally {
    await vite.close();
  }
}

const shaders = await loadShaders();

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>wgsl</title>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

// `--use-webgpu-adapter=swiftshader` is what makes this run without a GPU at all.
const launchArgs = ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--no-sandbox'];

/** Prefer Playwright's own browser; fall back to a preinstalled one when the pin doesn't match. */
async function launchChromium() {
  try {
    return await chromium.launch({ args: launchArgs });
  } catch (error) {
    const fallback = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
    if (!existsSync(fallback)) throw error;
    return chromium.launch({ args: launchArgs, executablePath: fallback });
  }
}

const browser = await launchChromium();
let failures = [];
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const report = await page.evaluate(async ([shaders, limits]) => {
    if (!navigator.gpu) return { fatal: 'navigator.gpu is unavailable in this browser build' };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { fatal: 'no WebGPU adapter' };
    const requiredLimits = {};
    for (const [key, value] of Object.entries(limits)) {
      if (adapter.limits[key] !== undefined) requiredLimits[key] = Math.min(value, adapter.limits[key]);
    }
    const device = await adapter.requestDevice({ requiredLimits });
    const results = {};
    for (const [name, code] of Object.entries(shaders)) {
      device.pushErrorScope('validation');
      const module = device.createShaderModule({ code });
      const info = await module.getCompilationInfo();
      const errors = info.messages
        .filter((message) => message.type === 'error')
        .map((message) => `line ${message.lineNum}:${message.linePos} — ${message.message}`);
      let pipeline = null;
      if (errors.length === 0) {
        try {
          await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
        } catch (error) {
          pipeline = String(error);
        }
      }
      await device.popErrorScope();
      results[name] = { errors, pipeline };
    }
    return { results, appliedLimits: requiredLimits };
  }, [shaders, BASELINE_LIMITS]);

  if (report.fatal) {
    console.error(`Cannot check WGSL: ${report.fatal}`);
    process.exitCode = 1;
  } else {
    const names = Object.keys(report.results);
    for (const name of names) {
      const { errors, pipeline } = report.results[name];
      if (errors.length === 0 && !pipeline) continue;
      failures.push(name);
      console.error(`\n✗ ${name}`);
      for (const error of errors) console.error(`    ${error}`);
      if (pipeline) console.error(`    pipeline: ${pipeline.trim()}`);
    }
    const limits = Object.entries(report.appliedLimits).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(
      failures.length === 0
        ? `\n✓ ${names.length} kernels compile and build a pipeline at baseline limits (${limits})`
        : `\n${failures.length} of ${names.length} kernels failed`
    );
    if (failures.length > 0) process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.close();
}
