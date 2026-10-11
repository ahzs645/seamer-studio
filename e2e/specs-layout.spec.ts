import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px production layout`, () => {
    test.use({ viewport });
    test.setTimeout(180_000);
    test('three panes have unique controls, resize independently, and Specs stays editable', async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem('seamer.welcomeSeen', '1');
        localStorage.setItem('seamer.autosaveSeconds', '120');
      });
      await page.goto('/studio', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
      await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
      if (viewport.width < 1024) await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByTestId('object-browser-toggle').click();
      await page.getByTestId('object-browser-piece').first().click();
      await page.getByTestId('object-browser').getByRole('button', { name: 'Close panel', exact: true }).click();
      const closeActions = page.getByRole('button', { name: 'Close studio actions', exact: true });
      if (await closeActions.isVisible()) await closeActions.click();
      const count = await page.evaluate(() => window.seamer!.getPattern!().pieces.length);
      await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Specs', exact: true }).click();
      const specs = page.getByTestId('specs-workspace');
      await expect(specs).toBeVisible();
      await specs.getByRole('button', { name: 'Add measurement row', exact: true }).focus();
      await page.keyboard.press('Control+d');
      expect(await page.evaluate(() => window.seamer!.getPattern!().pieces.length)).toBe(count);
      await page.getByRole('button', { name: 'Show 2D + 3D + Specs', exact: true }).click();
      const outer = page.getByRole('separator', { name: 'Resize Design and Specs views', exact: true });
      const inner = page.getByRole('separator', { name: 'Resize 2D and 3D views', exact: true });
      await expect(outer).toHaveAttribute('aria-valuenow', '70');
      await expect(inner).toHaveAttribute('aria-valuenow', '50');
      for (const id of ['studio-design-view', 'studio-specs-view', 'studio-draft-view', 'studio-garment-view']) {
        await expect(page.locator(`#${id}`)).toHaveCount(1);
      }
      await outer.focus();
      await page.keyboard.press(viewport.width < 768 ? 'ArrowUp' : 'ArrowLeft');
      await expect(outer).toHaveAttribute('aria-valuenow', '65');
      await expect(inner).toHaveAttribute('aria-valuenow', '50');
      await inner.focus();
      await page.keyboard.press(viewport.width < 768 ? 'ArrowDown' : 'ArrowRight');
      await expect(inner).toHaveAttribute('aria-valuenow', '55');
      await expect(outer).toHaveAttribute('aria-valuenow', '65');
      const geometry = await page.evaluate(() => ({ points: window.seamer!.getPattern!().points, pieces: window.seamer!.getPattern!().pieces }));
      await specs.getByRole('button', { name: 'Add measurement row', exact: true }).focus();
      for (const key of ['ArrowRight', 'n', 'Control+d']) await page.keyboard.press(key);
      expect(await page.evaluate(() => ({ points: window.seamer!.getPattern!().points, pieces: window.seamer!.getPattern!().pieces }))).toEqual(geometry);
      await specs.getByRole('button', { name: 'Add measurement row', exact: true }).click();
      await specs.getByLabel('Measurement name', { exact: true }).fill('Layout test');
      await specs.getByLabel('Measurement name', { exact: true }).press('Tab');
      await expect.poll(() => page.evaluate(() => window.seamer!.getPattern!().productionSpec?.measurements[0]?.name)).toBe('Layout test');
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `/workspace/scratch/seamer-all-${viewport.width}.png` });
      await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Specs', exact: true }).click();
      await expect(specs.getByLabel('Measurement name', { exact: true })).toHaveValue('Layout test');
    });
  });
}
