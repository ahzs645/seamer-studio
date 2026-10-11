import { expect, test, type Page } from '@playwright/test';
test.setTimeout(180_000);
test.use({viewport:{width:1440,height:900}});
async function setup(page:Page){
  await page.addInitScript(()=>{localStorage.setItem('seamer.welcomeSeen','1');localStorage.setItem('seamer.autosaveSeconds','600');});
  await page.goto('/studio',{waitUntil:'domcontentloaded'});
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy','false',{timeout:60000});
  await page.getByTestId('import-menu-trigger').click();await page.getByTestId('import-sample-rect-piece.dxf').click();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('rect-piece');
  await page.getByRole('group',{name:'Workspace view',exact:true}).getByRole('button',{name:'2D',exact:true}).click();
  const toggle=page.getByTestId('object-browser-toggle');if(!await toggle.isVisible())await page.getByRole('button',{name:'More',exact:true}).click();
  await toggle.click();await page.getByTestId('object-browser').getByTestId('object-browser-piece').first().click();await toggle.click();
  if(!await page.locator('#studio-left-panel').isVisible())await page.getByRole('button',{name:'Layers and body panel',exact:true}).click();
  await page.getByRole('tab',{name:'Artwork',exact:true}).click();
  return page.getByTestId('artwork-panel');
}
async function artwork(page:Page){return page.evaluate(()=>{const w=window as unknown as {seamer:{getPattern:()=>{artwork:Array<{x:number;y:number;widthMm:number;repeat?:{mode:string};treatment?:unknown;zone?:unknown[]}>;pieces:unknown[];points:unknown[]}}};return w.seamer.getPattern();});}
async function upload(page:Page){const data=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=64;c.height=32;const ctx=c.getContext('2d')!;ctx.fillStyle='#ff00ff';ctx.fillRect(0,0,64,32);return c.toDataURL('image/png');});await page.getByLabel('Add image to selected piece',{exact:true}).setInputFiles({name:'print.png',mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')});await expect(page.getByTestId('artwork-entry')).toHaveCount(1);}
async function printCenter(page:Page){return page.getByTestId('pattern-canvas-2d').evaluate((c:HTMLCanvasElement)=>{const pixels=c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;let n=0,x=0,y=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i]>245&&pixels[i+1]<5&&pixels[i+2]>245){n++;x+=(i/4)%c.width;y+=Math.floor(i/4/c.width);}}if(!n)throw Error('Print did not render');const r=c.getBoundingClientRect();return{x:r.left+x/n*r.width/c.width,y:r.top+y/n*r.height/c.height};});}
test('canvas artwork gestures preview, cancel and commit one appearance edit while preserving geometry',async({page})=>{
  const panel=await setup(page);await upload(page);const initial=await artwork(page);
  await panel.getByRole('button',{name:'Move',exact:true}).click();const center=await printCenter(page);
  await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+30,center.y-20);
  expect((await artwork(page)).artwork[0]).toMatchObject(initial.artwork[0]);
  const canvasBox=await page.getByTestId('pattern-canvas-2d').boundingBox();
  await page.mouse.move(canvasBox!.x+canvasBox!.width+40,center.y);
  expect((await artwork(page)).artwork[0]).toMatchObject(initial.artwork[0]);
  await page.keyboard.press('Escape');await page.mouse.up();expect((await artwork(page)).artwork[0]).toMatchObject(initial.artwork[0]);
  await page.waitForTimeout(850);
  await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+40,center.y-20);await page.mouse.up();
  await expect.poll(async()=>JSON.stringify((await artwork(page)).artwork[0])).not.toBe(JSON.stringify(initial.artwork[0]));
  const moved=await artwork(page);expect(moved.points).toEqual(initial.points);expect(moved.pieces).toEqual(initial.pieces);
  await page.keyboard.press('Control+z');await expect.poll(async()=>JSON.stringify((await artwork(page)).artwork[0])).toBe(JSON.stringify(initial.artwork[0]));
  // An admitted invalid print remains repairable without capturing a gesture or throwing.
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.evaluate(()=>{const document=structuredClone(window.seamer!.getPattern());document.artwork![0].widthMm=0;window.seamer!.execute('studio.replaceWithHistory',{pattern:document});});
  await expect(panel.getByText('Artwork width and height must be greater than zero and at most 10000 mm.',{exact:true})).toBeVisible();
  const invalid=await artwork(page);
  await page.getByTestId('pattern-canvas-2d').evaluate((canvas:HTMLCanvasElement,point)=>{
    canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:21,button:0,clientX:point.x,clientY:point.y}));
    canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:21,clientX:point.x+30,clientY:point.y+20}));
    canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:21,clientX:point.x+30,clientY:point.y+20}));
  },center);
  expect(await artwork(page)).toEqual(invalid);expect(errors).toEqual([]);
});
test('vector authoring, repeats, zone treatments and named appearance restoration are usable',async({page})=>{
  const panel=await setup(page);const editor=panel.getByTestId('vector-artwork-editor');await editor.locator('summary').click();
  await editor.getByRole('button',{name:'Add shape',exact:true}).click();await editor.getByRole('button',{name:'Add vector print',exact:true}).click();
  await expect(panel.getByTestId('artwork-entry')).toHaveCount(1);
  const history=panel.getByTestId('appearance-history');await history.locator('summary').click();await history.getByLabel('Version name').fill('Original vector');await history.getByRole('button',{name:'Save appearance version'}).click();
  const entry=panel.getByTestId('artwork-entry');await entry.locator('summary',{hasText:'Repeat, ink and print zone'}).click();
  await entry.getByRole('combobox',{name:'Repeat',exact:true}).selectOption('brick');await entry.getByRole('combobox',{name:'Ink blend',exact:true}).selectOption('multiply');await entry.getByLabel('Override ink colour').check();await entry.getByRole('button',{name:'Define print zone'}).click();
  const edited=await artwork(page);expect(edited.artwork[0].repeat?.mode).toBe('brick');expect(edited.artwork[0].zone).toHaveLength(4);
  await history.getByRole('button',{name:'Restore',exact:true}).click();const restored=await artwork(page);expect(restored.artwork[0].repeat).toBeUndefined();expect(restored.artwork[0].zone).toBeUndefined();expect(restored.points).toEqual(edited.points);
});
