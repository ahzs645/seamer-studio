import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';

test.setTimeout(180_000);
test.use({ viewport: { width: 1440, height: 1000 } });
test('production downloads contain fresh variant pixels, captured garment view, live prices and dated quotes', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
  await page.evaluate(() => {
    const pattern = structuredClone(window.seamer!.getPattern());
    for (const material of pattern.materials) if (material.frontTexture) material.frontTexture.url = '';
    const assignments = Object.fromEntries(pattern.pieces.map(piece => [piece.id, { materialId: piece.materialId, frontColor: '#ff0000' }]));
    pattern.colorways = { activeId: null, generatedMaterialSources: {}, variants: [{ id: 'red', name: 'Red export', pieces: assignments }, { id: 'blue', name: 'Blue export', pieces: Object.fromEntries(Object.entries(assignments).map(([id, value]) => [id, { ...value, frontColor: '#0000ff' }])) }] };
    window.seamer!.execute('studio.replaceWithHistory', { pattern });
  });
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await page.getByTestId('specs-workspace').getByRole('tab', { name: 'Tech Pack', exact: true }).click();
  const pack = page.getByTestId('tech-pack-panel');
  await pack.getByRole('tab', { name: 'Construction', exact: true }).click();
  await pack.getByRole('button', { name: 'Add construction instruction', exact: true }).click();
  await pack.getByLabel('Instruction title', { exact: true }).fill('Actual garment callout'); await pack.getByLabel('Instruction title', { exact: true }).blur();
  await pack.getByRole('button', { name: 'Capture current garment view', exact: true }).click();
  await expect(pack.getByAltText('Captured construction view for Actual garment callout')).toBeVisible();
  await pack.getByRole('tab', { name: 'Supplier costing', exact: true }).click();
  await pack.getByRole('button', { name: 'Add supplier cost', exact: true }).click();
  for (const [label, value] of [['Cost quantity', '2'], ['Unit cost', '4'], ['Exchange rate', '.92'], ['Exchange quote source', 'Supplier quote']]) { await pack.getByLabel(label, { exact: true }).fill(value); await pack.getByLabel(label, { exact: true }).blur(); }
  await pack.getByRole('button', { name: 'Record exchange quote', exact: true }).click();
  await expect(pack.getByTestId('exchange-quote')).toContainText('7.36 EUR');
  const snapshotBefore = await page.evaluate(() => JSON.stringify((({ points, paths, pieces, materials, artwork, colorways, techPack }) => ({ points, paths, pieces, materials, artwork, colorways, techPack }))(window.seamer!.getPattern())));
  const xlsxPromise = page.waitForEvent('download'); await pack.getByRole('button', { name: 'Download XLSX', exact: true }).click();
  const xlsx = await xlsxPromise; const xlsxPath = testInfo.outputPath('production.xlsx'); await xlsx.saveAs(xlsxPath);
  const entries = unzipSync(new Uint8Array(await readFile(xlsxPath)));
  expect(strFromU8(entries['xl/worksheets/sheet5.xml'])).toContain('<v>8</v>');
  expect(strFromU8(entries['xl/worksheets/sheet6.xml'])).toContain('<v>7.36</v>');
  expect(entries['xl/media/image3.png']).toBeDefined();
  expect(Buffer.from(entries['xl/media/image1.png']).equals(Buffer.from(entries['xl/media/image2.png']))).toBe(false);
  const verifyPixels = async (bytes: Uint8Array, channel: number) => page.evaluate(async ({ data, channel }) => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let matches = 0; for (let index = 0; index < pixels.length; index += 4) if (pixels[index + channel] > 240 && pixels[index + (channel === 0 ? 2 : 0)] < 20) matches++;
    return matches;
  }, { data: Buffer.from(bytes).toString('base64'), channel });
  expect(await verifyPixels(entries['xl/media/image1.png'], 0)).toBeGreaterThan(500);
  expect(await verifyPixels(entries['xl/media/image2.png'], 2)).toBeGreaterThan(500);
  const pdfPromise = page.waitForEvent('download'); await pack.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const pdf = await pdfPromise; const pdfPath = testInfo.outputPath('production.pdf'); await pdf.saveAs(pdfPath);
  const parsed = await PDFDocument.load(await readFile(pdfPath)); expect(parsed.getPageCount()).toBeGreaterThan(3);
  expect(await page.evaluate(() => JSON.stringify((({ points, paths, pieces, materials, artwork, colorways, techPack }) => ({ points, paths, pieces, materials, artwork, colorways, techPack }))(window.seamer!.getPattern())))).toBe(snapshotBefore);
});

test('fresh exported mockups paint diffuse fabric scale and repeated zone-restricted ink treatments', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  const sourceMaterial = await page.evaluate(() => window.seamer!.getPattern().materials[0]);
  await page.getByTestId('import-menu-trigger').click(); await page.getByTestId('import-sample-rect-piece.dxf').click();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('rect-piece');
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  const checkerSource = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16; const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 16, 16); context.fillStyle = '#0000ff'; context.fillRect(0, 0, 8, 8); context.fillRect(8, 8, 8, 8); return canvas.toDataURL('image/png');
  });
  const exportRequests: Array<Record<string, string>> = [];
  await page.route('https://catalog-fixture.seamer.test/fabric.png', async route => {
    if (route.request().resourceType() === 'fetch') exportRequests.push(route.request().headers());
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(checkerSource.split(',')[1], 'base64') });
  });
  const fixtureResult = await page.evaluate(sourceMaterial => {
    const pattern = structuredClone(window.seamer!.getPattern()), piece = pattern.pieces[0];
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 2, 2); const white = canvas.toDataURL('image/png');
    context.fillStyle = '#0000ff'; context.fillRect(0, 0, 1, 1); context.fillRect(1, 1, 1, 1);
    const material = pattern.materials.find(material => material.id === piece.materialId) ?? pattern.materials[0] ?? sourceMaterial;
    if (!pattern.materials.some(row => row.id === material.id)) pattern.materials.push(material);
    piece.materialId = material.id;
    material.frontTexture = { ...material.frontTexture!, color: '#ffffff', url: 'https://catalog-fixture.seamer.test/fabric.png', scale: 30 };
    // A previously saved variant has no assignment for this new geometry. Activation
    // retains its current fabric, and its exported variant must paint that fabric too.
    pattern.colorways = { activeId: null, generatedMaterialSources: {}, variants: [{ id: 'before-piece', name: 'Saved before new geometry', pieces: {} }] };
    const minX = Math.min(...pattern.points.map(p => p.x)), maxX = Math.max(...pattern.points.map(p => p.x)), minY = Math.min(...pattern.points.map(p => p.y)), maxY = Math.max(...pattern.points.map(p => p.y));
    pattern.artwork = [{ id: 'repeat', name: 'Zone ink', pieceId: piece.id, dataUrl: white, mimeType: 'image/png', pixelWidth: 2, pixelHeight: 2, x: (minX + maxX) / 2, y: (minY + maxY) / 2, widthMm: 15, heightMm: 15, rotation: 0, opacity: 1, repeat: { mode: 'grid', gapXmm: 5, gapYmm: 5 }, zone: [{ x: minX, y: minY }, { x: (minX + maxX) / 2, y: minY }, { x: (minX + maxX) / 2, y: maxY }, { x: minX, y: maxY }], treatment: { blend: 'source-over', tint: '#00ff00' }, vectorDesign: { width: 2, height: 2, shapes: [{ kind: 'rectangle', x: 0, y: 0, width: 2, height: 2, fill: '#ffffff', stroke: '#ffffff', strokeWidth: 0 }] } }];
    const result = window.seamer!.execute('studio.replaceWithHistory', { pattern });
    return { result, artwork: window.seamer!.getPattern().artwork };
  }, sourceMaterial);
  expect(fixtureResult.result.ok, JSON.stringify(fixtureResult.result)).toBe(true);
  expect(fixtureResult.artwork?.[0].name).toBe('Zone ink');
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Specs', exact: true }).click();
  await page.getByTestId('specs-workspace').getByRole('tab', { name: 'Tech Pack', exact: true }).click();
  const downloadPromise = page.waitForEvent('download'); await page.getByTestId('tech-pack-panel').getByRole('button', { name: 'Download XLSX', exact: true }).click();
  const download = await downloadPromise; const path = testInfo.outputPath('zone-repeat.xlsx'); await download.saveAs(path);
  const files = unzipSync(new Uint8Array(await readFile(path)));
  expect(strFromU8(files['xl/worksheets/sheet8.xml'])).toContain('Zone ink'); expect(strFromU8(files['xl/worksheets/sheet8.xml'])).toContain('grid');
  const counts = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let greenLeft = 0, greenRight = 0, blueRight = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const x = i / 4 % canvas.width;
      if (pixels[i] < 20 && pixels[i + 1] > 240 && pixels[i + 2] < 20) { if (x < 200) greenLeft++; else greenRight++; }
      if (x > 200 && x < 400 && pixels[i] < 20 && pixels[i + 1] < 20 && pixels[i + 2] > 240) blueRight++;
    }
    return { greenLeft, greenRight, blueRight };
  }, 'data:image/png;base64,' + Buffer.from(files['xl/media/image1.png']).toString('base64'));
  expect(counts.greenLeft).toBeGreaterThan(500); expect(counts.greenRight).toBe(0); expect(counts.blueRight).toBeGreaterThan(500);
  expect(exportRequests.length).toBeGreaterThan(0); for (const headers of exportRequests) { expect(headers.cookie).toBeUndefined(); expect(headers.authorization).toBeUndefined(); expect(headers.referer).toBeUndefined(); }
  // A provider failure still downloads an honest flat reference, with a visible warning
  // and the exact fallback reason retained alongside the variant in the workbook.
  await page.route('https://catalog-fixture.seamer.test/fabric.png', route => route.abort('blockedbyclient'));
  const snapshotBeforeFallback = await page.evaluate(() => JSON.stringify(window.seamer!.getPattern()));
  const fallbackPromise = page.waitForEvent('download');
  await page.getByTestId('tech-pack-panel').getByRole('button', { name: 'Download XLSX', exact: true }).click();
  const fallback = await fallbackPromise; const fallbackPath = testInfo.outputPath('blocked-provider.xlsx'); await fallback.saveAs(fallbackPath);
  await expect(page.getByTestId('tech-pack-panel').getByRole('status')).toContainText('export warning');
  const fallbackFiles = unzipSync(new Uint8Array(await readFile(fallbackPath)));
  const workbook = strFromU8(fallbackFiles['xl/workbook.xml']);
  const warningSheetId = workbook.match(/name="Export warnings" sheetId="(\d+)"/)![1];
  const warningSheet = strFromU8(fallbackFiles[`xl/worksheets/sheet${warningSheetId}.xml`]);
  expect(warningSheet).toContain('Saved before new geometry'); expect(warningSheet).toContain('Diffuse fabric texture unavailable'); expect(warningSheet).toContain('Flat tint shown');
  expect(fallbackFiles['xl/media/image1.png']).toBeDefined();
  expect(await page.evaluate(() => JSON.stringify(window.seamer!.getPattern()))).toBe(snapshotBeforeFallback);
});
