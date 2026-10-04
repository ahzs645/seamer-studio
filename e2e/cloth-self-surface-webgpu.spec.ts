import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
const sleeveContext = JSON.parse(readFileSync(new URL('./fixtures/sleeve-multi-candidate-owner.json',import.meta.url),'utf8'));
const sleeveOnset = JSON.parse(readFileSync(new URL('./fixtures/sleeve-onset-continuation.json',import.meta.url),'utf8'));
const sleeveNeighbor = JSON.parse(readFileSync(new URL('./fixtures/sleeve-neighbor-owner.json',import.meta.url),'utf8'));
const sleeveFold: { positions:number[];previousPositions:number[];triangles:number[];expectedUnsafePairs:number[][] } = JSON.parse(readFileSync(new URL('./fixtures/sleeve-fold-finite.json',import.meta.url),'utf8'));

test('lazy finite candidate ranking preserves exact eager IDs below and above capacity', async ({ page }) => {
  await page.goto('/studio', { waitUntil:'domcontentloaded' });
  test.skip(!await page.evaluate(async()=>!!navigator.gpu && !!await navigator.gpu.requestAdapter()),'WebGPU adapter unavailable');
  const result=await page.evaluate(async()=>{
    const shaderPath='/packages/cloth-sim/src/webgpu/shaders.ts';
    const selfPath='/packages/cloth-sim/src/webgpu/surfaceSelf.ts',bodyPath='/packages/cloth-sim/src/webgpu/bodySurfaceBroadphase.ts',configPath='/packages/cloth-sim/src/config.ts';
    const [{initSelfSurfaceCollisionWGSL},{initBodySurfaceBVHCollisionWGSL,buildBodySurfaceBVH},{SIM_CONFIG}]=await Promise.all([import(selfPath),import(bodyPath),import(configPath)]);
    const adapter=(await navigator.gpu.requestAdapter())!,device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:8}});
    const errors:string[]=[];device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
    const buffer=(data:Float32Array|Uint32Array|Int32Array)=>{const b=device.createBuffer({size:Math.max(16,data.byteLength),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});device.queue.writeBuffer(b,0,data.buffer as ArrayBuffer,data.byteOffset,data.byteLength);return b;};
    const pipe=async(code:string)=>{const module=device.createShaderModule({code});const info=await module.getCompilationInfo();errors.push(...info.messages.filter(m=>m.type==='error').map(m=>m.message));return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});};
    const group=(pipeline:GPUComputePipeline,values:GPUBuffer[])=>device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:values.map((value,binding)=>({binding,resource:{buffer:value}}))});
    const {clearU32WGSL}=await import(shaderPath);const clear=await pipe(clearU32WGSL());
    const records=[];
    for(const kind of ['self','body']) for(const [budget,counts]of [[4,[0,3,4,5,9]],[32,[31,32,33,65]],[128,[127,128,129,140]]]as const) {
      if(kind==='self' && budget===128 || kind==='body' && budget===32) continue;
      const cfg={...SIM_CONFIG,simulationThickness:.001,numInternalSurfaceCollisionConstraints:budget,numExternalSurfaceCollisionConstraints:budget};
      const eager=await pipe(kind==='self'?initSelfSurfaceCollisionWGSL(cfg,false):initBodySurfaceBVHCollisionWGSL(cfg,0,false));
      const lazy=await pipe(kind==='self'?initSelfSurfaceCollisionWGSL(cfg,true):initBodySurfaceBVHCollisionWGSL(cfg,0,true));
      const atomicReference=kind==='self'?await pipe(initSelfSurfaceCollisionWGSL(cfg,true,true)):null;
      for(const count of counts) {
        const seed=[-.05,.47,0,1,.05,.47,0,1,0,.55,0,1],indices=[0,1,2,0];
        for(let at=0;at<count;at++) {
          const x=(at%7-3)*.003,z=at%4===0?.0005:0,start=seed.length/4;
          if(at%4===0) seed.push(x-.007,.48,z,1,x+.007,.48,z,1,x,.52,z,1);
          else seed.push(x-.007,.49,-.004,1,x+.007,.49,-.004,1,x,.51,.004,1);
          indices.push(start,start+1,start+2,at%3===0?0x80000001:0);
        }
        const positions=new Float32Array(seed),triangles=new Uint32Array(indices),previous=positions.slice();
        previous[0]-=.02;previous[1]-=.01; // Include actual swept-priority work independent of current ties.
        const body={positions,triangles,numTriangles:triangles.length/4},tree=buildBodySurfaceBVH(body);
        const current=buffer(positions),faces=buffer(triangles),old=buffer(previous),nodes=buffer(tree.nodes),ordered=buffer(tree.triangleIds);
        const faceCount=kind==='self'?body.numTriangles:1,length=faceCount*budget;
        const seeded=new Uint32Array(length);
        if(kind==='self') for(let face=0;face<faceCount;face++) {
          const others=Array.from({length:body.numTriangles},(_,id)=>id).filter(id=>id!==face).reverse().slice(0,budget);
          others.forEach((id,slot)=>seeded[face*budget+slot]=(id+2)|([0x10000000,0x20000000,0x30000000,0x40000000,0x80000000,0xc0000000,0x50000000,0x90000000,0xf0000000][slot%9]));
        }
        const a=buffer(seeded),b=buffer(seeded),atomicOut=atomicReference?buffer(seeded):null,clothFaces=buffer(triangles.slice(0,4));
        const values=(out:GPUBuffer)=>kind==='self'?[current,faces,out,nodes,ordered,old]:[current,clothFaces,out,nodes,ordered,old,faces,current];
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(eager);pass.setBindGroup(0,group(eager,values(a)));pass.dispatchWorkgroups(Math.ceil(faceCount/64));
        pass.setPipeline(lazy);pass.setBindGroup(0,group(lazy,values(b)));pass.dispatchWorkgroups(Math.ceil(faceCount/64));
        if(atomicReference&&atomicOut) { pass.setPipeline(atomicReference);pass.setBindGroup(0,group(atomicReference,values(atomicOut)));pass.dispatchWorkgroups(Math.ceil(faceCount/64)); }
        pass.end();
        const read=device.createBuffer({size:Math.max(12,length*12),usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        encoder.copyBufferToBuffer(a,0,read,0,length*4);encoder.copyBufferToBuffer(b,0,read,length*4,length*4);
        if(atomicOut)encoder.copyBufferToBuffer(atomicOut,0,read,length*8,length*4);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const words=new Uint32Array(read.getMappedRange().slice(0));let mismatch=0,seedMismatch=0,resetMismatch=0,atomicMismatch=0;
        for(let at=0;at<length;at++) { if(words[at]!==words[length+at])mismatch++;if(atomicOut&&words[at]!==words[length*2+at])atomicMismatch++; }
        if(kind==='self') for(let at=0;at<length;at++) {
          const id=words[at]&0x0fffffff;if(id<2)continue;
          const start=Math.floor(at/budget)*budget;
          const matching=Array.from(seeded.slice(start,start+budget)).find(word=>(word&0x0fffffff)===id)??0;
          if((words[at]>>>28)!==(matching>>>28))seedMismatch++;
        }
        read.unmap();
        if(kind==='self') {
          const resetEncoder=device.createCommandEncoder(),resetPass=resetEncoder.beginComputePass();
          resetPass.setPipeline(clear);resetPass.setBindGroup(0,group(clear,[a]));resetPass.dispatchWorkgroups(Math.ceil(length/64));
          resetPass.setPipeline(eager);resetPass.setBindGroup(0,group(eager,values(a)));resetPass.dispatchWorkgroups(Math.ceil(faceCount/64));resetPass.end();
          resetEncoder.copyBufferToBuffer(a,0,read,0,length*4);device.queue.submit([resetEncoder.finish()]);await read.mapAsync(GPUMapMode.READ);
          const resetWords=new Uint32Array(read.getMappedRange());
          for(let at=0;at<length;at++) if(resetWords[at]!== (words[at]&0x0fffffff))resetMismatch++;
          read.unmap();
        }
        records.push({kind,budget,count,candidateFaceCount:body.numTriangles,mismatch,seedMismatch,resetMismatch,atomicMismatch});read.destroy();[current,faces,clothFaces,old,nodes,ordered,a,b,...(atomicOut?[atomicOut]:[])].forEach(value=>value.destroy());
      }
    }
    device.destroy();return{records,errors};
  });
  console.info('GPU eager/lazy candidate identity',JSON.stringify(result));
  expect(result.errors).toEqual([]);expect(result.records.length).toBe(18);
  for(const record of result.records) { expect(record.mismatch,JSON.stringify(record)).toBe(0);expect(record.seedMismatch).toBe(0);expect(record.resetMismatch).toBe(0);expect(record.atomicMismatch).toBe(0); }
});

test('canonical finite material witnesses clear real sleeve folds and reject ambiguous source history', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  test.skip(!await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter()), 'WebGPU adapter unavailable');
  const result = await page.evaluate(async ({fixture,onset,neighbor,context}) => {
    const surfacePath='/packages/cloth-sim/src/webgpu/surfaceSelf.ts', shaderPath='/packages/cloth-sim/src/webgpu/shaders.ts';
    const configPath='/packages/cloth-sim/src/config.ts', guardPath='/packages/cloth-sim/src/collisionGuard.ts';
    const [surface,shaders,{ SIM_CONFIG },{ ClothCollisionGuard }]=await Promise.all([import(surfacePath),import(shaderPath),import(configPath),import(guardPath)]);
    const adapter=(await navigator.gpu.requestAdapter())!;
    const device=await adapter.requestDevice({ requiredLimits:{ maxStorageBuffersPerShaderStage:8 } });
    const errors:string[]=[];device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
    const buffers:GPUBuffer[]=[];
    const buffer=(data:ArrayBufferView,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST)=>{
      const b=device.createBuffer({ size:Math.max(16,data.byteLength),usage });
      device.queue.writeBuffer(b,0,data.buffer as ArrayBuffer,data.byteOffset,data.byteLength);buffers.push(b);return b;
    };
    const pipeline=async(code:string)=>{
      const module=device.createShaderModule({ code });const messages=await module.getCompilationInfo();
      errors.push(...messages.messages.filter(message=>message.type==='error').map(message=>message.message));
      return device.createComputePipelineAsync({ layout:'auto',compute:{ module,entryPoint:'main' } });
    };
    const group=(pipe:GPUComputePipeline,values:GPUBuffer[])=>device.createBindGroup({ layout:pipe.getBindGroupLayout(0),entries:values.map((value,binding)=>({ binding,resource:{ buffer:value } })) });
    const cfg={ ...SIM_CONFIG,simulationThickness:.001,maxSurfaceCorrection:.005 };
    const strict=await pipeline(surface.solveSelfSurfaceCollisionWGSL(cfg,false));
    const native=await pipeline(surface.solveSelfSurfaceCollisionWGSL(cfg,true));
    const gather=await pipeline(surface.gatherSelfSurfaceCorrectionsWGSL(cfg,2));
    const apply=await pipeline(shaders.applyCorrectionsWGSL());
    const reset=await pipeline(shaders.resetCorrectionsWGSL());
    const dropHalf=await pipeline(`@group(0) @binding(0) var<storage,read_write> words:array<atomic<u32>>;
      @compute @workgroup_size(1) fn main() { atomicAnd(&words[32],0x0fffffffu); }`);
    const output=[];
    const scenarios:{name:string;seed:number[];previous:number[];triangles:number[];pairs:number[][];strict:boolean;passes?:number;seedFlags?:number[];dropHalf?:boolean}[]=[
      { name:'real sleeve material history',seed:fixture.positions,previous:fixture.previousPositions,triangles:fixture.triangles,pairs:fixture.expectedUnsafePairs,strict:true },
      { name:'source zero material history',seed:fixture.positions,previous:fixture.positions,triangles:fixture.triangles,pairs:fixture.expectedUnsafePairs,strict:true }
    ];
    for (const order of [context.candidatePairs,context.candidatePairs.slice().reverse()]) scenarios.push({name:'multi-candidate independent owner history '+order[0][1],seed:context.positions,previous:context.previousPositions,triangles:context.triangles,pairs:order,strict:true});
    scenarios.push({name:'actual remote sleeve neighbor owning face',seed:neighbor.positions,previous:neighbor.previousPositions,triangles:neighbor.triangles,pairs:neighbor.candidatePairs,strict:true});
    const oldSourceDegenerate=neighbor.previousPositions.slice();
    const ownerIds=neighbor.triangles.slice(0,3);for(const id of ownerIds.slice(1))for(let axis=0;axis<3;axis++)oldSourceDegenerate[id*4+axis]=oldSourceDegenerate[ownerIds[0]*4+axis];
    scenarios.push({name:'source owning face old degenerate',seed:neighbor.positions,previous:oldSourceDegenerate,triangles:neighbor.triangles,pairs:[[0,2]],strict:true});
    scenarios.push({ name:'actual sewing onset',seed:onset.positions,previous:onset.previousPositions,triangles:onset.triangles,pairs:onset.expectedUnsafePairs,strict:true });
    scenarios.push({ name:'actual deeper retained pair seed',seed:onset.deepPositions,previous:onset.previousPositions,triangles:onset.triangles,pairs:onset.expectedUnsafePairs,strict:true,passes:2,dropHalf:true });
    scenarios.push({name:'source conflicting continued seed',seed:onset.deepPositions,previous:onset.previousPositions,triangles:onset.triangles.slice(0,8),pairs:[[0,1]],strict:true,seedFlags:[0x40000000,0x80000000]});
    scenarios.push({name:'source invalid continued seed',seed:onset.deepPositions,previous:onset.previousPositions,triangles:onset.triangles.slice(0,8),pairs:[[0,1]],strict:true,seedFlags:[0x40000000,0xc0000000]});
    const separated=onset.deepPositions.slice();for(const id of onset.triangles.slice(4,7))separated[id*4+2]+=.05;
    scenarios.push({name:'source separated continued seed',seed:separated,previous:separated,triangles:onset.triangles.slice(0,8),pairs:[[0,1]],strict:true,seedFlags:[0x40000000,0x40000000]});
    const jittered=fixture.positions.slice();for(const p of [0,1,2]) jittered[p*4+1]+=1.2e-7;
    scenarios.push({ name:'source one ULP material history',seed:fixture.positions,previous:jittered,triangles:fixture.triangles,pairs:fixture.expectedUnsafePairs,strict:true });
    const thin=[-.01,1.259,0,1,.01,1.279,0,1,0,1.269,1e-8,1,-.01,1.269,-.01,0,.01,1.269,-.01,0,0,1.269,.01,0];
    scenarios.push({ name:'source ill-conditioned material history',seed:thin,previous:thin,triangles:[0,1,2,0,3,4,5,0],pairs:[[0,1]],strict:true });
    const mixed=[-.03,.47,0,1,.03,.47,0,1,0,.53,0,1,.005,.49,-.02,1,.005,.59,-.02,1,.005,.49,.02,1];
    const mixedOld=mixed.slice();for(const id of [0,1,2])mixedOld[id*4+2]+=.002;for(const id of [3,4,5])mixedOld[id*4]+=.002;
    scenarios.push({name:'actual mixed owning faces opposite material sides',seed:mixed,previous:mixedOld,triangles:[0,1,2,0,3,4,5,0],pairs:[[0,1]],strict:true,passes:4});
    scenarios.push({name:'actual mixed owning faces retained source only',seed:mixed,previous:mixedOld,triangles:[0,1,2,0,3,4,5,0],pairs:[[0,1]],strict:true,passes:4,seedFlags:[0x10000000,0x10000000]});
    scenarios.push({name:'actual mixed owning faces retained target only',seed:mixed,previous:mixedOld,triangles:[0,1,2,0,3,4,5,0],pairs:[[0,1]],strict:true,passes:4,seedFlags:[0x80000000,0x80000000]});
    // Both current hits lie inside the same target face, with genuinely opposing transported
    // material histories. Explicit scratch resets must not accept a direction for this pair.
    const opposed=[-.03,.47,0,1,.03,.47,0,1,0,.53,0,1,-.1,.5,-.1,1,.1,.5,-.1,1,0,.5,.1,1];
    const opposedOld=opposed.slice();opposedOld[1]+=.004;opposedOld[5]-=.004;
    scenarios.push({name:'source genuine opposing owner history',seed:opposed,previous:opposedOld,triangles:[0,1,2,0,3,4,5,0],pairs:[[0,1]],strict:true});
    const free=[-.03,.47,0,1,.03,.47,0,1,0,.53,0,1,-.01,.5,-.01,0,.01,.5,-.01,0,0,.5,.01,0];
    for(const flipped of [false,true]) for(const reversed of [false,true]) {
      const moving=[0,1,2,1],fixed=[3,4,5,flipped?0x80000000:0];
      scenarios.push({ name:`authored layer ${flipped} reversed ${reversed}`,seed:free,previous:free,triangles:reversed?[...fixed,...moving]:[...moving,...fixed],pairs:[[0,1]],strict:true });
    }
    const oldDegenerate=free.slice();for(const p of [4,5]) oldDegenerate.splice(p*4,3,...oldDegenerate.slice(12,15));
    scenarios.push({ name:'authored layer false old degenerate',seed:free,previous:oldDegenerate,triangles:[0,1,2,1,3,4,5,0],pairs:[[0,1]],strict:true });
    for(const scenario of scenarios) {
      const seed=new Float32Array(scenario.seed),triangles=new Uint32Array(scenario.triangles),faceCount=triangles.length/4;
      const guard=new ClothCollisionGuard({ bodyPositions:[],bodyIndices:[],clothTriangles:triangles,particleCount:seed.length/4 });
      const candidates=new Int32Array(faceCount*32),at=new Uint32Array(faceCount);
      for(const [a,b]of scenario.pairs) { candidates[a*32+at[a]++]=(b+2)|(scenario.seedFlags?.[0]??0);candidates[b*32+at[b]++]=(a+2)|(scenario.seedFlags?.[1]??0); }
      const incident=new Int32Array(seed.length/4*3).fill(-1);
      for(let p=0;p<seed.length/4;p++) {
        incident[p*3]=0;let count=0;
        for(let face=0;face<faceCount;face++) if(Array.from(triangles.slice(face*4,face*4+3)).includes(p)) incident[p*3+1+count++]=face;
      }
      const positions=buffer(seed),faces=buffer(triangles),corrections=buffer(new Float32Array(faceCount*12));
      const accumulated=buffer(new Float32Array(seed.length)),pipe=scenario.strict?strict:native;
      const candidateBuffer=buffer(candidates);
      const solveBG=group(pipe,[positions,faces,candidateBuffer,buffer(new Float32Array(scenario.previous)),corrections,
        buffer(new Uint32Array(faceCount+1).fill(faceCount+1)),buffer(new Uint32Array([1,1])),buffer(new Float32Array(1)),buffer(new Int32Array([0,0,0,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST)]);
      const gatherBG=group(gather,[faces,buffer(incident),corrections,accumulated,positions]),applyBG=group(apply,[positions,accumulated]);
      const passes=scenario.passes??1,resetBG=group(reset,[accumulated]);
      const encoder=device.createCommandEncoder();
      const read=buffer(new Uint8Array(seed.byteLength*passes),GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
      const cacheRead=buffer(new Uint8Array(candidates.byteLength),GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
      for(let iteration=0;iteration<passes;iteration++) {
        const pass=encoder.beginComputePass();
        if(iteration===1&&scenario.dropHalf){pass.setPipeline(dropHalf);pass.setBindGroup(0,group(dropHalf,[candidateBuffer]));pass.dispatchWorkgroups(1);}
        for(const [current,bg]of [[pipe,solveBG],[gather,gatherBG],[apply,applyBG],[reset,resetBG]]as const) { pass.setPipeline(current);pass.setBindGroup(0,bg);pass.dispatchWorkgroups(1); }
        pass.end();encoder.copyBufferToBuffer(positions,0,read,iteration*seed.byteLength,seed.byteLength);
      }
      encoder.copyBufferToBuffer(candidateBuffer,0,cacheRead,0,candidates.byteLength);
      device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const snapshots=new Float32Array(read.getMappedRange().slice(0));read.unmap();
      const final=snapshots.slice((passes-1)*seed.length);
      let maximum=0,prior=seed;
      for(let iteration=0;iteration<passes;iteration++) {
        const next=snapshots.subarray(iteration*seed.length,(iteration+1)*seed.length);
        for(let p=0;p<seed.length;p+=4) maximum=Math.max(maximum,Math.hypot(next[p]-prior[p],next[p+1]-prior[p+1],next[p+2]-prior[p+2]));
        prior=next;
      }
      await cacheRead.mapAsync(GPUMapMode.READ);const cacheWords=Array.from(new Uint32Array(cacheRead.getMappedRange()));cacheRead.unmap();
      output.push({ name:scenario.name,cacheWords,initial:Array.from(seed),final:Array.from(final),before:guard.inspect(seed).selfCrossingPairCount,after:guard.inspect(final).selfCrossingPairCount,maximum });
    }
    await device.queue.onSubmittedWorkDone();buffers.forEach(b=>b.destroy());device.destroy();return { output,errors };
  },{fixture:sleeveFold,onset:sleeveOnset,neighbor:sleeveNeighbor,context:sleeveContext});
  console.info('GPU finite material witness controls',JSON.stringify(result));
  expect(result.errors).toEqual([]);
  expect(result.output[0].before).toBe(3);expect(result.output[0].after).toBe(0);
  for(const run of result.output.filter(run=>run.name.startsWith('actual'))) { expect(run.after,run.name).toBe(0); }
  for(const run of result.output.filter(run=>run.name.includes('conflicting')||run.name.includes('invalid continued'))) { expect(run.cacheWords[0]>>>30).toBe(3);expect(run.cacheWords[32]>>>30).toBe(3); }
  for(const run of result.output.filter(run=>run.name.startsWith('multi-candidate'))) {
    expect(run.cacheWords[32]>>>28,run.name).toBe(9);
    expect(run.final.slice(0,3).some((v,i)=>v!==run.initial[i]),run.name).toBe(true);
  }
  for(const run of result.output.filter(run=>run.name.startsWith('actual mixed'))) { expect(run.cacheWords[0]>>>28).toBe(9);expect(run.cacheWords[32]>>>28).toBe(9); }
  const separatedRun=result.output.find(run=>run.name==='source separated continued seed')!;expect(separatedRun.cacheWords[0]>>>30).toBe(0);expect(separatedRun.cacheWords[32]>>>30).toBe(0);
  expect(result.output[1].final).toEqual(result.output[1].initial);expect(result.output[1].after).toBe(3);
  for(const run of result.output) { expect(run.final.every(Number.isFinite)).toBe(true);expect(run.maximum).toBeLessThanOrEqual(.005); }
  for(const run of result.output.filter(run=>run.name.startsWith('source'))) expect(run.final,run.name).toEqual(run.initial);
  for(const run of result.output.filter(run=>run.name.startsWith('authored'))) {
    expect(run.final.slice(12)).toEqual(run.initial.slice(12));
    const direction=run.name.includes('layer true')?1:-1;
    expect(direction*(run.final[1]-run.initial[1])).toBeGreaterThan(0);
  }
});

test('finite two-sided cloth faces collide when all free particles miss the other centroid', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  test.skip(!await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter()), 'WebGPU adapter unavailable');
  const result = await page.evaluate(async () => {
    const enginePath = '/packages/cloth-sim/src/webgpu/engine.ts';
    const configPath = '/packages/cloth-sim/src/config.ts';
    const guardPath = '/packages/cloth-sim/src/collisionGuard.ts';
    const [{ ClothEngine }, { SIM_CONFIG }, { ClothCollisionGuard }] = await Promise.all([import(enginePath), import(configPath), import(guardPath)]);
    const adapter = (await navigator.gpu.requestAdapter())!;
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
    const errors: string[] = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const seed = new Float32Array([-.03, -.03, 0, 1, .03, -.03, 0, 1, 0, .03, 0, 1,
      -.01, 0, -.01, 0, .01, 0, -.01, 0, 0, 0, .01, 0]);
    for (let index = 1; index < seed.length; index += 4) seed[index] += .5;
    const incident = new Int32Array(12);
    for (let index = 0; index < 6; index++) incident[index * 2 + 1] = index < 3 ? 0 : 1;
    const sim = {
      particleCount: 6, positions: seed, arrangedPositions: seed.slice(), positions2d: new Float32Array(24), anchors: new Float32Array(24),
      stretchColors: [], bendColors: [], seams: new Int32Array(24).fill(-1), pieces: [],
      triangles: new Uint32Array([0, 1, 2, 0, 3, 4, 5, 0]), triangleCount: 2, particleLayers: new Uint32Array(6),
      neighborIndices: new Int32Array(48).fill(-1), incidentTriangles: incident, maxIncidentTrianglesPerParticle: 1,
      edgeRuns: new Map(), seamPairsBySeam: [], seamOrder: new Int32Array(24).fill(-1), stitchCount: 0, seamStitchRanges: [], assemblySteps: [], wireRuns: []
    };
    const runs: { surface: boolean; strictHistory: boolean; positions: number[]; finite: boolean; crossings: number }[] = [];
    for (const [surface, reversed, strictHistory] of [[false, false, false], [true, false, false], [true, true, false], [true, false, true]]) {
      const triangles = new Uint32Array([0, 1, 2, 0, 3, ...(reversed ? [5, 4] : [4, 5]), 0]);
      const guard = new ClothCollisionGuard({ bodyPositions: [], bodyIndices: [], clothTriangles: triangles, particleCount: 6 });
      const engine = new ClothEngine(device, { ...sim, triangles }, { positions: new Float32Array(), triangles: new Uint32Array(), numTriangles: 0 },
        { ...SIM_CONFIG, gravity: [0, 0, 0], subSteps: 1, deltaT: .016, nearDamping: 0,
          handleExternalCollisions: false, handleSelfSurfaceCollisions: surface,
          seamIterations: reversed || strictHistory ? 8 : 1,substepContactIterations: reversed || strictHistory ? 4 : 1,finalContactIterations: reversed || strictHistory ? 4 : 1 },{ strictSurfaceHistory: strictHistory });
      engine.resetPositions(seed);
      let positions = seed;
      for (let frame = 0; frame < 20; frame++) positions = await engine.step();
      runs.push({ surface, strictHistory, positions: Array.from(positions), finite: Array.from(positions).every(Number.isFinite), crossings: guard.inspect(positions).selfCrossingPairCount });
      engine.dispose();
    }
    device.destroy();
    return { runs, errors, limit: device.limits.maxStorageBuffersPerShaderStage, seed: Array.from(seed) };
  });
  console.info("GPU finite self warm control", JSON.stringify(result));
  expect(result.errors).toEqual([]);
  expect(result.limit).toBe(8);
  expect(result.runs.every(run => run.finite)).toBe(true);
  expect(result.runs[0].positions).toEqual(result.seed); // Particle-only centroid gather misses this intersection.
  expect(result.runs[0].crossings).toBe(1);
  for (const run of result.runs.slice(1).filter(run=>!run.strictHistory)) {
    expect(run.crossings).toBe(0);
    for (const offset of [1, 5, 9]) expect(run.positions[offset]).toBeLessThan(.496);
    expect(run.positions.slice(12)).toEqual(result.seed.slice(12)); // Both fixed-face windings stay fixed.
  }
  expect(result.runs[3].positions).toEqual(result.seed);expect(result.runs[3].crossings).toBe(1);
});

test('Jacobi sewing converges paired, unequal-mass, fixed and multiply linked particles', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  test.skip(!await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter()), 'WebGPU adapter unavailable');
  const result = await page.evaluate(async () => {
    const shaderPath = '/packages/cloth-sim/src/webgpu/shaders.ts';
    const configPath = '/packages/cloth-sim/src/config.ts';
    const [{ seamWGSL, applyCorrectionsWGSL }, { SIM_CONFIG, seamMaxDisplacementSq }] = await Promise.all([import(shaderPath), import(configPath)]);
    const adapter = (await navigator.gpu.requestAdapter())!;
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
    const errors: string[] = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const shader = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: seamWGSL(SIM_CONFIG, seamMaxDisplacementSq(SIM_CONFIG)) }), entryPoint: 'main' } });
    const apply = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: applyCorrectionsWGSL() }), entryPoint: 'main' } });
    const runs: { name: string; initial: number[]; first: number[]; final: number[] }[] = [];
    for (const [name, masses, chain] of [
      ['equal', [1, 1], false], ['unequal', [2, 1], false], ['fixed', [0, 1], false], ['chain', [1, 1, 1, 1], true]
    ] as const) {
      const count = masses.length, seed = new Float32Array(count * 4), seams = new Int32Array(count * 4).fill(-1), order = new Int32Array(count * 4).fill(-1);
      for (let particle = 0; particle < count; particle++) { seed[particle * 4] = particle * .0006; seed[particle * 4 + 1] = .5; seed[particle * 4 + 3] = masses[particle]; }
      for (let particle = 0; particle < count; particle++) {
        const links = chain ? [particle - 1, particle + 1].filter(index => index >= 0 && index < count) : [1 - particle];
        links.forEach((index, slot) => { seams[particle * 4 + slot] = index; order[particle * 4 + slot] = 0; });
      }
      const buffer = (data: ArrayBufferView, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) => {
        const target = device.createBuffer({ size: data.byteLength, usage });
        device.queue.writeBuffer(target, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength); return target;
      };
      const positions = buffer(seed, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
      const corrections = buffer(new Float32Array(count * 4)), links = buffer(seams), orders = buffer(order), gate = buffer(new Int32Array([1, 0, 0, 0]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const group = (pipe: GPUComputePipeline, buffers: GPUBuffer[]) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: buffers.map((target, binding) => ({ binding, resource: { buffer: target } })) });
      const sewing = group(shader, [positions, links, corrections, orders, gate]), application = group(apply, [positions, corrections]);
      const readback = device.createBuffer({ size: seed.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      let first: number[] = [], final: number[] = [];
      for (let iteration = 0; iteration < 64; iteration++) {
        device.queue.writeBuffer(corrections, 0, new Float32Array(count * 4));
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(shader); pass.setBindGroup(0, sewing); pass.dispatchWorkgroups(1);
        pass.setPipeline(apply); pass.setBindGroup(0, application); pass.dispatchWorkgroups(1); pass.end();
        encoder.copyBufferToBuffer(positions, 0, readback, 0, seed.byteLength); device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ); final = Array.from(new Float32Array(readback.getMappedRange().slice(0))); readback.unmap();
        if (iteration === 0) first = final.slice();
      }
      runs.push({ name, initial: Array.from(seed), first, final });
      for (const target of [positions, corrections, links, orders, gate, readback]) target.destroy();
    }
    device.destroy(); return { runs, errors };
  });
  expect(result.errors).toEqual([]);
  console.info('GPU sewing primitive', JSON.stringify(result.runs.map(run => ({ name: run.name, first: run.first.filter((_, index) => index % 4 === 0), final: run.final.filter((_, index) => index % 4 === 0) }))));
  for (const run of result.runs) {
    expect(run.final.every(Number.isFinite)).toBe(true);
    const points = run.final.filter((_, index) => index % 4 === 0);
    expect(Math.max(...points) - Math.min(...points), `${run.name} sewing remains open`).toBeLessThan(1e-7);
    expect(run.final.filter((_, index) => index % 4 === 1)).toEqual(run.initial.filter((_, index) => index % 4 === 1));
  }
  expect(result.runs[0].first[0]).toBeCloseTo(.0003, 7);
  expect(result.runs[0].first[4]).toBeCloseTo(.0003, 7);
  expect(result.runs[1].first[0]).toBeCloseTo(.0004, 7);
  expect(result.runs[1].first[4]).toBeCloseTo(.0004, 7);
  expect(result.runs[2].first[0]).toBe(0);
  expect(result.runs[2].first[4]).toBeCloseTo(0, 7);
});

test('actual pending GPU steps cannot overwrite reset or disposal state', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  test.skip(!await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter()), 'WebGPU adapter unavailable');
  const result = await page.evaluate(async () => {
    const simulationPath = '/packages/cloth-sim/src/simulator.ts';
    const { ClothSimulation, packBodyMesh } = await import(simulationPath);
    const adapter = (await navigator.gpu.requestAdapter())!;
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
    const errors: string[] = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const positions = new Float32Array([1.97, .47, 0, 1, 2.03, .47, 0, 1, 2, .53, 0, 1]);
    const arranged = positions.slice(); for (let offset = 0; offset < arranged.length; offset += 4) arranged[offset] += .1;
    const targets = new Float32Array(12); targets[0] = positions[1]; targets[1] = 1;
    const simData = {
      particleCount: 3, positions, arrangedPositions: arranged, positions2d: new Float32Array(12), anchors: new Float32Array(12),
      stretchColors: [], bendColors: [], seams: new Int32Array(12).fill(-1), pieces: [],
      triangles: new Uint32Array([0, 1, 2, 0]), triangleCount: 1, particleLayers: new Uint32Array(3),
      neighborIndices: new Int32Array(24).fill(-1), incidentTriangles: new Int32Array([0, 0, 0, 0, 0, 0]), maxIncidentTrianglesPerParticle: 1,
      edgeRuns: new Map(), seamPairsBySeam: [], seamOrder: new Int32Array(12).fill(-1), stitchCount: 0, seamStitchRanges: [], assemblySteps: [], wireRuns: [],
      assemblySupport: { revision: 3, activeOnStart: true, targets, groups: [{ id: 'waist', kind: 'waist', particles: [0], seamPairs: [], releaseGapM: .006 }] }
    };
    const body = packBodyMesh(new Float32Array([-.1, .4, -.1, .1, .4, -.1, .1, .6, -.1, -.1, .6, -.1,
      -.1, .4, .1, .1, .4, .1, .1, .6, .1, -.1, .6, .1]), new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7
    ]));
    const simulation = new ClothSimulation(device, { simData, body, collisionSafety: true });
    const pending = simulation.step();
    simulation.resetToArranged();
    const resetSupport = simulation.captureAssemblySupport();
    const staleOutput = await pending;
    const afterReset = Array.from(simulation.positions), afterResetSupport = simulation.captureAssemblySupport();
    const safeAfterReset = simulation.safetyReport?.safe;
    const advanced = await simulation.step();
    const acceptedBeforeDispose = Array.from(simulation.positions);
    const pendingDispose = simulation.step(); simulation.dispose();
    const staleDisposedOutput = await pendingDispose;
    const disposedOutput = await simulation.step();
    await device.queue.onSubmittedWorkDone();
    device.destroy();
    return { errors, arranged: Array.from(arranged), staleOutput: Array.from(staleOutput), afterReset,
      resetSupport, afterResetSupport, safeAfterReset, advanced: Array.from(advanced), acceptedBeforeDispose,
      staleDisposedOutput: Array.from(staleDisposedOutput), disposedOutput: Array.from(disposedOutput) };
  });
  expect(result.errors).toEqual([]);
  expect(result.staleOutput).toEqual(result.arranged);
  expect(result.afterReset).toEqual(result.arranged);
  expect(result.safeAfterReset).toBe(true);
  expect(result.afterResetSupport).toEqual(result.resetSupport);
  expect(result.afterResetSupport?.elapsedSeconds).toBe(0);
  expect(result.advanced.every(Number.isFinite)).toBe(true);
  for (const offset of [0, 4, 8]) expect(result.advanced[offset]).toBe(result.arranged[offset]);
  expect(result.advanced[5]).toBeLessThan(result.arranged[5]); // The new simulation still responds to gravity.
  expect(result.staleDisposedOutput).toEqual(result.acceptedBeforeDispose);
  expect(result.disposedOutput).toEqual(result.acceptedBeforeDispose);
});


test('bottom-up finite BVH bounds match the complete subtree refit byte for byte', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  test.skip(!await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter()), 'WebGPU adapter unavailable');
  const results = await page.evaluate(async () => {
    const shaderPath = '/packages/cloth-sim/src/webgpu/surfaceSelf.ts';
    const planPath = '/packages/cloth-sim/src/webgpu/surfaceRefitPlan.ts';
    const bvhPath = '/packages/cloth-sim/src/webgpu/bodySurfaceBroadphase.ts';
    const [{ refitSurfaceBVHWGSL, refitSurfaceLeavesWGSL, refitSurfaceParentsWGSL }, { buildSurfaceRefitPlan }, { buildBodySurfaceBVH }] =
      await Promise.all([import(shaderPath), import(planPath), import(bvhPath)]);
    const adapter = (await navigator.gpu.requestAdapter())!;
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
    const errors: string[] = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const pipe = (code: string) => device.createComputePipeline({ layout: 'auto', compute: {
      module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const oldPipe = pipe(refitSurfaceBVHWGSL()), leafPipe = pipe(refitSurfaceLeavesWGSL()), parentPipe = pipe(refitSurfaceParentsWGSL());
    const buffer = (data: Float32Array | Uint32Array, usage = GPUBufferUsage.STORAGE) => {
      const result = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(result, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength); return result;
    };
    const group = (pipeline: GPUComputePipeline, buffers: GPUBuffer[]) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((value, binding) => ({ binding, resource: { buffer: value } })) });
    const cases: { rows: number; columns: number; signedZero: boolean }[] = [
      { rows: 2, columns: 2, signedZero: true }, { rows: 4, columns: 6, signedZero: true },
      { rows: 65, columns: 81, signedZero: false }
    ];
    const records: { faces: number; nodes: number; levels: number; mismatchedWords: number; oldMs: number; newMs: number }[] = [];
    for (const item of cases) {
      const seed = new Float32Array(item.rows * item.columns * 4);
      for (let y = 0; y < item.rows; y++) for (let x = 0; x < item.columns; x++) {
        const at = (y * item.columns + x) * 4;
        seed.set([x * .01, y * .01, Math.sin(x * .3) * Math.cos(y * .4) * .004, 1], at);
      }
      if (item.signedZero) for (let at = 0; at < seed.length; at += 4) seed[at + 2] = at % 8 ? -0 : 0;
      const indices: number[] = [];
      for (let y = 0; y < item.rows - 1; y++) for (let x = 0; x < item.columns - 1; x++) {
        const at = y * item.columns + x;
        indices.push(at, at + 1, at + item.columns, 0, at + 1, at + item.columns + 1, at + item.columns, 0);
      }
      const triangles = new Uint32Array(indices), bvh = buildBodySurfaceBVH({ positions: seed, triangles, numTriangles: indices.length / 4 });
      const plan = buildSurfaceRefitPlan(bvh, device.limits.minUniformBufferOffsetAlignment);
      const current = seed.slice(), previous = seed.slice();
      if (!item.signedZero) for (let at = 0; at < seed.length; at += 4) {
        current[at] += Math.sin(at * .09) * .03; previous[at + 1] -= Math.cos(at * .06) * .02;
      }
      const oldNodes = buffer(bvh.nodes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const newNodes = buffer(bvh.nodes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const ordered = buffer(bvh.triangleIds), faces = buffer(triangles), now = buffer(current), before = buffer(previous), ranges = buffer(bvh.ranges);
      const parentIds = buffer(plan.parentNodeIds), uniforms = buffer(plan.uniforms, GPUBufferUsage.UNIFORM);
      const oldGroup = group(oldPipe, [oldNodes, ordered, faces, now, before, ranges]);
      const leafGroup = group(leafPipe, [newNodes, ordered, faces, now, before, ranges]);
      const parentGroups = plan.levels.map((level: { count: number; uniformOffset: number }) => ({ count: level.count,
        bindGroup: device.createBindGroup({ layout: parentPipe.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: newNodes } }, { binding: 1, resource: { buffer: parentIds } },
          { binding: 2, resource: { buffer: uniforms, offset: level.uniformOffset, size: 16 } }
        ] }) }));
      const read = device.createBuffer({ size: bvh.nodes.byteLength * 2, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const run = async (bottomUp: boolean) => {
        const started = performance.now(), encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(bottomUp ? leafPipe : oldPipe); pass.setBindGroup(0, bottomUp ? leafGroup : oldGroup);
        pass.dispatchWorkgroups(Math.ceil(bvh.nodeCount / 64));
        if (bottomUp) {
          pass.setPipeline(parentPipe);
          for (const level of parentGroups) { pass.setBindGroup(0, level.bindGroup); pass.dispatchWorkgroups(Math.ceil(level.count / 64)); }
        }
        pass.end(); device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
        return performance.now() - started;
      };
      const oldMs = await run(false), newMs = await run(true);
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(oldNodes, 0, read, 0, bvh.nodes.byteLength);
      encoder.copyBufferToBuffer(newNodes, 0, read, bvh.nodes.byteLength, bvh.nodes.byteLength);
      device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(read.getMappedRange()), count = bvh.nodes.length;
      let mismatchedWords = 0;
      for (let at = 0; at < count; at++) if (words[at] !== words[count + at]) mismatchedWords++;
      read.unmap();
      records.push({ faces: indices.length / 4, nodes: bvh.nodeCount, levels: plan.levels.length, mismatchedWords, oldMs, newMs });
      for (const value of [oldNodes, newNodes, ordered, faces, now, before, ranges, parentIds, uniforms, read]) value.destroy();
    }
    const limit = device.limits.maxStorageBuffersPerShaderStage; device.destroy();
    return { records, errors, limit };
  });
  expect(results.errors).toEqual([]);
  expect(results.limit).toBe(8);
  expect(results.records.length).toBe(3);
  for (const record of results.records) expect(record.mismatchedWords).toBe(0);
  console.log(JSON.stringify({ bottomUpRefit: results.records }));
});
