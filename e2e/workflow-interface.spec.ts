import { expect, test, type Page } from '@playwright/test';
test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);
async function open(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('seamer.welcomeSeen', '1'); localStorage.setItem('seamer.autosaveSeconds', '600'); });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
  await page.getByTestId('task-draft').click();
}
test('task workflows expose production, appearance and cutting with accessible keyboard panels', async ({ page }) => {
  await open(page);
  const tabs = page.getByRole('tablist', { name: 'Studio panels', exact: true });
  await expect(tabs.getByRole('tab', { name: 'Layers', exact: true })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Layers', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Collection', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Artwork', exact: true })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: 'Artwork', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'studio-sidebar-tab-artwork');
  await page.getByTestId('task-production').click();
  await expect(page.getByTestId('specs-workspace')).toBeVisible();
  await page.getByTestId('task-appearance').click();
  await expect(tabs.getByRole('tab', { name: 'Fabric', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('pattern-scene-3d')).toBeVisible();
  await expect(page.getByTestId('simulation-stage')).toBeVisible();
  await page.getByTestId('task-cutting').click();
  await expect(page.getByRole('dialog')).toContainText('Cutting');
});
test('seam ease and assembly edits persist and support document undo', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: 'Seams', exact: true }).click();
  const seam = await page.evaluate(() => window.seamer!.getPattern().seams[0]);
  await page.getByTestId(`seam-select-${seam.id}`).click();
  const diagnostic = page.getByTestId(`seam-diagnostic-${seam.id}`);
  await expect(diagnostic).toContainText('Ease');
  const ease = page.getByLabel('Expected ease (mm)', { exact: true });
  await ease.fill('12.5'); await ease.press('Enter');
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().seams.find(seam => seam.id === id)?.expectedEaseMm, seam.id)).toBe(12.5);
  await page.evaluate(() => window.seamer!.undo());
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().seams.find(seam => seam.id === id)?.expectedEaseMm, seam.id)).toBe(seam.expectedEaseMm);
  const assembly = page.getByRole('region', { name: 'Assembly order', exact: true });
  await assembly.getByRole('button', { name: 'One seam per step', exact: true }).click();
  const before = await page.evaluate(() => window.seamer!.getPattern().assembly!.steps.map(step => step.seamIds));
  expect(before.length).toBeGreaterThan(1);
  await page.waitForTimeout(850);
  await assembly.getByRole('button', { name: 'Move assembly step 2 up', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().assembly!.steps[0].seamIds)).toEqual(before[1]);
  await page.evaluate(() => window.seamer!.undo());
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().assembly!.steps.map(step => step.seamIds))).toEqual(before);
});

test('linked mirror authoring follows canonical axis edits and can be detached', async ({ page }) => {
  await open(page);
  const fixture = await page.evaluate(() => {
    const api = window.seamer!;
    const created = api.execute('path.createLine', { from: { x: 0, y: -100 }, to: { x: 0, y: 1000 }, name: 'QA mirror axis' });
    if (!created.ok || !created.changed) throw new Error('Could not create mirror axis');
    const pattern = api.getPattern(), source = pattern.pieces.find(piece => !piece.mirrorX && !piece.mirrorY)!;
    const axis = pattern.paths.find(path => path.name === 'QA mirror axis')!;
    return { sourceId: source.id, sourceName: source.name, axisId: axis.id, axisPoints: axis.pathPoints.map(point => point.id) };
  });
  await page.getByTestId('object-browser-toggle').click();
  const browser = page.getByTestId('object-browser');
  await browser.getByPlaceholder('Search objects by name').fill(fixture.sourceName);
  await browser.getByTestId('object-browser-piece').filter({ hasText: fixture.sourceName }).first().click();
  await page.getByTestId('object-browser-toggle').click();
  await page.getByTestId('contextual-selection').getByRole('button', { name: 'Properties', exact: true }).click();
  await page.getByRole('button', { name: /Orientation & linked mirrors/ }).click();
  await page.getByRole('combobox', { name: 'Linked mirror axis', exact: true }).selectOption(fixture.axisId);
  await page.getByRole('button', { name: 'Create linked mirror', exact: true }).click();
  const mirror = await page.evaluate(id => window.seamer!.getPattern().pieces.find(piece => piece.linkedMirror?.sourcePieceId === id)!, fixture.sourceId);
  expect(mirror.linkedMirror).toMatchObject({ ownerPieceId: mirror.id, sourcePieceId: fixture.sourceId, axisPathId: fixture.axisId });
  expect(Object.keys(mirror.linkedMirror!.edgeMap ?? {})).not.toHaveLength(0);
  expect(Object.keys(mirror.linkedMirror!.pointMap ?? {})).not.toHaveLength(0);
  const expected = await page.evaluate(({ axisPoints, mirrorId }) => {
    const api = window.seamer!;
    for (const id of axisPoints) {
      const point = api.getPattern().points.find(point => point.id === id)!;
      const result = api.execute('point.move', { pointId: id, x: 10, y: point.y });
      if (!result.ok) throw new Error(result.error);
    }
    const pattern = api.getPattern(), mirror = pattern.pieces.find(piece => piece.id === mirrorId)!;
    const target = pattern.points.find(point => point.id === mirror.mainPaths[0].from)!;
    if (target.constraint?.type !== 'mirror') throw new Error('Expected persistent mirror constraint');
    const sourcePointId = target.constraint.source;
    return { targetX: target.x, expectedX: 20 - pattern.points.find(point => point.id === sourcePointId)!.x };
  }, { axisPoints: fixture.axisPoints, mirrorId: mirror.id });
  expect(expected.targetX).toBeCloseTo(expected.expectedX, 5);
  await page.getByTestId('object-browser-toggle').click();
  await browser.getByPlaceholder('Search objects by name').fill(mirror.name);
  await browser.getByTestId('object-browser-piece').filter({ hasText: mirror.name }).first().click();
  await page.getByTestId('object-browser-toggle').click();
  await page.getByRole('button', { name: 'Detach linked mirror', exact: true }).click();
  await expect.poll(() => page.evaluate(id => window.seamer!.getPattern().pieces.find(piece => piece.id === id)?.linkedMirror, mirror.id)).toBeUndefined();
});
