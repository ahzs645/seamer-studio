import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import type { Pattern } from '@seamer/pattern-model';

test.use({ viewport: { width: 1440, height: 900 } });

async function openColorways(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '600');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
  await page.locator('#studio-left-panel').getByRole('button', { name: 'Colorways', exact: true }).click();
  return page.getByTestId('colorway-panel');
}
async function create(page: Page, name: string) {
  const panel = page.getByTestId('colorway-panel');
  await panel.getByRole('textbox', { name: 'New colorway name', exact: true }).fill(name);
  await panel.getByRole('button', { name: 'Save current as colorway', exact: true }).click();
  await expect(panel.getByRole('button', { name: `Activate colorway ${name}`, exact: true })).toBeVisible();
}
async function tintFront(page: Page, color: string) {
  const input = page.getByTestId('colorway-piece-row').first().locator('input[type="color"]').first();
  await input.evaluate((element, value) => {
    const field = element as HTMLInputElement;
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, color);
}
const firstTint = (page: Page) => page.evaluate(() => {
  const pattern = window.seamer!.getPattern();
  return pattern.materials.find(material => material.id === pattern.pieces[0].materialId)?.frontTexture?.color;
});

function geometry(pattern: Pattern) {
  return { points: pattern.points, paths: pattern.paths, pieces: pattern.pieces.map(({ materialId: _material, ...piece }) => piece) };
}

test('named colorway tint changes actual 3D image, shares geometry and supports switch/undo/redo', async ({ page }) => {
  const panel = await openColorways(page);
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  const originalPattern = await page.evaluate(() => window.seamer!.getPattern());
  const originalTint = await firstTint(page);
  const imageBefore = await page.getByTestId('pattern-scene-3d').locator('canvas').first().screenshot();
  await create(page, 'Summer');
  await tintFront(page, '#ff0000');
  await expect.poll(() => firstTint(page)).toBe('#ff0000');
  const changed = await page.evaluate(() => window.seamer!.getPattern());
  expect(geometry(changed)).toEqual(geometry(originalPattern));
  expect(changed.materials.length).toBe(originalPattern.materials.length + 1);
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await expect.poll(async () => (await page.getByTestId('pattern-scene-3d').locator('canvas').first().screenshot()).equals(imageBefore)).toBe(false);
  await panel.getByRole('button', { name: 'Activate colorway Original', exact: true }).click();
  await expect.poll(() => firstTint(page)).toBe(originalTint);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => firstTint(page)).toBe('#ff0000');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => firstTint(page)).toBe(originalTint);
  await panel.getByRole('button', { name: 'Activate colorway Summer', exact: true }).click();
  await panel.getByRole('button', { name: 'Duplicate colorway', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Colorway name', exact: true }).fill('Evening');
  await panel.getByRole('textbox', { name: 'Colorway name', exact: true }).blur();
  await panel.getByRole('button', { name: 'Activate colorway Evening', exact: true }).click();
  await tintFront(page, '#0000ff');
  await panel.getByRole('button', { name: 'Activate colorway Summer', exact: true }).click();
  await expect.poll(() => firstTint(page)).toBe('#ff0000');
  await panel.getByRole('button', { name: 'Edit colorway Evening', exact: true }).click();
  await panel.getByRole('button', { name: 'Delete colorway', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Activate colorway Evening', exact: true })).toHaveCount(0);
  await expect.poll(() => firstTint(page)).toBe('#ff0000');
});

test('missing fabric references block activation and can be repaired without silently replacing every assignment', async ({ page }) => {
  const panel = await openColorways(page);
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await create(page, 'Summer');
  const ids = await page.evaluate(() => {
    const pattern = window.seamer!.getPattern();
    return { remove: pattern.materials[0].id, replacement: pattern.materials[1].id };
  });
  await page.evaluate(id => window.seamer!.execute('material.delete', { materialId: id }), ids.remove);
  const before = await page.evaluate(() => window.seamer!.getPattern().pieces.map(piece => piece.materialId));
  await panel.getByRole('button', { name: 'Activate colorway Original', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('no longer exists');
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().pieces.map(piece => piece.materialId))).toEqual(before);
  await panel.getByRole('button', { name: 'Edit colorway Original', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  const missingSelects = panel.locator('select').filter({ has: page.locator('option', { hasText: 'Missing fabric' }) });
  while (await missingSelects.count()) await missingSelects.first().selectOption(ids.replacement);
  await panel.getByRole('button', { name: 'Activate colorway Original', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().colorways?.activeId)).toBeTruthy();
});

test('named fabric variants round-trip through exported JSON and SSP imports', async ({ page }, testInfo) => {
  const panel = await openColorways(page);
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await create(page, 'Summer');
  await tintFront(page, '#ab1234');
  // Capture the canonical tinted material reference before comparing serialized variants.
  await panel.getByRole('button', { name: 'Activate colorway Original', exact: true }).click();
  await panel.getByRole('button', { name: 'Activate colorway Summer', exact: true }).click();
  const expected = await page.evaluate(() => window.seamer!.getPattern().colorways);
  for (const format of ['json', 'ssp'] as const) {
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: format === 'json' ? 'JSON (.seamer.json)' : 'Seamer Project — 2D + 3D (.ssp)', exact: true }).click();
    const download = await downloaded;
    const path = testInfo.outputPath(`colorways.${format}`);
    await download.saveAs(path);
    const bytes = await readFile(path);
    const raw = JSON.parse(format === 'ssp' ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8'));
    expect((format === 'ssp' ? raw.pattern : raw).colorways).toEqual(expected);
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('import-menu-trigger').click();
    await page.getByRole('button', { name: /From file/ }).click();
    await (await chooser).setFiles(path);
    await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().colorways)).toEqual(expected);
    await expect.poll(() => firstTint(page)).toBe('#ab1234');
    await panel.getByRole('button', { name: 'Activate colorway Original', exact: true }).click();
    await expect.poll(() => firstTint(page)).not.toBe('#ab1234');
    await panel.getByRole('button', { name: 'Activate colorway Summer', exact: true }).click();
    await expect.poll(() => firstTint(page)).toBe('#ab1234');
  }
});
