import { expect, test, type Page } from '@playwright/test';

async function openStudio(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '600');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(page.getByTestId('pattern-name-input')).toBeVisible();
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '2D', exact: true }).click();
}

async function openHeaderAction(page: Page, name: string) {
  const launcher = page.getByRole('button', { name, exact: true });
  const more = page.getByRole('button', { name: 'More', exact: true });
  const compact = !await launcher.isVisible();
  if (compact) await more.click();
  await launcher.click();
  return launcher;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 600 }]) {
  test.describe(`${viewport.width}px modal and menu keyboard behavior`, () => {
    test.use({ viewport });

    test('shortcut help contains focus, documents actual bindings and restores its launcher', async ({ page }) => {
      await openStudio(page);
      const pen = page.getByRole('button', { name: 'Pen tool (lines and curves)', exact: true });
      await pen.click();
      const launcher = await openHeaderAction(page, 'Keyboard shortcuts');
      const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
      await expect.poll(() => dialog.evaluate(element => element.matches(':modal'))).toBe(true);
      await expect(dialog.getByText('Command palette', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Paste as copy', { exact: true })).toBeVisible();
      for (const key of ['Tab', 'Shift+Tab', 'n', 'Control+k']) {
        await page.keyboard.press(key);
        await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
      }
      await expect(pen).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(launcher).toBeFocused();
      await openHeaderAction(page, 'Keyboard shortcuts');
      await page.mouse.click(1, 1);
      await expect(dialog).not.toBeVisible();
      await expect(launcher).toBeFocused();
    });

    test('tour skips hidden anchors, contains focus and honors native Back and Skip buttons', async ({ page }) => {
      await openStudio(page);
      const before = await page.evaluate(() => window.seamer!.getPattern().points);
      const launcher = await openHeaderAction(page, 'Take tour');
      const dialog = page.getByRole('dialog', { name: 'Guided tour', exact: true });
      await expect(dialog.getByRole('button', { name: 'Next', exact: true })).toBeFocused();
      await expect.poll(() => dialog.evaluate(element => element.matches(':modal'))).toBe(true);
      await expect(dialog.getByRole('heading')).toHaveText('Drawing tools');
      await page.keyboard.press('ArrowRight');
      await expect(dialog.getByRole('heading')).toHaveText('Canvas toolbar');
      const back = dialog.getByRole('button', { name: 'Back', exact: true });
      await back.focus();
      await page.keyboard.press('Enter');
      await expect(dialog.getByRole('heading')).toHaveText('Drawing tools');
      await expect(dialog.getByRole('button', { name: 'Next', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Skip', exact: true })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.getByRole('button', { name: 'Next', exact: true })).toBeFocused();

      const headings: string[] = [];
      for (let step = 0; step < 8; step++) {
        headings.push(await dialog.getByRole('heading').innerText());
        const card = dialog.getByRole('heading').locator('../..');
        const bounds = await card.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(7);
        expect(bounds!.y).toBeGreaterThanOrEqual(7);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 7);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 7);
        if (await dialog.getByRole('button', { name: 'Done', exact: true }).count()) break;
        await page.keyboard.press('ArrowRight');
      }
      expect(headings).not.toContain('3D try-on');
      expect(headings).not.toContain('Simulation controls');
      if (viewport.width === 390) {
        expect(headings).not.toContain('Layers, body & fabric');
        expect(headings).not.toContain('Properties');
      }
      expect(await page.evaluate(() => window.seamer!.getPattern().points)).toEqual(before);
      await dialog.getByRole('button', { name: 'Skip', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(dialog).not.toBeVisible();
      await expect(launcher).toBeFocused();
      await openHeaderAction(page, 'Take tour');
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(launcher).toBeFocused();
    });
  });
}

test('history menu supports keyboard multi-step undo, Escape, focus return and outside dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStudio(page);
  const original = await page.evaluate(() => window.seamer!.getPattern().layers[0]);
  const rename = await page.evaluate(({ layerId, name }) => window.seamer!.execute('layer.rename', { layerId, name }), { layerId: original.id, name: 'History renamed layer' });
  expect(rename.ok).toBe(true);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().layers[0].name)).toBe('History renamed layer');
  // Distinct actions create two history entries instead of coalescing repeated rename typing.
  const style = await page.evaluate(layerId => window.seamer!.execute('layer.setStyle', { layerId, style: { color: '#123456', dashed: true } }), original.id);
  expect(style.ok).toBe(true);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().layers[0].style?.color)).toBe('#123456');
  const trigger = page.getByRole('button', { name: 'Edit history', exact: true });
  const menu = page.getByRole('menu', { name: 'Edit history', exact: true });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().layers[0])).toEqual(original);
  await trigger.click();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(1, 1);
  await expect(menu).not.toBeVisible();
});

test('long context menu stays inside a phone viewport, scrolls with keyboard and isolates drawing keys', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await openStudio(page);
  await page.getByTestId('import-menu-trigger').click();
  await page.getByTestId('import-sample-rect-piece.dxf').click();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('rect-piece');
  // Import restores the document's saved Both layout; choose the drafting view again.
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '2D', exact: true }).click();
  await expect(page.getByTestId('pattern-scene-3d')).not.toBeVisible();
  for (let index = 0; index < 12; index++) {
    const response = await page.evaluate(name => window.seamer!.execute('layer.create', { name }), `Context layer ${index + 1}`);
    expect(response.ok).toBe(true);
  }
  const pen = page.getByRole('button', { name: 'Pen tool (lines and curves)', exact: true });
  await pen.click();
  const before = await page.evaluate(() => window.seamer!.getPattern().points);
  const canvas = page.getByTestId('pattern-canvas-2d');
  const menu = page.getByRole('menu', { name: 'Selection actions', exact: true });
  const canvasBounds = await canvas.boundingBox();
  expect(canvasBounds).not.toBeNull();
  const interior = { x: canvasBounds!.width * 0.4, y: canvasBounds!.height * 0.62 };
  await canvas.click({ button: 'right', position: interior });
  await expect(menu.getByRole('menuitem', { name: 'Duplicate', exact: true })).toBeFocused();
  // Right-button menu opening must never place a pen point or switch the current tool.
  expect(await page.evaluate(() => window.seamer!.getPattern().points)).toEqual(before);
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(7);
  expect(bounds!.y).toBeGreaterThanOrEqual(7);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(383);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(593);
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
  await expect.poll(() => menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('n');
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.seamer!.getPattern().points)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(canvas).toBeFocused();
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  const resizedCanvas = await canvas.boundingBox();
  expect(resizedCanvas).not.toBeNull();
  await canvas.click({ button: 'right', position: { x: resizedCanvas!.width * 0.4, y: resizedCanvas!.height * 0.62 } });
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => window.seamer!.getPattern().points)).toEqual(before);
  await page.mouse.click(1, 1);
  await expect(menu).not.toBeVisible();
});
