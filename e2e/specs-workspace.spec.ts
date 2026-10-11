import { expect, test, type Page } from '@playwright/test';

async function openStudio(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '2');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
}
async function commitNumber(page: Page, label: string, value: string) {
  await page.getByTestId('specs-workspace').getByLabel(label, { exact: true }).fill(value);
  await page.getByTestId('specs-workspace').getByLabel(label, { exact: true }).press('Tab');
}

test.use({ viewport: { width: 1440, height: 900 } });

test('manual production POMs and BOM rows use document undo and survive autosave/reload', async ({ page }) => {
  await openStudio(page);
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Specs', exact: true }).click();
  const panel = page.getByTestId('specs-workspace');
  await panel.getByRole('button', { name: 'Add measurement row', exact: true }).click();
  await panel.getByLabel('Measurement name', { exact: true }).fill('Finished hem');
  await panel.getByLabel('Measurement name', { exact: true }).press('Tab');
  await panel.getByLabel('Measurement unit', { exact: true }).selectOption('cm');
  await commitNumber(page, 'Sample actual', '51');
  await commitNumber(page, 'Measurement target', '50');
  await commitNumber(page, 'Minus tolerance', '0.5');
  await commitNumber(page, 'Plus tolerance', '2');
  await expect(panel.getByTestId('spec-measurement-status')).toHaveText('Within tolerance');
  await commitNumber(page, 'Sample actual', '53');
  await expect(panel.getByTestId('spec-measurement-status')).toHaveText('Outside tolerance');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.getByLabel('Sample actual', { exact: true })).toHaveValue('51');
  await expect(panel.getByTestId('spec-measurement-status')).toHaveText('Within tolerance');
  await panel.getByRole('tab', { name: 'Bill of materials', exact: true }).click();
  await expect(panel.getByTestId('spec-assigned-fabric').first()).toBeVisible();
  await panel.getByRole('button', { name: 'Add BOM row', exact: true }).click();
  await panel.getByLabel('BOM item name', { exact: true }).fill('Invisible zip');
  await panel.getByLabel('BOM item name', { exact: true }).press('Tab');
  await commitNumber(page, 'BOM quantity', '1');
  await panel.getByLabel('BOM notes', { exact: true }).fill('20 cm');
  await panel.getByLabel('BOM notes', { exact: true }).press('Tab');
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Measurement name', { exact: true })).toHaveValue('Finished hem');
  await expect(panel.getByLabel('Sample actual', { exact: true })).toHaveValue('51');
  await panel.getByRole('tab', { name: 'Bill of materials', exact: true }).click();
  await expect(panel.getByLabel('BOM item name', { exact: true })).toHaveValue('Invisible zip');
  await expect(panel.getByLabel('BOM quantity', { exact: true })).toHaveValue('1');
  await expect(panel.getByLabel('BOM notes', { exact: true })).toHaveValue('20 cm');
});

test('linked 2D distances and angles update live, convert units and surface deleted references', async ({ page }) => {
  await openStudio(page);
  const fixture = await page.evaluate(() => {
    const pattern = window.seamer!.getPattern!();
    return { ...pattern, id: 'specs-browser-fixture', name: 'Specs annotation fixture', viewMode: 'specs',
      points: [...pattern.points,
        { id: 'spec-a', name: 'Spec A', x: 0, y: 0 },
        { id: 'spec-v', name: 'Spec vertex', x: 30, y: 0 },
        { id: 'spec-b', name: 'Spec B', x: 30, y: 40 }],
      measurements: [
        { id: 'spec-distance', name: 'QA distance', fromPointId: 'spec-a', toPointId: 'spec-b', targetMm: 50 },
        { id: 'spec-angle', name: 'QA angle', kind: 'angle', fromPointId: 'spec-a', viaPointId: 'spec-v', toPointId: 'spec-b', targetMm: 90 }
      ] };
  });
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles({ name: 'specs-fixture.seamer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  const panel = page.getByTestId('specs-workspace');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Add measurement row', exact: true }).click();
  await panel.getByLabel('Measurement source', { exact: true }).selectOption('spec-distance');
  await panel.getByLabel('Measurement unit', { exact: true }).selectOption('cm');
  await expect(panel.getByTestId('spec-actual')).toHaveText('5');
  await expect(panel.getByLabel('Measurement target', { exact: true })).toHaveValue('5');
  await page.evaluate(() => window.seamer!.execute('point.move', { pointId: 'spec-b', x: 30, y: 80 }));
  await expect(panel.getByTestId('spec-actual')).toHaveText('8.544');
  await panel.getByLabel('Measurement source', { exact: true }).selectOption('spec-angle');
  await expect(panel.getByLabel('Measurement unit', { exact: true })).toHaveValue('deg');
  await expect(panel.getByTestId('spec-actual')).toHaveText('90');
  await expect(panel.getByLabel('Measurement target', { exact: true })).toHaveValue('90');
  await page.evaluate(() => window.seamer!.execute('element.delete', { id: 'spec-b' }));
  await expect(panel.getByTestId('spec-measurement-status')).toHaveText('Missing annotation');
  await expect(panel.getByTestId('spec-actual')).toHaveText('—');
});
