import { devices, expect, test, type Page, type Locator } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { PerspectiveCamera, Vector3 } from 'three';

type CameraState = { position: [number, number, number]; target: [number, number, number]; fov: number };
async function cameraState(page: Page): Promise<CameraState | null> {
  return page.evaluate(() => (window as unknown as { __seamerWebgpuDrape?: {
    getCameraState: () => CameraState | null
  } }).__seamerWebgpuDrape?.getCameraState() ?? null);
}

function cameraDifference(actual: CameraState | null, expected: CameraState | null) {
  if (!actual || !expected) return Infinity;
  return Math.max(Math.abs(actual.fov - expected.fov),
    ...actual.position.map((v, i) => Math.abs(v - expected.position[i])),
    ...actual.target.map((v, i) => Math.abs(v - expected.target[i])));
}

async function importFile(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/json', buffer });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue(name.replace(/\.(json|ssp)$/, ''));
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready');
}

async function revealControls(page: Page) {
  const expand = page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Expand 3D controls', exact: true });
  if (await expand.isVisible()) await expand.click();
}

async function actualTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate(element => {
    const r = element.getBoundingClientRect();
    return r.width >= 44 && r.height >= 44 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button,[role="button"]') === element;
  })).toBe(true);
  return locator.boundingBox();
}

async function inspectShortTouchLayout(page: Page) {
  const header = page.locator('.studio-topbar');
  const scene = page.getByTestId('pattern-scene-3d');
  const canvas = await scene.boundingBox();
  const headerBounds = await header.boundingBox();
  expect(headerBounds!.height).toBeLessThanOrEqual(105);
  expect(canvas!.height).toBeGreaterThanOrEqual(248);
  const trigger = page.getByTestId('templates-menu-trigger');
  const targets = [];
  for (const button of [trigger, page.getByTestId('import-menu-trigger'), header.locator('[data-tour-id="tour-save"]'), header.getByRole('button', { name: 'More', exact: true })]) {
    const bounds = await actualTouchTarget(button);
    targets.push({ label: await button.innerText(), bounds });
  }
  for (let a = 0; a < targets.length; a++) for (let b = a + 1; b < targets.length; b++) {
    const first = targets[a].bounds!, second = targets[b].bounds!;
    expect(first.x < second.x + second.width && first.x + first.width > second.x
      && first.y < second.y + second.height && first.y + first.height > second.y,
    `Visible header actions overlap: ${targets[a].label}/${targets[b].label}`).toBe(false);
  }
  await trigger.tap();
  const library = page.getByRole('dialog', { name: 'Pattern library', exact: true });
  await expect(library).toBeVisible();
  const libraryBounds = (await library.boundingBox())!;
  expect(libraryBounds.y).toBeGreaterThanOrEqual(0);
  expect(libraryBounds.y + libraryBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await actualTouchTarget(library.getByRole('button', { name: 'Close pattern library', exact: true }));
  await library.getByRole('button', { name: 'Close pattern library', exact: true }).tap();
  await expect(trigger).toBeFocused();
  const more = header.getByRole('button', { name: 'More', exact: true });
  await more.tap();
  await actualTouchTarget(header.getByRole('button', { name: 'Layers and body panel', exact: true }));
  const fabric = header.getByRole('button', { name: 'Fabric', exact: true });
  await actualTouchTarget(fabric); await fabric.tap();
  const panels = page.getByRole('dialog', { name: 'Layers, body, fabric and seams', exact: true });
  await expect(panels.getByRole('button', { name: 'Fabric', exact: true })).toHaveClass(/tab-active/);
  await panels.getByRole('button', { name: 'Close pattern panels', exact: true }).tap();
  await expect(more).toBeFocused();
  const primary = scene.getByRole('group', { name: 'Primary 3D controls', exact: true });
  await expect(primary.getByRole('button')).toHaveCount(3);
  for (const button of await primary.getByRole('button').all()) await actualTouchTarget(button);
  await scene.getByRole('button', { name: 'Expand 3D controls', exact: true }).tap();
  const controls = scene.getByRole('group', { name: '3D controls', exact: true });
  const close = controls.getByRole('button', { name: 'Close 3D controls', exact: true });
  await actualTouchTarget(close); await close.tap();
  await expect(scene.getByRole('button', { name: 'Expand 3D controls', exact: true })).toBeFocused();
  expect(await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth - innerWidth,
    vertical: document.documentElement.scrollHeight - innerHeight }))).toEqual({ horizontal: 0, vertical: 0 });
  return { headerBounds, canvasBounds: canvas, actualHeaderTargets: targets, libraryBounds, primaryBounds: await primary.boundingBox() };
}

async function actualGeometry(page: Page) {
  await revealControls(page);
  const pending = page.waitForEvent('download');
  await page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Download as OBJ', exact: true }).click();
  const file = await (await pending).path();
  expect(file).not.toBeNull();
  return (await readFile(file!, 'utf8')).split('\n').filter(line => line.startsWith('v '))
    .map(line => line.trim().split(/\s+/).slice(1, 4).map(Number));
}

async function inspectFraming(page: Page, points: number[][]) {
  const layout = await page.getByTestId('pattern-scene-3d').evaluate(shell => {
    const canvas = shell.querySelector('canvas')!.getBoundingClientRect();
    const controls = Array.from(shell.querySelectorAll<HTMLElement>(
      '.scene-controls,.scene-camera,.scene-lighting,.scene-poses,.scene-info,.scene-mobile-primary'))
      .filter(element => element.getClientRects().length > 0).map(element => {
        const r = element.getBoundingClientRect();
        return { className: element.className, left: r.left - canvas.left, right: r.right - canvas.left,
          top: r.top - canvas.top, bottom: r.bottom - canvas.top };
      });
    return { width: canvas.width, height: canvas.height, controls };
  });
  const state = await cameraState(page);
  expect(state).not.toBeNull();
  const camera = new PerspectiveCamera(state!.fov, layout.width / layout.height, .01, 100);
  camera.position.fromArray(state!.position); camera.lookAt(new Vector3(...state!.target)); camera.updateMatrixWorld();
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const p of points) {
    const v = new Vector3(...p).project(camera);
    expect(Number.isFinite(v.x) && Number.isFinite(v.y) && v.z > -1 && v.z < 1).toBe(true);
    const x = (v.x + 1) * layout.width / 2, y = (1 - v.y) * layout.height / 2;
    bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x);
    bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
  }
  expect(points.length).toBeGreaterThan(500);
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(layout.width);
  expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(layout.height);
  for (const r of layout.controls) {
    expect(bounds.left < r.right && bounds.right > r.left && bounds.top < r.bottom && bounds.bottom > r.top,
      `Actual rendered geometry overlaps visible control container ${r.className}`).toBe(false);
  }
  return { camera: state, canvas: layout, actualExportedVertexCount: points.length, projectedGeometryBounds: bounds };
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 },
  { width: 360, height: 800 }, { width: 667, height: 375 }]) {
  test(`fresh source camera fits actual garment/body and Reset at ${viewport.width}x${viewport.height}`, async ({ browser, request, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ ...(viewport.width < 700 ? devices['Pixel 7'] : devices['Desktop Chrome']),
      viewport, baseURL, serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(() => {
        localStorage.setItem('seamer.welcomeSeen', '1'); localStorage.setItem('seamer.autosaveSeconds', '600');
        const target = window as unknown as { __cameraTrace: unknown[]; __seamerWebgpuDrape?: { getCameraState: () => CameraState | null } };
        target.__cameraTrace = [];
        let previous = '';
        setInterval(() => {
          const actual = target.__seamerWebgpuDrape?.getCameraState();
          const s = window.seamer?.getPattern().settings3d;
          if (!actual || !s) return;
          const stored = { position: s.cameraPosition, target: s.controlsTarget, fov: s.cameraFov, sourceCameraFraming: s.sourceCameraFraming };
          const signature = JSON.stringify({ actual, stored });
          if (signature === previous) return;
          previous = signature; target.__cameraTrace.push({ milliseconds: performance.now(), actual, stored });
        }, 100);
      });
      const response = await request.post('/api/garmentcode', { data: { preset: 'dress', body: { height: 176, waist: 88 }, design: {} } });
      expect(response.ok(), await response.text()).toBe(true);
      const source = await response.text();
      await writeFile(testInfo.outputPath('actual-generated-source.json'), source);
      await page.goto('/studio', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready');
      await importFile(page, 'fresh-camera-source.json', Buffer.from(source));
      await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().settings3d.sourceCameraFraming)).toBe('viewport');
      const shortLayout = viewport.width === 667 ? await inspectShortTouchLayout(page) : null;
      const points = await actualGeometry(page);
      const initial = await inspectFraming(page, points);
      await writeFile(testInfo.outputPath('initial-framing-observed.json'), JSON.stringify(initial, null, 2));
      await page.screenshot({ path: testInfo.outputPath(`initial-source-${viewport.width}.png`) });
      let savedRoundTrip: unknown = null;
      if (viewport.width === 1280) {
        // An explicit Save persists the live fitted view and removes fresh-import intent.
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.seamer!.getPattern().settings3d.sourceCameraFraming)).toBeUndefined();
        const saved = await cameraState(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('pattern-name-input')).toHaveValue('fresh-camera-source');
        await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready');
        await expect.poll(async () => cameraDifference(await cameraState(page), saved)).toBeLessThan(1e-10);
        const restored = await cameraState(page);
        const sceneBounds = (await page.getByTestId('pattern-scene-3d').boundingBox())!;
        await page.mouse.move(sceneBounds.x + 30, sceneBounds.y + sceneBounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(sceneBounds.x + 85, sceneBounds.y + sceneBounds.height / 2 + 20, { steps: 5 });
        await page.mouse.up();
        await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().settings3d.cameraPosition[0])).not.toBe(saved!.position[0]);
        await expect.poll(async () => {
          const actual = (await cameraState(page))!;
          const persisted = await page.evaluate(() => window.seamer!.getPattern().settings3d.cameraPosition);
          return Math.max(...actual.position.map((v, i) => Math.abs(v - persisted[i])));
        }).toBeLessThan(1e-7);
        const orbited = await cameraState(page);
        await page.setViewportSize({ width: 1200, height: 720 });
        await expect.poll(async () => cameraDifference(await cameraState(page), orbited)).toBeLessThan(1e-10);
        savedRoundTrip = { saved, restored, actualUserOrbit: orbited, resizedOrbit: await cameraState(page) };
      }
      await revealControls(page);
      await page.getByTestId('pattern-scene-3d').locator('button[title="Front view"]:visible').click();
      await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().settings3d.sourceCameraFraming)).toBeUndefined();
      await revealControls(page);
      await page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Reset view', exact: true }).click();
      const reset = await inspectFraming(page, points);
      await page.screenshot({ path: testInfo.outputPath(`reset-source-${viewport.width}.png`) });
      await writeFile(testInfo.outputPath('framing-observed.json'), JSON.stringify({ viewport, emulatedPhone: viewport.width < 700,
        initial, reset, savedRoundTrip, shortLayout, errors, garmentAccepted: false, evidenceScope: 'Actual source cold rendering and camera/interface only; no simulation or physical phone.' }, null, 2));
      expect(errors).toEqual([]);
    } finally {
      if (!page.isClosed()) {
        try {
          const trace = await page.evaluate(() => (window as unknown as { __cameraTrace: unknown[] }).__cameraTrace);
          await writeFile(testInfo.outputPath('actual-camera-timeline.json'), JSON.stringify(trace));
        } catch { /* Preserve the original test error if the context was already lost. */ }
      }
      await context.close();
    }
  });
}
