import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

type CameraState = { position: number[]; target: number[]; fov: number };
async function camera(page: Page): Promise<CameraState | null> {
  return page.evaluate(() => (window as unknown as { __seamerWebgpuDrape?: {
    getCameraState: () => CameraState | null
  } }).__seamerWebgpuDrape?.getCameraState() ?? null);
}
async function stored(page: Page): Promise<CameraState> {
  return page.evaluate(() => {
    const s = window.seamer!.getPattern().settings3d;
    return { position: s.cameraPosition, target: s.controlsTarget, fov: s.cameraFov };
  });
}
function difference(a: CameraState | null, b: CameraState | null) {
  if (!a || !b) return Infinity;
  return Math.max(Math.abs(a.fov - b.fov), ...a.position.map((v, i) => Math.abs(v - b.position[i])),
    ...a.target.map((v, i) => Math.abs(v - b.target[i])));
}

async function awaitCurrentScene(page: Page) {
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => window.seamer?.getPattern().name), { timeout: 90_000 }).toBe('Pencil skirt - 3D');
  const scene = page.getByTestId('pattern-scene-3d');
  await expect(scene).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });
  await expect(scene).toHaveAttribute('data-export-ready', 'true', { timeout: 90_000 });
}

test.use({ viewport: { width: 1280, height: 720 } });
test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1'); localStorage.setItem('seamer.autosaveSeconds', '600');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await awaitCurrentScene(page);
  await page.getByRole('group', { name: 'Workspace view', exact: true })
    .getByRole('button', { name: '3D', exact: true }).click();
  await awaitCurrentScene(page);
  expect(await page.evaluate(() => window.seamer!.getPattern().garmentCodeSource)).toBeUndefined();
});

test('native initial camera and explicit Reset remain exact through Save and reload', async ({ page }, testInfo) => {
  const initialStored = await stored(page);
  await expect.poll(async () => difference(await camera(page), initialStored)).toBeLessThan(1e-10);
  const scene = page.getByTestId('pattern-scene-3d');
  const expand = scene.getByRole('button', { name: 'Expand 3D controls', exact: true });
  if (await expand.isVisible()) await expand.click();
  await scene.locator('button[title="Front view"]:visible').click();
  await scene.getByRole('button', { name: 'Reset view', exact: true }).click();
  const reset = { position: [.5, .9, 1.6], target: [0, .9, 0], fov: initialStored.fov };
  await expect.poll(async () => difference(await camera(page), reset)).toBeLessThan(1e-10);
  await expect.poll(async () => difference(await camera(page), await stored(page))).toBeLessThan(1e-7);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  const saved = await camera(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await awaitCurrentScene(page);
  await expect.poll(async () => difference(await camera(page), saved)).toBeLessThan(1e-10);
  await writeFile(testInfo.outputPath('native-reset-camera.json'), JSON.stringify({ initialStored, reset, saved,
    reloaded: await camera(page), evidenceScope: 'Native camera/interface only; no simulation.' }, null, 2));
});

test('native actual user orbit settles, persists, survives resize and reload', async ({ page }, testInfo) => {
  const initial = await camera(page);
  const scene = page.getByTestId('pattern-scene-3d'), bounds = (await scene.boundingBox())!;
  await page.mouse.move(bounds.x + 30, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 85, bounds.y + bounds.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => difference(await stored(page), initial)).toBeGreaterThan(.01);
  await expect.poll(async () => difference(await camera(page), await stored(page))).toBeLessThan(1e-7);
  const orbited = await camera(page);
  await page.setViewportSize({ width: 1200, height: 720 });
  await expect.poll(async () => difference(await camera(page), orbited)).toBeLessThan(1e-10);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await awaitCurrentScene(page);
  await expect.poll(async () => difference(await camera(page), orbited)).toBeLessThan(1e-10);
  await writeFile(testInfo.outputPath('native-orbit-camera.json'), JSON.stringify({ initial, orbited,
    reloaded: await camera(page), evidenceScope: 'Native camera/interface only; no simulation.' }, null, 2));
});
