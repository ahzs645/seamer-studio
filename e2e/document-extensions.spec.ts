import { expect, test } from '@playwright/test';

test.setTimeout(180_000);
test.use({ viewport: { width: 1440, height: 900 } });

test('malformed production and appearance imports leave the current document and renderers intact', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('seamer.welcomeSeen', '1'); });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#studio-draft-view canvas').first().evaluate(node => node.setAttribute('data-import-probe', 'retained'));
  const before = await page.evaluate(() => structuredClone(window.seamer!.getPattern()));
  for (const [field, invalid] of Object.entries({ artwork: [null], techPack: {}, colorways: {} })) {
    const candidate = { ...before, name: `Invalid ${field}`, [field]: invalid };
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('import-menu-trigger').click();
    await page.getByRole('button', { name: /From file/ }).click();
    await (await chooser).setFiles({ name: `${field}.seamer.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(candidate)) });
    await expect(page.getByText(/Invalid document extension:/).last()).toBeVisible();
    expect(await page.evaluate(() => { const pattern = window.seamer!.getPattern(); return { id: pattern.id, points: pattern.points, paths: pattern.paths, pieces: pattern.pieces }; }))
      .toEqual({ id: before.id, points: before.points, paths: before.paths, pieces: before.pieces });
    await expect(page.getByTestId('pattern-name-input')).toHaveValue(before.name);
    await expect(page.locator('#studio-draft-view canvas').first()).toHaveAttribute('data-import-probe', 'retained');
    // Failed imports intentionally keep their menu open for another choice.
    await page.getByTestId('import-menu-trigger').click();
  }
  expect(errors).toEqual([]);
});
