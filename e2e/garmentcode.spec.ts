import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Request interception must bypass the app's offline worker for cancellation/error cases.
test.use({ serviceWorkers: 'block' });

const examples = [
  { file: 'shirt_mean_specification.json', label: 'GarmentCode Shirt', pieces: 8, seams: 18 },
  { file: 'hoody_mean_specification.json', label: 'GarmentCode Hoodie', pieces: 6, seams: 12 },
  { file: 'dress_pencil_specification.json', label: 'GarmentCode Dress', pieces: 6, seams: 23 },
  { file: 'js_mean_all_specification.json', label: 'GarmentCode Jumpsuit', pieces: 12, seams: 57 }
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1');
    localStorage.setItem('seamer.autosaveSeconds', '120');
  });
});

async function openStudio(page: Page) {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready');
}

async function openGenerator(page: Page) {
  await page.getByTestId('templates-menu-trigger').click();
  await page.getByTestId('template-garmentcode').click();
  const dialog = page.getByRole('dialog', { name: 'GarmentCode garment', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function renderedObj(page: Page) {
  const scene = page.getByTestId('pattern-scene-3d');
  await expect(scene).toHaveAttribute('data-status', 'ready');
  const revealControls = async () => {
    const expand = scene.getByRole('button', { name: 'Expand 3D controls', exact: true });
    if (await expand.isVisible()) await expand.click();
  };
  // Export just the garment to prove real cloth triangles exist independently of the avatar.
  await revealControls();
  await scene.getByRole('button', { name: 'Hide avatar', exact: true }).click();
  await revealControls();
  const pending = page.waitForEvent('download');
  await scene.getByRole('button', { name: 'Download as OBJ', exact: true }).click();
  const download = await pending;
  const path = await download.path();
  expect(path).not.toBeNull();
  const text = await readFile(path!, 'utf8');
  const expectedPieces = await page.evaluate(() => window.seamer!.getPattern().pieces.filter((piece) => !piece.hidden).length);
  expect(text.split('\n').filter((line) => line.startsWith('o '))).toHaveLength(expectedPieces);
  const vertices = text.split('\n').filter((line) => line.startsWith('v ')).map((line) => line.trim().split(/\s+/).slice(1).map(Number));
  const faces = text.split('\n').filter((line) => line.startsWith('f '));
  expect(vertices.length).toBeGreaterThan(100);
  expect(faces.length).toBeGreaterThan(100);
  expect(vertices.every((vertex) => vertex.length === 3 && vertex.every(Number.isFinite))).toBe(true);
  // Project actual exported mesh vertices through the saved camera; the complete garment must fit.
  const camera = await page.evaluate(() => {
    const settings = window.seamer!.getPattern().settings3d;
    const canvas = document.querySelector('[data-testid="pattern-scene-3d"] canvas')!.getBoundingClientRect();
    return { position: settings.cameraPosition, target: settings.controlsTarget, fov: settings.cameraFov, aspect: canvas.width / canvas.height };
  });
  const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const normalized = (a: number[]) => a.map((value) => value / Math.hypot(...a));
  const z = normalized(camera.position.map((value, index) => value - camera.target[index]));
  const x = normalized([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const tangent = Math.tan(camera.fov * Math.PI / 360);
  const projected = vertices.map((vertex) => {
    const offset = vertex.map((value, index) => value - camera.position[index]);
    const depth = -dot(offset, z);
    expect(depth).toBeGreaterThan(0);
    return [dot(offset, x) / (depth * tangent * camera.aspect), dot(offset, y) / (depth * tangent)];
  });
  expect(Math.max(...projected.flat().map(Math.abs))).toBeLessThan(0.98);
  // Show the avatar again for the representative screenshots.
  await revealControls();
  await scene.getByRole('button', { name: 'Hide avatar', exact: true }).click();
  return { vertices: vertices.length, faces: faces.length };
}

for (const example of examples) {
  test(`renders and exports real ${example.label} geometry`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openStudio(page);
    await page.getByTestId('import-menu-trigger').click();
    const menu = page.getByTestId('import-menu-trigger').locator('..').locator('.dropdown-content');
    await expect.poll(async () => {
      const bounds = await menu.boundingBox();
      return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize()!.width;
    }).toBe(true);
    await page.getByTestId(`garmentcode-example-${example.file}`).click();
    await expect(page.getByTestId('pattern-name-input')).toHaveValue(example.label);
    await expect.poll(() => page.evaluate(() => {
      const pattern = window.seamer!.getPattern();
      return { pieces: pattern.pieces.length, seams: pattern.seams.length, source: pattern.garmentCodeSource?.format, placements: pattern.pieces.filter((piece) => piece.settings3d.arrangement.sourcePlacement).length };
    })).toEqual({ pieces: example.pieces, seams: example.seams, source: 'garmentcode-json', placements: example.pieces });
    await renderedObj(page);
    await expect.poll(() => page.locator('.studio-shell').evaluate((element) => element.scrollTop)).toBe(0);
    if (example.label === 'GarmentCode Shirt') await page.screenshot({ path: testInfo.outputPath('garment-render-desktop.png') });
    expect(errors).toEqual([]);
  });
}

test('source placement and seam directions survive save and reload', async ({ page }) => {
  await openStudio(page);
  await page.getByTestId('import-menu-trigger').click();
  await page.getByTestId('garmentcode-example-js_mean_all_specification.json').click();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('GarmentCode Jumpsuit');
  const snapshot = await page.evaluate(() => {
    const pattern = window.seamer!.getPattern();
    return JSON.parse(JSON.stringify({ source: pattern.garmentCodeSource, seams: pattern.seams, placements: pattern.pieces.map((piece) => piece.settings3d.arrangement.sourcePlacement) }));
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  const url = page.url();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('GarmentCode Jumpsuit');
  await expect.poll(() => page.evaluate(() => {
    const pattern = window.seamer!.getPattern();
    return JSON.parse(JSON.stringify({ source: pattern.garmentCodeSource, seams: pattern.seams, placements: pattern.pieces.map((piece) => piece.settings3d.arrangement.sourcePlacement) }));
  })).toEqual(snapshot);
  expect(page.url()).toBe(url);
  await renderedObj(page);
});

test('generates a real measured garment and preserves generation inputs', async ({ page }) => {
  await openStudio(page);
  const dialog = await openGenerator(page);
  expect(await dialog.locator('form').evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(true);
  await dialog.getByRole('combobox').selectOption('skirt');
  await dialog.getByLabel('Height', { exact: true }).fill('175');
  await dialog.getByLabel('Waist', { exact: true }).fill('88');
  await dialog.getByLabel('Skirt length ratio', { exact: true }).fill('0.6');
  const generationResponse = page.waitForResponse((response) => response.url().endsWith('/api/garmentcode') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Generate garment', exact: true }).click();
  const response = await generationResponse;
  test.skip(response.status() === 503 && (await response.json()).error.includes('unavailable on this host'), 'Live generation requires GARMENTCODE_ROOT and its configured Python environment.');
  await expect(dialog).not.toBeVisible({ timeout: 65_000 });
  await expect(page.getByTestId('pattern-scene-3d')).toBeFocused();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('GarmentCode Skirt');
  await expect.poll(() => page.evaluate(() => {
    const pattern = window.seamer!.getPattern();
    return { panels: pattern.pieces.length, stitches: pattern.seams.length, generation: pattern.garmentCodeSource?.generation };
  })).toMatchObject({ panels: 4, stitches: 6, generation: { preset: 'skirt', body: { height: 175, waist: 88 }, design: { skirt: { length: 0.6 } } } });
  await renderedObj(page);
  const reopened = await openGenerator(page);
  await expect(reopened.getByRole('combobox')).toHaveValue('skirt');
  await expect(reopened.getByLabel('Skirt length ratio', { exact: true })).toHaveValue('0.6');
  await expect(reopened.getByLabel('Height', { exact: true })).toHaveValue('175');
});

test('fresh Dress uses waist-length default and sends an explicit cropped length unchanged', async ({ page }) => {
  await openStudio(page);
  const requests: Array<{ preset: string; design: { shirt?: { length?: number } } }> = [];
  await page.route('**/api/garmentcode', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Request inspected; original document retained.' }) });
  });
  const dialog = await openGenerator(page);
  await dialog.getByRole('combobox').selectOption('dress');
  const length = dialog.getByLabel('Top length ratio', { exact: true });
  await expect(length).toHaveValue('1');
  await dialog.getByRole('button', { name: 'Generate garment', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Request inspected');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ preset: 'dress', design: { shirt: { length: 1 } } });

  await length.fill('0.8');
  await dialog.getByRole('button', { name: 'Generate garment', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(dialog.getByRole('button', { name: 'Generate garment', exact: true })).toBeEnabled();
  expect(requests[1]).toMatchObject({ preset: 'dress', design: { shirt: { length: 0.8 } } });
  await expect(length).toHaveValue('0.8');
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('unavailable generation preserves document and offers working examples', async ({ page }) => {
  await openStudio(page);
  await page.route('**/api/garmentcode', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' }));
  const dialog = await openGenerator(page);
  await dialog.getByRole('button', { name: 'Generate garment', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('generation is unavailable');
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
  await dialog.getByRole('button', { name: 'Dress', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('GarmentCode Dress');
});

test('cancelled late generation cannot replace document and Escape restores focus', async ({ page }) => {
  await openStudio(page);
  const specification = await readFile('static/examples/garmentcode/shirt_mean_specification.json', 'utf8');
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const requestStarted = new Promise<void>((resolve) => { requested = resolve; });
  await page.route('**/api/garmentcode', async (route) => {
    requested();
    await deferred;
    await route.fulfill({ status: 200, contentType: 'application/json', body: specification }).catch(() => {});
  });
  const dialog = await openGenerator(page);
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole('button', { name: 'Generate garment', exact: true }).click();
  await requestStarted;
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId('templates-menu-trigger')).toBeFocused();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
});

test('cancelled example response cannot replace the active document', async ({ page }) => {
  await openStudio(page);
  const specification = await readFile('static/examples/garmentcode/shirt_mean_specification.json', 'utf8');
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route('**/examples/garmentcode/shirt_mean_specification.json', async (route) => {
    requested();
    await deferred;
    await route.fulfill({ status: 200, contentType: 'application/json', body: specification }).catch(() => {});
  });
  const dialog = await openGenerator(page);
  await dialog.getByRole('button', { name: 'Shirt', exact: true }).click();
  await started;
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
});

test('manual arrangement overrides imported placement and clears the restored 3D checkpoint', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await openStudio(page);
  await page.getByTestId('import-menu-trigger').click();
  await page.getByTestId('garmentcode-example-shirt_mean_specification.json').click();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('GarmentCode Shirt');
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready');
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Seamer Project — 2D + 3D (.ssp)', exact: true }).click();
  const download = await exported;
  const archive = testInfo.outputPath('garment-checkpoint.ssp');
  await download.saveAs(archive);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooser).setFiles(archive);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().pieces[0].settings3d.savedPositions.length)).toBeGreaterThan(0);
  const pieceId = await page.evaluate(() => window.seamer!.getPattern().pieces[0].id);
  await page.getByTestId('object-browser-toggle').click();
  const browser = page.getByTestId('object-browser');
  await browser.getByTestId('object-browser-piece').first().click();
  await page.keyboard.press('Escape');
  const properties = page.getByRole('complementary', { name: 'Properties', exact: true });
  await properties.getByRole('button', { name: /3D Settings/ }).click();
  await properties.getByLabel('Cylinder', { exact: true }).fill('torso');
  await expect.poll(() => page.evaluate((id) => {
    const piece = window.seamer!.getPattern().pieces.find((candidate) => candidate.id === id)!;
    return { source: !!piece.settings3d.arrangement.sourcePlacement, saved: piece.settings3d.savedPositions.length, snapshot: !!piece.settings3d.savedMeshSnapshot, cylinder: piece.settings3d.arrangement.cylinderName };
  }, pieceId)).toEqual({ source: false, saved: 0, snapshot: false, cylinder: 'torso' });
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready');
});

test('GarmentCode checkpoints hold only when explicitly chosen and reset clears that choice', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await openStudio(page);
  await page.getByTestId('import-menu-trigger').click();
  await page.getByTestId('garmentcode-example-shirt_mean_specification.json').click();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('GarmentCode Shirt');
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).click();
  const scene = page.getByTestId('pattern-scene-3d');
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await scene.getByRole('button', { name: 'Simulation controls', exact: true }).click();
  const hold = scene.getByLabel('Hold saved checkpoint', { exact: true });
  await expect(hold).not.toBeChecked();
  await expect(hold).toBeDisabled();
  await scene.getByRole('button', { name: 'Close', exact: true }).click();

  // A real project export captures current triangles, even though no simulation was run.
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Seamer Project — 2D + 3D (.ssp)', exact: true }).click();
  const archive = testInfo.outputPath('explicit-checkpoint.ssp');
  await (await exported).saveAs(archive);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button', { name: /From file/ }).click();
  await (await chooser).setFiles(archive);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().pieces.every((piece) => piece.settings3d.savedPositions.length > 0))).toBe(true);
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await scene.getByRole('button', { name: 'Simulation controls', exact: true }).click();
  await expect(hold).toBeEnabled();
  await expect(hold).not.toBeChecked();
  await hold.check();
  await expect(hold).toBeChecked();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().pieces.every((piece) => piece.settings3d.savedDrapeState === 'held'))).toBe(true);
  await expect.poll(() => localAnchorChoice(page)).toBe('true');
  await hold.uncheck();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().pieces.every((piece) => piece.settings3d.savedDrapeState === 'checkpoint'))).toBe(true);
  await expect.poll(() => localAnchorChoice(page)).toBe('false');
  await hold.check();
  await scene.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await scene.getByRole('button', { name: 'Reset simulation', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().pieces.every((piece) => piece.settings3d.savedPositions.length === 0 && piece.settings3d.savedDrapeState === undefined))).toBe(true);
  await expect(scene).toHaveAttribute('data-status', 'ready');
  await scene.getByRole('button', { name: 'Simulation controls', exact: true }).click();
  await expect(hold).not.toBeChecked();
  await expect(hold).toBeDisabled();
});

async function localAnchorChoice(page: Page) {
  return page.evaluate(() => localStorage.getItem('seamer.simAnchors.v3'));
}

test('generator API returns usable errors for invalid and oversized requests', async ({ request }) => {
  const malformed = await request.post('/api/garmentcode', { data: Buffer.from('{invalid'), headers: { 'content-type': 'application/json' } });
  expect(malformed.status()).toBe(400);
  expect((await malformed.json()).error).toContain('JSON');
  const unknownPreset = await request.post('/api/garmentcode', { data: { preset: 'unknown', body: {}, design: {} } });
  expect(unknownPreset.status()).toBe(400);
  expect((await unknownPreset.json()).error).toContain('preset');
  const oversized = await request.post('/api/garmentcode', { data: Buffer.from('x'.repeat(70_000)), headers: { 'content-type': 'application/json' } });
  expect(oversized.status()).toBe(413);
  expect((await oversized.json()).error).toBeTruthy();
});

test.describe('GarmentCode on touch mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('generator and real garment render remain usable without overflow', async ({ page }, testInfo) => {
    await openStudio(page);
    const dialog = await openGenerator(page);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    const example = dialog.getByRole('button', { name: 'Hoodie', exact: true });
    await example.scrollIntoViewIfNeeded();
    await example.tap();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByTestId('pattern-name-input')).toHaveValue('GarmentCode Hoodie');
    await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).tap();
    await renderedObj(page);
    await expect.poll(() => page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }))).toEqual({ x: 0, y: 0 });
    await page.screenshot({ path: testInfo.outputPath('garment-render-mobile.png') });
  });
});
