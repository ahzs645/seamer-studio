import { expect, test } from '@playwright/test';

test('command edits autosave and survive reload without an explicit Save', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '2');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await page.evaluate(() => window.seamer!.execute('point.create', { x: 345, y: 678, name: 'Autosave QA' }));
  const pointId = await page.evaluate(() => window.seamer!.getPattern().points.find(point => point.name === 'Autosave QA')!.id);
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  const savedUrl = page.url();
  expect(new URL(savedUrl).pathname).toMatch(/\/studio\/[^/]+$/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(id => {
    const point = window.seamer?.getPattern().points.find(point => point.id === id);
    return point && { name: point.name, x: point.x, y: point.y };
  }, pointId)).toEqual({ name: 'Autosave QA', x: 345, y: 678 });
  expect(page.url()).toBe(savedUrl);
});
