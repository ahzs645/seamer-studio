import { devices, expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { PerspectiveCamera, Vector3 } from 'three';
import type { Pattern } from '@seamer/pattern-model';
import type { DrapeDebugState, DrapeFailureDiagnostics } from '../src/lib/scene/scene3d';

// These cases exercise the real trusted generator and original/refined mesh lifecycle.
// They never create approvals, simulate accepted frames, or certify a settled garment fit.
test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader',
    ...(process.platform === 'linux' ? ['--use-webgpu-adapter=swiftshader'] : [])] } });

type CameraState = { position: [number, number, number]; target: [number, number, number]; fov: number };
type DebugApi = { getState: () => DrapeDebugState | null; getCameraState: () => CameraState | null;
  getFailureDiagnostics: () => DrapeFailureDiagnostics | null };

async function actualPattern(page: Page): Promise<Pattern> {
  return page.evaluate(() => (window as unknown as { seamer: { getPattern: () => Pattern } }).seamer.getPattern());
}

async function state(page: Page) {
  return page.evaluate(() => {
    const actual = (window as unknown as { __seamerWebgpuDrape?: DebugApi }).__seamerWebgpuDrape?.getState();
    if (!actual) return null;
    const stage = actual.sourceAssemblyState;
    return { ...actual, sourceAssemblyState: stage && { ...stage,
      activeSeamMask: Array.from(stage.activeSeamMask), activeStitchMask: Array.from(stage.activeStitchMask) } };
  });
}

async function touchTarget(control: Locator) {
  await expect(control).toBeVisible();
  await expect.poll(() => control.evaluate(element => {
    const r = element.getBoundingClientRect();
    return r.width >= 44 && r.height >= 44
      && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === element;
  }), { timeout: 1000 }).toBe(true);
  return control.boundingBox();
}

async function activate(control: Locator, touch: boolean) {
  if (touch) await control.tap({ timeout: 15_000 }); else await control.click({ timeout: 15_000 });
}

async function revealControls(page: Page, touch: boolean) {
  const expand = page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Expand 3D controls', exact: true });
  if (await expand.isVisible()) await activate(expand, touch);
}

async function dismissDrawer(page: Page, touch: boolean) {
  const close = page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Close 3D controls', exact: true });
  if (await close.isVisible()) {
    if (touch) await touchTarget(close);
    await activate(close, touch);
    await expect(page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Expand 3D controls', exact: true })).toBeFocused();
  }
}

async function generateTrustedSkirt(page: Page, touch: boolean, info: TestInfo) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '600');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toBeVisible();
  await activate(page.getByTestId('templates-menu-trigger'), touch);
  await activate(page.getByTestId('template-garmentcode'), touch);
  const dialog = page.getByRole('dialog', { name: 'GarmentCode garment', exact: true });
  await dialog.getByRole('combobox').selectOption('skirt');
  for (const [label, value] of [['Height', '170'], ['Bust / chest', '99.8407'], ['Waist', '84.3338'],
    ['Hips', '103.478'], ['Arm length', '53.9697']] as const) {
    await dialog.getByLabel(label, { exact: true }).fill(value);
  }
  await dialog.getByLabel('Skirt length ratio', { exact: true }).fill('0.5');
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/garmentcode')
    && response.request().method() === 'POST');
  await activate(dialog.getByRole('button', { name: 'Generate garment', exact: true }), touch);
  const response = await responsePromise;
  const responseText = await response.text();
  await writeFile(info.outputPath('actual-generator-response.json'), responseText);
  await writeFile(info.outputPath('actual-generator-request.json'), response.request().postData() ?? '');
  expect(response.status(), responseText).toBe(200);
  const raw = JSON.parse(responseText);
  expect(raw.properties.garmentcode_gather_evidence.stitches.length).toBeGreaterThan(0);
  await expect.poll(async () => !(await dialog.isVisible()) || await dialog.getByRole('alert').isVisible(),
    { timeout: 90_000 }).toBe(true);
  const generationError = await dialog.getByRole('alert').isVisible() ? await dialog.getByRole('alert').innerText() : null;
  expect(generationError, 'Trusted generation must import successfully, preserving exact source provenance').toBeNull();
  await expect(dialog).not.toBeVisible({ timeout: 90_000 });
  await activate(page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }), touch);
  const scene = page.getByTestId('pattern-scene-3d');
  await expect(scene).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });
  const pattern = await actualPattern(page);
  expect(pattern.garmentCodeSource?.gatherProvenance?.origin).toBe('trusted-generator-response');
  expect(pattern.garmentCodeSource?.gatherSourceDocument).toBeDefined();
  await expect(scene.getByText('This garment reassembles when reopened. Start simulation to drape it.', { exact: true })).toBeVisible();
  expect((await state(page))?.deviceAcquired).toBe(false);
  return pattern;
}

async function menuAction(page: Page, label: string, touch: boolean) {
  const control = page.getByRole('button', { name: label, exact: true });
  if (!(await control.isVisible())) await activate(page.locator('.studio-topbar').getByRole('button', { name: 'More', exact: true }), touch);
  await activate(control, touch);
}

async function exportArchive(page: Page, touch: boolean, info: TestInfo, name: string) {
  const pending = page.waitForEvent('download');
  await menuAction(page, 'Export', touch);
  await activate(page.getByRole('button', { name: 'Seamer Project — 2D + 3D (.ssp)', exact: true }), touch);
  const file = info.outputPath(name);
  await (await pending).saveAs(file);
  await expect(page.locator('#studio-export-menu')).not.toBeVisible();
  const trigger = page.locator('.studio-topbar').getByRole('button', { name: touch ? 'More' : 'Export', exact: true });
  await expect(trigger).toBeFocused();
  if (touch) {
    await touchTarget(trigger);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const toast = page.locator('.toast-message').filter({ hasText: 'Exported Seamer project (.ssp)' }).last();
    await expect(toast).toBeVisible();
    const dismiss = toast.getByRole('button', { name: 'Dismiss', exact: true });
    await touchTarget(dismiss);
    if (name === 'actual-refined-checkpoint.ssp') {
      const primary = page.getByRole('group', { name: 'Primary 3D controls', exact: true });
      for (const control of await primary.getByRole('button').all()) await touchTarget(control);
      const toastBounds = await toast.boundingBox();
      const primaryBounds = await primary.boundingBox();
      expect(toastBounds!.y + toastBounds!.height).toBeLessThanOrEqual(primaryBounds!.y);
      await writeFile(info.outputPath('actual-immediate-export-toast.json'), JSON.stringify({
        toastBounds, primaryBounds, dismissBounds: await dismiss.boundingBox(),
        controlsUnobscured: true, garmentAccepted: false }, null, 2));
      await page.screenshot({ path: info.outputPath('actual-immediate-export-toast.png') });
    }
    await activate(dismiss, true);
    await expect(toast).not.toBeVisible();
  }
  const bytes = await readFile(file);
  const envelope = JSON.parse(gunzipSync(bytes).toString('utf8')) as { pattern: Pattern };
  return { file, bytes, pattern: envelope.pattern };
}

async function importArchive(page: Page, touch: boolean, file: string, expected: Pattern) {
  // Navigate using the actual reachable Close action if a user opened More separately.
  const close = page.locator('.studio-topbar').getByRole('button', { name: 'Close studio actions', exact: true });
  if (await close.isVisible()) {
    if (touch) await touchTarget(close);
    await activate(close, touch);
    await expect(page.locator('.studio-topbar').getByRole('button', { name: 'More', exact: true })).toBeFocused();
  }
  const scene = page.getByTestId('pattern-scene-3d');
  await scene.evaluate(shell => {
    const observed: string[] = [];
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.oldValue) observed.push(record.oldValue);
        observed.push(shell.getAttribute('data-status') ?? '');
      }
    });
    observer.observe(shell, { attributes: true, attributeFilter: ['data-status'], attributeOldValue: true });
    (window as unknown as { __importObservation: { observed: string[]; observer: MutationObserver } }).__importObservation = { observed, observer };
  });
  const chooser = page.waitForEvent('filechooser', { timeout: 15_000 });
  await activate(page.getByTestId('import-menu-trigger'), touch);
  await activate(page.getByRole('button', { name: /From file/ }), touch);
  await (await chooser).setFiles(file);
  // A previously ready scene remains visible during the real350ms rebuild debounce.
  // First bind to the committed document, then require an observed new loading/ready cycle.
  await expect.poll(async () => (await actualPattern(page)).pieces.map(piece => ({ id: piece.id,
    savedPositions: piece.settings3d.savedPositions, intent: piece.settings3d.savedSourceGatherIntent,
    marker: piece.settings3d.savedSourceGatherPolicy })), { timeout: 90_000 }).toEqual(expected.pieces.map(piece => ({ id: piece.id,
    savedPositions: piece.settings3d.savedPositions, intent: piece.settings3d.savedSourceGatherIntent,
    marker: piece.settings3d.savedSourceGatherPolicy })));
  await expect.poll(() => page.evaluate(() => {
    const observed = (window as unknown as { __importObservation: { observed: string[] } }).__importObservation.observed;
    const loading = observed.indexOf('loading');
    return loading >= 0 && observed.slice(loading + 1).includes('ready');
  }), { timeout: 90_000 }).toBe(true);
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await expect(page.locator('#studio-import-menu')).not.toBeVisible();
  await expect(page.getByTestId('import-menu-trigger')).toBeFocused();
  await page.evaluate(() => (window as unknown as { __importObservation: { observer: MutationObserver } }).__importObservation.observer.disconnect());
}

function sourceCuts(pattern: Pattern) {
  return { points: pattern.points, paths: pattern.paths, seams: pattern.seams,
    pieces: pattern.pieces.map(piece => {
      const placement = piece.settings3d.arrangement.sourcePlacement;
      return { id: piece.id, mainPaths: piece.mainPaths, sourcePlacement: placement && { ...placement,
        // Derived affine matrix zeros are geometrically identical. Standard SSP JSON stores
        // them as +0; every nonzero coordinate and all authored source bytes remain exact.
        worldMatrix: placement.worldMatrix.map(value => value === 0 ? 0 : value) } };
    }) };
}

async function cutSha256(page: Page, pattern: Pattern): Promise<string> {
  return page.evaluate(async pattern => {
    const moduleUrl = '/src/lib/utils/sourceGatherEvidence.ts';
    const { sourceCutSha256 } = await import(moduleUrl);
    return sourceCutSha256(pattern);
  }, pattern);
}

async function assertOriginalSource(page: Page, actual: Pattern, original: Pattern, originalCutSha: string) {
  expect(sourceCuts(actual)).toEqual(sourceCuts(original));
  expect(actual.body).toEqual(original.body);
  // Tagged raw IEEE numbers preserve -0, panel order, resolved inputs and every stitch.
  expect(actual.garmentCodeSource?.gatherSourceDocument).toEqual(original.garmentCodeSource?.gatherSourceDocument);
  expect(actual.garmentCodeSource?.gatherProvenance).toEqual(original.garmentCodeSource?.gatherProvenance);
  expect(await cutSha256(page, actual)).toBe(originalCutSha);
}

async function inspectFraming(page: Page, touch: boolean, info: TestInfo, label: string) {
  await revealControls(page, touch);
  const pending = page.waitForEvent('download');
  await activate(page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Download as OBJ', exact: true }), touch);
  const download = await pending;
  const file = info.outputPath(label + '.obj');
  await download.saveAs(file);
  const points = (await readFile(file, 'utf8')).split('\n').filter(line => line.startsWith('v '))
    .map(line => line.trim().split(/\s+/).slice(1, 4).map(Number));
  await dismissDrawer(page, touch);
  const layout = await page.getByTestId('pattern-scene-3d').evaluate(shell => {
    const r = shell.querySelector('canvas')!.getBoundingClientRect();
    const obstacles = Array.from(shell.querySelectorAll<HTMLElement>(
      '.scene-controls,.scene-camera,.scene-lighting,.scene-poses,.scene-info,.scene-mobile-primary,.scene-status-notice'))
      .filter(element => element.getClientRects().length > 0).map(element => {
        const b = element.getBoundingClientRect();
        return { className: element.className, text: element.textContent?.trim(), left: b.left - r.left, right: b.right - r.left,
          top: b.top - r.top, bottom: b.bottom - r.top };
      });
    return { width: r.width, height: r.height, obstacles };
  });
  const cameraState = await page.evaluate(() => (window as unknown as { __seamerWebgpuDrape: DebugApi }).__seamerWebgpuDrape.getCameraState());
  expect(cameraState).not.toBeNull();
  const camera = new PerspectiveCamera(cameraState!.fov, layout.width / layout.height, .01, 100);
  camera.position.fromArray(cameraState!.position);
  camera.lookAt(new Vector3(...cameraState!.target)); camera.updateMatrixWorld();
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const p of points) {
    const v = new Vector3(...p).project(camera);
    expect(Number.isFinite(v.x) && Number.isFinite(v.y) && v.z > -1 && v.z < 1).toBe(true);
    const x = (v.x + 1) * layout.width / 2, y = (1 - v.y) * layout.height / 2;
    bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x);
    bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
  }
  const observed = { camera: cameraState, canvas: layout, actualExportedVertexCount: points.length,
    projectedGeometryBounds: bounds, garmentAccepted: false };
  // Preserve observed coordinates and image before any clearance assertion can fail.
  await writeFile(info.outputPath(label + '-framing.json'), JSON.stringify(observed, null, 2));
  await page.screenshot({ path: info.outputPath(label + '.png') });
  expect(points.length).toBeGreaterThan(500);
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(layout.width);
  expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(layout.height);
  for (const obstacle of layout.obstacles) {
    expect(bounds.left < obstacle.right && bounds.right > obstacle.left && bounds.top < obstacle.bottom && bounds.bottom > obstacle.top,
      `Actual cloth/body projection overlaps ${obstacle.className}: ${obstacle.text}`).toBe(false);
  }
  return observed;
}

async function inspectLibraryAndControls(page: Page, touch: boolean) {
  const trigger = page.getByTestId('templates-menu-trigger');
  if (touch) await touchTarget(trigger);
  await activate(trigger, touch);
  const library = page.getByRole('dialog', { name: 'Pattern library', exact: true });
  await expect(library.getByLabel('Search pattern library', { exact: true })).toBeVisible();
  const close = library.getByRole('button', { name: 'Close pattern library', exact: true });
  if (touch) await touchTarget(close);
  await activate(close, touch);
  await expect(trigger).toBeFocused();
  const importTrigger = page.getByTestId('import-menu-trigger');
  if (touch) await touchTarget(importTrigger);
  await importTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(importTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /From file/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#studio-import-menu')).not.toBeVisible();
  await expect(importTrigger).toBeFocused();
  await menuAction(page, 'Export', touch);
  const exportTrigger = page.locator('.studio-topbar').getByRole('button', { name: 'Export', exact: true });
  await expect(exportTrigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#studio-export-menu')).not.toBeVisible();
  await expect(exportTrigger).toBeFocused();
  if (touch) {
    const closeActions = page.locator('.studio-topbar').getByRole('button', { name: 'Close studio actions', exact: true });
    await touchTarget(closeActions);
    await activate(closeActions, true);
    await expect(page.locator('.studio-topbar').getByRole('button', { name: 'More', exact: true })).toBeFocused();
    const scene = page.getByTestId('pattern-scene-3d');
    const primary = scene.getByRole('group', { name: 'Primary 3D controls', exact: true });
    for (const control of await primary.getByRole('button').all()) await touchTarget(control);
    await revealControls(page, true);
    await dismissDrawer(page, true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
}

async function inspectTimelineTargets(page: Page, touch: boolean) {
  await revealControls(page, touch);
  await activate(page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Assembly timeline', exact: true }), touch);
  const timeline = page.getByRole('group', { name: 'Assembly timeline', exact: true });
  await expect(timeline).toBeVisible();
  const observed = [];
  for (const label of ['Record from the finished form', 'Record from flat', 'Close']) {
    const button = timeline.getByRole('button', { name: label, exact: true });
    const bounds = touch ? await touchTarget(button) : await button.boundingBox();
    observed.push({ label, bounds });
  }
  await activate(timeline.getByRole('button', { name: 'Close', exact: true }), touch);
  await expect(timeline).not.toBeVisible();
  return observed;
}

async function preserveFailure(page: Page, info: TestInfo) {
  const diagnostic = await page.evaluate(() => {
    const d = (window as unknown as { __seamerWebgpuDrape?: DebugApi }).__seamerWebgpuDrape?.getFailureDiagnostics();
    if (!d) return null;
    let base64: string | null = null;
    if (d.candidateTrajectory) {
      const width = d.candidateTrajectory[0].length;
      const bytes = new Uint8Array(d.candidateTrajectory.length * width * 4), view = new DataView(bytes.buffer);
      d.candidateTrajectory.forEach((sample, step) => {
        if (sample.length !== width) throw Error('Rejected trajectory dimensions changed');
        sample.forEach((value, index) => view.setFloat32((step * width + index) * 4, value, true));
      });
      let encoded = '';
      for (let start = 0; start < bytes.length; start += 32768) encoded += String.fromCharCode(...bytes.subarray(start, start + 32768));
      base64 = btoa(encoded);
    }
    return { ...d, candidateTrajectory: undefined, base64,
      candidatePositions: d.candidatePositions && Array.from(d.candidatePositions), previousPositions: Array.from(d.previousPositions),
      bodyPositions: Array.from(d.bodyPositions), bodyTriangles: Array.from(d.bodyTriangles),
      clothTriangles: Array.from(d.clothTriangles), seams: Array.from(d.seams) };
  });
  if (!diagnostic) return null;
  const { base64, ...metadata } = diagnostic;
  await writeFile(info.outputPath('actual-rejected-diagnostic.json'), JSON.stringify(metadata));
  let sampleCount: number | null = null;
  if (base64) {
    const bytes = Buffer.from(base64, 'base64');
    const frameBytes = diagnostic.particleCount * 16;
    sampleCount = bytes.length / frameBytes;
    await writeFile(info.outputPath('actual-rejected-trajectory.bin'), bytes);
    await writeFile(info.outputPath('actual-rejected-trajectory.json'), JSON.stringify({ diagnosticOnly: true,
      format: 'float32-le-vec4', byteLength: bytes.length, sampleCount,
      sha256: createHash('sha256').update(bytes).digest('hex'), particleCount: diagnostic.particleCount,
      subSteps: diagnostic.config.subSteps, report: diagnostic.report }, null, 2));
    expect(sampleCount).toBe(diagnostic.config.subSteps + 1);
    const pack = (values: number[]) => {
      const out = Buffer.alloc(values.length * 4);
      values.forEach((value, index) => out.writeFloatLE(value, index * 4));
      return out;
    };
    expect(bytes.subarray(0, frameBytes).equals(pack(diagnostic.previousPositions))).toBe(true);
    expect(diagnostic.candidatePositions).not.toBeNull();
    expect(bytes.subarray(bytes.length - frameBytes).equals(pack(diagnostic.candidatePositions!))).toBe(true);
  }
  return { captured: base64 !== null, sampleCount, subSteps: diagnostic.config.subSteps,
    particleCount: diagnostic.particleCount, report: diagnostic.report };
}

for (const touch of [false, true]) {
  test.describe(`gathered source interface ${touch ? 'touch phone' : 'desktop'}`, () => {
    const device = devices[touch ? 'Pixel 7' : 'Desktop Chrome'];
    test.use({ userAgent: device.userAgent, deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile, hasTouch: device.hasTouch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 720 }, serviceWorkers: 'block' });

    for (const manual of [false, true]) {
      test(manual ? 'manual recording restores original sewing mesh and preserves cache intent' : 'trusted gathered garment notice and real SSP reopen preserve geometry', async ({ page }, info) => {
        test.setTimeout(manual ? 420_000 : 180_000);
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        const evidence: Record<string, unknown> = { emulatedTouchPhone: touch, manualRecording: manual, garmentAccepted: false,
          scope: 'Real trusted generation, rendered camera/notice clearance and checkpoint lifecycle; not garment fit acceptance.' };
        const persistEvidence = () => writeFile(info.outputPath('actual-interface-observed.json'), JSON.stringify(evidence, null, 2));
        try {
          const original = await generateTrustedSkirt(page, touch, info);
          const originalCutSha = await cutSha256(page, original);
          evidence.originalCutSha256 = originalCutSha;
          evidence.initial = await state(page);
          await inspectLibraryAndControls(page, touch);
          evidence.initialTimelineTargets = await inspectTimelineTargets(page, touch);
          evidence.freshFraming = await inspectFraming(page, touch, info, 'fresh-approved-source');
          const refinedArchive = await exportArchive(page, touch, info, 'actual-refined-checkpoint.ssp');
          expect(refinedArchive.pattern.pieces.every(piece => piece.settings3d.savedPositions.length > 0
            && piece.settings3d.savedSourceGatherPolicy?.revision === 'source-free-gather-boundary-v1'
            && piece.settings3d.savedSourceAssemblyComplete === false && piece.settings3d.savedDrapeState === 'checkpoint')).toBe(true);
          await assertOriginalSource(page, refinedArchive.pattern, original, originalCutSha);
          expect(refinedArchive.pattern.pieces.every(piece => piece.settings3d.savedSourceGatherPolicy?.sourceCutSha256 === originalCutSha)).toBe(true);
          await persistEvidence();
          await importArchive(page, touch, refinedArchive.file, refinedArchive.pattern);
          const reopened = await actualPattern(page);
          expect(reopened.pieces.map(piece => piece.settings3d.savedPositions)).toEqual(refinedArchive.pattern.pieces.map(piece => piece.settings3d.savedPositions));
          await assertOriginalSource(page, reopened, original, originalCutSha);
          await expect(page.getByTestId('pattern-scene-3d').getByText('Garment fit updated. Start simulation to reassemble the garment.', { exact: true })).toBeVisible();
          evidence.reopened = await state(page);
          expect((await state(page))?.deviceAcquired).toBe(false);
          expect((await state(page))?.safetyReport?.safe).toBe(true);
          expect((await state(page))?.safetyReport?.bodyClosed).toBe(true);

          if (manual) {
            await revealControls(page, touch);
            await activate(page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Assembly timeline', exact: true }), touch);
            const timeline = page.getByRole('group', { name: 'Assembly timeline', exact: true });
            const record = timeline.getByRole('button', { name: 'Record from flat', exact: true });
            evidence.recordTarget = touch ? await touchTarget(record) : await record.boundingBox();
            await persistEvidence();
            await activate(record, touch);
            await expect.poll(async () => (await state(page))?.collisionSafetyPending, { timeout: 240_000, intervals: [250, 500, 1000] }).toBe(true);
            evidence.pendingManual = await state(page);
            await persistEvidence();
            const stop = timeline.getByRole('button', { name: 'Stop', exact: true });
            evidence.stopTarget = touch ? await touchTarget(stop) : await stop.boundingBox();
            await activate(stop, touch);
            await expect(page.getByRole('button', { name: 'Stop', exact: true })).not.toBeVisible({ timeout: 180_000 });
            const actual = await state(page);
            evidence.manualOutcome = actual;
            const manualFailure = await preserveFailure(page, info);
            evidence.manualFailure = manualFailure;
            await persistEvidence();
            expect(actual?.deviceAcquired).toBe(true);
            expect(actual?.positionsFinite).toBe(true);
            expect(actual?.collisionSafetyPending).toBe(false);
            // An actual rejected guarded recording is valid lifecycle evidence, never a fit.
            if (actual?.simulationFailure) {
              expect(manualFailure?.captured).toBe(true);
              expect(manualFailure?.sampleCount).toBe(41);
              expect(manualFailure?.subSteps).toBe(40);
              expect(actual.safetyReport?.safe).toBe(false);
            } else {
              expect(actual?.safetyReport?.safe).toBe(true);
              expect(actual?.safetyReport?.trajectory?.valid).toBe(true);
              expect(actual?.safetyReport?.trajectory?.inspectedSubsteps).toBe(40);
            }
            const close = timeline.getByRole('button', { name: 'Close', exact: true });
            evidence.timelineCloseTarget = touch ? await touchTarget(close) : await close.boundingBox();
            await activate(close, touch);
            const manualArchive = await exportArchive(page, touch, info, 'actual-manual-checkpoint.ssp');
            expect(manualArchive.pattern.pieces.every(piece => piece.settings3d.savedPositions.length > 0
              && piece.settings3d.savedSourceGatherIntent === 'manual' && piece.settings3d.savedSourceGatherPolicy === undefined
              && piece.settings3d.savedSourceAssemblyComplete === false)).toBe(true);
            const refinedParticleCount = refinedArchive.pattern.pieces.reduce((sum, piece) => sum + piece.settings3d.savedPositions.length / 5, 0);
            const manualParticleCount = manualArchive.pattern.pieces.reduce((sum, piece) => sum + piece.settings3d.savedPositions.length / 5, 0);
            evidence.numericalMeshTransition = { refinedParticleCount, manualParticleCount };
            expect(Number.isInteger(manualParticleCount)).toBe(true);
            expect(manualParticleCount).toBeLessThan(refinedParticleCount);
            await assertOriginalSource(page, manualArchive.pattern, original, originalCutSha);
            await persistEvidence();
            await importArchive(page, touch, manualArchive.file, manualArchive.pattern);
            const manualReopened = await actualPattern(page);
            await assertOriginalSource(page, manualReopened, original, originalCutSha);
            expect(manualReopened.pieces.map(piece => piece.settings3d.savedPositions)).toEqual(manualArchive.pattern.pieces.map(piece => piece.settings3d.savedPositions));
            expect(manualReopened.pieces.every(piece => piece.settings3d.savedSourceGatherIntent === 'manual')).toBe(true);
            const originalMeshArchive = await exportArchive(page, touch, info, 'reopened-original-mesh.ssp');
            expect(originalMeshArchive.pattern.pieces.every(piece => piece.settings3d.savedSourceGatherPolicy === undefined
              && piece.settings3d.savedSourceGatherIntent === 'manual' && piece.settings3d.savedSourceAssemblyComplete === false)).toBe(true);
            await assertOriginalSource(page, originalMeshArchive.pattern, original, originalCutSha);
            evidence.manualReopened = await state(page);
          }
          await inspectLibraryAndControls(page, touch);
          expect(errors).toEqual([]);
        } finally {
          if (!page.isClosed()) {
            try {
              evidence.final = await state(page);
              evidence.errors = errors;
              await writeFile(info.outputPath('actual-interface-observed.json'), JSON.stringify(evidence, null, 2));
              await writeFile(info.outputPath('final-source-model.json'), JSON.stringify(await actualPattern(page)));
              await preserveFailure(page, info);
              await page.screenshot({ path: info.outputPath('final-interface.png') });
            } catch { /* The original failure and Playwright screenshot retain the outcome if the page was lost. */ }
          }
        }
      });
    }
  });
}
