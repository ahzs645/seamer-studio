import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

test.setTimeout(180_000);
test.use({ viewport: { width: 1440, height: 900 } });

async function openRectangle(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '600');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await page.getByTestId('import-menu-trigger').click();
  await page.getByTestId('import-sample-rect-piece.dxf').click();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('rect-piece');
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '2D', exact: true }).click();
}

async function selectFirstPiece(page: Page) {
  const toggle = page.getByTestId('object-browser-toggle');
  if (!await toggle.isVisible()) await page.getByRole('button', { name: 'More', exact: true }).click();
  await toggle.click();
  await page.getByTestId('object-browser').getByTestId('object-browser-piece').first().click();
  await toggle.click();
}

async function openArtwork(page: Page) {
  const panel = page.locator('#studio-left-panel');
  if (!await panel.isVisible()) await page.getByRole('button', { name: 'Layers and body panel', exact: true }).click();
  await panel.locator('.tabs').getByText('Artwork', { exact: true }).click();
  await expect(page.getByTestId('artwork-panel')).toBeVisible();
  return page.getByTestId('artwork-panel');
}

async function imageUpload(page: Page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fa00f8'; context.fillRect(0, 0, 40, 40);
    context.fillStyle = '#00d2f4'; context.fillRect(40, 0, 40, 40);
    return canvas.toDataURL('image/png');
  });
  return { name: 'Two-color-logo.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') };
}

async function printPixels(page: Page) {
  return page.getByTestId('pattern-canvas-2d').evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    const colors = { magenta: { count: 0, x: 0, y: 0 }, cyan: { count: 0, x: 0, y: 0 } };
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
      const key = red > 240 && green < 10 && blue > 240 ? 'magenta' : red < 10 && green > 200 && green < 220 && blue > 235 ? 'cyan' : null;
      if (key) { colors[key].count++; colors[key].x += index / 4 % element.width; colors[key].y += Math.floor(index / 4 / element.width); }
    }
    return Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, {
      count: color.count, x: color.count ? color.x / color.count : 0, y: color.count ? color.y / color.count : 0
    }])) as Record<'magenta' | 'cyan', { count: number; x: number; y: number }>;
  });
}

async function commitNumber(page: Page, label: string, value: string) {
  const control = page.getByTestId('artwork-panel').getByLabel(label, { exact: true });
  await control.fill(value); await control.press('Tab');
}

test('piece-bound artwork paints actual 2D geometry, follows rotation/mirroring, and persists through SSP', async ({ page }, testInfo) => {
  await openRectangle(page);
  await selectFirstPiece(page);
  const panel = await openArtwork(page);
  const before = await page.evaluate(() => { const p = window.seamer!.getPattern(); return { points: p.points, paths: p.paths, pieces: p.pieces }; });
  await panel.getByLabel('Add image to selected piece', { exact: true }).setInputFiles(await imageUpload(page));
  await expect(panel.getByTestId('artwork-entry')).toHaveCount(1);
  await expect.poll(() => printPixels(page).then(result => result.magenta.count)).toBeGreaterThan(50);
  const initial = await printPixels(page);
  expect(initial.magenta.x).toBeLessThan(initial.cyan.x);
  expect(await page.evaluate(() => { const p = window.seamer!.getPattern(); return { points: p.points, paths: p.paths, pieces: p.pieces }; })).toEqual(before);
  await commitNumber(page, 'Artwork width', '80');
  await commitNumber(page, 'Artwork height', '40');
  await commitNumber(page, 'Artwork rotation', '90');
  await expect.poll(() => printPixels(page).then(result => result.magenta.y - result.cyan.y)).toBeGreaterThan(10);
  await commitNumber(page, 'Artwork rotation', '0');
  const ownerId = await page.evaluate(() => window.seamer!.getPattern().artwork![0].pieceId);
  const response = await page.evaluate(pieceId => window.seamer!.execute('piece.update', { pieceId, mirrorX: true }), ownerId);
  expect(response.ok).toBe(true);
  // Fit the mirrored placement as a user would; the raw drafting copy remains in this editor.
  await page.getByTestId('pattern-canvas-2d').focus();
  await page.keyboard.press('Control+0');
  await expect.poll(() => printPixels(page).then(result => result.magenta.x - result.cyan.x)).toBeGreaterThan(10);
  await page.evaluate(() => window.seamer!.undo());
  await expect.poll(() => printPixels(page).then(result => result.cyan.x - result.magenta.x)).toBeGreaterThan(10);
  await panel.getByRole('button', { name: 'Remove artwork', exact: true }).click();
  await expect(panel.getByTestId('artwork-entry')).toHaveCount(0);
  await expect.poll(() => printPixels(page).then(result => result.magenta.count)).toBe(0);
  await page.evaluate(() => window.seamer!.undo());
  await expect(panel.getByTestId('artwork-entry')).toHaveCount(1);
  await expect.poll(() => printPixels(page).then(result => result.magenta.count)).toBeGreaterThan(50);
  const artwork = await page.evaluate(() => window.seamer!.getPattern().artwork);
  await page.locator('[data-tour-id="tour-save"]').click();
  await expect(page.locator('[data-tour-id="tour-save"]')).toHaveText('Saved');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().artwork)).toEqual(artwork);
  await expect.poll(() => printPixels(page).then(result => result.magenta.count)).toBeGreaterThan(50);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Seamer Project — 2D + 3D (.ssp)', exact: true }).click();
  const download = await downloadPromise;
  const archivePath = testInfo.outputPath('artwork.ssp'); await download.saveAs(archivePath);
  const archive = JSON.parse(gunzipSync(await readFile(archivePath)).toString('utf8'));
  expect(archive.pattern.artwork).toEqual(artwork);
  const reloadedPanel = await openArtwork(page);
  await reloadedPanel.getByRole('button', { name: 'Remove artwork', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().artwork)).toEqual([]);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooserPromise).setFiles(archivePath);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().artwork)).toEqual(artwork);
  await expect.poll(() => printPixels(page).then(result => result.magenta.count)).toBeGreaterThan(50);
});

test('artwork upload requires explicit piece selection and rejects active/corrupt sources without editing geometry', async ({ page }) => {
  await openRectangle(page);
  const panel = await openArtwork(page);
  const upload = panel.getByLabel('Add image to selected piece', { exact: true });
  await expect(upload).toBeDisabled();
  await selectFirstPiece(page);
  await expect(upload).toBeEnabled();
  const before = await page.evaluate(() => window.seamer!.getPattern());
  await upload.setInputFiles({ name: 'active.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
  await expect(panel.getByRole('alert')).toHaveText('Choose a PNG, JPEG or WebP image.');
  await upload.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('invalid raster content') });
  await expect(panel.getByRole('alert')).toHaveText(/cannot be decoded/);
  expect(await page.evaluate(() => window.seamer!.getPattern())).toEqual(before);
  await upload.setInputFiles(await imageUpload(page));
  await expect(panel.getByTestId('artwork-entry')).toHaveCount(1);
  const geometry = await page.evaluate(() => window.seamer!.getPattern().points);
  await panel.getByRole('button', { name: 'Center on piece', exact: true }).focus();
  await page.keyboard.press('n');
  expect(await page.evaluate(() => window.seamer!.getPattern().points)).toEqual(geometry);
  await expect(page.getByRole('button', { name: 'Modify & select', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await commitNumber(page, 'Artwork width', '-5');
  await expect(panel.getByRole('alert')).toHaveText(/greater than zero/);
  expect((await page.evaluate(() => window.seamer!.getPattern().artwork![0])).widthMm).toBeGreaterThan(0);
});

test('missing owners and imported image sources are shown for repair without remote image requests', async ({ page }) => {
  await openRectangle(page);
  await selectFirstPiece(page);
  const panel = await openArtwork(page);
  await panel.getByLabel('Add image to selected piece', { exact: true }).setInputFiles(await imageUpload(page));
  await expect(panel.getByTestId('artwork-entry')).toHaveCount(1);
  const deletion = await page.evaluate(() => window.seamer!.execute('selection.delete'));
  expect(deletion.ok).toBe(true);
  await expect(panel.getByText('The owner piece is missing. Choose another piece or remove this artwork.', { exact: true })).toBeVisible();
  await page.evaluate(() => window.seamer!.undo());
  await expect(panel.getByText('The owner piece is missing. Choose another piece or remove this artwork.', { exact: true })).not.toBeVisible();
  const imported = await page.evaluate(() => {
    const pattern = structuredClone(window.seamer!.getPattern());
    pattern.name = 'Artwork source repair';
    pattern.artwork![0].dataUrl = 'https://never.test/no-request.png';
    return JSON.stringify(pattern);
  });
  let remoteRequested = false;
  await page.route('https://never.test/**', async route => { remoteRequested = true; await route.abort(); });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooserPromise).setFiles({ name: 'repair.seamer.json', mimeType: 'application/json', buffer: Buffer.from(imported) });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Artwork source repair');
  const repairPanel = await openArtwork(page);
  await expect(repairPanel.getByText('Use an embedded PNG, JPEG or WebP image.', { exact: true })).toBeVisible();
  expect(remoteRequested).toBe(false);
  await repairPanel.getByLabel('Replace image (keeps placement)', { exact: true }).setInputFiles(await imageUpload(page));
  await expect(repairPanel.getByText('Use an embedded PNG, JPEG or WebP image.', { exact: true })).not.toBeVisible();
  await expect.poll(() => printPixels(page).then(result => result.magenta.count)).toBeGreaterThan(50);
  expect(remoteRequested).toBe(false);
});
