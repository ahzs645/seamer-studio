import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

interface DrapeState {
  deviceAcquired: boolean;
  deviceLostReason: string | null;
  running: boolean;
  frameCount: number;
  particleCount: number;
  positionHash: string | null;
  positionsFinite: boolean;
  particleBounds: { min: number[]; max: number[]; centroid: number[] } | null;
}
async function readState(page: Page): Promise<DrapeState | null> {
  return page.evaluate(() => (window as unknown as {
    __seamerWebgpuDrape?: { getState: () => DrapeState | null };
  }).__seamerWebgpuDrape?.getState() ?? null);
}
async function waitForFrames(page: Page, minimum: number) {
  await expect.poll(async () => {
    const state = await readState(page);
    return !!state && state.deviceAcquired && state.running && state.frameCount >= minimum
      && state.particleCount > 0 && state.positionsFinite && state.deviceLostReason === null;
  }, { timeout: 60_000 }).toBe(true);
  return (await readState(page))!;
}

test('self-collision OFF and ON rebuild from the current shape and survive pause/resume', async ({ page }, testInfo) => {
  // Software WebGPU also runs finite body/cloth-face contacts; keep every transition and
  // advancing-frame assertion while allowing the slower CPU adapter to complete them.
  testInfo.setTimeout(600_000);
  const pageErrors: string[] = [];
  const gpuErrors: string[] = [];
  const states: Record<string, DrapeState | null> = {};
  const checkpoint = async (phase: string) => {
    const state = states[phase];
    console.log(JSON.stringify({ phase, frames: state?.frameCount, particles: state?.particleCount, running: state?.running }));
    await writeFile(testInfo.outputPath('self-collision-transitions.json'), JSON.stringify({ states, pageErrors, gpuErrors }, null, 2));
  };
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /webgpu|gpuvalidation|validation|device.*lost/i.test(message.text())) gpuErrors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '120');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 90_000 });
  const gpuAvailable = await page.evaluate(async () => !!navigator.gpu && !!(await navigator.gpu.requestAdapter()));
  test.skip(!gpuAvailable, 'A WebGPU adapter is unavailable');

  // Use the real native document with a coarse preview mesh so this tests solver transitions
  // rather than the speed of software WebGPU. Its saved surface still seeds the rebuilt topology.
  const pattern = await page.evaluate(() => window.seamer!.getPattern());
  pattern.settings3d.globalParticleDistanceOverride = 30;
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooserPromise).setFiles({
    name: 'self-collision-preview.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pattern))
  });
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().settings3d.globalParticleDistanceOverride)).toBe(30);
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).click();
  const scene = page.getByTestId('pattern-scene-3d');
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await scene.getByRole('button', { name: 'Simulation controls', exact: true }).click();
  const collision = scene.getByLabel('Self-collision', { exact: true });
  await collision.uncheck();
  await expect(collision).not.toBeChecked();
  await scene.getByRole('button', { name: 'Close', exact: true }).click();
  await scene.getByRole('button', { name: 'Start simulation' }).click();
  states.offStart = await waitForFrames(page, 2);
  await checkpoint('offStart');
  states.offAdvanced = await waitForFrames(page, states.offStart.frameCount + 2);
  await checkpoint('offAdvanced');
  expect(states.offAdvanced.positionHash).not.toBe(states.offStart.positionHash);
  await scene.getByRole('button', { name: 'Pause simulation' }).click();
  await expect(scene).toHaveAttribute('data-status', 'ready');
  states.offPaused = await readState(page);
  await checkpoint('offPaused');
  await page.waitForTimeout(1_200);
  expect((await readState(page))?.positionHash).toBe(states.offPaused?.positionHash);
  await scene.getByRole('button', { name: 'Start simulation' }).click();
  states.offResumed = await waitForFrames(page, (states.offPaused?.frameCount ?? 0) + 2);
  await checkpoint('offResumed');
  expect(states.offResumed.positionHash).not.toBe(states.offPaused?.positionHash);
  await scene.getByRole('button', { name: 'Pause simulation' }).click();
  states.beforeOn = await readState(page);
  await checkpoint('beforeOn');

  await scene.getByRole('button', { name: 'Simulation controls', exact: true }).click();
  await collision.check();
  await expect(collision).toBeChecked();
  await scene.getByRole('button', { name: 'Close', exact: true }).click();
  // A new frame counter proves that the option provisions a fresh engine. Before its first
  // step, a matching hash proves the rebuild preserves the exact current garment shape.
  await expect.poll(async () => (await readState(page))?.frameCount).toBe(0);
  states.onRebuilt = await readState(page);
  await checkpoint('onRebuilt');
  expect(states.onRebuilt?.particleCount).toBe(states.beforeOn?.particleCount);
  expect(states.onRebuilt?.positionHash).toBe(states.beforeOn?.positionHash);
  expect(states.onRebuilt?.running).toBe(false);
  await scene.getByRole('button', { name: 'Start simulation' }).click();
  states.onStart = await waitForFrames(page, 2);
  await checkpoint('onStart');
  states.onAdvanced = await waitForFrames(page, states.onStart.frameCount + 2);
  await checkpoint('onAdvanced');
  expect(states.onAdvanced.positionHash).not.toBe(states.onStart.positionHash);
  await scene.getByRole('button', { name: 'Pause simulation' }).click();
  states.beforeOff = await readState(page);
  await checkpoint('beforeOff');

  // Exercise OFF after an engine has actually run its self-collision passes, too.
  await scene.getByRole('button', { name: 'Simulation controls', exact: true }).click();
  await collision.uncheck();
  await expect(collision).not.toBeChecked();
  await scene.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(async () => (await readState(page))?.frameCount).toBe(0);
  states.offRebuilt = await readState(page);
  await checkpoint('offRebuilt');
  expect(states.offRebuilt?.positionHash).toBe(states.beforeOff?.positionHash);
  await scene.getByRole('button', { name: 'Start simulation' }).click();
  states.offAgain = await waitForFrames(page, 2);
  await checkpoint('offAgain');
  await scene.getByRole('button', { name: 'Pause simulation' }).click();
  expect(pageErrors).toEqual([]);
  expect(gpuErrors).toEqual([]);
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await scene.getByRole('button', { name: 'A', exact: true }).click();
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await expect(scene.locator('canvas')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('self-collision-preview-A-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(scene).toBeVisible();
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await expect.poll(() => page.evaluate(() => ({
    x: document.documentElement.scrollWidth - innerWidth,
    y: document.documentElement.scrollHeight - innerHeight
  }))).toEqual({ x: 0, y: 0 });
  await page.screenshot({ path: testInfo.outputPath('self-collision-preview-A-mobile.png') });
  await writeFile(testInfo.outputPath('self-collision-transitions.json'), JSON.stringify({ states, pageErrors, gpuErrors }, null, 2));
});
