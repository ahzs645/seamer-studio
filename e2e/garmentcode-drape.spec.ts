import { expect, test, type Page } from '@playwright/test';
import { acceptVerifiedSourceImport, captureSourceImportDocument } from './verified-source-import';
import { writeFile } from 'node:fs/promises';

interface State {
 deviceAcquired:boolean; deviceLostReason:string|null; running:boolean; frameCount:number;
 particleCount:number; positionHash:string|null; positionsFinite:boolean;
 particleBounds:{min:number[];max:number[];centroid:number[]}|null;
 avatarBounds:{min:number[];max:number[];centroid:number[]}|null;
 maxSeamPairDistanceMm:number|null;
}
async function readState(page:Page):Promise<State|null>{
 return page.evaluate(()=> (window as unknown as {__seamerWebgpuDrape?:{getState:()=>State|null}}).__seamerWebgpuDrape?.getState()??null);
}

for (const preset of ['t-shirt','skirt','hoodie']) {
 test(`real generated ${preset}: renders, runs finite WebGPU frames, pauses and resets`, async({page, request},testInfo)=>{
  // Guarded source frames include all corrected substeps and their actual safety proof.
  // The skirt also prepares/runs again after Reset and a live seam edit.
  testInfo.setTimeout(preset === 'skirt' ? 1_200_000 : 600_000);
  const errors:string[]=[];
  page.on('pageerror', error=> errors.push(error.message));
  const generated = await request.post('/api/garmentcode', { data: { preset, body: {}, design: {} } });
  const specification = await generated.text();
  test.skip(generated.status() === 503 && specification.includes('Garment generation is unavailable on this host'), 'GarmentCode Python bridge is not configured on this host');
  expect(generated.status(), specification).toBe(200);
  await page.addInitScript(()=>localStorage.setItem('seamer.welcomeSeen','1'));
  await page.goto('/studio',{waitUntil:'domcontentloaded'});
  await expect(page.getByTestId('pattern-name-input')).toBeVisible({ timeout: 90_000 });
  const documentBefore = await captureSourceImportDocument(page);
  const chooserPromise=page.waitForEvent('filechooser');
  await page.getByTestId('import-menu-trigger').click();
  await page.getByRole('button',{name:/From file/}).click();
  const chooser=await chooserPromise;
  await chooser.setFiles({ name: `generated-${preset}.json`, mimeType: 'application/json', buffer: Buffer.from(specification) });
  await acceptVerifiedSourceImport(page, documentBefore);
  await expect(page.getByTestId('pattern-name-input')).toHaveValue(`generated-${preset}`);
  await page.getByRole('button',{name:'3D',exact:true}).click();
  const scene=page.getByTestId('pattern-scene-3d');
  await expect(scene).toHaveAttribute('data-status','ready');
  await expect(scene).toHaveAttribute('data-export-ready','true', { timeout: 90_000 });
  await expect(scene.getByText(/Invalid shape/)).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath(`garment-${preset}-initial.png`)});
  const gpuAvailable = await page.evaluate(async () => !!navigator.gpu && !!(await navigator.gpu.requestAdapter()));
  test.skip(!gpuAvailable, 'WebGPU adapter is unavailable');
  await scene.getByRole('button',{name:'Start simulation'}).click();
  await expect(scene).toHaveAttribute('data-status','simulating');
  await expect.poll(async()=>{
   const s=await readState(page);return !!s&&s.deviceAcquired&&s.running&&s.frameCount>=2&&s.positionsFinite&&s.particleCount>0;
  }, { timeout: 240_000 }).toBe(true);
  const baseline=await readState(page);
  await expect.poll(async () => {
   const s=await readState(page);
   return !!s && s.running && s.positionsFinite && s.deviceLostReason === null
    && s.frameCount > (baseline?.frameCount ?? 0) && s.positionHash !== baseline?.positionHash;
  }, { timeout: 180_000 }).toBe(true);
  const running=await readState(page);
  expect(running?.frameCount).toBeGreaterThan(baseline?.frameCount??0);
  expect(running?.positionHash).not.toBe(baseline?.positionHash);
  expect(running?.positionsFinite).toBe(true);
  expect(running?.deviceLostReason).toBeNull();
  expect(running?.maxSeamPairDistanceMm).not.toBeNull();
  // A finite position alone would miss an exploding solver. Keep the early drape in a
  // plausible body-scale envelope without claiming a fully settled fit or collision proof.
  const bounds = running?.particleBounds;
  const avatar = running?.avatarBounds;
  expect(bounds).not.toBeNull();
  expect(avatar).not.toBeNull();
  if (!bounds || !avatar) throw new Error('Cloth/avatar bounds unavailable');
  const bodyHeight = avatar.max[1] - avatar.min[1];
  for (let axis = 0; axis < 3; axis++) {
   expect(bounds.max[axis] - bounds.min[axis]).toBeLessThan(bodyHeight * 3);
  }
  await scene.getByRole('button',{name:'Pause simulation'}).click();
  await expect(scene).toHaveAttribute('data-status','ready');
  const paused=await readState(page);
  await page.waitForTimeout(1_200);
  expect((await readState(page))?.positionHash).toBe(paused?.positionHash);
  await page.screenshot({path:testInfo.outputPath(`garment-${preset}-simulated.png`)});
  await scene.getByRole('button',{name:'Reset simulation'}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Reset',exact:true}).click();
  await expect(scene).toHaveAttribute('data-status','ready');
  const reset=await readState(page);
  expect(reset?.positionHash).not.toBe(paused?.positionHash);
  expect(errors).toEqual([]);
  await writeFile(testInfo.outputPath(`garment-${preset}-simulation-metrics.json`),JSON.stringify({baseline,running,paused,reset,errors},null,2));
  if (preset === 'skirt') {
   await scene.getByRole('button', { name: 'Start simulation' }).click();
   await expect.poll(async () => (await readState(page))?.frameCount ?? 0, { timeout: 360_000 }).toBeGreaterThanOrEqual(5);
   const beforeEdit = (await readState(page))!.frameCount;
   const seamCount = await page.evaluate(() => {
    const pattern = window.seamer!.getPattern();
    window.seamer!.execute('seam.reverse', { seamId: pattern.seams[0].id, side: 'to' });
    return pattern.seams.length;
   });
   // Live edits deliberately restart the solver after rebuilding. The new frame counter
   // proves the seam topology was rebuilt even though the number of seams stayed the same.
   await expect.poll(async () => (await readState(page))?.frameCount ?? beforeEdit, { timeout: 180_000 }).toBeLessThan(beforeEdit);
   expect(await page.evaluate(() => window.seamer!.getPattern().seams.length)).toBe(seamCount);
   await expect.poll(async () => {
    const state = await readState(page);
    return !!state && state.running && state.frameCount >= 2 && state.positionsFinite;
   }, { timeout: 240_000 }).toBe(true);
   await scene.getByRole('button', { name: 'Pause simulation' }).click();
   await page.evaluate(() => {
    const pattern = window.seamer!.getPattern();
    window.seamer!.execute('seam.reverse', { seamId: pattern.seams[0].id, side: 'to' });
   });
   await expect(scene).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });
   await expect(scene).toHaveAttribute('data-export-ready', 'true', { timeout: 180_000 });
   await expect.poll(async () => (await readState(page))?.particleCount).toBe(0);
   await scene.getByRole('button', { name: 'Start simulation' }).click();
   await expect.poll(async () => {
    const state = await readState(page);
    return !!state && state.running && state.frameCount >= 2 && state.positionsFinite;
   }, { timeout: 240_000 }).toBe(true);
   await scene.getByRole('button', { name: 'Pause simulation' }).click();
   expect(errors).toEqual([]);
  } });
}
