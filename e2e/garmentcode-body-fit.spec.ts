import { expect, test, type Locator } from '@playwright/test';
import { acceptVerifiedSourceImport, captureSourceImportDocument } from './verified-source-import';
import { readFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';

test.use({ serviceWorkers: 'block' });

test('generated source body calibrates the real avatar and survives save/reload', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '600');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toBeVisible();
  await page.getByTestId('templates-menu-trigger').click();
  await page.getByTestId('template-garmentcode').click();
  const dialog = page.getByRole('dialog', { name: 'GarmentCode garment', exact: true });
  await dialog.getByRole('combobox').selectOption('hoodie');
  await dialog.getByLabel('Height', { exact: true }).fill('176');
  await dialog.getByLabel('Bust / chest', { exact: true }).fill('101');
  await dialog.getByLabel('Waist', { exact: true }).fill('88');
  await dialog.getByRole('button', { name: 'Generate garment', exact: true }).click();
  await expect(dialog).not.toBeVisible({ timeout: 65_000 });
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).click();
  const scene = page.getByTestId('pattern-scene-3d');
  const sourceBody = () => page.evaluate(() => window.seamer!.getPattern().body);
  const height = () => page.evaluate(() => {
    const state = (window as unknown as { __seamerWebgpuDrape: { getState: () => { avatarBounds: { min: number[]; max: number[] } | null } } }).__seamerWebgpuDrape.getState();
    return state.avatarBounds ? { height: state.avatarBounds.max[1] - state.avatarBounds.min[1], ground: state.avatarBounds.min[1] } : null;
  });
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await expect.poll(sourceBody).toMatchObject({ unitType: 'metric', fields: { height: 176, chestGirth: 101, waistGirth: 88 }, garmentCodeBody: { measurementsCm: { height: 176 } } });
  await expect.poll(async () => {
    const bounds = await height();
    return !!bounds && Math.abs(bounds.height - 1.76) < 0.005 && Math.abs(bounds.ground) < 0.001;
  }).toBe(true);
  await expect(scene.getByRole('group', { name: 'Body poses', exact: true }).getByRole('button', { name: 'A', exact: true })).toHaveClass(/btn-active/);
  const metadata = (await sourceBody()).garmentCodeBody;
  await page.getByRole('button', { name: /^Save(d)?$/, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(scene).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  expect((await sourceBody()).garmentCodeBody).toEqual(metadata);
  await expect.poll(async () => Math.abs((await height())!.height - 1.76)).toBeLessThan(0.005);

  // Editing measurements invalidates source calibration; it must not force the old height back.
  await page.evaluate(() => {
    const pattern = JSON.parse(JSON.stringify(window.seamer!.getPattern()));
    pattern.body.fields.height = 155;
    window.seamer!.execute('studio.replaceWithHistory', { pattern });
  });
  await expect.poll(async () => Math.abs((await height())!.height - 1.76)).toBeGreaterThan(0.03);
  expect((await sourceBody()).fields.height).toBe(155);
  expect(errors).toEqual([]);
});

test('raw generated JSON preserves resolved source measurements without a UI generation request', async ({ page, request }) => {
  test.setTimeout(120_000);
  const response = await request.post('/api/garmentcode', { data: { preset: 'pants', body: { height: 183, waist: 92 }, design: {} } });
  expect(response.status(), await response.text()).toBe(200);
  const specification = await response.text();
  await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toBeVisible();
  const documentBefore = await captureSourceImportDocument(page);
  const pending = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await pending).setFiles({ name: 'source-body-pants.json', mimeType: 'application/json', buffer: Buffer.from(specification) });
  await acceptVerifiedSourceImport(page, documentBefore, false);
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('source-body-pants');
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready');
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().body)).toMatchObject({ unitType: 'metric', fields: { height: 183, waistGirth: 92 }, garmentCodeBody: { measurementsCm: { height: 183, waist: 92 } } });
  await expect.poll(() => page.evaluate(() => {
    const state = (window as unknown as { __seamerWebgpuDrape: { getState: () => { avatarBounds: { min: number[]; max: number[] } } } }).__seamerWebgpuDrape.getState();
    return state.avatarBounds.max[1] - state.avatarBounds.min[1];
  })).toBeCloseTo(1.83, 2);
});

test('older source-body drapes reassemble and partial source exports retain geometry without certifying assembly', async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);
  const response = await request.post('/api/garmentcode', { data: { preset: 'hoodie', body: { height: 176 }, design: {} } });
  expect(response.status(), await response.text()).toBe(200);
  await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toBeVisible();
  const documentBefore = await captureSourceImportDocument(page);
  const chooseRaw = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooseRaw).setFiles({ name: 'arm-checkpoint.json', mimeType: 'application/json', buffer: Buffer.from(await response.text()) });
  await acceptVerifiedSourceImport(page, documentBefore, false);
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('arm-checkpoint');
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).click();
  const scene = page.getByTestId('pattern-scene-3d');
  await expect(scene).toHaveAttribute('data-status', 'ready');
  const revisions = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/scene/sourceBodyCheckpoint.ts';
    const { SOURCE_BODY_FIT_REVISION, GARMENT_CODE_ASSEMBLY_REVISION, GARMENT_CODE_SOURCE_STRETCH_POLICY } = await import(moduleUrl);
    return { body: SOURCE_BODY_FIT_REVISION as number, assembly: GARMENT_CODE_ASSEMBLY_REVISION as number,
      rest: GARMENT_CODE_SOURCE_STRETCH_POLICY as string };
  });
  await page.evaluate((revisions) => {
    const pattern = JSON.parse(JSON.stringify(window.seamer!.getPattern()));
    pattern.pieces[0].settings3d.savedPositions = [0, 0, .5, 1, .2, 10, 0, .51, 1, .2, 0, 10, .5, 1.01, .2];
    pattern.pieces[0].settings3d.savedDrapeState = 'held';
    pattern.pieces[0].settings3d.savedBodyFitRevision = revisions.body - 1;
    pattern.pieces[0].settings3d.savedAssemblyRevision = revisions.assembly;
    window.seamer!.execute('studio.replaceWithHistory', { pattern });
  }, revisions);
  const reassembly = scene.getByText('Garment fit updated. Start simulation to reassemble the garment.', { exact: true });
  await expect(reassembly).toBeVisible();
  await expect(scene).toHaveAttribute('data-status', 'ready');
  expect(await page.evaluate(() => window.seamer!.getPattern().pieces[0].settings3d.savedPositions.length)).toBe(15);
  await scene.getByRole('button', { name: 'Simulation controls', exact: true }).click();
  await expect(scene.getByLabel('Hold saved checkpoint', { exact: true })).toBeDisabled();
  await scene.getByRole('button', { name: 'Close', exact: true }).click();

  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Seamer Project — 2D + 3D (.ssp)', exact: true }).click();
  const archive = testInfo.outputPath('current-arm-fit.ssp');
  await (await exported).saveAs(archive);
  const envelope = JSON.parse(gunzipSync(await readFile(archive)).toString('utf8'));
  expect(envelope.pattern.pieces.every((piece: { settings3d: { savedBodyFitRevision?: number; savedAssemblyRevision?: number; savedSourceStretchPolicy?: string; savedSourceAssemblyComplete?: boolean; savedPositions: number[]; savedDrapeState?: string } }) =>
    piece.settings3d.savedBodyFitRevision === revisions.body && piece.settings3d.savedAssemblyRevision === revisions.assembly
    && piece.settings3d.savedSourceStretchPolicy === revisions.rest && piece.settings3d.savedSourceAssemblyComplete === false && piece.settings3d.savedPositions.length > 0 && piece.settings3d.savedDrapeState === 'checkpoint')).toBe(true);
  const chooseArchive = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooseArchive).setFiles(archive);
  await expect.poll(() => page.evaluate((revisions) => window.seamer!.getPattern().pieces.every(piece => piece.settings3d.savedBodyFitRevision === revisions.body
    && piece.settings3d.savedAssemblyRevision === revisions.assembly && piece.settings3d.savedSourceStretchPolicy === revisions.rest), revisions)).toBe(true);
  await expect(scene).toHaveAttribute('data-status', 'ready');
  // Exporting before Start has no live accepted all-active stage, even with current revisions.
  // The archive preserves these actual positions, while the renderer safely reassembles them.
  await expect(reassembly).toBeVisible();
  expect(await page.evaluate(() => window.seamer!.getPattern().pieces.every(piece => piece.settings3d.savedSourceAssemblyComplete === false))).toBe(true);
  const savedCheckpoint = await page.evaluate(() => window.seamer!.getPattern().pieces.map(piece => piece.settings3d.savedPositions));
  expect(savedCheckpoint.every(positions => positions.length > 0)).toBe(true);
  await scene.getByRole('button', { name: 'Reset simulation', exact: true }).click();
  const resetDialog = page.getByRole('dialog', { name: 'Reset all simulations?', exact: true });
  await expect(resetDialog).toBeVisible();
  await expect(resetDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(resetDialog).not.toBeVisible();
  expect(await page.evaluate(() => window.seamer!.getPattern().pieces.map(piece => piece.settings3d.savedPositions))).toEqual(savedCheckpoint);
  await expect(scene.getByRole('button', { name: 'Reset simulation', exact: true })).toBeFocused();
  await expect(scene).toHaveAttribute('data-status', 'ready');

  // These are complete arrays from the actual pre-Start renderer export, not an assembled
  // stage certificate. Original arrays and hold intent remain intact on every stale import.
  for (const oldPolicy of [undefined, 'legacy-softened-seam-stretch']) {
    const staleArchive = structuredClone(envelope);
    for (const piece of staleArchive.pattern.pieces) {
      piece.settings3d.savedSourceStretchPolicy = oldPolicy;
      piece.settings3d.savedDrapeState = 'held';
    }
    const chooseStale = page.waitForEvent('filechooser');
    await page.getByTestId('import-menu-trigger').click();
    await page.getByRole('button', { name: /From file/ }).click();
    await (await chooseStale).setFiles({ name: 'old-rest-checkpoint.ssp', mimeType: 'application/octet-stream',
      buffer: gzipSync(Buffer.from(JSON.stringify(staleArchive))) });
    await expect(scene).toHaveAttribute('data-status', 'ready');
    await expect(reassembly).toBeVisible();
    const retained = await page.evaluate(() => window.seamer!.getPattern().pieces.map(piece => ({
      saved: piece.settings3d.savedPositions, policy: piece.settings3d.savedSourceStretchPolicy, state: piece.settings3d.savedDrapeState
    })));
    expect(retained.map(piece => piece.saved)).toEqual(savedCheckpoint);
    expect(retained.every(piece => piece.policy === oldPolicy && piece.state === 'held')).toBe(true);
    await scene.getByRole('button', { name: 'Simulation controls', exact: true }).click();
    const hold = scene.getByLabel('Hold saved checkpoint', { exact: true });
    await expect(hold).toBeDisabled(); await expect(hold).not.toBeChecked();
    await scene.getByRole('button', { name: 'Close', exact: true }).click();
    // Current revision metadata still preserves the partial archive's geometry without
    // certifying a live all-active stage or enabling held stale targets.
    const chooseCurrent = page.waitForEvent('filechooser');
    await page.getByTestId('import-menu-trigger').click();
    await page.getByRole('button', { name: /From file/ }).click();
    await (await chooseCurrent).setFiles(archive);
    await expect(scene).toHaveAttribute('data-status', 'ready');
    await expect(reassembly).toBeVisible();
    expect(await page.evaluate(() => window.seamer!.getPattern().pieces.map(piece => piece.settings3d.savedPositions))).toEqual(savedCheckpoint);
  }
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`source material contact controls ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width < 480, isMobile: viewport.width < 480 });
    test('show effective material padding and preserve a deliberate override after fabric changes', async ({ page, request }) => {
      test.setTimeout(150_000);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const response = await request.post('/api/garmentcode', { data: { preset: 'skirt', body: { height: 176, waist: 88 }, design: {} } });
      expect(response.status(), await response.text()).toBe(200);
      await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
      await page.goto('/studio', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('pattern-name-input')).toBeVisible();
      const documentBefore = await captureSourceImportDocument(page);
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('import-menu-trigger').click();
      await page.getByRole('button', { name: /From file/ }).click();
      await (await chooser).setFiles({ name: 'material-padding.json', mimeType: 'application/json', buffer: Buffer.from(await response.text()) });
      await acceptVerifiedSourceImport(page, documentBefore, viewport.width < 480);
      await expect(page.getByTestId('pattern-name-input')).toHaveValue('material-padding');
      await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).click();
      const scene = page.getByTestId('pattern-scene-3d');
      await expect(scene).toHaveAttribute('data-status', 'ready');
      const activate = (control: Locator) => viewport.width < 480 ? control.tap() : control.click();
      const panels = page.getByRole('button', { name: 'Layers and body panel', exact: true });
      if (await panels.getAttribute('aria-expanded') === 'true') await panels.click();
      const openControls = async () => {
        const expand = scene.getByRole('button', { name: 'Expand 3D controls', exact: true });
        if (await expand.isVisible()) await activate(expand);
        await activate(scene.getByRole('button', { name: 'Simulation controls', exact: true }));
      };
      const thickness = scene.getByRole('slider', { name: /^Simulation thickness/ });
      const edgeThickness = scene.getByRole('slider', { name: /^Simulation edge thickness/ });
      const substepContacts = scene.getByRole('slider', { name: /^Contact passes per substep/ });
      const finalContacts = scene.getByRole('slider', { name: /^Final contact passes/ });
      await openControls();
      await expect(thickness).toHaveValue('1');
      await expect(edgeThickness).toHaveValue('1');
      await expect(substepContacts).toHaveValue('4');
      await expect(finalContacts).toHaveValue('4');
      // Home is a real native range input event. Choosing the native default deliberately
      // must override the source policy, including after a later material/topology rebuild.
      for (const slider of [substepContacts, finalContacts]) {
        await slider.scrollIntoViewIfNeeded();
        if (viewport.width < 480) {
          const bounds = await slider.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.height).toBeGreaterThanOrEqual(44);
          await slider.tap({ position: { x: bounds!.width / 2, y: bounds!.height / 2 } });
          await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThanOrEqual(7);
          expect(Number(await slider.inputValue())).toBeLessThanOrEqual(10);
        }
        await slider.focus();
        await slider.press('Home');
        await expect(slider).toHaveValue('1');
        expect(await slider.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight;
        })).toBe(true);
      }
      await expect(scene.getByLabel('Hold saved checkpoint', { exact: true })).toBeDisabled();
      await activate(scene.getByRole('button', { name: 'Close', exact: true }));
      const closeControls = scene.getByRole('button', { name: 'Close 3D controls', exact: true });
      if (await closeControls.isVisible()) await activate(closeControls);

      const editThickness = async (value: string) => {
        const headerFabric = page.locator('.studio-topbar').getByRole('button', { name: 'Fabric', exact: true });
        if (await headerFabric.isVisible()) await headerFabric.click();
        else {
          if (await panels.getAttribute('aria-expanded') !== 'true') await panels.click();
          await page.locator('#studio-left-panel').getByRole('tab', { name: 'Fabric', exact: true }).click();
        }
        const fabric = page.locator('#studio-left-panel .material-panel');
        const edit = fabric.getByRole('button', { name: /^Edit fabric / }).first();
        if (await edit.isVisible()) await edit.click();
        const input = fabric.getByRole('spinbutton', { name: 'Thickness (mm)', exact: true });
        await input.fill(value);
        await input.press('Tab');
        await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials[0].thickness)).toBe(Number(value));
        await expect(scene).toHaveAttribute('data-status', 'ready');
        await panels.click();
      };
      await editThickness('2');
      await openControls();
      await expect(thickness).toHaveValue('2.5');
      await expect(edgeThickness).toHaveValue('2.5');
      await expect(substepContacts).toHaveValue('1');
      await expect(finalContacts).toHaveValue('1');

      // Native range keyboard input exercises the same explicit-intent setter as touch input.
      await thickness.focus();
      await thickness.press('Home');
      for (let step = 0; step < 10; step++) await thickness.press('ArrowRight');
      await expect(thickness).toHaveValue('5');
      await activate(scene.getByRole('button', { name: 'Close', exact: true }));
      if (await closeControls.isVisible()) await activate(closeControls);
      await editThickness('3');
      await openControls();
      await expect(thickness).toHaveValue('5');
      await expect(edgeThickness).toHaveValue('3.5');
      await expect(substepContacts).toHaveValue('1');
      await expect(finalContacts).toHaveValue('1');
      await expect(scene.getByText('Changes update simulation. Unfinished garments may reassemble.', { exact: true })).toBeVisible();
      await activate(scene.getByRole('button', { name: 'Close', exact: true }));
      if (await closeControls.isVisible()) await activate(closeControls);
      const canvas = scene.locator('canvas').first();
      await expect(canvas).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // GPU assembly/rebuild state continuity is separately verified by renderer orchestration tests.
      expect(errors).toEqual([]);
    });
  });
}
