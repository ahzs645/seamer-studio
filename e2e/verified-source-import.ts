import { expect, type Page } from '@playwright/test';

/** Observe the current document before a raw generated-source file is chosen. */
export async function captureSourceImportDocument(page: Page): Promise<string> {
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 90_000 });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => window.seamer?.getPattern().name), { timeout: 90_000 }).toBe('Pencil skirt - 3D');
  const scene = page.getByTestId('pattern-scene-3d');
  if (await scene.isVisible()) await expect(scene).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });
  return page.evaluate(() => JSON.stringify(window.seamer!.getPattern()));
}

/** Exercise the explicit consent required for independently verified raw source. */
export async function acceptVerifiedSourceImport(page: Page, documentBefore: string, touch?: boolean) {
  const dialog = page.getByRole('dialog', { name: 'Import verified source', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  expect(await page.evaluate(() => JSON.stringify(window.seamer!.getPattern()))).toBe(documentBefore);
  const accept = dialog.getByRole('button', { name: 'Import verified source', exact: true });
  const useTouch = touch ?? await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  if (useTouch) await accept.tap();
  else await accept.click();
  await expect(dialog).not.toBeVisible();
}
