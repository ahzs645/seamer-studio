import { expect, test } from '@playwright/test';

test('actual cloth WGSL finds finite triangle contacts and closest points on faces, edges and vertices', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  test.skip(!await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter()), 'A WebGPU adapter is unavailable');
  const result = await page.evaluate(async () => {
    const shaderPath = '/packages/cloth-sim/src/webgpu/shaders.ts';
    const configPath = '/packages/cloth-sim/src/config.ts';
    const shaders = await import(shaderPath);
    const { SIM_CONFIG } = await import(configPath);
    const adapter = (await navigator.gpu.requestAdapter())!;
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const storage = (values: Float32Array | Int32Array | Uint32Array) => {
      const buffer = device.createBuffer({ size: Math.max(16, values.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, values.buffer as ArrayBuffer, values.byteOffset, values.byteLength);
      return buffer;
    };
    const execute = async (code: string, buffers: GPUBuffer[], count: number, output: GPUBuffer, bytes: number, integers = false) => {
      const module = device.createShaderModule({ code });
      const compilation = await module.getCompilationInfo();
      errors.push(...compilation.messages.filter(message => message.type === 'error').map(message => message.message));
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(count); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const mapped = readback.getMappedRange().slice(0);
      const values = Array.from(integers ? new Uint32Array(mapped) : new Float32Array(mapped));
      readback.unmap(); readback.destroy(); buffers.forEach(buffer => buffer.destroy());
      return values;
    };
    const triangle = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    const cases = [
      { triangle, point: [.25, .25, .2], expected: [.25, .25, 0] },
      { triangle, point: [.25, .25, -.2], expected: [.25, .25, 0] },
      { triangle, point: [.5, -.2, .2], expected: [.5, 0, 0] },
      { triangle, point: [.8, .8, -.1], expected: [.5, .5, 0] },
      { triangle, point: [-.2, -.2, .1], expected: [0, 0, 0] },
      { triangle, point: [1.3, -.1, 0], expected: [1, 0, 0] },
      { triangle: [[2, 3, 4], [3, 3, 4], [2, 4, 4]], point: [2.2, 3.3, 5], expected: [2.2, 3.3, 4] },
      { triangle: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], point: [.4, .2, 0], expected: [.4, 0, 0] },
      { triangle: [[2, 3, 4], [2, 3, 4], [2, 3, 4]], point: [5, 6, 7], expected: [2, 3, 4] }
    ];
    const queries: { solver: string; expected: number[][]; actual: number[][] }[] = [];
    for (const solver of ['body', 'self']) {
      const source = solver === 'body' ? shaders.solveExternalCollisionWGSL(SIM_CONFIG, 0) : shaders.solveSelfCollisionWGSL(SIM_CONFIG);
      const start = source.indexOf('fn getClosestPointOnSegment');
      const end = source.indexOf(solver === 'body' ? 'fn computeClothNormal' : 'fn computeBarycentric', start);
      const helper = source.slice(start, end);
      const input = storage(new Float32Array(cases.flatMap(entry => [...entry.triangle, entry.point].flatMap(v => [...v, 0]))));
      const output = storage(new Float32Array(cases.length * 4));
      const code = `@group(0) @binding(0) var<storage,read> input: array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output: array<vec4f>;
${helper}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
let offset=id.x*4u; output[id.x]=vec4f(getClosestPointOnTriangle(input[offset].xyz,input[offset+1u].xyz,input[offset+2u].xyz,input[offset+3u].xyz),0.0);
}`;
      const values = await execute(code, [input, output], cases.length, output, cases.length * 16);
      queries.push({ solver, expected: cases.map(entry => entry.expected), actual: cases.map((_, index) => values.slice(index * 4, index * 4 + 3)) });
    }
    // Run the complete body-contact shader, rather than reproducing its contact policy in JS.
    // The last position lies further outside along the normal, so every particle moves inward.
    const positions = [[.25, .25, .002], [.25, .25, -.002], [2, 2, .002], [.5, -.02, .002], [.5, -.002, .002], [.25, .25, -.02], [.5, -.02, -.02]];
    const buffers = [
      storage(new Float32Array(positions.flatMap(p => [...p, 1]))),
      storage(new Float32Array(positions.length * 4)),
      storage(new Int32Array(positions.flatMap(() => [2, ...Array(SIM_CONFIG.numExternalCollisionConstraintsPerParticle - 1).fill(0)]))),
      storage(new Uint32Array([0, 1, 2, 0])),
      storage(new Float32Array(triangle.flatMap(p => [...p, 0]))),
      storage(new Float32Array(positions.flatMap((p, index) => [p[0], p[1], index >= 5 ? .02 : p[2] + .001, 1]))),
      storage(new Uint32Array([0, 1, 2, 0])),
      storage(new Int32Array(positions.length))
    ];
    const contacts = await execute(shaders.solveExternalCollisionWGSL({ ...SIM_CONFIG, externalCollisionFriction: 0 }, 0), buffers, 1, buffers[1], positions.length * 16);

    // Deliberately collide hash cells, saturate the candidate budget with distant surfaces,
    // then present the nearest surfaces last. Hash traversal order must not hide them.
    const centers = [...Array.from({ length: 40 }, (_, index) => [.02 + index * .00001, 0, 0]), ...[.001, .002, .003, .004].map(x => [x, 0, 0])];
    const gatherBuffers = [
      storage(new Float32Array([0, 0, 0, 1])), storage(new Int32Array(4)),
      storage(new Uint32Array([0, centers.length])), storage(new Uint32Array(centers.map((_, index) => index))),
      storage(new Float32Array(centers.flatMap(p => [...p, 0]))), storage(new Float32Array([0, 0, 0, 1]))
    ];
    const gathered = await execute(shaders.initExternalCollisionWGSL({ ...SIM_CONFIG, numExternalCollisionConstraintsPerParticle: 4 }, 1), gatherBuffers, 1, gatherBuffers[1], 16, true);
    device.destroy();
    return { queries, contacts, gathered, errors };
  });
  expect(result.errors).toEqual([]);
  for (const query of result.queries) {
    query.actual.forEach((actual, index) => actual.forEach((value, axis) => {
      expect(Number.isFinite(value), `${query.solver} query ${index}`).toBe(true);
      expect(value, `${query.solver} query ${index} axis ${axis}`).toBeCloseTo(query.expected[index][axis], 5);
    }));
  }
  expect(result.contacts[2]).toBeCloseTo(.003, 6);
  expect(result.contacts[6]).toBeCloseTo(.007, 6);
  expect(result.contacts.slice(8, 16)).toEqual(Array(8).fill(0));
  expect(result.contacts[22]).toBeCloseTo(.025, 6); // A swept face crossing recovers a deep endpoint.
  expect(result.contacts.slice(24, 28)).toEqual([0, 0, 0, 0]); // Crossing an extended plane is not contact.
  expect(result.contacts[18]).toBeGreaterThan(0); // Genuine contact within thickness at an edge.
  expect(result.gathered.sort((a, b) => a - b)).toEqual([42, 43, 44, 45]);
});

test('finite nearest body features recover separating interior points and preserve exterior edge controls', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  test.skip(!await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter()), 'A WebGPU adapter is unavailable');
  const result = await page.evaluate(async () => {
    const pointPath = '/packages/cloth-sim/src/webgpu/bodyPointContacts.ts';
    const featurePath = '/packages/cloth-sim/src/webgpu/bodyContactFeatures.ts';
    const treePath = '/packages/cloth-sim/src/webgpu/bodySurfaceBroadphase.ts';
    const shaderPath = '/packages/cloth-sim/src/webgpu/shaders.ts';
    const configPath = '/packages/cloth-sim/src/config.ts';
    const { gatherBodyPointContactsWGSL, solveBodyPointContactsWGSL } = await import(pointPath);
    const { buildBodyContactFeatureNormals } = await import(featurePath);
    const { buildBodySurfaceBVH } = await import(treePath);
    const shaders = await import(shaderPath);
    const { SIM_CONFIG } = await import(configPath);
    const adapter = (await navigator.gpu.requestAdapter())!;
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
    const errors: string[] = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const resources: GPUBuffer[] = [];
    const storage = (values: Float32Array | Int32Array | Uint32Array) => {
      const buffer = device.createBuffer({ size: Math.max(16, values.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, values.buffer as ArrayBuffer, values.byteOffset, values.byteLength);
      resources.push(buffer); return buffer;
    };
    const pipeline = async (code: string) => {
      const module = device.createShaderModule({ code });
      const info = await module.getCompilationInfo();
      errors.push(...info.messages.filter(message => message.type === 'error').map(message => message.message));
      return device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    };
    const gatherCode=gatherBodyPointContactsWGSL();
    const originalCode=gatherCode.replace(/if\(nearby\) \{([\s\S]*?)\n {6}\}/,'$1');
    if(originalCode===gatherCode) throw Error('Missing nearest-only leaf gate comparison');
    const gather = await pipeline(gatherCode),originalGather=await pipeline(originalCode);
    const solve = await pipeline(solveBodyPointContactsWGSL({ ...SIM_CONFIG, simulationThickness: .001, maxSurfaceCorrection: .005, externalCollisionFriction: 0 }, 1));
    const frictionSolve = await pipeline(solveBodyPointContactsWGSL({ ...SIM_CONFIG, simulationThickness: .001, maxSurfaceCorrection: .005, externalCollisionFriction: .4 }, 1));
    const apply = await pipeline(shaders.applyCorrectionsWGSL());
    const reset = await pipeline(shaders.resetCorrectionsWGSL());
    const group = (pipe: GPUComputePipeline, buffers: GPUBuffer[]) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const cubeVertices = [-.02,-.02,-.02,.02,-.02,-.02,.02,.02,-.02,-.02,.02,-.02,-.02,-.02,.02,.02,-.02,.02,.02,.02,.02,-.02,.02,.02];
    const cubeIndices = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7];
    const wedgeVertices = [0,0,-1,1,-.1,-1,1,.1,-1,0,0,1,1,-.1,1,1,.1,1];
    const wedgeIndices = [0,2,1,3,4,5,0,1,4,0,4,3,1,2,5,1,5,4,2,0,3,2,3,5];
    const concaveXY = [[0,0],[.02,0],[.02,.01],[.01,.01],[.01,.02],[0,.02]];
    const concaveVertices = [-.02,.02].flatMap(z=>concaveXY.flatMap(([x,y])=>[x,y,z]));
    const capTriangles = [[0,1,3],[1,2,3],[0,3,5],[3,4,5]];
    const concaveIndices = [...capTriangles.flatMap(([a,b,c])=>[a,c,b]),...capTriangles.flatMap(([a,b,c])=>[a+6,b+6,c+6]),...concaveXY.flatMap((_,i)=>{ const j=(i+1)%6;return [i,j,j+6,i,j+6,i+6]; })];
    const cases = [
      { name: 'inside outward positive cloth normal', point: [.014,0,0], previous: [.013,0,0], flag: 1, cube: true },
      { name: 'inside outward opposite cloth normal', point: [.014,0,0], previous: [.013,0,0], flag: -1, cube: true },
      { name: 'inside stationary edge', point: [.018,.018,0], previous: [.018,.018,0], flag: -1, cube: true },
      { name: 'exterior separating', point: [.0205,0,0], previous: [.0204,0,0], flag: 1, cube: true },
      { name: 'exterior entering padding', point: [.0205,0,0], previous: [.0206,0,0], flag: 1, cube: true },
      { name: 'distant negative plane extension', point: [.03,.03,0], previous: [.029,.029,0], flag: 0, cube: true },
      { name: 'sharp edge exterior negative incident plane', point: [-.0001,.0005,0], previous: [-.00009,.00045,0], flag: 0, cube: false },
      { name: 'concave shared edge interior outward', point: [.008,.008,0], previous: [.007,.007,0], flag: -1, cube: false, concave: true },
      { name: 'outside through entire closed body', point: [-.03,0,0], previous: [.03,0,0], flag: -1, cube: true },
      { name: 'interior friction combined bound', point: [.014,.001,0], previous: [.013,0,0], flag: -1, cube: true, friction: true },
      { name: 'nearest cache and sweep-only leaf', point: [.081,0,0], previous: [-.03,0,0], flag: -1, cube: true, twoCubes: true }
    ];
    const results = [];
    for (const entry of cases) {
      const xyz = 'twoCubes' in entry ? [...cubeVertices,...cubeVertices.map((value,index)=>index%3===0?value+.06:value)] : entry.cube ? cubeVertices : 'concave' in entry ? concaveVertices : wedgeVertices;
      const ids = 'twoCubes' in entry ? [...cubeIndices,...cubeIndices.map(index=>index+8)] : entry.cube ? cubeIndices : 'concave' in entry ? concaveIndices : wedgeIndices;
      const mesh = { positions: new Float32Array(Array.from({ length: xyz.length / 3 }, (_, i) => [...xyz.slice(i * 3, i * 3 + 3),0]).flat()), triangles: new Uint32Array(Array.from({ length: ids.length / 3 }, (_, i) => [...ids.slice(i * 3, i * 3 + 3),0]).flat()), numTriangles: ids.length / 3 };
      const tree = buildBodySurfaceBVH(mesh);
      const positions = storage(new Float32Array([...entry.point,1,entry.point[0],entry.point[1]+.002,entry.point[2],0,entry.point[0],entry.point[1],entry.point[2]+.002,0]));
      const previous = storage(new Float32Array([...entry.previous,1,entry.point[0],entry.point[1]+.002,entry.point[2],0,entry.point[0],entry.point[1],entry.point[2]+.002,0]));
      const initialContacts=new Float32Array(3*16);if('twoCubes' in entry) initialContacts[7]=19;
      const contacts = storage(initialContacts),originalContacts=storage(initialContacts);
      const corrections = storage(new Float32Array(12));
      const cloth = storage(new Uint32Array([0,1,2,0]));
      const incident = storage(new Int32Array([entry.flag,0,0,-1,0,-1]));
      const bodyBuffers=[storage(tree.nodes),storage(tree.triangleIds),storage(mesh.triangles),storage(mesh.positions),previous,storage(buildBodyContactFeatureNormals(mesh))];
      const gatherBG = group(gather,[positions,contacts,...bodyBuffers]),originalBG=group(originalGather,[positions,originalContacts,...bodyBuffers]);
      const solvePipeline = 'friction' in entry ? frictionSolve : solve;
      const solveBG = group(solvePipeline,[positions,corrections,contacts,previous,cloth,incident]);
      const applyBG = group(apply,[positions,corrections]);
      const resetBG = group(reset,[corrections]);
      const readback = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      const dispatch = (pipe: GPUComputePipeline, bg: GPUBindGroup) => { const pass=encoder.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,bg);pass.dispatchWorkgroups(1);pass.end(); };
      for(let iteration=0;iteration<12;iteration++) {
        dispatch(reset,resetBG);dispatch(gather,gatherBG);dispatch(originalGather,originalBG);
        if(iteration===0) encoder.copyBufferToBuffer(contacts,0,readback,32,16);
        dispatch(solvePipeline,solveBG);dispatch(apply,applyBG);
        if(iteration===0) encoder.copyBufferToBuffer(positions,0,readback,0,16);
      }
      encoder.copyBufferToBuffer(positions,0,readback,16,16);
      encoder.copyBufferToBuffer(contacts,0,readback,128,192);encoder.copyBufferToBuffer(originalContacts,0,readback,320,192);
      device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);
      const mapped=readback.getMappedRange().slice(0);
      const values=Array.from(new Float32Array(mapped));
      const words=new Uint32Array(mapped);let contactMismatches=0;
      for(let word=0;word<48;word++) if(words[32+word]!==words[80+word]) contactMismatches++;
      readback.unmap();readback.destroy();
      results.push({ name: entry.name, initial: entry.point, first: values.slice(0,3), final: values.slice(4,7), initialSignedDistance: values[11],contactMismatches });
    }
    await device.queue.onSubmittedWorkDone();resources.forEach(resource=>resource.destroy());device.destroy();
    return { results, errors };
  });
  expect(result.errors).toEqual([]);
  for (const entry of result.results) { expect([...entry.first,...entry.final,entry.initialSignedDistance].every(Number.isFinite),entry.name).toBe(true);expect(entry.contactMismatches,entry.name).toBe(0); }
  for (const index of [0,1]) {
    const entry=result.results[index];
    expect(entry.initialSignedDistance).toBeCloseTo(-.006,5);
    expect(entry.first[0]-entry.initial[0]).toBeCloseTo(.005,6);
    expect(entry.final[0]).toBeGreaterThanOrEqual(.020999);
  }
  expect(result.results[2].initialSignedDistance).toBeLessThan(0);
  expect(Math.max(...result.results[2].final.slice(0,2))).toBeGreaterThanOrEqual(.020999);
  for (const index of [3,5,6]) result.results[index].final.forEach((value,axis)=>expect(value,result.results[index].name).toBeCloseTo(result.results[index].initial[axis],7));
  expect(result.results[4].final[0]).toBeCloseTo(.021,6);
  expect(result.results[6].initialSignedDistance).toBeGreaterThan(0);
  expect(result.results[7].initialSignedDistance).toBeCloseTo(-Math.sqrt(2)*.002,6);
  expect(result.results[7].final[0]).toBeGreaterThanOrEqual(.010706);
  expect(result.results[7].final[1]).toBeGreaterThanOrEqual(.010706);
  const crossing=result.results[8];
  expect(Math.hypot(...crossing.first.map((value,axis)=>value-crossing.initial[axis]))).toBeLessThanOrEqual(.005001);
  expect(crossing.final[0]).toBeGreaterThanOrEqual(.020999);
  const friction=result.results[9];
  expect(Math.hypot(...friction.first.map((value,axis)=>value-friction.initial[axis]))).toBeLessThanOrEqual(.005001);
  expect(friction.first[1]).toBeLessThan(friction.initial[1]);
  expect(friction.final[0]).toBeGreaterThanOrEqual(.020999);
});
