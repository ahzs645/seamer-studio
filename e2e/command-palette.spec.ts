import { expect, test, type Page } from '@playwright/test';

async function openStudio(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '600');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toBeVisible();
}

test.use({ viewport: { width: 1440, height: 900 } });

test('command palette contains focus, isolates drawing keys and supports every dismissal', async ({ page }) => {
  await openStudio(page);
  const pen = page.getByRole('button', { name: 'Pen tool (lines and curves)', exact: true });
  await pen.click();
  const launcher = page.getByRole('button', { name: 'Command palette', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true });
  const search = dialog.getByRole('searchbox', { name: 'Search commands', exact: true });
  await launcher.click();
  await expect(search).toBeFocused();
  await expect.poll(() => dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await search.focus();
  await page.keyboard.type('n');
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(launcher).toBeFocused();
  await launcher.click();
  await dialog.getByRole('button', { name: 'Close command palette', exact: true }).click();
  await expect(launcher).toBeFocused();
  await launcher.click();
  await page.mouse.click(1, 1);
  await expect(dialog).not.toBeVisible();
  await expect(launcher).toBeFocused();
});

test('workspace search and keyboard navigation switch views and open the fabric panel', async ({ page }) => {
  await openStudio(page);
  const launcher = page.getByRole('button', { name: 'Command palette', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true });
  const search = dialog.getByRole('searchbox', { name: 'Search commands', exact: true });
  await launcher.click();
  await search.fill('workspace');
  await expect(dialog.getByRole('button', { name: 'Show 2D pattern view', exact: true })).toHaveAttribute('aria-current', 'true');
  await search.press('ArrowDown');
  await search.press('ArrowDown');
  await expect(dialog.getByRole('button', { name: 'Show 3D garment view', exact: true })).toHaveAttribute('aria-current', 'true');
  await search.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await launcher.click();
  await search.fill('fabric');
  await search.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#studio-left-panel').getByRole('button', { name: 'Fabric', exact: true })).toHaveClass(/tab-active/);
});

test('advanced commands validate parameters and retain execution through the command bus', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('button', { name: 'Command palette', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true });
  const search = dialog.getByRole('searchbox', { name: 'Search commands', exact: true });
  await search.fill('layer.rename');
  await search.press('Enter');
  const params = dialog.getByRole('textbox', { name: /Advanced parameters \(JSON\)/ });
  await expect(params).toBeFocused();
  const run = dialog.getByRole('button', { name: 'Run Rename layer', exact: true });
  await params.fill('{');
  await run.click();
  await expect(dialog.getByRole('alert')).toHaveText('Invalid JSON');
  await params.fill('[]');
  await run.click();
  await expect(dialog.getByRole('alert')).toHaveText('Parameters must be a JSON object');
  const layerId = await page.evaluate(() => window.seamer!.getPattern().layers[0].id);
  await params.fill(JSON.stringify({ layerId, name: 'Palette renamed layer' }));
  await run.click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().layers[0].name)).toBe('Palette renamed layer');
});
