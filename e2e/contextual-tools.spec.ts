import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);

async function openStudio(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '600');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '2D', exact: true }).click();
}

async function selectFirstPiece(page: Page) {
  await page.getByTestId('object-browser-toggle').click();
  const browser = page.getByTestId('object-browser');
  await browser.getByPlaceholder('Search objects by name').fill('');
  await browser.getByTestId('object-browser-piece').first().click();
  await page.getByTestId('object-browser-toggle').click();
}

async function selectNamedObject(page: Page, name: string) {
  await page.getByTestId('object-browser-toggle').click();
  const browser = page.getByTestId('object-browser');
  await browser.getByPlaceholder('Search objects by name').fill(name);
  await browser.getByText(name, { exact: true }).click();
  await page.getByTestId('object-browser-toggle').click();
}

test('piece actions share canonical selection and undo; toolbar arrow keys move focus only', async ({ page }) => {
  await openStudio(page);
  await selectFirstPiece(page);
  const bar = page.getByTestId('contextual-selection');
  const actions = bar.getByRole('toolbar', { name: 'Selection actions', exact: true });
  await expect(bar.getByRole('status')).toHaveText('1 piece selected');
  const before = await page.evaluate(() => {
    const selection = window.seamer!.getSelection();
    const pattern = window.seamer!.getPattern();
    const piece = pattern.pieces.find(item => selection.pieceIds.includes(item.id))!;
    return { id: piece.id, position: piece.position, mirrorX: piece.mirrorX, count: pattern.pieces.length };
  });
  const properties = actions.getByRole('button', { name: 'Properties', exact: true });
  await properties.focus();
  await page.keyboard.press('ArrowRight');
  await expect(actions.getByRole('button', { name: 'Duplicate', exact: true })).toBeFocused();
  expect(await page.evaluate(id => window.seamer!.getPattern().pieces.find(piece => piece.id === id)!.position, before.id)).toEqual(before.position);
  await actions.getByRole('button', { name: 'Mirror selection left and right', exact: true }).click();
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().pieces.find(piece => piece.id === id)!.mirrorX, before.id)).toBe(!before.mirrorX);
  await page.evaluate(() => window.seamer!.undo());
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().pieces.find(piece => piece.id === id)!.mirrorX, before.id)).toBe(before.mirrorX);
  await actions.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().pieces.length)).toBe(before.count + 1);
  await page.evaluate(() => window.seamer!.undo());
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().pieces.length)).toBe(before.count);
});

test('seam panel selection drives contextual reverse/delete and preserves undo semantics', async ({ page }) => {
  await openStudio(page);
  const first = await page.evaluate(() => window.seamer!.getPattern().seams[0]);
  await page.locator('#studio-left-panel').getByRole('tab', { name: 'Seams', exact: true }).click();
  await page.getByTestId(`seam-select-${first.id}`).click();
  const bar = page.getByTestId('contextual-selection');
  await expect(bar.getByRole('status')).toHaveText('1 seam selected');
  expect(await page.evaluate(() => window.seamer!.getSelection().seamIds)).toEqual([first.id]);
  const count = await page.evaluate(() => window.seamer!.getPattern().seams.length);
  await bar.getByRole('button', { name: 'Reverse seam target direction', exact: true }).click();
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().seams.find(seam => seam.id === id)!.toPaths.map(ref => ref.reversed), first.id))
    .toEqual(first.toPaths.map(ref => !ref.reversed));
  await page.evaluate(() => window.seamer!.undo());
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().seams.find(seam => seam.id === id)!.toPaths, first.id)).toEqual(first.toPaths);
  await bar.getByRole('button', { name: 'Delete selected seam', exact: true }).click();
  await expect(bar).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().seams.length)).toBe(count - 1);
  expect(await page.evaluate(() => window.seamer!.getSelection().seamIds)).toEqual([]);
  await page.evaluate(() => window.seamer!.undo());
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().seams.length)).toBe(count);
});

test('point and path actions use command transforms without detaching drafting constraints', async ({ page }) => {
  await openStudio(page);
  const created = await page.evaluate(() => {
    const api = window.seamer!;
    const result = api.execute('path.createLine', {
      from: { x: 800, y: 0 }, to: { x: 850, y: 0 }, name: 'Context QA free path'
    });
    if (!result.ok || !result.changed) throw new Error('Test line creation failed');
    const path = api.getPattern().paths.find(path => path.name === 'Context QA free path')!;
    const pointId = path.pathPoints[0].id;
    api.execute('element.rename', { id: pointId, name: 'Context QA free point' });
    const constrained = api.getPattern().points.find(point => point.constraint);
    if (!constrained) throw new Error('Default drafting fixture must contain a constrained point');
    api.execute('element.rename', { id: constrained.id, name: 'Context QA constrained point' });
    return { pointId, pathId: path.id };
  });
  await selectNamedObject(page, 'Context QA free point');
  const bar = page.getByTestId('contextual-selection');
  await expect(bar.getByRole('status')).toHaveText('1 point selected');
  await bar.getByRole('button', { name: 'Move selection right 1 mm', exact: true }).click();
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().points.find(point => point.id === id)!.x, created.pointId)).toBe(801);
  await page.evaluate(() => window.seamer!.undo());
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().points.find(point => point.id === id)!.x, created.pointId)).toBe(800);
  await selectNamedObject(page, 'Context QA free path');
  await expect(bar.getByRole('status')).toHaveText('1 path selected');
  await bar.getByRole('button', { name: 'Rotate selection left 15 degrees', exact: true }).click();
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().points.find(point => point.id === id)!.y, created.pointId)).not.toBe(0);
  await page.evaluate(() => window.seamer!.undo());
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().points.find(point => point.id === id)!.y, created.pointId)).toBe(0);
  await selectNamedObject(page, 'Context QA constrained point');
  await expect(bar.getByRole('status')).toHaveText('1 point selected');
  await expect(bar.getByRole('button', { name: 'Move selection right 1 mm', exact: true })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Mirror selection left and right', exact: true })).toHaveCount(0);
});

test('mixed selection never exposes a mutation and compact screens keep actions reachable', async ({ page }) => {
  await openStudio(page);
  await selectFirstPiece(page);
  await page.getByTestId('contextual-selection').getByRole('button', { name: 'Properties', exact: true }).click();
  const boundary = page.locator('#studio-right-panel').getByRole('button', { name: /Seam boundary/ });
  if (await boundary.getAttribute('aria-expanded') !== 'true') await boundary.click();
  await page.getByTestId('piece-edge-select').first().click();
  const bar = page.getByTestId('contextual-selection');
  await expect(bar.getByRole('status')).toHaveText('2 items selected');
  await expect(bar.getByRole('button')).toHaveCount(1);
  await expect(bar.getByRole('button', { name: 'Properties', exact: true })).toBeVisible();
  const mixed = await page.evaluate(() => window.seamer!.getSelection());
  expect(mixed.pieceIds).toHaveLength(1);
  expect(mixed.pathIds).toHaveLength(1);
  await selectFirstPiece(page);
  await expect(bar.getByRole('status')).toHaveText('1 piece selected');
  await page.setViewportSize({ width: 390, height: 390 });
  const last = bar.getByRole('button', { name: 'Delete selected piece', exact: true });
  await last.focus();
  await expect.poll(() => last.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const root = element.closest('[data-testid="contextual-selection"]')!.getBoundingClientRect();
    return bounds.left >= root.left && bounds.right <= root.right + 1 && bounds.bottom <= window.innerHeight && bounds.height >= 44;
  })).toBe(true);
  await page.keyboard.press('Home');
  await expect(bar.getByRole('button', { name: 'Properties', exact: true })).toBeFocused();
});

test('selecting text replaces geometry selection and opens Text properties without geometry actions', async ({ page }) => {
  await openStudio(page);
  const label = 'Context QA text';
  const before = await page.evaluate(value => {
    const api = window.seamer!;
    const result = api.execute('text.create', { value, x: 800, y: 100 });
    if (!result.ok || !result.changed) throw new Error('Test text creation failed');
    return {
      textId: api.getPattern().texts.find(text => text.value === value)!.id,
      pieces: api.getPattern().pieces,
      points: api.getPattern().points
    };
  }, label);
  await selectFirstPiece(page);
  const bar = page.getByTestId('contextual-selection');
  await expect(bar.getByRole('status')).toHaveText('1 piece selected');
  await selectNamedObject(page, label);
  const textSelection = await page.evaluate(() => window.seamer!.getSelection());
  expect(textSelection.textIds).toEqual([before.textId]);
  expect(textSelection.pieceIds).toEqual([]);
  expect(textSelection.pointIds).toEqual([]);
  expect(textSelection.pathIds).toEqual([]);
  expect(textSelection.seamIds).toEqual([]);
  await expect(bar.getByRole('button')).toHaveCount(1);
  await bar.getByRole('button', { name: 'Properties', exact: true }).click();
  const properties = page.locator('#studio-right-panel');
  await expect(properties.getByRole('button', { name: /Text \(/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(properties.getByPlaceholder('Text…').last()).toHaveValue(label);

  const textInput = properties.getByPlaceholder('Text…').last();
  await textInput.fill(`${label} edited`);
  await textInput.press('Tab');
  await expect(textInput).toHaveValue(`${label} edited`);
  expect(await page.evaluate(() => window.seamer!.getPattern().pieces)).toEqual(before.pieces);
  expect(await page.evaluate(() => window.seamer!.getPattern().points)).toEqual(before.points);
  await page.evaluate(() => window.seamer!.undo());
  await expect(textInput).toHaveValue(label);

  await properties.getByRole('button', { name: 'Delete text', exact: true }).last().click();
  await expect(bar).not.toBeVisible();
  expect(await page.evaluate(() => window.seamer!.getSelection().textIds)).toEqual([]);
  expect(await page.evaluate(() => window.seamer!.getPattern().pieces)).toEqual(before.pieces);
  expect(await page.evaluate(() => window.seamer!.getPattern().points)).toEqual(before.points);
  await page.evaluate(() => window.seamer!.undo());
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().texts.some(text => text.id === id), before.textId)).toBe(true);
  await selectNamedObject(page, label);

  await selectFirstPiece(page);
  await expect(bar.getByRole('status')).toHaveText('1 piece selected');
  expect(await page.evaluate(() => window.seamer!.getSelection().textIds)).toEqual([]);
  await expect(bar.getByRole('button', { name: 'Mirror selection left and right', exact: true })).toBeVisible();

  await selectNamedObject(page, label);
  await page.getByTestId('object-browser-toggle').click();
  const browser = page.getByTestId('object-browser');
  const row = browser.locator('[role="button"][title="Select"]').filter({ hasText: label });
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await row.getByTitle('Delete', { exact: true }).click();
  await expect(bar).not.toBeVisible();
  expect(await page.evaluate(() => window.seamer!.getSelection().textIds)).toEqual([]);
  const after = await page.evaluate(() => ({ pieces: window.seamer!.getPattern().pieces, points: window.seamer!.getPattern().points }));
  expect(after.pieces).toEqual(before.pieces);
  expect(after.points).toEqual(before.points);
  await page.getByTestId('object-browser-toggle').click();
});
