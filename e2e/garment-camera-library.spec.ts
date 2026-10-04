import { devices, expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { inspectProjection } from './geometry-projection';
import type { Pattern } from '@seamer/pattern-model';
import type { DrapeDebugState } from '../src/lib/scene/scene3d';
import { sourceCameraSafeRect } from '../src/lib/scene/sourceCameraFit';

type Camera = { position: [number, number, number]; target: [number, number, number]; fov: number };
type Api = { getCameraState(): Camera; getState(): DrapeDebugState };
async function activate(button: Locator, touch: boolean) { if (touch) await button.tap(); else await button.click(); }
async function target(button: Locator, touch: boolean) {
  await expect(button).toBeVisible();
  await button.scrollIntoViewIfNeeded();
  if (touch) {
    const sample = () => button.evaluate(node => {
      const b = node.getBoundingClientRect(), style = getComputedStyle(node);
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      const parents: Record<string, unknown>[] = [];
      for (let parent = node.parentElement; parent && !parent.matches('[data-testid="pattern-scene-3d"]'); parent = parent.parentElement) {
        const r = parent.getBoundingClientRect(), css = getComputedStyle(parent);
        parents.push({ className: parent.className, bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
          scrollTop: parent.scrollTop, clientHeight: parent.clientHeight, scrollHeight: parent.scrollHeight,
          overflowY: css.overflowY, transform: css.transform });
      }
      return { at: performance.now(), label: node.getAttribute('aria-label') ?? node.textContent?.trim(),
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        computed: { height: style.height, minHeight: style.minHeight, width: style.width, transform: style.transform,
          scale: style.scale, animation: style.animation, transition: style.transition },
        centerHit: hit?.closest('button') === node,
        hit: hit ? { tag: hit.tagName, className: hit.className, text: hit.textContent?.trim(), button: hit.closest('button')?.getAttribute('aria-label') ?? hit.closest('button')?.textContent?.trim() } : null,
        parents };
    });
    const observations = [await sample()];
    const diagnosticPath = test.info().outputPath(`touch-target-${observations[0].label?.replace(/[^a-z0-9]+/gi, '-')}-${randomUUID()}.json`);
    // The list-only reporter discards in-memory attachments on a pass; persist actual measurements first.
    await writeFile(diagnosticPath, JSON.stringify(observations, null, 2), { flag: 'wx' });
    try {
      await expect.poll(async () => {
        const actual = await sample(); observations.push(actual);
        return actual.bounds.width >= 44 && actual.bounds.height >= 44 && actual.centerHit;
      }, { timeout: 1000 }).toBe(true);
    } finally {
      observations.push(await sample());
      await writeFile(diagnosticPath, JSON.stringify(observations, null, 2));
      await test.info().attach(`touch-target-${observations[0].label}`, {
        path: diagnosticPath, contentType: 'application/json'
      });
    }
  }
  return button.boundingBox();
}
async function model(page: Page): Promise<Pattern> { return page.evaluate(() => (window as unknown as { seamer: { getPattern(): Pattern } }).seamer.getPattern()); }
async function view(page: Page) {
  return page.getByTestId('pattern-scene-3d').evaluate(shell => {
    const api = (window as unknown as { __seamerWebgpuDrape: Api }).__seamerWebgpuDrape;
    const b = shell.querySelector('canvas')!.getBoundingClientRect();
    const obstacles = [...shell.querySelectorAll<HTMLElement>('.scene-controls,.scene-camera,.scene-lighting,.scene-poses,.scene-info,.scene-mobile-primary,.scene-mobile-drawer,.scene-sim-panel,.scene-status-notice')]
      .filter(node => node.getClientRects().length).map(node => { const r = node.getBoundingClientRect(); return { left: r.left - b.left, right: r.right - b.left, top: r.top - b.top, bottom: r.bottom - b.top, name: node.className }; });
    const rail = shell.querySelector<HTMLElement>('.scene-desktop-controls');
    const railRect = rail?.getBoundingClientRect();
    const controlsRail = rail && railRect ? { scrollTop: rail.scrollTop, scrollHeight: rail.scrollHeight,
      clientHeight: rail.clientHeight, top: railRect.top, bottom: railRect.bottom,
      buttons: [...rail.querySelectorAll<HTMLButtonElement>('button')].map(node => {
        const r = node.getBoundingClientRect(); return { label: node.getAttribute('aria-label'), top: r.top, bottom: r.bottom,
          fullyWithinRail: r.top >= railRect.top && r.bottom <= railRect.bottom,
          centerHit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === node };
      }) } : null;
    return { controlsRail, camera: api.getCameraState(), state: api.getState(), canvas: { width: b.width, height: b.height }, obstacles };
  });
}
async function reveal(page: Page, touch: boolean) {
  const button = page.getByRole('button', { name: 'Expand 3D controls', exact: true });
  if (await button.isVisible()) { await target(button, touch); await activate(button, touch); }
}
async function cameraAction(page: Page, name: string, touch: boolean) {
  if (!(touch && name === 'Zoom to garment')) await reveal(page, touch);
  const button = page.getByTestId('pattern-scene-3d').getByRole('button', { name, exact: true }).filter({ visible: true });
  if (touch && name === 'Zoom to garment') {
    await expect(page.getByRole('button', { name: 'Close 3D controls', exact: true })).not.toBeVisible();
    await expect(button).toHaveCount(1);
    // Verify the camera shortcut is immediately reachable in the primary row before scrolling.
    await expect.poll(() => button.evaluate(node => {
      const r = node.getBoundingClientRect();
      const row = node.closest('.scene-mobile-primary')?.getBoundingClientRect();
      return !!row && r.width >= 44 && r.height >= 44 && r.left >= row.left && r.right <= row.right &&
        row.left >= 0 && row.right <= innerWidth &&
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === node;
    }), { timeout: 1000 }).toBe(true);
  }
  const bounds = await target(button, touch); await activate(button, touch);
  if (touch) {
    await expect(page.getByRole('button', { name: 'Close 3D controls', exact: true })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Expand 3D controls', exact: true })).toBeFocused();
  }
  return bounds;
}
async function obj(page: Page, touch: boolean, info: TestInfo, name: string) {
  await reveal(page, touch);
  const pending = page.waitForEvent('download');
  await activate(page.getByRole('button', { name: 'Download as OBJ', exact: true }).filter({ visible: true }), touch);
  const file = info.outputPath(`${name}.obj`); await (await pending).saveAs(file);
  const close = page.getByRole('button', { name: 'Close 3D controls', exact: true });
  if (await close.isVisible()) await activate(close, touch);
  const text = await readFile(file, 'utf8');
  const objects = text.split(/^o .*$/m).map(block => block.split('\n').filter(line => line.startsWith('v ')).map(line => line.trim().split(/\s+/).slice(1, 4).map(Number))).filter(points => points.length);
  expect(objects[0].length, 'Actual exporter includes the visible body mesh first').toBeGreaterThan(1000);
  expect(objects.length).toBeGreaterThan(1);
  return { objects, body: objects[0], cloth: objects.slice(1).flat(), sha256: createHash('sha256').update(text).digest('hex') };
}
function projected(points: number[][], actual: Awaited<ReturnType<typeof view>>) {
  const report = inspectProjection(points, actual);
  expect(report.vertexCount).toBe(points.length);
  expect(report.nonFiniteVertices).toBe(0);
  expect(report.depthViolations).toBe(0);
  return report.bounds;
}
function clearOfControls(bounds: ReturnType<typeof projected>, actual: Awaited<ReturnType<typeof view>>) {
  const rect = sourceCameraSafeRect(actual.canvas.width, actual.canvas.height, actual.obstacles); expect(rect).not.toBeNull();
  expect(bounds.left).toBeGreaterThanOrEqual(rect!.left); expect(bounds.right).toBeLessThanOrEqual(rect!.right);
  expect(bounds.top).toBeGreaterThanOrEqual(rect!.top); expect(bounds.bottom).toBeLessThanOrEqual(rect!.bottom);
}
async function menu(page: Page, name: string, touch: boolean) {
  const button = page.locator('.studio-topbar').getByRole('button', { name, exact: true });
  if (!(await button.isVisible())) await activate(page.locator('.studio-topbar').getByRole('button', { name: 'More', exact: true }), touch);
  await activate(button, touch);
}
async function generate(page: Page, touch: boolean, info: TestInfo) {
  await page.addInitScript(() => { localStorage.setItem('seamer.welcomeSeen', '1'); localStorage.setItem('seamer.autosaveSeconds', '600'); });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await activate(page.getByTestId('templates-menu-trigger'), touch); await activate(page.getByTestId('template-garmentcode'), touch);
  const dialog = page.getByRole('dialog', { name: 'GarmentCode garment', exact: true }); await dialog.getByRole('combobox').selectOption('skirt');
  for (const [label, value] of [['Height', '170'], ['Bust / chest', '99.8407'], ['Waist', '84.3338'], ['Hips', '103.478'], ['Arm length', '53.9697'], ['Skirt length ratio', '.5']] as const) await dialog.getByLabel(label, { exact: true }).fill(value);
  const pending = page.waitForResponse(response => response.url().endsWith('/api/garmentcode') && response.request().method() === 'POST');
  await activate(dialog.getByRole('button', { name: 'Generate garment', exact: true }), touch); const response = await pending;
  const raw = await response.text(); await writeFile(info.outputPath('actual-generator-response.json'), raw); await writeFile(info.outputPath('actual-generator-request.json'), response.request().postData()!); expect(response.status(), raw).toBe(200);
  await expect(dialog).not.toBeVisible({ timeout: 90_000 });
  await activate(page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }), touch);
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 667, height: 375 }]) {
  test(`actual garment camera and Library at ${viewport.width}x${viewport.height}`, async ({ browser, baseURL }, info) => {
    test.setTimeout(180_000); const touch = viewport.width < 1024;
    const context = await browser.newContext({ ...devices[touch ? 'Pixel 7' : 'Desktop Chrome'], viewport, baseURL, acceptDownloads: true, serviceWorkers: 'block' });
    const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const evidence: Record<string, unknown> = { viewport, touchEmulation: touch, fitAccepted: false, scope: 'Camera/Library usability using actual cold published source; no simulation or geometry injection' };
    const save = () => writeFile(info.outputPath('actual-camera-library.json'), JSON.stringify(evidence, null, 2));
    try {
      await generate(page, touch, info); const original = await model(page); evidence.originalSource = original.garmentCodeSource;
      const before = await view(page), geometry = await obj(page, touch, info, 'actual-before-focus');
      const full = await view(page); const fullBounds = projected(geometry.objects.flat(), full); const fullClothBounds = projected(geometry.cloth, full); clearOfControls(fullBounds, full);
      if (viewport.width === 667 && viewport.height === 375) {
        const notice = page.getByTestId('pattern-scene-3d').locator('.scene-reassembly-info');
        const measurement = await notice.evaluate(node => {
          const r = node.getBoundingClientRect(), canvas = node.closest('[data-testid="pattern-scene-3d"]')!.querySelector('canvas')!.getBoundingClientRect();
          const full = node.querySelector<HTMLElement>('.source-reassembly-full')!;
          const compact = node.querySelector<HTMLElement>('.source-reassembly-compact')!;
          return { topWithinCanvas: r.top - canvas.top, height: r.height, width: r.width,
            fullMessage: full.textContent, fullClipPath: getComputedStyle(full).clipPath,
            compactMessage: compact.textContent, compactDisplay: getComputedStyle(compact).display,
            compactAriaHidden: compact.getAttribute('aria-hidden') };
        });
        evidence.actualCompactSourceNotice = measurement; await save();
        expect(measurement.topWithinCanvas).toBe(8); expect(measurement.height).toBeLessThanOrEqual(28);
        expect(measurement.compactMessage).toBe('Start simulation to reassemble'); expect(measurement.compactDisplay).not.toBe('none');
        expect(measurement.compactAriaHidden).toBe('true'); expect(measurement.fullMessage).toBe('This garment reassembles when reopened. Start simulation to drape it.');
        await expect(notice).toMatchAriaSnapshot('- status: This garment reassembles when reopened. Start simulation to drape it.');
      }
      evidence.fullBody = { ...full, projectedBounds: fullBounds, clothProjectedBounds: fullClothBounds, geometrySha256: geometry.sha256 }; await save(); await page.screenshot({ path: info.outputPath('actual-full-body.png') });
      evidence.zoomTarget = await cameraAction(page, 'Zoom to garment', touch);
      await expect.poll(async () => (await view(page)).camera).not.toEqual(before.camera);
      const focused = await view(page), focusBounds = projected(geometry.cloth, focused); evidence.garmentFocus = { ...focused, projectedBounds: focusBounds }; await save(); await page.screenshot({ path: info.outputPath('actual-garment-focus.png') });
      clearOfControls(focusBounds, focused);
      if (viewport.width === 667 && viewport.height === 375) {
        // Strictly improve the earlier observed110.8px actual projection without discarding notice obstacles.
        expect(focusBounds.bottom - focusBounds.top).toBeGreaterThan(110.8);
      }
      expect((focusBounds.bottom - focusBounds.top) * (focusBounds.right - focusBounds.left)).toBeGreaterThan((fullClothBounds.bottom - fullClothBounds.top) * (fullClothBounds.right - fullClothBounds.left));
      expect(focused.camera.fov).toBe(full.camera.fov); expect(focused.state.deviceAcquired).toBe(false);
      const afterGeometry = await obj(page, touch, info, 'actual-after-focus'); expect(afterGeometry.objects).toEqual(geometry.objects);
      expect((await model(page)).garmentCodeSource).toEqual(original.garmentCodeSource);
      const trigger = page.getByTestId('templates-menu-trigger'); await expect(trigger).toHaveText(/Library/); await target(trigger, touch); await activate(trigger, touch);
      const library = page.getByRole('dialog', { name: 'Pattern library', exact: true }); const normalBounds = (await library.boundingBox())!;
      evidence.libraryNormal = { bounds: normalBounds, measuredMaxHeight: await library.evaluate(node => getComputedStyle(node).maxHeight) }; await save(); await page.screenshot({ path: info.outputPath('actual-library.png') });
      expect(normalBounds.y + normalBounds.height).toBeLessThanOrEqual(viewport.height); if (viewport.height === 375) expect(normalBounds.height).toBeGreaterThanOrEqual(300);
      await library.getByRole('searchbox', { name: 'Search pattern library', exact: true }).fill('skirt');
      if (touch) {
        const reduced = { width: viewport.width, height: Math.min(viewport.height, 280) }; await page.setViewportSize(reduced);
        await expect.poll(async () => { const b = (await library.boundingBox())!; return b.y >= 0 && b.y + b.height <= reduced.height; }).toBe(true);
        await library.locator('.library-item').first().scrollIntoViewIfNeeded();
        const close = library.getByRole('button', { name: 'Close pattern library', exact: true }); await target(close, true);
        evidence.libraryReducedViewport = { explicitlyEmulatedKeyboardSpace: true, viewport: reduced, bounds: await library.boundingBox(), closeBounds: await close.boundingBox() }; await save(); await page.screenshot({ path: info.outputPath('actual-library-reduced-viewport.png') });
        await activate(close, true); await expect(trigger).toBeFocused(); await page.setViewportSize(viewport);
      } else { await page.keyboard.press('Escape'); await expect(trigger).toBeFocused(); }
      await activate(trigger, touch); await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
      await expect.poll(async () => (await model(page)).settings3d.cameraPosition).toEqual(focused.camera.position);
      const pending = page.waitForEvent('download'); await menu(page, 'Export', touch); await activate(page.getByRole('button', { name: 'Seamer Project — 2D + 3D (.ssp)', exact: true }), touch);
      const archivePath = info.outputPath('actual-camera.ssp'); await (await pending).saveAs(archivePath); const archive = JSON.parse(gunzipSync(await readFile(archivePath)).toString('utf8')) as { pattern: Pattern };
      expect(archive.pattern.settings3d.cameraPosition).toEqual(focused.camera.position); expect(archive.pattern.settings3d.controlsTarget).toEqual(focused.camera.target); expect(archive.pattern.settings3d.sourceCameraFraming).toBeUndefined();
      const chooser = page.waitForEvent('filechooser'); await activate(page.getByTestId('import-menu-trigger'), touch); await activate(page.getByRole('button', { name: 'From file… (project or auto-detect)', exact: true }), touch); await (await chooser).setFiles(archivePath);
      await expect.poll(async () => (await model(page)).pieces.map(piece => piece.settings3d.savedPositions)).toEqual(archive.pattern.pieces.map(piece => piece.settings3d.savedPositions));
      await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });
      await expect.poll(async () => (await view(page)).camera).toEqual(focused.camera); expect((await view(page)).state.deviceAcquired).toBe(false);
      evidence.reopenedCamera = await view(page); await save();
      await cameraAction(page, 'Reset view', touch); const reset = await view(page); const resetGeometry = await obj(page, touch, info, 'actual-after-full-body-reset');
      const resetBounds = projected(resetGeometry.objects.flat(), await view(page)); evidence.resetFullBody = { ...reset, projectedBounds: resetBounds }; await save(); await page.screenshot({ path: info.outputPath('actual-reset-full-body.png') });
      clearOfControls(resetBounds, await view(page)); expect(resetGeometry.objects).toEqual(geometry.objects);
      expect(errors).toEqual([]); expect((await view(page)).state.deviceAcquired).toBe(false);
    } finally {
      try {
        if (!page.isClosed()) { evidence.errors = errors; evidence.final = await view(page).catch(() => null); await save(); await page.screenshot({ path: info.outputPath('final-interface.png') }).catch(() => {}); }
      } finally {
        await context.close();
        await writeFile(info.outputPath('resources-closed.json'), JSON.stringify({ contextClosed: true,
          observedSolverDeviceAcquired: (evidence.final as Awaited<ReturnType<typeof view>> | null)?.state.deviceAcquired ?? null,
          browserManagedByPlaywright: true, fitAccepted: false }));
      }
    }
  });
}
