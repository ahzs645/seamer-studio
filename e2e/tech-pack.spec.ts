import { expect, test, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function openStudio(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '2');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toBeVisible();
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Specs', exact: true }).click();
}
async function enter(scope: Locator, label: string, value: string) {
  const input = scope.getByLabel(label, { exact: true });
  await input.fill(value); await input.press('Tab');
}

test.use({ viewport: { width: 1440, height: 1000 } });

test('Tech Pack edits manual size values, converts POM units, costs live BOM quantities and exports an offline document', async ({ page }, testInfo) => {
  await openStudio(page);
  const specs = page.getByTestId('specs-workspace');
  await specs.getByRole('button', { name: 'Add measurement row', exact: true }).click();
  await enter(specs, 'Measurement name', 'Finished hem');
  await specs.getByLabel('Measurement unit', { exact: true }).selectOption('cm');
  await enter(specs, 'Minus tolerance', '0.5'); await enter(specs, 'Plus tolerance', '1');
  await specs.getByRole('tab', { name: 'Bill of materials', exact: true }).click();
  await specs.getByRole('button', { name: 'Add BOM row', exact: true }).click();
  await enter(specs, 'BOM item name', 'Invisible zip'); await enter(specs, 'BOM quantity', '2');
  await specs.getByRole('tab', { name: 'Tech Pack', exact: true }).click();
  const pack = page.getByTestId('tech-pack-panel');
  await enter(pack, 'Style code', 'SK-TEST'); await enter(pack, 'Document revision', 'Sample B');
  await enter(pack, 'Primary supplier', 'Factory A'); await enter(pack, 'Cost currency', 'CAD');
  await enter(pack, 'Document notes', 'Seam <checked> & supplier approved');
  await pack.getByRole('tab', { name: 'Size chart', exact: true }).click();
  await pack.getByRole('button', { name: 'Add production size', exact: true }).click();
  await enter(pack, 'Size name 1', 'M');
  await pack.getByLabel('Sample size', { exact: true }).selectOption({ label: 'M' });
  await enter(pack, 'Finished hem M target', '50'); await enter(pack, 'Finished hem M actual', '50.5');
  await expect(pack.getByTestId('tech-pack-size-status')).toHaveText('Within tolerance');
  await specs.getByRole('tab', { name: 'Measurements', exact: true }).click();
  await specs.getByLabel('Measurement unit', { exact: true }).selectOption('mm');
  await specs.getByRole('tab', { name: 'Tech Pack', exact: true }).click();
  await pack.getByRole('tab', { name: 'Size chart', exact: true }).click();
  await expect(pack.getByLabel('Finished hem M target', { exact: true })).toHaveValue('500');
  await expect(pack.getByLabel('Finished hem M actual', { exact: true })).toHaveValue('505');
  await pack.getByRole('tab', { name: 'Construction', exact: true }).click();
  await pack.getByRole('button', { name: 'Add construction instruction', exact: true }).click();
  await enter(pack, 'Instruction title', 'Finish hem'); await enter(pack, 'Construction instruction', 'Turn 20 mm and topstitch.');
  await pack.getByRole('tab', { name: 'Supplier costing', exact: true }).click();
  await pack.getByRole('button', { name: 'Add supplier cost', exact: true }).click();
  await pack.getByLabel('Cost item source', { exact: true }).selectOption({ label: 'BOM · Invisible zip' });
  await enter(pack, 'Unit cost', '3.5');
  await expect(pack.getByTestId('tech-pack-line-total')).toHaveText('7 CAD');
  await specs.getByRole('tab', { name: 'Bill of materials', exact: true }).click();
  await enter(specs, 'BOM quantity', '3');
  await specs.getByRole('tab', { name: 'Tech Pack', exact: true }).click();
  await pack.getByRole('tab', { name: 'Supplier costing', exact: true }).click();
  await expect(pack.getByTestId('tech-pack-line-total')).toHaveText('10.5 CAD');
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await specs.getByRole('tab', { name: 'Tech Pack', exact: true }).click();
  await expect(pack.getByLabel('Style code', { exact: true })).toHaveValue('SK-TEST');
  await expect(pack.getByLabel('Document revision', { exact: true })).toHaveValue('Sample B');
  await pack.getByRole('tab', { name: 'Preview', exact: true }).click();
  const preview = page.frameLocator('iframe[title="Tech Pack export preview"]');
  await expect(preview.getByRole('heading', { name: 'Document identity', exact: true })).toBeVisible();
  await expect(preview.getByText('Seam <checked> & supplier approved', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await pack.getByRole('button', { name: 'Download Tech Pack HTML', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('SK-TEST_tech-pack.html');
  const outputPath = testInfo.outputPath('tech-pack.html'); await download.saveAs(outputPath);
  const html = await readFile(outputPath, 'utf8');
  expect(html).toContain('Seam &lt;checked&gt; &amp; supplier approved');
  expect(html).toContain('Finish hem'); expect(html).toContain('Turn 20 mm and topstitch.');
  expect(html).toContain('500 / 505'); expect(html).toContain('10.5'); expect(html).toContain('CAD');
  expect(html).not.toMatch(/<script|<img[^>]+src="https?:/i);
  const csvPromise = page.waitForEvent('download');
  await pack.getByRole('button', { name: 'Download measurements CSV', exact: true }).click();
  const csvDownload = await csvPromise; const csvPath = testInfo.outputPath('measurements.csv'); await csvDownload.saveAs(csvPath);
  expect(await readFile(csvPath, 'utf8')).toContain('"Finished hem","M","Manual size entry","mm","505","500","5","10"');
});

test('Tech Pack changes use document undo and repeated direct navigation opens its tab', async ({ page }) => {
  await openStudio(page);
  const specs = page.getByTestId('specs-workspace');
  await specs.getByRole('tab', { name: 'Tech Pack', exact: true }).click();
  const pack = page.getByTestId('tech-pack-panel');
  await enter(pack, 'Style code', 'UNDO-STYLE');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(pack.getByLabel('Style code', { exact: true })).toHaveValue('');
  await specs.getByRole('tab', { name: 'Measurements', exact: true }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Tech Pack…', exact: true }).click();
  await expect(pack).toBeVisible();
  await specs.getByRole('tab', { name: 'Measurements', exact: true }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Tech Pack…', exact: true }).click();
  await expect(pack).toBeVisible();
});
