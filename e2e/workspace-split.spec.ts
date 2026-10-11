import { expect, test, type Page } from '@playwright/test';

async function openSplit(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '120');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Both', exact: true }).click();
}

test.describe('adjustable desktop workspace', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(180_000);

  test('dragging resizes actual canvases, persists through view changes and reload, and resets', async ({ page }) => {
    await openSplit(page);
    const divider = page.getByRole('separator', { name: 'Resize 2D and 3D views' });
    await expect(divider).toHaveAttribute('aria-orientation', 'vertical');
    const draft = page.locator('#studio-draft-view');
    const garment = page.locator('#studio-garment-view');
    const before = (await draft.boundingBox())!.width;
    const grip = (await divider.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 90, grip.y + grip.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await draft.boundingBox())!.width).toBeGreaterThan(before + 60);
    await expect.poll(async () => (await draft.boundingBox())!.width / (await garment.boundingBox())!.width).toBeGreaterThan(1.2);
    await expect.poll(async () => {
      const canvas = draft.locator('canvas').first();
      return Math.abs((await canvas.boundingBox())!.width - (await draft.boundingBox())!.width);
    }).toBeLessThan(2);
    const ratio = await divider.getAttribute('aria-valuenow');
    await page.getByRole('button', { name: '2D', exact: true }).click();
    await page.getByRole('button', { name: 'Both', exact: true }).click();
    await expect(divider).toHaveAttribute('aria-valuenow', ratio!);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
    await expect(divider).toHaveAttribute('aria-valuenow', ratio!);
    await divider.dblclick();
    await expect(divider).toHaveAttribute('aria-valuenow', '50');
  });

  test('keyboard adjusts panes within bounds and leaves pattern geometry intact', async ({ page }) => {
    await openSplit(page);
    const divider = page.getByRole('separator', { name: 'Resize 2D and 3D views' });
    const points = await page.evaluate(() => window.seamer!.getPattern!().points);
    await divider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '55');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '75');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowLeft');
    await expect(divider).toHaveAttribute('aria-valuenow', '25');
    await page.keyboard.press('Enter');
    await expect(divider).toHaveAttribute('aria-valuenow', '50');
    expect(await page.evaluate(() => window.seamer!.getPattern!().points)).toEqual(points);
  });
});

test.describe('adjustable touch portrait workspace', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.setTimeout(180_000);

  test('vertical touch drag resizes stacked views and keyboard follows the orientation', async ({ page, context }) => {
    await openSplit(page);
    const divider = page.getByRole('separator', { name: 'Resize 2D and 3D views' });
    await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
    const draft = page.locator('#studio-draft-view');
    const before = (await draft.boundingBox())!.height;
    const bounds = (await divider.boundingBox())!;
    const x = Math.round(bounds.x + bounds.width / 2);
    const y = Math.round(bounds.y + bounds.height / 2);
    const session = await context.newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 55 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await session.detach(); }
    await expect.poll(async () => (await draft.boundingBox())!.height).toBeGreaterThan(before + 30);
    await divider.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await expect(divider).toHaveAttribute('aria-valuenow', '55');
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
  });
});
