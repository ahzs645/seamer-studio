import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.setTimeout(180_000);
test.use({ viewport: { width: 1440, height: 900 } });

async function printPixels(page: Page) {
  const screenshot = await page.getByTestId('pattern-scene-3d').locator('canvas').first().screenshot();
  return page.evaluate(async source => {
    const image = new Image(); image.src = `data:image/png;base64,${source}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = { magenta: { count: 0, x: 0, y: 0 }, cyan: { count: 0, x: 0, y: 0 } };
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
      const key = r > 150 && b > 150 && g < r * .55 && g < b * .55 ? 'magenta' :
        g > 150 && b > 150 && r < g * .5 && r < b * .5 ? 'cyan' : null;
      if (key) { const color = colors[key]; color.count++; color.x += index / 4 % canvas.width; color.y += Math.floor(index / 4 / canvas.width); }
    }
    return Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, {
      count: color.count, x: color.count ? color.x / color.count : 0, y: color.count ? color.y / color.count : 0
    }])) as typeof colors;
  }, screenshot.toString('base64'));
}

async function geometryOBJ(page: Page, testInfo: TestInfo, name: string) {
  const downloaded = page.waitForEvent('download');
  await page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Download as OBJ', exact: true }).click();
  const path = testInfo.outputPath(name); await (await downloaded).saveAs(path);
  return (await readFile(path, 'utf8')).split('\n').filter(line => /^(v |vt |vn |f )/.test(line)).join('\n');
}

test('front-face artwork changes actual 3D raster while current geometry and checkpoints stay exact', async ({ page }, testInfo) => {
  await page.addInitScript(() => { localStorage.setItem('seamer.welcomeSeen', '1'); localStorage.setItem('seamer.autosaveSeconds', '600'); });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await page.getByTestId('import-menu-trigger').click();
  await page.getByTestId('import-sample-rect-piece.dxf').click();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('rect-piece');
  // Native drafting files place this standalone panel near the floor. Import a real saved
  // camera around its planar mesh instead of viewing it with the avatar's torso camera.
  const framed = await page.evaluate(() => {
    const pattern = structuredClone(window.seamer!.getPattern());
    pattern.name = 'Artwork 3D panel';
    pattern.settings3d.cameraPosition = [.075, .11, .7];
    pattern.settings3d.controlsTarget = [.075, .11, .3];
    pattern.settings3d.showAvatar = false;
    return JSON.stringify(pattern);
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooser).setFiles({ name: 'artwork-panel.seamer.json', mimeType: 'application/json', buffer: Buffer.from(framed) });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Artwork 3D panel');
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).click();
  if (!await page.locator('#studio-left-panel').isVisible()) await page.getByRole('button', { name: 'Layers and body panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Artwork', exact: true }).click();
  const panel = page.getByTestId('artwork-panel'), scene = page.getByTestId('pattern-scene-3d');
  await expect(scene).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await scene.getByRole('button', { name: 'Front view', exact: true }).click();
  // Selecting the actual 3D garment enters temporary Move mode. Upload must paint visibly
  // before any artwork tool is activated, and discard no retained cloth geometry.
  await scene.locator('canvas').first().click();
  await expect(scene.getByRole('button', { name: 'Exit move mode', exact: true })).toBeVisible();
  await expect(panel.getByLabel('Add image to selected piece', { exact: true })).toBeEnabled();
  const geometry = await geometryOBJ(page, testInfo, 'before.obj');
  expect(geometry).toContain('v ');
  const pieces = await page.evaluate(() => {
    const pattern = window.seamer!.getPattern();
    return { points: pattern.points, paths: pattern.paths, pieces: pattern.pieces };
  });
  const state = await page.evaluate(() => (window as Window & { __seamerWebgpuDrape?: { getState(): unknown } }).__seamerWebgpuDrape?.getState());
  await scene.locator('canvas').first().evaluate(element => element.setAttribute('data-artwork-identity', 'retained'));
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40;
    const context = canvas.getContext('2d')!; context.fillStyle = '#fa00f8'; context.fillRect(0, 0, 40, 40);
    context.fillStyle = '#00d2f4'; context.fillRect(40, 0, 40, 40); return canvas.toDataURL('image/png');
  });
  await panel.getByLabel('Add image to selected piece', { exact: true }).setInputFiles({ name: 'Two-color-print.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
  await expect(panel.getByTestId('artwork-entry')).toHaveCount(1);
  await expect(scene.getByRole('button', { name: 'Exit move mode', exact: true })).toHaveCount(0);
  const frontVisible = await expect.poll(() => printPixels(page).then(colors => Math.min(colors.magenta.count, colors.cyan.count)), { timeout: 6000 }).toBeGreaterThan(30).then(() => true, () => false);
  if (!frontVisible) {
    await scene.getByRole('button', { name: 'Back view', exact: true }).click();
    await expect.poll(() => printPixels(page).then(colors => Math.min(colors.magenta.count, colors.cyan.count)), { timeout: 15_000 }).toBeGreaterThan(30);
  }
  const initial = await printPixels(page);
  // A surface drag operates in draft UVs and must never pull cloth or accept a second pointer.
  const initialPrint = await page.evaluate(() => window.seamer!.getPattern().artwork![0]);
  await panel.getByRole('button', { name: 'Move', exact: true }).click();
  const canvasBox = await scene.locator('canvas').first().boundingBox();
  const origin = { x: canvasBox!.x + initial.magenta.x, y: canvasBox!.y + initial.magenta.y };
  // Toolbar pointer events may have garment coordinates beneath them, but must retain control ownership.
  await scene.getByRole('button', { name: 'Front view', exact: true }).evaluate((element, point) => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 17, button: 0, clientX: point.x, clientY: point.y }));
  }, origin);
  expect(await page.evaluate(() => window.seamer!.getPattern().artwork![0])).toEqual(initialPrint);
  await page.mouse.move(origin.x, origin.y); await page.mouse.down(); await page.mouse.move(origin.x + 12, origin.y + 6);
  expect(await page.evaluate(() => window.seamer!.getPattern().artwork![0])).toEqual(initialPrint);
  await scene.locator('canvas').first().evaluate(element => {
    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 17, clientX: 5, clientY: 5 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 17 }));
  });
  expect(await page.evaluate(() => window.seamer!.getPattern().artwork![0])).toEqual(initialPrint);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await page.evaluate(() => window.seamer!.getPattern().artwork![0])).toEqual(initialPrint);
  await page.mouse.move(origin.x, origin.y); await page.mouse.down(); await page.mouse.move(origin.x + 16, origin.y + 5); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().artwork![0].x)).not.toBe(initialPrint.x);
  expect(await geometryOBJ(page, testInfo, 'after-surface-gesture.obj')).toBe(geometry);
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  await panel.getByLabel('Artwork rotation', { exact: true }).fill('90');
  await panel.getByLabel('Artwork rotation', { exact: true }).press('Tab');
  await expect.poll(() => printPixels(page).then(colors => Math.hypot(colors.magenta.x - initial.magenta.x, colors.magenta.y - initial.magenta.y)), { timeout: 15_000 }).toBeGreaterThan(5);
  expect(await geometryOBJ(page, testInfo, 'after-print.obj')).toBe(geometry);
  expect(await page.evaluate(() => { const pattern = window.seamer!.getPattern(); return { points: pattern.points, paths: pattern.paths, pieces: pattern.pieces }; })).toEqual(pieces);
  await expect(scene.locator('canvas').first()).toHaveAttribute('data-artwork-identity', 'retained');
  expect(await page.evaluate(() => (window as Window & { __seamerWebgpuDrape?: { getState(): unknown } }).__seamerWebgpuDrape?.getState())).toEqual(state);
  await panel.getByRole('button', { name: 'Remove artwork', exact: true }).click();
  await expect.poll(() => printPixels(page).then(colors => colors.magenta.count), { timeout: 15_000 }).toBe(0);
  expect(await geometryOBJ(page, testInfo, 'after-remove.obj')).toBe(geometry);
});
