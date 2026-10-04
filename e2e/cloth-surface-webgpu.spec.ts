import { expect, test } from '@playwright/test';

test('body surface blocks a cloth face even when its three particles remain outside', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  test.skip(!await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter()), 'A WebGPU adapter is unavailable');
  const result = await page.evaluate(async () => {
    const enginePath = '/packages/cloth-sim/src/webgpu/engine.ts';
    const simulatorPath = '/packages/cloth-sim/src/simulator.ts';
    const configPath = '/packages/cloth-sim/src/config.ts';
    const guardPath = '/packages/cloth-sim/src/collisionGuard.ts';
    const [{ ClothEngine }, { packBodyMesh }, { SIM_CONFIG }, { ClothCollisionGuard }] = await Promise.all([import(enginePath), import(simulatorPath), import(configPath), import(guardPath)]);
    const adapter = (await navigator.gpu.requestAdapter())!;
    const device = await adapter.requestDevice(); // Default baseline limits, including eight storage buffers.
    const errors: string[] = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const vertices = [-.01, -.01, -.01, .01, -.01, -.01, .01, .01, -.01, -.01, .01, -.01,
      -.01, -.01, .01, .01, -.01, .01, .01, .01, .01, -.01, .01, .01];
    const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
    for (let index = 1; index < vertices.length; index += 3) vertices[index] += .5;
    const body = packBodyMesh(new Float32Array(vertices), new Uint32Array(faces));
    const seed = new Float32Array([-.03, -.03, 0, 1, .03, -.03, 0, 1, 0, .03, 0, 1]);
    for (let index = 1; index < seed.length; index += 4) seed[index] += .5;
    const sim = {
      particleCount: 3, positions: seed, arrangedPositions: seed.slice(), positions2d: new Float32Array(12), anchors: new Float32Array(12),
      stretchColors: [], bendColors: [], seams: new Int32Array(12).fill(-1), pieces: [],
      triangles: new Uint32Array([0, 1, 2, 0]), triangleCount: 1, particleLayers: new Uint32Array(3),
      neighborIndices: new Int32Array(24).fill(-1), incidentTriangles: new Int32Array([0, 0, 0, 0, 0, 0]), maxIncidentTrianglesPerParticle: 1,
      edgeRuns: new Map(), seamPairsBySeam: [], seamOrder: new Int32Array(12).fill(-1), stitchCount: 0, seamStitchRanges: [], assemblySteps: [], wireRuns: []
    };
    const guard = new ClothCollisionGuard({ bodyPositions: vertices, bodyIndices: faces, clothTriangles: sim.triangles, particleCount: 3 });
    const runs: { surface: boolean; thickness:number; positions: number[]; finite: boolean; crossings: number; inside: number }[] = [];
    for (const {surface,thickness} of [{surface:false,thickness:.005},{surface:true,thickness:.005},{surface:true,thickness:.001}]) {
      const engine = new ClothEngine(device, sim, body, { ...SIM_CONFIG, gravity: [0, 0, 0], subSteps: 1, deltaT: .016,
        nearDamping: 0, simulationThickness:thickness, handleSelfCollisions: false, handleExternalSurfaceCollisions: surface, externalCollisionGatherInterval: 1 });
      engine.resetPositions(seed);
      let positions = seed;
      for (let step = 0; step < 20; step++) positions = await engine.step();
      const geometry = guard.inspect(positions);
      runs.push({ surface, thickness, positions: Array.from(positions), finite: Array.from(positions).every(Number.isFinite), crossings: geometry.bodyCrossingTriangleCount, inside: geometry.insideParticleCount });
      engine.dispose();
    }
    device.destroy();
    return { runs, errors };
  });
  expect(result.errors).toEqual([]);
  expect(result.runs.every(run => run.finite)).toBe(true);
  const particleOnly = result.runs[0].positions;
  for (const index of [2, 6, 10]) expect(particleOnly[index]).toBeCloseTo(0, 7);
  expect(result.runs[0].inside).toBe(0); // All particles are individually outside the cube.
  expect(result.runs[0].crossings).toBe(1); // Its finite face still crosses the cube.
  expect(result.runs[1].inside).toBe(0);
  expect(result.runs[1].crossings).toBe(0);
  expect(result.runs[2].inside).toBe(0);
  expect(result.runs[2].crossings).toBe(0); // One-mm physical clearance retains a five-mm recovery bound.
});

test('perpendicular body edges resolve against a finite cloth face on the eight-buffer baseline', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  test.skip(!await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter()), 'A WebGPU adapter is unavailable');
  const result = await page.evaluate(async () => {
    const shaderPath = '/packages/cloth-sim/src/webgpu/shaders.ts';
    const configPath = '/packages/cloth-sim/src/config.ts';
    const [{ solveExternalSurfaceCollisionWGSL }, { SIM_CONFIG }] = await Promise.all([import(shaderPath), import(configPath)]);
    const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const errors: string[] = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const seed = new Float32Array([-.03,.49,0,1, .03,.49,0,1, 0,.57,0,1]);
    // The body face is perpendicular to cloth and wholly inside its planar footprint. Only
    // body-edge -> cloth-face tests hit; none of the three cloth edges reach the finite body face.
    const body = new Float32Array([0,.5,.01,0, 0,.5,-.01,0, 0,.56,0,0]);
    const buffers: GPUBuffer[] = [];
    const buffer = (array: ArrayBufferView, extra = 0) => {
      const value = device.createBuffer({ size: array.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extra });
      device.queue.writeBuffer(value, 0, array.buffer, array.byteOffset, array.byteLength);
      buffers.push(value); return value;
    };
    const positions = buffer(seed), clothTriangles = buffer(new Uint32Array([0,1,2,0]));
    const candidates = buffer(new Int32Array([2]));
    const bodyTriangles = buffer(new Uint32Array([0,1,2,0]));
    const bodyPositions = buffer(body);
    const corrections = buffer(new Float32Array(12), GPUBufferUsage.COPY_SRC);
    const previous = buffer(seed);
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: {
      module: device.createShaderModule({ code: solveExternalSurfaceCollisionWGSL({ ...SIM_CONFIG, numExternalSurfaceCollisionConstraints: 1, simulationThickness:.001 }) }), entryPoint: 'main'
    } });
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [positions,clothTriangles,candidates,bodyTriangles,bodyPositions,corrections,previous]
      .map((value,binding) => ({ binding, resource: { buffer: value } })) });
    const readback = device.createBuffer({ size:48, usage:GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0,bind); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(corrections,0,readback,0,48); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = Array.from(new Float32Array(readback.getMappedRange().slice(0)));
    readback.unmap(); readback.destroy(); buffers.forEach(value => value.destroy()); device.destroy();
    return { result, errors };
  });
  expect(result.errors).toEqual([]);
  expect(result.result.every(Number.isFinite)).toBe(true);
  expect(Math.max(result.result[2],result.result[6],result.result[10])).toBeGreaterThan(.0049);
  for (let corner=0; corner<3; corner++) {
    expect(result.result[corner*4]).toBeCloseTo(0,7);
    expect(result.result[corner*4+1]).toBeCloseTo(0,7);
    expect(result.result[corner*4+2]).toBeGreaterThan(0);
    expect(result.result[corner*4+2]).toBeLessThanOrEqual(.005001);
  }
});

test('a finite outside-to-outside cloth edge clears a skin crease without endpoint-plane inflation', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  test.skip(!await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter()), 'A WebGPU adapter is unavailable');
  const result = await page.evaluate(async () => {
    const shaderPath = '/packages/cloth-sim/src/webgpu/shaders.ts', configPath = '/packages/cloth-sim/src/config.ts';
    const guardPath = '/packages/cloth-sim/src/collisionGuard.ts', threePath = '/node_modules/three/build/three.module.js';
    const [{ solveExternalSurfaceCollisionWGSL, applyCorrectionsWGSL }, { SIM_CONFIG }, { ClothCollisionGuard }, T] =
      await Promise.all([import(shaderPath), import(configPath), import(guardPath), import(threePath)]);
    // Exact right-underarm feature from the fresh, fully released dress: all three particles
    // are outside skin, but edge 1→2 passes through the finite crease between these two faces.
    const seed = new Float32Array([-.20373763144016266,1.3090828657150269,-.05874394252896309,1,
      -.20538486540317535,1.3170523643493652,-.06452830135822296,1,
      -.20432256162166595,1.3145103454589844,-.045600589364767075,1]);
    const skin = new Float32Array([-.20373286306858063,1.3218731880187988,-.072333924472332,
      -.20067960023880005,1.3111940622329712,-.06530429422855377,
      -.20615321397781372,1.3166494369506836,-.058961573988199234,
      -.20324921607971191,1.3174095153808594,-.04957716539502144]);
    const body = new Float32Array(16); for (let index=0;index<4;index++) body.set(skin.subarray(index*3,index*3+3),index*4);
    const faces = new Uint32Array([0,1,2,3,2,1]), cloth = new Uint32Array([0,1,2,0]);
    const guard = new ClothCollisionGuard({ bodyPositions: skin, bodyIndices: faces, clothTriangles: cloth, particleCount: 3 });
    const initialCrossings = guard.inspect(seed).bodyCrossingTriangleCount;
    const vector = (array:Float32Array,index:number,stride:number) => new T.Vector3().fromArray(array,index*stride);
    const edgeStart=vector(seed,1,4), edgeEnd=vector(seed,2,4), direction=edgeEnd.clone().sub(edgeStart);
    const ray=new T.Ray(edgeStart,direction.clone().normalize()), hit=new T.Vector3(), parameters:number[]=[];
    const triangles=[new T.Triangle(...[0,1,2].map(index=>vector(skin,index,3))),new T.Triangle(...[3,2,1].map(index=>vector(skin,index,3)))];
    const minimumVertexClearance=Math.min(...[0,1,2].map(index=>Math.min(...triangles.map(triangle=>{
      const point=vector(seed,index,4);return triangle.closestPointToPoint(point,new T.Vector3()).distanceTo(point);
    }))));
    const clothFace=new T.Triangle(...[0,1,2].map(index=>vector(seed,index,4))), plane=clothFace.getPlane(new T.Plane());
    const bodyVertexProjectionsInside=[0,1,2,3].filter(index=>clothFace.containsPoint(plane.projectPoint(vector(skin,index,3),new T.Vector3()))).length;
    for(const triangle of triangles) { ray.intersectTriangle(triangle.a,triangle.b,triangle.c,false,hit);parameters.push(hit.distanceTo(edgeStart)/direction.length()); }
    const parameter=(parameters[0]+parameters[1])/2, midpoint=edgeStart.clone().addScaledVector(direction,parameter);
    const nearest=triangles.map(triangle=>triangle.closestPointToPoint(midpoint,new T.Vector3())).sort((a,b)=>a.distanceToSquared(midpoint)-b.distanceToSquared(midpoint))[0];
    const escape=nearest.clone().sub(midpoint), requiredMovement=.001+escape.length();escape.normalize();
    const device=await (await navigator.gpu.requestAdapter())!.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:8}});
    const errors:string[]=[];device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
    const buffers:GPUBuffer[]=[];
    const buffer=(array:ArrayBufferView,extra=0)=>{const value=device.createBuffer({size:array.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|extra});device.queue.writeBuffer(value,0,array.buffer,array.byteOffset,array.byteLength);buffers.push(value);return value;};
    const positions=buffer(seed,GPUBufferUsage.COPY_SRC), corrections=buffer(new Float32Array(12)), previous=buffer(seed);
    const constraints=buffer(cloth), candidates=buffer(new Int32Array([2,3])), bodyFaces=buffer(new Uint32Array([0,1,2,0,3,2,1,0])), bodyPositions=buffer(body);
    const pipeline=(code:string)=>device.createComputePipeline({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}});
    const solve=pipeline(solveExternalSurfaceCollisionWGSL({...SIM_CONFIG,simulationThickness:.001,numExternalSurfaceCollisionConstraints:2})), apply=pipeline(applyCorrectionsWGSL());
    const group=(pipe:GPUComputePipeline,values:GPUBuffer[])=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:values.map((value,binding)=>({binding,resource:{buffer:value}}))});
    const solveGroup=group(solve,[positions,constraints,candidates,bodyFaces,bodyPositions,corrections,previous]), applyGroup=group(apply,[positions,corrections]);
    const readback=device.createBuffer({size:48,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});let first:number[]=[], final:number[]=[];
    for(let iteration=0;iteration<32;iteration++) {const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(solve);pass.setBindGroup(0,solveGroup);pass.dispatchWorkgroups(1);pass.setPipeline(apply);pass.setBindGroup(0,applyGroup);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(positions,0,readback,0,48);device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);final=Array.from(new Float32Array(readback.getMappedRange().slice(0)));readback.unmap();if(!iteration)first=final.slice();}
    const chordMovement=new T.Vector3().fromArray(first,4).sub(edgeStart).multiplyScalar(1-parameter)
      .add(new T.Vector3().fromArray(first,8).sub(edgeEnd).multiplyScalar(parameter)).dot(escape);
    const finalCrossings=guard.inspect(new Float32Array(final)).bodyCrossingTriangleCount;
    const largestFirstStep=Math.max(...[0,1,2].map(index=>new T.Vector3().fromArray(first,index*4).distanceTo(vector(seed,index,4))));
    await device.queue.onSubmittedWorkDone();readback.destroy();buffers.forEach(value=>value.destroy());device.destroy();
    return {errors,first,final,initialCrossings,finalCrossings,chordMovement,requiredMovement,largestFirstStep,minimumVertexClearance,bodyVertexProjectionsInside};
  });
  expect(result.errors).toEqual([]);
  expect(result.initialCrossings).toBe(1);
  expect(result.minimumVertexClearance).toBeGreaterThan(.000999);
  expect(result.bodyVertexProjectionsInside).toBe(0);
  expect(result.first.every(Number.isFinite)).toBe(true); expect(result.final.every(Number.isFinite)).toBe(true);
  expect(result.requiredMovement).toBeGreaterThan(.0015); expect(result.requiredMovement).toBeLessThan(.0016);
  expect(result.chordMovement).toBeGreaterThan(result.requiredMovement-.00001);
  expect(result.largestFirstStep).toBeLessThanOrEqual(.005001);
  expect(result.finalCrossings).toBe(0);
});
