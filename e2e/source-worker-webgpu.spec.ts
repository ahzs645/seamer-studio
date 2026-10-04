import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { DrapeDebugState, DrapeFailureDiagnostics } from '../src/lib/scene/scene3d';
import { gunzipSync } from 'node:zlib';

interface SourceProofState {
  deviceAcquired: boolean;
  running: boolean;
  frameCount: number;
  particleCount: number;
  positionsFinite: boolean;
  collisionSafetyPending: boolean;
  simulationFailure: string | null;
  positionHash: string | null;
}

async function readStageState(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as { __seamerWebgpuDrape?: { getState: () => DrapeDebugState | null } }).__seamerWebgpuDrape?.getState();
    if (!state) return null;
    const stage = state.sourceAssemblyState;
    return { ...state, sourceAssemblyState: stage && { ...stage,
      activeSeamMask: Array.from(stage.activeSeamMask), activeStitchMask: Array.from(stage.activeStitchMask) } };
  });
}

async function loadStageSource(page: Page, source: string) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '600');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooser).setFiles({ name: 'source-stage-dress.json', mimeType: 'application/json', buffer: Buffer.from(source) });
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).click();
  const scene = page.getByTestId('pattern-scene-3d');
  await expect(scene).toHaveAttribute('data-status', 'ready');
  return scene;
}

function readState(page: Page): Promise<SourceProofState | null> {
  return page.evaluate(() => (window as unknown as {
    __seamerWebgpuDrape?: { getState: () => SourceProofState | null }
  }).__seamerWebgpuDrape?.getState() ?? null);
}

async function saveFailure(page: Page, destination: (name: string) => string, frame: number, source: string, fingerprints: Record<string, string>) {
  const diagnostic = await page.evaluate(() => {
    const d = (window as unknown as { __seamerWebgpuDrape: { getFailureDiagnostics: () => DrapeFailureDiagnostics | null } }).__seamerWebgpuDrape.getFailureDiagnostics();
    if (!d) return null;
    let trajectoryBase64: string | null = null;
    if (d.candidateTrajectory) {
      const count = d.candidateTrajectory[0]?.length ?? 0;
      const bytes = new Uint8Array(d.candidateTrajectory.length * count * 4), view = new DataView(bytes.buffer);
      d.candidateTrajectory.forEach((sample, step) => {
        if (sample.length !== count) throw Error('Rejected trajectory changed particle dimensions');
        sample.forEach((value, index) => view.setFloat32((step * count + index) * 4, value, true));
      });
      let encoded = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      trajectoryBase64 = btoa(encoded);
    }
    return { ...d, candidateTrajectory: undefined, trajectoryBase64,
      candidatePositions: d.candidatePositions && Array.from(d.candidatePositions), previousPositions: Array.from(d.previousPositions),
      bodyPositions: Array.from(d.bodyPositions), bodyTriangles: Array.from(d.bodyTriangles),
      clothTriangles: Array.from(d.clothTriangles), seams: Array.from(d.seams) };
  });
  if (!diagnostic) return null;
  const { trajectoryBase64, ...metadata } = diagnostic;
  await writeFile(destination('failure-diagnostic.json'), JSON.stringify(metadata));
  if (!trajectoryBase64 || !diagnostic.candidatePositions) return { captured: false, reason: 'Missing exact rejected candidate trajectory', metadata };
  const bytes = Buffer.from(trajectoryBase64, 'base64'), subSteps = diagnostic.config.subSteps;
  const sliceBytes = diagnostic.particleCount * 16;
  expect(bytes.length).toBe((subSteps + 1) * sliceBytes);
  const pack = (values: number[], integer = false) => {
    const packed = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => integer ? packed.writeUInt32LE(value, index * 4) : packed.writeFloatLE(value, index * 4));
    return packed;
  };
  expect(bytes.subarray(0, sliceBytes).equals(pack(diagnostic.previousPositions))).toBe(true);
  expect(bytes.subarray(bytes.length - sliceBytes).equals(pack(diagnostic.candidatePositions))).toBe(true);
  for (let offset = 0; offset < bytes.length; offset += 4) {
    if (!Number.isFinite(bytes.readFloatLE(offset))) throw Error('Nonfinite rejected GPU trajectory');
    if ((offset / 4) % 4 === 3 && bytes.readFloatLE(offset) !== bytes.readFloatLE(offset % sliceBytes)) throw Error('Rejected GPU trajectory inverse mass changed');
  }
  const vec3 = (values: number[], stride: number) => values.filter((_, index) => index % stride < 3);
  const common = { inputSha256: createHash('sha256').update(source).digest('hex'), sourceFingerprints: fingerprints,
    bodyPositions: vec3(diagnostic.bodyPositions, diagnostic.bodyPositionStride), bodyIndices: vec3(diagnostic.bodyTriangles, diagnostic.bodyTriangleStride),
    clothTriangles: diagnostic.clothTriangles, seams: diagnostic.seams, seamPairs: diagnostic.seamPairsBySeam,
    simulationConfig: diagnostic.config, pattern: diagnostic.pattern, sceneGeneration: diagnostic.sceneGeneration,
    diagnosticOnly: true, accepted: false, particleCount: diagnostic.particleCount };
  const { trajectorySourceHashes } = await import('../scripts/garmentcode/qa/particle-trajectory-audit.mjs');
  const binaryFile = destination('failure-trajectory.bin');
  const descriptor = { ...trajectorySourceHashes(common), file: binaryFile, inputSha256: common.inputSha256,
    format: 'float32-le-vec4', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    sampleCount: subSteps + 1, subSteps, particleCount: diagnostic.particleCount, stepIndices: Array.from({ length: subSteps + 1 }, (_, i) => i),
    fromFrame: frame, toFrame: frame + 1, startPositionsSha256: createHash('sha256').update(bytes.subarray(0, sliceBytes)).digest('hex'),
    endPositionsSha256: createHash('sha256').update(bytes.subarray(bytes.length - sliceBytes)).digest('hex') };
  await writeFile(binaryFile, bytes);
  await writeFile(destination('failure-previous-frozen.json'), JSON.stringify({ ...common, frame, clothPositions: diagnostic.previousPositions, safetyReport: null, runtimeSafe: null }));
  await writeFile(destination('failure-rejected-frozen.json'), JSON.stringify({ ...common, kind: 'rejectedDiagnostic', rejected: true,
    halted: true, runtimeSafe: false, frame: frame + 1, clothPositions: diagnostic.candidatePositions, safetyReport: diagnostic.report, particleTrajectory: descriptor }));
  return { captured: true, binaryFile, sha256: descriptor.sha256, sampleCount: descriptor.sampleCount, report: diagnostic.report, config: diagnostic.config };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`source Worker interface ${viewport.width}px`, () => {
    const touch = viewport.width < 480;
    const device = devices[touch ? 'Pixel 7' : 'Desktop Chrome'];
    test.use({ viewport, userAgent: device.userAgent, deviceScaleFactor: device.deviceScaleFactor,
      hasTouch: device.hasTouch, isMobile: device.isMobile, serviceWorkers: 'block' });
    for (const scenario of ['default', 'body-contact-off'] as const) {
    test(scenario === 'default' ? 'Library remains responsive during actual guarded GPU frame proof' : 'Controlled Body collision off keeps source guard and Reset recovery active', async ({ page, request }, testInfo) => {
      const controlledFailure = scenario === 'body-contact-off';
      test.setTimeout(controlledFailure ? 420_000 : 240_000);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const activate = (control: Locator) => touch ? control.tap() : control.click();
      const generationRequest = { preset: 'dress', body: { height: 176, waist: 88 }, design: {} };
      await writeFile(testInfo.outputPath('generation-request.json'), JSON.stringify(generationRequest));
      const response = await request.post('/api/garmentcode', { data: generationRequest });
      const source = await response.text();
      await writeFile(testInfo.outputPath('original-source.json'), source);
      expect(response.status(), source).toBe(200);
      const fingerprints: Record<string, string> = {};
      for (const path of ['packages/cloth-sim/src/simulator.ts', 'packages/cloth-sim/src/webgpu/engine.ts', 'packages/cloth-sim/src/collisionGuard.ts', 'packages/cloth-sim/src/collisionGuardWorker.ts', 'packages/cloth-sim/src/collisionGuardWorkerRuntime.ts', 'packages/cloth-sim/src/contactConfig.ts', 'packages/cloth-sim/src/assembly.ts', 'packages/avatar/src/garmentCodeFit.ts', 'src/lib/scene/sourceBodyCheckpoint.ts', 'src/lib/scene/scene3d.ts'])
        fingerprints[path] = createHash('sha256').update(await readFile(path)).digest('hex');
      await page.addInitScript(() => {
        localStorage.setItem('seamer.welcomeSeen', '1');
        localStorage.setItem('seamer.autosaveSeconds', '600');
        const target = window as unknown as { __sourceUiTiming: { events: { phase: string; action: string; time: number; pending: boolean | null }[]; longTasks: { start: number; duration: number }[] }; __seamerWebgpuDrape?: { getState: () => SourceProofState | null } };
        target.__sourceUiTiming = { events: [], longTasks: [] };
        const record = (phase: string, action: string) => target.__sourceUiTiming.events.push({ phase, action, time: performance.now(), pending: target.__seamerWebgpuDrape?.getState()?.collisionSafetyPending ?? null });
        for (const phase of ['pointerdown', 'click']) document.addEventListener(phase, event => {
          const element = event.target instanceof Element ? event.target : null;
          if (element?.closest('[data-testid="templates-menu-trigger"]')) record(phase, 'open');
          if (element?.closest('[aria-label="Close pattern library"]')) record(phase, 'close');
        }, true);
        let wasOpen = false;
        new MutationObserver(() => {
          const isOpen = !!document.querySelector('[role="dialog"][aria-label="Pattern library"]');
          if (isOpen === wasOpen) return;
          wasOpen = isOpen; const action = isOpen ? 'open' : 'close'; record('dom', action);
          requestAnimationFrame(() => record('raf', action));
        }).observe(document, { childList: true, subtree: true });
        try { new PerformanceObserver(list => { for (const entry of list.getEntries()) target.__sourceUiTiming.longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: true }); } catch { /* Older browser has no Long Tasks API. */ }
      });
      await page.goto('/studio', { waitUntil: 'domcontentloaded' });
      const browserIdentity = await page.evaluate(() => ({ userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints, devicePixelRatio, coarsePointer: matchMedia('(pointer: coarse)').matches }));
      if (touch) {
        expect(browserIdentity.userAgent).toMatch(/Android.+Mobile/);
        expect(browserIdentity.maxTouchPoints).toBeGreaterThan(0);
        expect(browserIdentity.coarsePointer).toBe(true);
      }
      await expect(page.getByTestId('pattern-name-input')).toBeVisible();
      const chooser = page.waitForEvent('filechooser');
      await activate(page.getByTestId('import-menu-trigger'));
      await activate(page.getByRole('button', { name: /From file/ }));
      await (await chooser).setFiles({ name: 'worker-source-dress.json', mimeType: 'application/json', buffer: Buffer.from(source) });
      await expect(page.getByTestId('pattern-name-input')).toHaveValue('worker-source-dress');
      await activate(page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }));
      const scene = page.getByTestId('pattern-scene-3d');
      await expect(scene).toHaveAttribute('data-status', 'ready');
      const panels = page.getByRole('button', { name: 'Layers and body panel', exact: true });
      if (await panels.getAttribute('aria-expanded') === 'true') await activate(panels);
      expect(await page.evaluate(() => window.seamer!.getPattern().pieces.every(piece => piece.settings3d.savedPositions.length === 0))).toBe(true);
      const meshResolution = await page.evaluate(() => {
        const pattern = window.seamer!.getPattern();
        return { globalOverrideMm: pattern.settings3d.globalParticleDistanceOverride ?? null,
          pieces: pattern.pieces.map(piece => ({ name: piece.name, spacingMm: piece.settings3d.particleDistance })) };
      });
      expect(meshResolution.globalOverrideMm).toBeNull();
      expect(meshResolution.pieces.every(piece => piece.spacingMm === 15)).toBe(true);
      const configureBodyContacts = async (enabled: boolean) => {
        const expand = scene.getByRole('button', { name: 'Expand 3D controls', exact: true });
        if (await expand.isVisible()) await activate(expand);
        await activate(scene.getByRole('button', { name: 'Simulation controls', exact: true }));
        const contacts = scene.getByRole('checkbox', { name: 'Body collision', exact: true });
        if ((await contacts.isChecked()) !== enabled) await activate(contacts);
        await expect(contacts).toBeChecked({ checked: enabled });
        await expect(scene.getByRole('spinbutton', { name: 'Time step', exact: true })).toHaveValue('0.016');
        await expect(scene.getByRole('spinbutton', { name: 'Sub steps', exact: true })).toHaveValue('40');
        await activate(scene.getByRole('button', { name: 'Close', exact: true }));
        await expect(scene).toHaveAttribute('data-status', 'ready');
      };
      if (controlledFailure) await configureBodyContacts(false);
      const libraryTrigger = page.getByTestId('templates-menu-trigger');
      const libraryBounds = await libraryTrigger.boundingBox(); expect(libraryBounds).not.toBeNull();
      const tapPoint = (bounds: { x: number; y: number; width: number; height: number }) => touch ? page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) : page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      const initial = await readState(page);
      let failureEvidenceSaved = false;
      let closeTarget: unknown = null;
      const confirmationTargets: unknown[] = [];
      const readyConfirmation = async (dialog: Locator, round: string) => {
        if (!touch) return;
        for (const name of ['Cancel', 'Reset']) {
          const button = dialog.getByRole('button', { name, exact: true });
          const entryBounds = await button.boundingBox(), startedAt = Date.now();
          expect(entryBounds?.height).toBeGreaterThanOrEqual(44); expect(entryBounds?.width).toBeGreaterThanOrEqual(44);
          await expect.poll(async () => {
            const bounds = await button.boundingBox(); return bounds ? Math.min(bounds.height, bounds.width) : 0;
          }, { timeout: 1000, intervals: [20, 50] }).toBeGreaterThanOrEqual(44);
          const bounds = await button.boundingBox();
          confirmationTargets.push({ round, name, entryBounds, stableBounds: bounds, stableTargetLatencyMs: Date.now() - startedAt });
          expect(bounds?.height).toBeGreaterThanOrEqual(44); expect(bounds?.width).toBeGreaterThanOrEqual(44);
        }
      };
      try {
      await activate(scene.getByRole('button', { name: 'Start simulation', exact: true }));
      await expect.poll(async () => (await readState(page))?.collisionSafetyPending, { timeout: 120_000, intervals: [20, 50, 100] }).toBe(true);
      const pending = await readState(page);
      expect(pending?.deviceAcquired).toBe(true);
      expect(pending!.particleCount).toBeGreaterThan(0);

      // This uses a real source GPU step and Worker proof, without a synthetic delay or guard.
      // A possible safety rejection remains a failed drape; this test only verifies interface access.
      const openedAt = Date.now();
      await tapPoint(libraryBounds!);
      const library = page.getByRole('dialog', { name: 'Pattern library', exact: true });
      await expect(library).toBeVisible();
      const openLatencyMs = Date.now() - openedAt;
      const opened = await readState(page);
      await writeFile(testInfo.outputPath('source-worker-open.json'), JSON.stringify({
        viewport, browserIdentity, meshResolution, initial, pending, opened, openLatencyMs, errors
      }, null, 2));
      // Assertion follows exact failure capture/recovery so failed timings cannot lose diagnostics.
      const close = library.getByRole('button', { name: 'Close pattern library', exact: true });
      const entryBounds = await close.boundingBox(), stableStartedAt = Date.now();
      if (touch) { expect(entryBounds?.height).toBeGreaterThanOrEqual(44); expect(entryBounds?.width).toBeGreaterThanOrEqual(44); }
      closeTarget = { entryBounds, stableBounds: null, stableTargetLatencyMs: null };
      await expect.poll(async () => (await close.boundingBox())?.height ?? 0, { timeout: 1000, intervals: [20, 50] }).toBeGreaterThanOrEqual(touch ? 44 : 24);
      const closeBounds = await close.boundingBox();
      const stableTargetLatencyMs = Date.now() - stableStartedAt;
      closeTarget = { entryBounds, stableBounds: closeBounds, stableTargetLatencyMs };
      expect(closeBounds).not.toBeNull();
      expect(closeBounds!.height).toBeGreaterThanOrEqual(touch ? 44 : 24);
      await page.screenshot({ path: testInfo.outputPath(`source-worker-library-${viewport.width}.png`) });
      const closedAt = Date.now();
      await tapPoint(closeBounds!);
      await expect(library).not.toBeVisible();
      await expect(libraryTrigger).toBeFocused();
      const closeLatencyMs = Date.now() - closedAt;

      const closed = await readState(page);
      const pause = scene.getByRole('button', { name: 'Pause simulation', exact: true });
      if (controlledFailure) {
        await expect.poll(async () => {
          const state = await readState(page);
          if (state && !state.simulationFailure && state.frameCount >= 3) throw Error('Controlled contact-off setup remained safe for three accepted frames; choose a demonstrated negative fixture');
          return state?.simulationFailure ?? null;
        }, { timeout: 300_000, intervals: [50, 100] }).not.toBeNull();
      } else if (await pause.isVisible() && await pause.isEnabled()) await activate(pause);
      await expect.poll(async () => {
        const state = await readState(page);
        return !!state && !state.running && !state.collisionSafetyPending;
      }, { timeout: 60_000 }).toBe(true);
      const final = await readState(page);
      const timing = await page.evaluate(() => (window as unknown as { __sourceUiTiming: { events: { phase: string; action: string; time: number; pending: boolean | null }[]; longTasks: unknown[] } }).__sourceUiTiming);
      const latency = (action: string, phase: string) => {
        const pointer = timing.events.find(event => event.phase === 'pointerdown' && event.action === action);
        const output = timing.events.find(event => event.phase === phase && event.action === action);
        return pointer && output ? output.time - pointer.time : null;
      };
      const inputLatency = { openDomMs: latency('open', 'dom'), openRafMs: latency('open', 'raf'), closeDomMs: latency('close', 'dom'), closeRafMs: latency('close', 'raf') };
      await writeFile(testInfo.outputPath('source-worker-timing.json'), JSON.stringify({ viewport, browserIdentity, initial, pending, opened, closed, final, timing, inputLatency, closeTarget, openLatencyMs, closeLatencyMs }, null, 2));
      const failure = await saveFailure(page, testInfo.outputPath.bind(testInfo), final!.frameCount, source, fingerprints);
      failureEvidenceSaved = failure?.captured === true;
      if (controlledFailure) {
        expect(final?.simulationFailure).not.toBeNull();
        expect(failure?.captured).toBe(true);
        expect(failure && 'config' in failure ? failure.config.handleExternalCollisions : null).toBe(false);
        expect(failure && 'config' in failure ? failure.config.handleExternalSurfaceCollisions : null).toBe(false);
        expect(failure && 'report' in failure ? failure.report.safe : null).toBe(false);
      }
      if (final?.simulationFailure) {
        const reset = scene.getByRole('button', { name: 'Reset simulation', exact: true });
        await expect(reset).toBeEnabled(); await activate(reset);
        const resetDialog = page.getByRole('dialog', { name: 'Reset all simulations?', exact: true });
        await expect(resetDialog).toBeVisible();
        await readyConfirmation(resetDialog, 'cancel');
        const cancelledPositions = await page.evaluate(() => window.seamer!.getPattern().pieces.map(piece => piece.settings3d.savedPositions));
        await expect(resetDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(resetDialog.getByRole('button', { name: 'Reset', exact: true })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(resetDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(resetDialog).not.toBeVisible();
        await expect(reset).toBeFocused();
        expect((await readState(page))?.simulationFailure).toBe(final.simulationFailure);
        expect((await readState(page))?.positionHash).toBe(final.positionHash);
        expect(await page.evaluate(() => window.seamer!.getPattern().pieces.map(piece => piece.settings3d.savedPositions))).toEqual(cancelledPositions);
        expect(await page.evaluate(() => (window as unknown as { __seamerWebgpuDrape: { getFailureDiagnostics: () => unknown } }).__seamerWebgpuDrape.getFailureDiagnostics())).not.toBeNull();
        await activate(reset);
        await expect(resetDialog).toBeVisible();
        await readyConfirmation(resetDialog, 'escape');
        await page.keyboard.press('Escape');
        await expect(resetDialog).not.toBeVisible();
        await expect(reset).toBeFocused();
        expect((await readState(page))?.simulationFailure).toBe(final.simulationFailure);
        await activate(reset);
        await expect(resetDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await readyConfirmation(resetDialog, 'confirm');
        await page.keyboard.press('Tab');
        await expect(resetDialog.getByRole('button', { name: 'Reset', exact: true })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(scene).toHaveAttribute('data-status', 'ready');
        await expect.poll(async () => (await readState(page))?.simulationFailure).toBeNull();
        expect(await page.evaluate(() => (window as unknown as { __seamerWebgpuDrape: { getFailureDiagnostics: () => unknown } }).__seamerWebgpuDrape.getFailureDiagnostics())).toBeNull();
      }
      const recovered = await readState(page);
      if (controlledFailure) await configureBodyContacts(true);
      expect(final?.positionsFinite).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      await writeFile(testInfo.outputPath('source-worker-interface.json'), JSON.stringify({
        scenario, controlledFailure, viewport, browserIdentity, meshResolution, initial, pending, opened, closed, final, recovered, failure, timing, inputLatency, closeTarget, confirmationTargets, openLatencyMs, closeLatencyMs, errors,
        garmentAccepted: false, purpose: controlledFailure ? 'Explicit user Body collision off must still invoke actual source guard and safe Reset; never a fit certificate.' : 'Unmodified default source must leave Library accessible during genuine pending proof; no default rejection is required.'
      }, null, 2));
      if (final?.simulationFailure) expect(failure?.captured).toBe(true);
      expect(openLatencyMs).toBeLessThan(1000); expect(closeLatencyMs).toBeLessThan(1000);
      expect(stableTargetLatencyMs).toBeLessThan(1000);
      for (const value of Object.values(inputLatency)) { expect(value).not.toBeNull(); expect(value!).toBeLessThan(1000); }
      expect(timing.events.find(event => event.phase === 'pointerdown' && event.action === 'open')?.pending).toBe(true);
      } finally {
        try {
          const pause = scene.getByRole('button', { name: 'Pause simulation', exact: true });
          if (await pause.isVisible() && await pause.isEnabled()) await activate(pause);
          await expect.poll(async () => !(await readState(page))?.collisionSafetyPending, { timeout: 60_000 }).toBe(true);
          const finalObservation = await readState(page);
          const telemetry = await page.evaluate(() => (window as unknown as { __sourceUiTiming: unknown }).__sourceUiTiming);
          await writeFile(testInfo.outputPath('source-worker-finally.json'), JSON.stringify({ viewport, browserIdentity, finalObservation, telemetry, closeTarget, confirmationTargets }));
          if (!failureEvidenceSaved && finalObservation?.simulationFailure)
            await saveFailure(page, testInfo.outputPath.bind(testInfo), finalObservation.frameCount, source, fingerprints);
        } catch (error) {
          await writeFile(testInfo.outputPath('failure-capture-error.json'), JSON.stringify({ message: String(error) }));
        }
      }
    });
    }
  });
}

test('accepted partial source assembly exports without certifying a warm restart', async ({ page, request }, testInfo) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const response = await request.post('/api/garmentcode', { data: { preset: 'dress', body: { height: 176, waist: 88 }, design: {} } });
  const source = await response.text();
  expect(response.status(), source).toBe(200);
  await writeFile(testInfo.outputPath('partial-stage-source.json'), source);
  const scene = await loadStageSource(page, source);
  await scene.getByRole('button', { name: 'Start simulation', exact: true }).click();
  await expect.poll(async () => (await readStageState(page))?.collisionSafetyPending, { timeout: 180_000 }).toBe(true);
  await scene.getByRole('button', { name: 'Pause simulation', exact: true }).click();
  await expect.poll(async () => {
    const state = await readStageState(page);
    if (state?.simulationFailure) throw Error(state.simulationFailure);
    return !!state && state.safetyReport?.safe === true && state.safetyReport.trajectory?.valid === true
      && state.safetyReport.trajectory.inspectedSubsteps === 40
      && (state.sourceAssemblyState?.enabledStitchCount ?? 0) > 0 && !state.collisionSafetyPending && !state.running;
  }, { timeout: 120_000 }).toBe(true);
  const partial = await readStageState(page);
  await writeFile(testInfo.outputPath('first-accepted-partial-stage.json'), JSON.stringify(partial));
  expect(partial?.sourceAssemblyState?.phase).toBe('structural');
  expect(partial?.sourceAssemblyState?.allActive).toBe(false);
  expect(partial?.sourceAssemblyComplete).toBe(false);
  expect(partial?.renderedPositionErrorM).toBe(0);
  expect(partial?.safetyReport?.safe).toBe(true);
  expect(partial?.safetyReport?.trajectory?.inspectedSubsteps).toBe(40);
  await page.screenshot({ path: testInfo.outputPath('accepted-partial-stage.png') });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Seamer Project — 2D + 3D (.ssp)', exact: true }).click();
  const archive = testInfo.outputPath('partial-source-stage.ssp');
  await (await download).saveAs(archive);
  const envelope = JSON.parse(gunzipSync(await readFile(archive)).toString('utf8'));
  const saved = envelope.pattern.pieces.map((piece: { settings3d: { savedPositions: number[]; savedSourceAssemblyComplete?: boolean } }) => piece.settings3d);
  expect(saved.every((settings: { savedPositions: number[]; savedSourceAssemblyComplete?: boolean }) => settings.savedPositions.length > 0
    && settings.savedSourceAssemblyComplete === false)).toBe(true);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooser).setFiles(archive);
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await expect(scene.getByText('Garment fit updated. Start simulation to reassemble the garment.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.seamer!.getPattern().pieces.map(piece => piece.settings3d.savedPositions)))
    .toEqual(saved.map((settings: { savedPositions: number[] }) => settings.savedPositions));
  await scene.getByRole('button', { name: 'Simulation controls', exact: true }).click();
  await expect(scene.getByLabel('Hold saved checkpoint', { exact: true })).toBeDisabled();
  await scene.getByRole('button', { name: 'Close', exact: true }).click();
  await scene.getByRole('button', { name: 'Start simulation', exact: true }).click();
  await expect.poll(async () => (await readStageState(page))?.collisionSafetyPending, { timeout: 180_000 }).toBe(true);
  await scene.getByRole('button', { name: 'Pause simulation', exact: true }).click();
  await expect.poll(async () => !(await readStageState(page))?.collisionSafetyPending, { timeout: 120_000 }).toBe(true);
  const reopened = await readStageState(page);
  expect(reopened?.simulationFailure).toBeNull();
  expect(reopened?.sourceAssemblyState?.phase).toBe('structural');
  expect(reopened?.sourceAssemblyState?.allActive).toBe(false);
  expect(reopened?.sourceAssemblyComplete).toBe(false);
  expect(reopened?.renderedPositionErrorM).toBe(0);
  expect(errors).toEqual([]);
  await writeFile(testInfo.outputPath('partial-stage-roundtrip.json'), JSON.stringify({ partial, reopened, errors, garmentAccepted: false }));
});

test('paused manual recording preserves the accepted prefix through settings rebuild', async ({ page, request }, testInfo) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const response = await request.post('/api/garmentcode', { data: { preset: 'dress', body: { height: 176, waist: 88 }, design: {} } });
  const source = await response.text();
  expect(response.status(), source).toBe(200);
  await writeFile(testInfo.outputPath('manual-stage-source.json'), source);
  const scene = await loadStageSource(page, source);
  await scene.getByRole('button', { name: 'Assembly timeline', exact: true }).click();
  await scene.getByRole('button', { name: 'Record from flat', exact: true }).click();
  await expect.poll(async () => (await readStageState(page))?.collisionSafetyPending, { timeout: 180_000 }).toBe(true);
  await scene.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(scene.getByRole('button', { name: 'Stop', exact: true })).not.toBeVisible({ timeout: 120_000 });
  const stopped = await readStageState(page);
  expect(stopped?.simulationFailure).toBeNull();
  expect(stopped?.sourceAssemblyState?.enabledStitchCount).toBe(0);
  expect(stopped?.sourceAssemblyState?.activeSeamMask.every(value => value === 1)).toBe(true);
  expect(stopped?.sourceAssemblyComplete).toBe(false);
  expect(stopped?.running).toBe(false);
  expect(stopped?.safetyReport?.safe).toBe(true);
  expect(stopped?.safetyReport?.trajectory?.inspectedSubsteps).toBe(40);
  await scene.getByRole('button', { name: 'Close', exact: true }).click();
  await scene.getByRole('button', { name: 'Simulation controls', exact: true }).click();
  const contacts = scene.getByRole('slider', { name: /^Contact passes per substep/ });
  await contacts.focus();
  await contacts.press('Home');
  await expect(contacts).toHaveValue('1');
  await scene.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(async () => (await readStageState(page))?.sourceAssemblyState).toEqual(stopped!.sourceAssemblyState);
  const rebuilt = await readStageState(page);
  expect(rebuilt?.sourceAssemblyComplete).toBe(false);
  expect(rebuilt?.running).toBe(false);
  expect(rebuilt?.positionHash).toBe(stopped?.positionHash);
  await scene.getByRole('button', { name: 'Start simulation', exact: true }).click();
  await expect.poll(async () => (await readStageState(page))?.collisionSafetyPending, { timeout: 180_000 }).toBe(true);
  const pending = await readStageState(page);
  expect(pending?.sourceAssemblyState).toEqual(stopped?.sourceAssemblyState);
  expect(pending?.sourceAssemblyComplete).toBe(false);
  await scene.getByRole('button', { name: 'Pause simulation', exact: true }).click();
  await expect.poll(async () => !(await readStageState(page))?.collisionSafetyPending, { timeout: 120_000 }).toBe(true);
  const final = await readStageState(page);
  if (final?.simulationFailure) {
    expect(final.sourceAssemblyState).toEqual(stopped?.sourceAssemblyState);
    expect(final.positionHash).toBe(stopped?.positionHash);
    expect(final.safetyReport?.safe).toBe(false);
    expect(final.safetyReport?.seamActivation?.sewnUpTo).toBe(stopped!.sourceAssemblyState!.totalStitchCount);
    expect(final.safetyReport?.seamActivation?.activeSeams.every(value => value === 1)).toBe(true);
  } else {
    expect(final?.sourceAssemblyState?.enabledStitchCount).toBe(stopped!.sourceAssemblyState!.totalStitchCount);
    expect(final?.sourceAssemblyState?.allActive).toBe(true);
    expect(final?.safetyReport?.safe).toBe(true);
    expect(final?.safetyReport?.trajectory?.inspectedSubsteps).toBe(40);
  }
  expect(final?.running).toBe(false);
  expect(errors).toEqual([]);
  await writeFile(testInfo.outputPath('manual-stage-settings.json'), JSON.stringify({ stopped, rebuilt, pending, final, errors, garmentAccepted: false }));
});
