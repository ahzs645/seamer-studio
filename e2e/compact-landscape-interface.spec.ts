import { devices, expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { PerspectiveCamera, Vector3 } from 'three';

// Genuine Generate/UI cold rendering only. Manual source sewing/proof is a later
// coordinated case; no accepted positions, approval, cache or fit claims are injected.
async function activate(control: Locator, touch: boolean) {
  if (touch) await control.tap(); else await control.click();
}
async function target(control: Locator, touch: boolean) {
  await expect(control).toBeVisible();
  if (touch) await expect.poll(() => control.evaluate(element => {
    const b = element.getBoundingClientRect();
    return b.width >= 44 && b.height >= 44 && document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('button,a,[role="button"]') === element;
  })).toBe(true);
  return control.boundingBox();
}
async function controls(page: Page, touch: boolean) {
  const expand = page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Expand 3D controls', exact: true });
  if (await expand.isVisible()) { await target(expand, touch); await activate(expand, touch); }
}
async function closeControls(page: Page, touch: boolean) {
  const close = page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Close 3D controls', exact: true });
  if (await close.isVisible()) { await target(close, touch); await activate(close, touch); }
}
async function compactTasks(page: Page, info: TestInfo, artifact: string) {
  const header = page.locator('.studio-topbar');
  const more = header.getByRole('button', { name: 'More', exact: true });
  await activate(more, true);
  const tasks = header.getByRole('navigation', { name: 'Studio tasks', exact: true });
  await expect(tasks.getByRole('button')).toHaveCount(5);
  const targets = [];
  for (const button of await tasks.getByRole('button').all()) {
    await button.scrollIntoViewIfNeeded();
    targets.push({ label: await button.innerText(), bounds: await target(button, true) });
  }
  await writeFile(info.outputPath(artifact), JSON.stringify(targets, null, 2));
  await expect(page.getByTestId('task-appearance')).not.toBeVisible();
  const appearance = tasks.getByRole('button', { name: 'Appearance', exact: true });
  await appearance.scrollIntoViewIfNeeded();
  await activate(appearance, true);
  const panel = page.getByRole('dialog', { name: 'Layers, body, fabric and seams', exact: true });
  await expect(panel.getByRole('tab', { name: 'Fabric', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('pattern-scene-3d')).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await activate(panel.getByRole('button', { name: 'Close pattern panels', exact: true }), true);
  await expect(more).toBeFocused();
  await activate(more, true);
  await expect(appearance).toHaveAttribute('aria-pressed', 'true');
  await appearance.focus();
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
}
async function generate(page: Page, touch: boolean, info: TestInfo) {
  await page.addInitScript(() => {
    localStorage.setItem('seamer.welcomeSeen', '1'); localStorage.setItem('seamer.autosaveSeconds', '600');
  });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await activate(page.getByTestId('templates-menu-trigger'), touch);
  await activate(page.getByTestId('template-garmentcode'), touch);
  const dialog = page.getByRole('dialog', { name: 'GarmentCode garment', exact: true });
  await dialog.getByRole('combobox').selectOption('t-shirt');
  await dialog.getByLabel('Height', { exact: true }).fill('176');
  const pending = page.waitForResponse(response => response.url().endsWith('/api/garmentcode') && response.request().method() === 'POST');
  await activate(dialog.getByRole('button', { name: 'Generate garment', exact: true }), touch);
  const response = await pending, bytes = await response.text();
  await writeFile(info.outputPath('actual-generator-response.json'), bytes);
  await writeFile(info.outputPath('actual-generator-request.json'), response.request().postData() ?? '');
  expect(response.status(), bytes).toBe(200);
  await expect.poll(async () => !(await dialog.isVisible()) || await dialog.getByRole('alert').isVisible(), { timeout: 90_000 }).toBe(true);
  expect(await dialog.getByRole('alert').isVisible() ? await dialog.getByRole('alert').innerText() : null).toBeNull();
  await expect(dialog).not.toBeVisible();
  await activate(page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }), touch);
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready', { timeout: 90_000 });
}
async function actualFraming(page: Page, touch: boolean, info: TestInfo) {
  await controls(page, touch);
  const scene = page.getByTestId('pattern-scene-3d');
  await activate(scene.getByRole('button', { name: 'Reset view', exact: true }).filter({ visible: true }), touch);
  await controls(page, touch);
  const pending = page.waitForEvent('download');
  await activate(scene.getByRole('button', { name: 'Download as OBJ', exact: true }).filter({ visible: true }), touch);
  const file = info.outputPath('actual-cold-geometry.obj'); await (await pending).saveAs(file);
  const points = (await readFile(file, 'utf8')).split('\n').filter(line => line.startsWith('v ')).map(line => line.trim().split(/\s+/).slice(1,4).map(Number));
  await closeControls(page, touch);
  const actual = await scene.evaluate(shell => {
    const canvas = shell.querySelector('canvas')!.getBoundingClientRect();
    const visible = [...shell.querySelectorAll<HTMLElement>('.scene-controls,.scene-camera,.scene-lighting,.scene-poses,.scene-mobile-primary,.scene-status-notice')].filter(element => element.getClientRects().length > 0);
    const api = (window as unknown as { __seamerWebgpuDrape: { getCameraState: () => { position: [number,number,number]; target:[number,number,number]; fov:number }; getState: () => { deviceAcquired: boolean } } }).__seamerWebgpuDrape;
    return { canvas: { width: canvas.width, height: canvas.height }, camera: api.getCameraState(), state: api.getState(), obstacles: visible.map(element => {
      const b=element.getBoundingClientRect();return { name: element.className, left:b.left-canvas.left, right:b.right-canvas.left, top:b.top-canvas.top, bottom:b.bottom-canvas.top };
    }) };
  });
  const camera = new PerspectiveCamera(actual.camera.fov, actual.canvas.width/actual.canvas.height,.01,100);
  camera.position.fromArray(actual.camera.position);camera.lookAt(new Vector3(...actual.camera.target));camera.updateMatrixWorld();
  const bounds={left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity};
  for(const point of points) {
    const projected=new Vector3(...point).project(camera);
    expect([projected.x,projected.y,projected.z].every(Number.isFinite)).toBe(true);
    expect(projected.z).toBeGreaterThan(-1);expect(projected.z).toBeLessThan(1);
    const x=(projected.x+1)*actual.canvas.width/2,y=(1-projected.y)*actual.canvas.height/2;
    bounds.left=Math.min(bounds.left,x);bounds.right=Math.max(bounds.right,x);bounds.top=Math.min(bounds.top,y);bounds.bottom=Math.max(bounds.bottom,y);
  }
  expect(actual.state.deviceAcquired, 'Cold interface checks must not initialize a cloth GPU device').toBe(false);
  const observed={...actual, actualOBJVertices:points.length, projectedBounds:bounds, fitAccepted:false, evidenceScope:'Actual cold source camera/interface only; no garment simulation or physical device'};
  await writeFile(info.outputPath('actual-framing.json'),JSON.stringify(observed,null,2));
  await page.screenshot({path:info.outputPath('normal-source-framing.png')});
  expect(points.length).toBeGreaterThan(500);
  expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(actual.canvas.width);
  expect(bounds.top).toBeGreaterThanOrEqual(0);expect(bounds.bottom).toBeLessThanOrEqual(actual.canvas.height);
  for(const obstacle of actual.obstacles) expect(bounds.left<obstacle.right && bounds.right>obstacle.left && bounds.top<obstacle.bottom && bounds.bottom>obstacle.top,`Geometry covers ${obstacle.name}`).toBe(false);
}

for(const viewport of [{width:667,height:375},{width:768,height:375},{width:390,height:844},{width:1280,height:720}]) {
  test(`normal Library and garment space at ${viewport.width}x${viewport.height}`,async({browser,baseURL},info)=>{
    test.setTimeout(180_000);
    const touch=viewport.width<1024;
    const context=await browser.newContext({...devices[touch?'Pixel 7':'Desktop Chrome'],viewport,baseURL,acceptDownloads:true,serviceWorkers:'block'});
    const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    try {
      await generate(page,touch,info);
      if(viewport.width===390){
        // Check the unchanged narrow-landscape fallback inside this same genuine
        // source session, then restore portrait before the main camera evidence.
        await page.setViewportSize({width:390,height:280});
        const fallbackHeader=page.locator('.studio-topbar');
        const fallbackTargets=[];
        for(const control of [page.getByTestId('templates-menu-trigger'),page.getByTestId('import-menu-trigger'),
          fallbackHeader.locator('[data-tour-id="tour-save"]'),fallbackHeader.getByRole('button',{name:'More',exact:true})]){
          fallbackTargets.push({label:await control.innerText(),bounds:await target(control,true)});
        }
        const fallback={viewport:{width:390,height:280},header:await fallbackHeader.boundingBox(),
          canvas:await page.getByTestId('pattern-scene-3d').boundingBox(),targets:fallbackTargets};
        await writeFile(info.outputPath('actual-narrow-landscape-fallback.json'),JSON.stringify(fallback,null,2));
        await page.screenshot({path:info.outputPath('narrow-landscape-fallback.png')});
        expect(fallback.header!.height).toBeGreaterThanOrEqual(96);expect(fallback.header!.height).toBeLessThanOrEqual(105);
        expect(fallback.canvas!.height).toBeGreaterThanOrEqual(150);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
        await compactTasks(page, info, 'narrow-landscape-task-targets.json');
        await page.setViewportSize(viewport);
      }
      const header=page.locator('.studio-topbar'),scene=page.getByTestId('pattern-scene-3d');
      const viewButtons=await header.getByRole('group',{name:'Workspace view',exact:true}).getByRole('button').all();
      const labels:Locator[]=[header.getByRole('link',{name:'Back to patterns',exact:true}),page.getByTestId('templates-menu-trigger'),
        ...viewButtons,page.getByTestId('import-menu-trigger'),header.locator('[data-tour-id="tour-save"]')];
      if(touch)labels.push(header.getByRole('button',{name:'More',exact:true}));
      const buttons=[];
      for(const button of labels)buttons.push({label:await button.innerText(),bounds:await target(button,touch)});
      const viewGroup=header.getByRole('group',{name:'Workspace view',exact:true});
      // Joined view buttons share their one-pixel border; their individual center
      // hit-tests stay strict, while spatial clearance compares whole control groups.
      const groups=[buttons[0],buttons[1],{label:'Workspace view',bounds:await viewGroup.boundingBox()},...buttons.slice(2+viewButtons.length)];
      const observed={viewport,touchEmulation:touch,header:await header.boundingBox(),scene:await scene.boundingBox(),buttons,groups};
      await writeFile(info.outputPath('actual-header-layout.json'),JSON.stringify(observed,null,2));
      await page.screenshot({path:info.outputPath('normal-header.png')});
      if(viewport.height===375){expect(observed.header!.height).toBeLessThanOrEqual(56);expect(observed.scene!.height).toBeGreaterThanOrEqual(290);}
      for(let a=0;a<groups.length;a++)for(let b=a+1;b<groups.length;b++) {
        const x=groups[a].bounds!,y=groups[b].bounds!;
        expect(x.x<y.x+y.width&&x.x+x.width>y.x&&x.y<y.y+y.height&&x.y+x.height>y.y,`Header overlaps ${groups[a].label}/${groups[b].label}`).toBe(false);
      }
      if (viewport.height === 375) await compactTasks(page, info, 'compact-task-targets.json');
      else {
        const tasks = page.getByRole('navigation', { name: 'Studio tasks', exact: true });
        await expect(tasks.getByRole('button')).toHaveCount(5);
        for (const button of await tasks.getByRole('button').all()) {
          await button.scrollIntoViewIfNeeded();
          await target(button, touch);
        }
      }
      const trigger=page.getByTestId('templates-menu-trigger');await activate(trigger,touch);
      const library=page.getByRole('dialog',{name:'Pattern library',exact:true});await expect(library).toBeVisible();
      const bounds=(await library.boundingBox())!;await writeFile(info.outputPath('actual-library-bounds.json'),JSON.stringify(bounds));
      expect(bounds.y).toBeGreaterThanOrEqual(0);expect(bounds.y+bounds.height).toBeLessThanOrEqual(viewport.height);
      if(viewport.height===375)expect(bounds.y).toBeLessThanOrEqual(60);
      await library.getByRole('searchbox',{name:'Search pattern library',exact:true}).fill('shirt');
      await expect(library.locator('.library-item').first()).toBeVisible();
      const close=library.getByRole('button',{name:'Close pattern library',exact:true});await target(close,touch);await activate(close,touch);await expect(trigger).toBeFocused();
      const importTrigger=page.getByTestId('import-menu-trigger');await importTrigger.focus();await page.keyboard.press('Enter');
      await expect(page.locator('#studio-import-menu')).toBeVisible();await page.keyboard.press('Escape');await expect(importTrigger).toBeFocused();
      if(touch){
        const more=header.getByRole('button',{name:'More',exact:true});await activate(more,true);
        const panelButton=header.getByRole('button',{name:'Layers and body panel',exact:true}).filter({visible:true});await target(panelButton,true);
        const fabric=header.getByRole('button',{name:'Fabric',exact:true}).filter({visible:true});
        const fabricIsMenuAction=await fabric.evaluate(element=>element.closest('#studio-more-actions')!==null);
        await target(fabric,true);await activate(fabric,true);
        const panel=page.getByRole('dialog',{name:'Layers, body, fabric and seams',exact:true});await expect(panel.getByRole('tab',{name:'Fabric',exact:true})).toHaveAttribute('aria-selected', 'true');
        await activate(panel.getByRole('button',{name:'Close pattern panels',exact:true}),true);
        // A menu action restores More; the directly visible portrait action
        // restores its own Fabric trigger. Both actual focus paths stay asserted.
        await expect(fabricIsMenuAction ? more : fabric).toBeFocused();
        const primary=scene.getByRole('group',{name:'Primary 3D controls',exact:true});await expect(primary.getByRole('button')).toHaveCount(4);
        await expect(primary.getByRole('button',{name:'Zoom to garment',exact:true})).toBeVisible();
        for(const button of await primary.getByRole('button').all())await target(button,true);
      }
      await actualFraming(page,touch,info);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
      expect(errors).toEqual([]);
    }finally{
      if(!page.isClosed()){
        await page.screenshot({path:info.outputPath('final-state.png')}).catch(()=>{});
        await writeFile(info.outputPath('page-errors.json'),JSON.stringify(errors));
      }
      await context.close();await writeFile(info.outputPath('resources-closed.json'),JSON.stringify({contextClosed:true,browserManagedByPlaywright:true,fitAccepted:false}));
    }
  });
}
