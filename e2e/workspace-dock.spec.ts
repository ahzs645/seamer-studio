import { expect, test, type Page } from '@playwright/test';

async function openDock(page: Page, preset: 'Both' | 'All' | '2D' = 'All') {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '2');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: preset, exact: true }).click();
  if (await page.getByRole('button', { name: 'More', exact: true }).isVisible()) await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Workspace layout', exact: true }).click();
  await expect(page.getByTestId('workspace-dock')).toBeVisible();
}

async function options(page: Page) {
  await page.getByRole('button', { name: 'Workspace layout options', exact: true }).click();
  return page.getByRole('dialog', { name: 'Arrange workspace panes', exact: true });
}

test.describe('custom document docking', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(180_000);

  test('native controls and pointer docking form nested trees without remounting panes, then reload the saved tree', async ({ page }) => {
    await openDock(page);
    const draftCanvas = page.locator('#studio-draft-view canvas').first();
    const garmentCanvas = page.locator('#studio-garment-view canvas').first();
    await expect(draftCanvas).toBeVisible();
    await expect(garmentCanvas).toBeVisible();
    await draftCanvas.evaluate(node => node.setAttribute('data-instance-probe', 'draft-original'));
    await garmentCanvas.evaluate(node => node.setAttribute('data-instance-probe', 'garment-original'));
    const panel = await options(page);
    await panel.getByLabel('Move pane', { exact: true }).selectOption('specs');
    await panel.getByLabel('Relative to pane', { exact: true }).selectOption('2d');
    await panel.getByLabel('Dock position', { exact: true }).selectOption('below');
    const move = panel.getByRole('button', { name: 'Move pane', exact: true });
    await move.focus();
    await page.keyboard.press('Enter');
    await expect(move).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.seamer!.getPattern!().workspaceLayout?.root))
      .toMatchObject({ type: 'split', direction: 'horizontal', first: { type: 'split', direction: 'vertical', first: { pane: '2d' }, second: { pane: 'specs' } }, second: { pane: '3d' } });
    await expect(draftCanvas).toHaveAttribute('data-instance-probe', 'draft-original');
    await expect(garmentCanvas).toHaveAttribute('data-instance-probe', 'garment-original');
    const firstDraft = (await page.locator('#studio-draft-view').boundingBox())!;
    const firstSpecs = (await page.locator('#studio-specs-view').boundingBox())!;
    const firstGarment = (await page.locator('#studio-garment-view').boundingBox())!;
    expect(firstSpecs.x).toBeCloseTo(firstDraft.x, 0);
    expect(firstSpecs.y).toBeGreaterThan(firstDraft.y);
    expect(firstGarment.x).toBeGreaterThan(firstDraft.x);
    await panel.getByRole('button', { name: 'Close layout options', exact: true }).click();

    const moveGarment = page.getByRole('button', { name: 'Move 3D pane', exact: true });
    await moveGarment.focus();
    const target = page.locator('[data-pane-slot="2d"]');
    const bounds = (await target.boundingBox())!;
    await moveGarment.dragTo(target, { targetPosition: { x: bounds.width / 2, y: bounds.height - 4 } });
    await expect.poll(() => page.evaluate(() => window.seamer!.getPattern!().workspaceLayout?.root))
      .toMatchObject({ type: 'split', direction: 'vertical', first: { type: 'split', direction: 'vertical', first: { pane: '2d' }, second: { pane: '3d' } }, second: { pane: 'specs' } });
    await expect(moveGarment).toBeFocused();
    await expect(draftCanvas).toHaveAttribute('data-instance-probe', 'draft-original');
    await expect(garmentCanvas).toHaveAttribute('data-instance-probe', 'garment-original');
    for (const id of ['studio-draft-view', 'studio-garment-view', 'studio-specs-view']) await expect(page.locator(`#${id}`)).toHaveCount(1);
    for (const pane of ['2d', '3d', 'specs']) await expect(page.locator(`[data-pane-slot="${pane}"] > [data-workspace-pane="${pane}"]`)).toHaveCount(1);
    const stackedDraft = (await page.locator('#studio-draft-view').boundingBox())!;
    const stackedGarment = (await page.locator('#studio-garment-view').boundingBox())!;
    const stackedSpecs = (await page.locator('#studio-specs-view').boundingBox())!;
    expect(stackedDraft.y + stackedDraft.height).toBeLessThanOrEqual(stackedGarment.y + 1);
    expect(stackedGarment.y + stackedGarment.height).toBeLessThanOrEqual(stackedSpecs.y + 1);
    const saved = await page.evaluate(() => window.seamer!.getPattern!().workspaceLayout);
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    await expect(page.getByTestId('workspace-dock')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.seamer!.getPattern!().workspaceLayout)).toEqual(saved);
  });

  test('split sizes are independent; a live pointer resize commits once and one undo restores it', async ({ page }) => {
    await openDock(page);
    const inner = page.getByRole('separator', { name: 'Resize 2D and 3D views', exact: true });
    const outer = page.getByRole('separator', { name: 'Resize Design and Specs views', exact: true });
    const geometry = await page.evaluate(() => ({ points: window.seamer!.getPattern!().points, pieces: window.seamer!.getPattern!().pieces }));
    await inner.focus();
    await page.keyboard.press('ArrowRight');
    await expect(inner).toHaveAttribute('aria-valuenow', '55');
    await expect(outer).toHaveAttribute('aria-valuenow', '70');
    // Separate this gesture from the editor's intentional 800ms history coalescing interval.
    await page.waitForTimeout(850);
    const before = await page.evaluate(() => window.seamer!.getPattern!().workspaceLayout);
    const bounds = (await outer.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 45, bounds.y + bounds.height / 2, { steps: 6 });
    await expect.poll(async () => Number(await outer.getAttribute('aria-valuenow'))).toBeGreaterThan(70);
    expect(await page.evaluate(() => window.seamer!.getPattern!().workspaceLayout)).toEqual(before);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.seamer!.getPattern!().workspaceLayout)).not.toEqual(before);
    await expect(inner).toHaveAttribute('aria-valuenow', '55');
    await page.evaluate(() => window.seamer!.undo());
    await expect.poll(() => page.evaluate(() => window.seamer!.getPattern!().workspaceLayout)).toEqual(before);
    await expect(outer).toHaveAttribute('aria-valuenow', '70');
    expect(await page.evaluate(() => ({ points: window.seamer!.getPattern!().points, pieces: window.seamer!.getPattern!().pieces }))).toEqual(geometry);
  });
});

test.describe('touch layout controls', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.setTimeout(180_000);
  test('show/hide and native move controls work on portrait screens and retain one pane', async ({ page }) => {
    await openDock(page, '2D');
    const panel = await options(page);
    await expect(panel.getByLabel('Show 2D pane', { exact: true })).toBeDisabled();
    await panel.getByLabel('Show Specs pane', { exact: true }).check();
    await panel.getByLabel('Show 2D pane', { exact: true }).uncheck();
    await expect(panel.getByLabel('Show Specs pane', { exact: true })).toBeDisabled();
    await expect(page.locator('[data-workspace-pane]')).toHaveCount(1);
    await panel.getByLabel('Show 3D pane', { exact: true }).check();
    await panel.getByLabel('Move pane', { exact: true }).selectOption('specs');
    await panel.getByLabel('Relative to pane', { exact: true }).selectOption('3d');
    await panel.getByLabel('Dock position', { exact: true }).selectOption('above');
    await panel.getByRole('button', { name: 'Move pane', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.seamer!.getPattern!().workspaceLayout?.root))
      .toMatchObject({ type: 'split', direction: 'vertical', first: { pane: 'specs' }, second: { pane: '3d' } });
    await panel.getByRole('button', { name: 'Close layout options', exact: true }).click();
    await expect(page.getByRole('separator', { name: 'Resize Specs and 3D views', exact: true })).toHaveAttribute('aria-orientation', 'horizontal');
    const specs = (await page.locator('#studio-specs-view').boundingBox())!;
    const garment = (await page.locator('#studio-garment-view').boundingBox())!;
    expect(specs.y + specs.height).toBeLessThanOrEqual(garment.y);
    await expect(page.getByRole('button', { name: 'Move Specs pane', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    for (const id of ['studio-garment-view', 'studio-specs-view']) await expect(page.locator(`#${id}`)).toHaveCount(1);
  });
});
