import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
});

test('material maps can remain URL-only, download an offline copy, or upload a file', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');

  await page.getByRole('button', { name: 'Fabric', exact: true }).first().click();
  await page.getByRole('button', { name: /Material ↔10\/10/ }).dblclick();
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
