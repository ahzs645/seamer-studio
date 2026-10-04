import { expect, test } from '@playwright/test';

for (const profile of [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, hasTouch: false },
  { name: 'touch phone', viewport: { width: 390, height: 844 }, hasTouch: true }
]) {
  test.describe(profile.name, () => {
    test.use({ viewport: profile.viewport, hasTouch: profile.hasTouch });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
      await page.goto('/studio', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('pattern-name-input')).toBeVisible();
      await page.getByRole('button', { name: '2D', exact: true }).click();
    });

    test('grouped tools support pointer selection, keyboard navigation and dismissal', async ({ page }) => {
      const arc = page.getByRole('button', { name: 'Arc/circle tools', exact: true });
      const seam = page.getByRole('button', { name: 'Seam tools', exact: true });
      const activate = async (button: typeof arc) => profile.hasTouch ? button.tap() : button.click();
      await activate(arc);
      await expect(arc).toHaveAttribute('aria-expanded', 'true');
      const threePoint = page.getByRole('button', { name: 'New three-point-arc', exact: true });
      await expect(threePoint).toBeVisible();
      await activate(threePoint);
      await expect(arc).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('button', { name: 'New three-point-arc', exact: true, includeHidden: true })).toHaveAttribute('aria-pressed', 'true');

      await activate(seam);
      await activate(page.getByRole('button', { name: 'Create multi seam', exact: true }));
      await expect(page.getByRole('button', { name: 'Create multi seam', exact: true, includeHidden: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(seam).toHaveAttribute('aria-expanded', 'false');

      await arc.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByRole('button', { name: 'New circle/ellipse', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(arc).toBeFocused();
      await expect(arc).toHaveAttribute('aria-expanded', 'false');
      // Dismissing a flyout must not also cancel the active drawing tool.
      await expect(page.getByRole('button', { name: 'Create multi seam', exact: true, includeHidden: true })).toHaveAttribute('aria-pressed', 'true');

      await activate(arc);
      await page.getByTestId('pattern-name-input').click();
      await expect(arc).toHaveAttribute('aria-expanded', 'false');
    });

    test('typing and modal dialogs keep drawing shortcuts from changing tools', async ({ page }) => {
      const pen = page.getByRole('button', { name: 'Pen tool (lines and curves)', exact: true });
      if (profile.hasTouch) await pen.tap();
      else await pen.click();
      await page.getByTestId('pattern-name-input').focus();
      await page.keyboard.press('c');
      await expect(pen).toHaveAttribute('aria-pressed', 'true');

      const settings = page.getByRole('button', { name: 'Settings', exact: true });
      if (!await settings.isVisible()) await page.getByRole('button', { name: 'More', exact: true }).click();
      await settings.click();
      await expect(page.locator('dialog[open]')).toBeVisible();
      await page.keyboard.press('c');
      await expect(pen).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      await expect(pen).toHaveAttribute('aria-pressed', 'true');

      await pen.focus();
      await page.keyboard.press('v');
      await expect(page.getByRole('button', { name: 'Modify & select', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('button', { name: 'Cancel operation (Esc or V)', exact: true })).toHaveCount(0);
    });
  });
}

test('3D hover and keyboard focus own their shortcuts', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toBeVisible();
  const pen = page.getByRole('button', { name: 'Pen tool (lines and curves)', exact: true });
  await pen.click();
  const scene = page.getByTestId('pattern-scene-3d');
  await scene.hover({ position: { x: 15, y: 15 } });
  await page.keyboard.press('a');
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  await scene.focus();
  await page.mouse.move(10, 10);
  await page.keyboard.press('a');
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+S');
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
});

test('hidden dialogs do not block shortcuts and editable controls retain key ownership', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toBeVisible();
  await page.getByRole('button', { name: '2D', exact: true }).click();
  const pen = page.getByRole('button', { name: 'Pen tool (lines and curves)', exact: true });
  await pen.click();
  // Simulate a responsive drawer that remains in the DOM while CSS hides it.
  await page.evaluate(() => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.style.display = 'none';
    document.body.append(dialog);
  });
  await pen.focus();
  await page.keyboard.press('n');
  await expect(page.getByRole('button', { name: 'New point', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(() => {
    const select = document.createElement('select');
    select.id = 'shortcut-select';
    select.innerHTML = '<option>Choose a value</option><option>Point</option>';
    select.style.position = 'fixed';
    select.style.zIndex = '500';
    const editable = document.createElement('div');
    editable.id = 'shortcut-editable';
    editable.contentEditable = 'true';
    editable.style.position = 'fixed';
    editable.style.zIndex = '500';
    editable.innerHTML = '<span>Editable notes</span>';
    document.body.append(select, editable);
  });
  await page.locator('#shortcut-select').focus();
  await page.keyboard.press('p');
  await expect(pen).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#shortcut-editable').focus();
  await page.keyboard.press('p');
  await expect(pen).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#shortcut-editable').evaluate((element) => {
    element.querySelector('span')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
  });
  await expect(pen).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: 'New point', exact: true }).focus();
  await page.evaluate(() => {
    const consume = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', consume, { capture: true, once: true });
  });
  await page.keyboard.press('p');
  await expect(pen).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('p');
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
});
