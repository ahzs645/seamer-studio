import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Pattern } from '@seamer/pattern-model';

const example = JSON.parse(readFileSync(new URL('../static/templates/pencil-skirt.json', import.meta.url), 'utf8')) as Pattern;
const savedFabric = {
  id: 'qa-saved-fabric', name: 'QA saved denim', version: 3, updatedAt: '2026-01-02T00:00:00Z',
  writeProtected: false, ownerUserId: null,
  material: { ...example.materials[0], name: 'QA saved denim', stretchWarpValue: 37 }
};

test.use({ viewport: { width: 1440, height: 900 } });

async function openFabric(page: Page) {
  await page.addInitScript(item => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '600');
    localStorage.setItem('seamer.materialLibrary.v1', JSON.stringify([item]));
  }, savedFabric);
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await page.locator('#studio-left-panel').getByRole('button', { name: 'Fabric', exact: true }).click();
  return page.locator('.material-panel');
}

async function selectFirstPiece(page: Page) {
  await page.getByTestId('object-browser-toggle').click();
  await page.getByTestId('object-browser-piece').first().click();
  const selection = await page.evaluate(() => window.seamer!.getSelection().pieceIds);
  expect(selection).toHaveLength(1);
  await page.getByTestId('object-browser-toggle').click();
  return selection[0];
}

const assignments = (page: Page) => page.evaluate(() => window.seamer!.getPattern().pieces.map(piece => ({ id: piece.id, materialId: piece.materialId })));

test('project fabric search and explicit selected/all application keep scope and undo intact', async ({ page }) => {
  const panel = await openFabric(page);
  await expect(panel.getByRole('button', { name: 'Apply to selected pieces', exact: true })).toBeDisabled();
  const before = await assignments(page);
  const targetId = await selectFirstPiece(page);
  const chosenMaterial = await page.evaluate(() => window.seamer!.getPattern().materials.find(material => material.name === 'Waistband')!);
  await panel.getByRole('searchbox', { name: 'Search fabrics' }).fill('Waistband');
  await expect(panel.getByTestId('project-fabric-card')).toHaveCount(1);
  await panel.getByTestId('project-fabric-card').click();
  await panel.getByRole('button', { name: 'Apply to selected pieces', exact: true }).click();
  const selectedOnly = before.map(piece => piece.id === targetId ? { ...piece, materialId: chosenMaterial.id } : piece);
  await expect.poll(() => assignments(page)).toEqual(selectedOnly);
  await expect(panel.getByRole('status')).toHaveText(/Applied Waistband to 1 piece/);
  await panel.getByRole('button', { name: 'Apply to all pieces', exact: true }).click();
  await expect.poll(() => assignments(page)).toEqual(before.map(piece => ({ ...piece, materialId: chosenMaterial.id })));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => assignments(page)).toEqual(selectedOnly);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => assignments(page)).toEqual(before);
});

test('saved fabric copy and assignments undo together; removal keeps valid assignments and undoes', async ({ page }) => {
  const panel = await openFabric(page);
  const before = await assignments(page);
  const materialCount = await page.evaluate(() => window.seamer!.getPattern().materials.length);
  const targetId = await selectFirstPiece(page);
  await panel.getByRole('button', { name: 'Saved library', exact: true }).click();
  await panel.getByRole('searchbox', { name: 'Search fabrics' }).fill('QA saved');
  await panel.getByTestId('library-fabric-card').click();
  await panel.getByRole('button', { name: 'Apply to selected pieces', exact: true }).click();
  const copy = await page.evaluate(() => window.seamer!.getPattern().materials.find(material => material.name === 'QA saved denim')!);
  expect(copy).toMatchObject({ libraryItemId: savedFabric.id, libraryVersion: 3, stretchWarpValue: 37 });
  expect(copy.id).not.toBe(savedFabric.material.id);
  await expect.poll(() => assignments(page)).toEqual(before.map(piece => piece.id === targetId ? { ...piece, materialId: copy.id } : piece));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => assignments(page)).toEqual(before);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials.length)).toBe(materialCount);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await panel.getByRole('button', { name: 'Project fabrics', exact: true }).click();
  await panel.getByRole('button', { name: 'Remove fabric QA saved denim', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const pattern = window.seamer!.getPattern();
    return pattern.pieces.every(piece => !piece.materialId || pattern.materials.some(material => material.id === piece.materialId));
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials.length)).toBe(materialCount);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().materials.some(material => material.id === id), copy.id)).toBe(true);
  await expect.poll(() => assignments(page)).toEqual(before.map(piece => piece.id === targetId ? { ...piece, materialId: copy.id } : piece));
});

test('library browsing never applies without a selection and create-from-library only adds a fabric', async ({ page }) => {
  const panel = await openFabric(page);
  const before = await assignments(page);
  const materialCount = await page.evaluate(() => window.seamer!.getPattern().materials.length);
  await panel.getByRole('button', { name: 'Saved library', exact: true }).click();
  await panel.getByTestId('library-fabric-card').click();
  await expect(panel.getByRole('button', { name: 'Apply to selected pieces', exact: true })).toBeDisabled();
  await expect.poll(() => assignments(page)).toEqual(before);
  await panel.getByRole('button', { name: 'Create from library', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Fabric name', exact: true })).toHaveValue('QA saved denim');
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials.length)).toBe(materialCount + 1);
  await expect.poll(() => assignments(page)).toEqual(before);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials.length)).toBe(materialCount);
});
