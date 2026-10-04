import { expect, test } from '@playwright/test';

test('diagnostic copies retain packed candidate integers and every selected stage', async ({ page }) => {
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const path = '/packages/cloth-sim/src/webgpu/diagnosticCopies.ts';
    const { captureUint32WordsWGSL } = await import(path);
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('Actual WebGPU diagnostic copy requires an adapter');
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
    const errors: string[] = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const input = new Uint32Array([0, 1, 2, 0xffffffff, 0x90000003, 0x30000002, 0x7fc00001, 0x80000000]);
    const source = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const destination = device.createBuffer({ size: input.byteLength * 3, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const params = device.createBuffer({ size: 768, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const records = new Uint32Array(192); records[64] = 1; records[128] = 2;
    device.queue.writeBuffer(source, 0, input); device.queue.writeBuffer(params, 0, records);
    const module = device.createShaderModule({ code: captureUint32WordsWGSL() });
    errors.push(...(await module.getCompilationInfo()).messages.filter(m => m.type === 'error').map(m => m.message));
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    for (const stage of [2, 0, 1]) {
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: destination } },
        { binding: 2, resource: { buffer: params, offset: stage * 256, size: 16 } }
      ] }));
      pass.dispatchWorkgroups(1);
    }
    pass.end();
    const readback = device.createBuffer({ size: input.byteLength * 3, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.copyBufferToBuffer(destination, 0, readback, 0, input.byteLength * 3);
    device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const words = Array.from(new Uint32Array(readback.getMappedRange().slice(0))); readback.unmap();
    for (const buffer of [source, destination, params, readback]) buffer.destroy(); device.destroy();
    return { words, expected: Array.from(input), errors };
  });
  expect(result.errors).toEqual([]);
  expect(result.words).toEqual([...result.expected, ...result.expected, ...result.expected]);
});
