import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Pattern } from '@seamer/pattern-model';

const example = JSON.parse(readFileSync(new URL('../static/templates/pencil-skirt.json', import.meta.url), 'utf8')) as Pattern;
const saved = { id: 'library-collection-qa', name: 'QA collection fabric', version: 2, updatedAt: '2026-10-11T00:00:00Z', writeProtected: false, ownerUserId: null, material: example.materials[0], collection: 'Autumn', tags: ['woven', 'sample'] };
test.use({ viewport: { width: 1440, height: 1000 } });
async function open(page: Page, libraryFabric = saved) {
  await page.addInitScript(item => { localStorage.setItem('seamer.welcomeSeen', '1'); localStorage.setItem('seamer.autosaveSeconds', '2'); localStorage.setItem('seamer.materialLibrary.v1', JSON.stringify([item])); }, libraryFabric);
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '2D', exact: true }).click();
}

test('collection range planning persists real style references, totals and independent document undo', async ({ page }, testInfo) => {
  await open(page);
  const activePatternId = await page.evaluate(() => window.seamer!.getPattern().id);
  await page.locator('#studio-left-panel').getByRole('tab', { name: 'Collection', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Collection range plan', exact: true });
  await panel.getByRole('button', { name: 'Create collection', exact: true }).click();
  await panel.getByLabel('Collection name', { exact: true }).fill('Autumn capsule');
  await panel.getByLabel('Collection name', { exact: true }).press('Tab');
  await panel.getByRole('button', { name: 'Add current pattern to collection', exact: true }).click();
  await panel.getByLabel('Planned units', { exact: true }).fill('100'); await panel.getByLabel('Planned units', { exact: true }).press('Tab');
  await panel.getByLabel('Target unit cost (USD)', { exact: true }).fill('12.5'); await panel.getByLabel('Target unit cost (USD)', { exact: true }).press('Tab');
  await expect(panel.getByText('100 known units · 1250.00 USD known planned budget · 0 styles without complete costing', { exact: true })).toBeVisible();
  await page.waitForTimeout(850);
  await panel.getByLabel('Style name', { exact: true }).fill('Renamed capsule style'); await panel.getByLabel('Style name', { exact: true }).press('Tab');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.getByLabel('Style name', { exact: true })).toHaveValue(example.name);
  const downloadPromise = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Export collection JSON', exact: true }).click();
  const download = await downloadPromise; const file = testInfo.outputPath('collection.range.json'); await download.saveAs(file);
  const data = JSON.parse(await readFile(file, 'utf8')); expect(data).toMatchObject({ name: 'Autumn capsule', styles: [{ patternId: activePatternId, plannedUnits: 100, targetUnitCost: 12.5 }] });
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await page.locator('#studio-left-panel').getByRole('tab', { name: 'Collection', exact: true }).click();
  await expect(panel.getByLabel('Collection name', { exact: true })).toHaveValue('Autumn capsule');
  await panel.getByLabel('Import collection JSON', { exact: true }).setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"styles":[]}') });
  await expect(panel.getByRole('status')).toHaveText('Invalid range plan.');
  await expect(panel.getByLabel('Collection name', { exact: true })).toHaveValue('Autumn capsule');
});

test('fabric library collections, physics recommendations and real catalog errors remain visible', async ({ page }) => {
  await open(page);
  await page.locator('#studio-left-panel').getByRole('tab', { name: 'Fabric', exact: true }).click();
  const panel = page.locator('.material-panel');
  await panel.getByRole('button', { name: 'Saved library', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Collection', exact: true }).selectOption('Autumn');
  await panel.getByRole('combobox', { name: 'Recommend for', exact: true }).selectOption('Woven shirt');
  await expect(panel.getByTestId('library-fabric-card')).toHaveCount(1);
  await expect(panel.getByTestId('library-fabric-card')).toHaveAttribute('draggable', 'true');
  await panel.getByTestId('library-fabric-card').click();
  await panel.getByRole('button', { name: 'Organize & import fabrics', exact: true }).click();
  await panel.getByLabel('Fabric collection', { exact: true }).fill('Winter'); await panel.getByLabel('Fabric collection', { exact: true }).press('Tab');
  await panel.getByRole('combobox', { name: 'Collection', exact: true }).selectOption('Winter');
  await expect(panel.getByTestId('library-fabric-card')).toHaveCount(1);
  await page.route('https://catalog.example/fabrics.json', route => route.fulfill({ status: 503, body: '', headers: { 'access-control-allow-origin': '*' } }));
  await panel.getByLabel('Remote catalog URL', { exact: true }).fill('https://catalog.example/fabrics.json');
  await panel.getByRole('button', { name: 'Import catalog', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Catalog request failed (503).');
  await page.unroute('https://catalog.example/fabrics.json');
  await page.route('https://catalog.example/fabrics.json', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ version: 1, materials: [{ ...saved, id: 'provider-fabric', name: 'Provider fabric' }] }) }));
  await panel.getByRole('button', { name: 'Import catalog', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Imported 1 catalog fabrics into your local library.');
  await expect(panel.getByTestId('library-fabric-card')).toHaveCount(2);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('seamer.materialLibrary.v1')!).map((item: { collection: string }) => item.collection))).toEqual(expect.arrayContaining(['Winter', 'catalog.example']));
});

test('dragging a saved fabric onto actual 2D and 3D surfaces copies and assigns it with document undo', async ({ page }) => {
  const visibleFabric = { ...saved, material: structuredClone(saved.material) };
  for (const slot of [visibleFabric.material.frontTexture, visibleFabric.material.backTexture]) if (slot) { slot.color = '#12d83a'; slot.url = ''; }
  await open(page, visibleFabric);
  await page.getByTestId('import-menu-trigger').click(); await page.getByTestId('import-sample-rect-piece.dxf').click();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('rect-piece');
  const framed = await page.evaluate(() => {
    const document = structuredClone(window.seamer!.getPattern()); document.name = 'Fabric drop panel';
    document.settings3d.cameraPosition = [.075, .11, .7]; document.settings3d.controlsTarget = [.075, .11, .3]; document.settings3d.showAvatar = false;
    return JSON.stringify(document);
  });
  const chooser = page.waitForEvent('filechooser'); await page.getByTestId('import-menu-trigger').click(); await page.getByRole('button', { name: /From file/ }).click();
  await (await chooser).setFiles({ name: 'fabric-panel.seamer.json', mimeType: 'application/json', buffer: Buffer.from(framed) });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Fabric drop panel');
  const view = page.getByRole('group', { name: 'Workspace view', exact: true });
  await view.getByRole('button', { name: '2D', exact: true }).click();
  await page.locator('#studio-left-panel').getByRole('tab', { name: 'Fabric', exact: true }).click();
  const panel = page.locator('.material-panel'); await panel.getByRole('button', { name: 'Saved library', exact: true }).click();
  const before = await page.evaluate(() => { const p = window.seamer!.getPattern(); return { pieces: p.pieces, paths: p.paths, points: p.points, materials: p.materials }; });
  async function drop(surface: ReturnType<Page['locator']>) {
    const bounds = await surface.boundingBox(); expect(bounds).not.toBeNull();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await panel.getByTestId('library-fabric-card').dispatchEvent('dragstart', { dataTransfer });
    const clientX = bounds!.x + bounds!.width / 2, clientY = bounds!.y + bounds!.height / 2;
    await surface.dispatchEvent('dragover', { dataTransfer, clientX, clientY }); await surface.dispatchEvent('drop', { dataTransfer, clientX, clientY });
    await dataTransfer.dispose();
  }
  await drop(page.getByTestId('pattern-canvas-2d'));
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials.length)).toBe(before.materials.length + 1);
  await expect.poll(() => page.evaluate(() => { const p = window.seamer!.getPattern(); return p.materials.find(m => m.id === p.pieces[0].materialId)?.libraryItemId; })).toBe(saved.id);
  expect(await page.evaluate(() => ({ points: window.seamer!.getPattern().points, paths: window.seamer!.getPattern().paths }))).toEqual({ points: before.points, paths: before.paths });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials)).toEqual(before.materials);
  await view.getByRole('button', { name: '3D', exact: true }).click();
  if (!await page.locator('#studio-left-panel').isVisible()) await page.getByRole('button', { name: 'Layers and body panel', exact: true }).click();
  await page.locator('#studio-left-panel').getByRole('tab', { name: 'Fabric', exact: true }).click();
  await panel.getByRole('button', { name: 'Saved library', exact: true }).click();
  const scene = page.getByTestId('pattern-scene-3d'); await expect(scene).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await scene.getByRole('button', { name: 'Front view', exact: true }).click();
  await page.waitForTimeout(850);
  const canvas = scene.locator('canvas').first();
  await canvas.click();
  await expect(scene.getByRole('button', { name: 'Exit move mode', exact: true })).toBeVisible();
  async function greenPixels() {
    const screenshot = await canvas.screenshot();
    return page.evaluate(async source => {
      const image = new Image(); image.src = `data:image/png;base64,${source}`; await image.decode();
      const raster = document.createElement('canvas'); raster.width = image.naturalWidth; raster.height = image.naturalHeight;
      const context = raster.getContext('2d')!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, raster.width, raster.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 1] > 100 && pixels[index + 1] > pixels[index] * 1.5 && pixels[index + 1] > pixels[index + 2] * 1.5) count++;
      return count;
    }, screenshot.toString('base64'));
  }
  const greenBefore = await greenPixels();
  await drop(canvas);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials.length)).toBe(before.materials.length + 1);
  await expect.poll(() => page.evaluate(() => { const p = window.seamer!.getPattern(); return p.materials.find(m => m.id === p.pieces[0].materialId)?.libraryItemId; })).toBe(saved.id);
  await expect.poll(greenPixels).toBeGreaterThan(greenBefore + 200);
  expect(await page.evaluate(() => ({ points: window.seamer!.getPattern().points, paths: window.seamer!.getPattern().paths }))).toEqual({ points: before.points, paths: before.paths });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials)).toEqual(before.materials);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().pieces)).toEqual(before.pieces);
  await expect.poll(greenPixels).toBeLessThanOrEqual(greenBefore + 50);
});
