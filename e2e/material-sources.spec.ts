import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
});

test('material maps can remain URL-only, download an offline copy, or upload a file', async ({ page }) => {
  // Keep URL download coverage independent of the captured application's asset host.
  const texture = await readFile(new URL('../static/textures/69db4cec-026c-44e3-b5f5-cf088e1aca43.jpg', import.meta.url));
  await page.route(/69db4cec-026c-44e3-b5f5-cf088e1aca43\.jpg(?:\?.*)?$/, route =>
    route.fulfill({ status: 200, contentType: 'image/jpeg', body: texture })
  );
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');

  await page.locator('#studio-left-panel').getByRole('tab', { name: 'Fabric', exact: true }).click();
  await page.locator('.material-panel').getByRole('button', { name: 'Edit fabric Material', exact: true }).click();
  const source = page.getByTestId('texture-source-base').first();
  const url = source.getByRole('textbox', { name: 'Texture map URL' });
  await expect(url).toHaveValue(/69db4cec-026c-44e3-b5f5-cf088e1aca43\.jpg$/);

  await source.getByRole('button', { name: 'Reference URL' }).click();
  await expect(source.getByText('URL only')).toBeVisible();

  await source.getByRole('button', { name: 'Download URL' }).click();
  await expect(source.getByText('Downloaded')).toBeVisible();
  await expect(source.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);

  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  await source.locator('input[type="file"]').setInputFiles({ name: 'swatch.png', mimeType: 'image/png', buffer: onePixelPng });
  await expect(source.getByText('Uploaded')).toBeVisible();
  await expect(source.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);

  await url.fill('https://example.com/fabric.png');
  await source.getByRole('button', { name: 'Reference URL' }).click();
  await expect(source.getByText('URL only')).toBeVisible();
});
