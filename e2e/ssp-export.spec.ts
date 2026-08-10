import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
});

test('SSP v2 captures the live 3D checkpoint, preview, lighting, and workspace mode', async ({ page }, testInfo) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready');

  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.getByRole('button', { name: 'Sunset', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sunset', exact: true })).toHaveClass(/btn-active/);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Seamer Project — 2D + 3D (.ssp)', exact: true }).click();
  const download = await downloadPromise;
  const archivePath = testInfo.outputPath('round-trip.ssp');
  await download.saveAs(archivePath);

  const envelope = JSON.parse(gunzipSync(await readFile(archivePath)).toString('utf8'));
  expect(envelope.format).toBe('seamer-project');
  expect(envelope.manifest.schemaVersion).toBe(2);
  expect(envelope.manifest.workspace.viewMode).toBe('3d');
  expect(envelope.manifest.workspace.lightingMode).toBe('sunset');
  expect(envelope.manifest.checkpoint.resumePolicy).toBe('zero-velocity');
  expect(envelope.manifest.checkpoint.particleCount).toBeGreaterThan(0);
  expect(envelope.manifest.previewAssetId).toMatch(/^asset-/);
  expect(envelope.pattern.pieces.every((piece: { settings3d: { savedPositions: number[] } }) => piece.settings3d.savedPositions.length > 0)).toBe(true);

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(archivePath);

  await expect(page.getByText('Imported "Pencil skirt - 3D"')).toBeVisible();
  await expect(page.getByRole('button', { name: '3D', exact: true })).toHaveClass(/btn-active/);
  await expect(page.getByRole('button', { name: 'Sunset', exact: true })).toHaveClass(/btn-active/);
});
