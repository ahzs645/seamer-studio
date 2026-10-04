import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import * as atelierSim from '@atelier/sim';
import { ClothCollisionGuard } from '@seamer/cloth-sim';
import { PatternRenderer } from './scene3d';
import * as binding from './frozenAppRender';
import { bindingFixture } from './frozenAppRender.fixture';
import { SOURCE_BODY_FIT_REVISION, GARMENT_CODE_ASSEMBLY_REVISION } from './sourceBodyCheckpoint';
vi.mock('./seamerLighting', () => ({ SeamerLighting: vi.fn() }));
vi.mock('./pieceTexture', () => ({ createPieceTexture: vi.fn(), pieceNeedsBake: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

async function rig() {
  const f = await bindingFixture();
  f.evidence.sourceFitRevision = SOURCE_BODY_FIT_REVISION; f.evidence.sourceAssemblyRevision = GARMENT_CODE_ASSEMBLY_REVISION;
  const data = f.prepared.simData;
  const uv = new Float32Array([0,0, 0,.3, .3,0]);
  Object.assign(data, { pieces: [{ pieceId: 'panel', start: 0, count: 3, triangles: [0,1,2], uv }] });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(Array.from(data.positions).filter((_,i)=>i%4!==3)),3));
  geometry.setAttribute('uv',new THREE.BufferAttribute(uv.slice(),2)); geometry.setIndex([0,1,2]);
  const mesh = new THREE.Mesh(geometry,new THREE.MeshStandardMaterial());
  const bodyGeometry = new THREE.BufferGeometry();
  bodyGeometry.setAttribute('position',new THREE.BufferAttribute(f.bodyPositions.slice(),3)); bodyGeometry.setIndex(Array.from(f.bodyIndices));
  const avatar = { vertexPositions: f.bodyPositions, indices: f.bodyIndices, mesh: new THREE.Mesh(bodyGeometry,new THREE.MeshStandardMaterial()) };
  const renderer = Object.create(PatternRenderer.prototype) as PatternRenderer;
  Object.assign(renderer, { prepared: f.prepared, avatar, pattern: f.pattern, mode: 'view', sim: null, device: null,
    frozenRequestRevision:0, frozenPending:false, frozenDisplay:null, sourceSceneGeneration:1,
    sourceBodyInitializationRevision:0, sourcePreparationRequestRevision:0, simulationResetRevision:0,
    sourceContactOptions:{}, buildQueue:Promise.resolve(true), disposed:false, activeSimulationStep:null,
    sourcePublishedCollisionContext:null, sourcePreviewGuard:null, sourcePreviewReport:null,
    clothMeshes:[{ pieceId:'panel', start:0, count:3, geometry, mesh, baseVisible:true }], lastClothPositions:data.positions.slice(), pieceLabels:[],
    invalidate:vi.fn(), updateDebugFocusPoint:vi.fn(), pauseSimulation:vi.fn(), getCameraState:()=>({position:[0,0,4],target:[0,0,0],fov:50}),
    setCameraState:vi.fn(), overlays:{updatePositions:vi.fn()} });
  const pins = vi.spyOn(binding,'verifyFrozenModulePins').mockResolvedValue(undefined);
  async function request() { const snapshotJson=JSON.stringify(f.evidence); return {snapshotJson,snapshotSha256:await binding.frozenSha256(new TextEncoder().encode(snapshotJson))}; }
  return { ...f, renderer, geometry, mesh, pins, request };
}

describe('production Scene3D frozen read-only publication (CPU, no device)', () => {
  it('publishes actual guarded XYZ through the real mesh updater and restores the original scene without changing the seed/document', async()=>{
    const f=await rig(), before=structuredClone(f.pattern), seed=f.prepared.simData.positions.slice();
    f.evidence.clothPositions[0]=2.125;
    const receipt=await f.renderer.presentFrozenCheckpoint(await f.request());
    expect(receipt).toMatchObject({diagnostic:true,garmentAccepted:false,cacheResumeEligible:false,deviceAcquired:false,clothPositionErrorM:0,bodyPositionErrorM:0});
    const actual=f.renderer.getFrozenRenderedGeometry();
    expect(actual.clothPositions[0]).toBe(2.125); expect(f.geometry.getAttribute('position').getX(0)).toBe(2.125);
    expect(f.prepared.simData.positions).toEqual(seed); expect(f.pattern).toEqual(before);
    expect(f.renderer.getSourceAssemblyComplete()).toBeNull();
    expect(()=>f.renderer.extractSavedPositions()).toThrow('read-only'); expect(()=>f.renderer.exportScene()).toThrow('read-only');
    await expect(f.renderer.simulate()).rejects.toThrow('read-only'); expect(()=>f.renderer.resetSimulation()).toThrow('read-only');
    const copy=f.renderer.getFrozenRenderedGeometry();copy.clothPositions[0]=99;
    expect(f.renderer.getFrozenRenderedGeometry().clothPositions[0]).toBe(2.125);
    f.renderer.exitFrozenCheckpoint();
    expect(f.geometry.getAttribute('position').getX(0)).toBe(seed[0]); expect(f.pattern).toEqual(before);
  });
  it('rejects genuinely inside-body geometry despite a forged safe report without replacing visible XYZ',async()=>{
    const f=await rig(), before=f.geometry.getAttribute('position').array.slice();
    for(let i=0;i<3;i++)f.evidence.clothPositions[i*4]=0;
    const real=new ClothCollisionGuard({bodyPositions:f.bodyPositions,bodyIndices:f.bodyIndices,clothTriangles:f.prepared.simData.triangles,particleCount:3});
    expect(real.inspect(Float32Array.from(f.evidence.clothPositions)).safe).toBe(false);
    await expect(f.renderer.presentFrozenCheckpoint(await f.request())).rejects.toThrow();
    expect(f.geometry.getAttribute('position').array).toEqual(before);
  });
  it.each(['generation','body','request','reset','document','disposed'])( 'rejects stale %s after actual async pin verification',async reason=>{
    const f=await rig();let release!:()=>void;
    f.pins.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
    const pending=f.renderer.presentFrozenCheckpoint(await f.request());
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    const changed:Record<string,unknown>={generation:{sourceSceneGeneration:2},body:{sourceBodyInitializationRevision:1},request:{sourcePreparationRequestRevision:1},reset:{simulationResetRevision:1},document:{pattern:{...f.pattern}},disposed:{disposed:true}};
    Object.assign(f.renderer,changed[reason]); release();
    await expect(pending).rejects.toThrow('changed'); expect(f.geometry.getAttribute('position').getX(0)).toBe(2);
  });
  it('rejects concurrent publication and cancellation while verification is pending',async()=>{
    const f=await rig();let release!:()=>void;
    f.pins.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
    const request=await f.request(), pending=f.renderer.presentFrozenCheckpoint(request);
    await expect(f.renderer.presentFrozenCheckpoint(request)).rejects.toThrow('read-only');
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.renderer.exitFrozenCheckpoint();release();
    await expect(pending).rejects.toThrow('changed');
  });
  it('rejects nonidentity actual mesh transforms and rolls back publication',async()=>{
    const f=await rig();f.mesh.position.x=.1;
    await expect(f.renderer.presentFrozenCheckpoint(await f.request())).rejects.toThrow('mesh transform');
    expect(()=>f.renderer.getFrozenRenderedGeometry()).toThrow('No frozen');
  });
  it('does not borrow a live device/solver for frozen publication',async()=>{
    const f=await rig(); Object.assign(f.renderer,{device:{},sim:{}});
    await expect(f.renderer.presentFrozenCheckpoint(await f.request())).rejects.toThrow('fresh');
    expect(f.pins).not.toHaveBeenCalled();
  });
  it('drains the actual queued preparation before reading any frozen bindings and can cancel that wait', async()=>{
    const f=await rig(); let finish!:()=>void;
    Object.assign(f.renderer,{buildQueue:new Promise<void>(resolve=>{finish=resolve;})});
    const pending=f.renderer.presentFrozenCheckpoint(await f.request());
    expect(f.pins).not.toHaveBeenCalled();
    f.renderer.exitFrozenCheckpoint(); finish();
    await expect(pending).rejects.toThrow('fresh');expect(f.pins).not.toHaveBeenCalled();
  });
  it('does not persist a diagnostic camera flight that completes after exiting',async()=>{
    const f=await rig(); let finish!:()=>void;
    const queueCameraSave=vi.fn(), release=vi.fn();
    Object.assign(f.renderer,{cameraWritebackEnabled:true,sourceCameraPatternId:'original',queueCameraSave,
      viewport:{acquireRenderLease:()=>release,camera:{flyTo:()=>new Promise<void>(resolve=>{finish=resolve;})}}});
    await f.renderer.presentFrozenCheckpoint(await f.request());
    const internals=f.renderer as unknown as {flyCamera(position:THREE.Vector3,target:THREE.Vector3,duration:number):Promise<void>};
    const moving=internals.flyCamera(new THREE.Vector3(0,0,-4),new THREE.Vector3(),450);
    f.renderer.exitFrozenCheckpoint();finish();await moving;
    expect(release).toHaveBeenCalledOnce();expect(queueCameraSave).not.toHaveBeenCalled();
  });

  it('retains the original snapshot digest in its receipt when caller fields change during pin verification', async () => {
    const f = await rig();let release!:()=>void;
    f.pins.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
    const request = await f.request(), originalSha = request.snapshotSha256;
    const pending = f.renderer.presentFrozenCheckpoint(request);
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    request.snapshotSha256 = 'f'.repeat(64);request.snapshotJson = '{}';release();
    expect((await pending).snapshotSha256).toBe(originalSha);
    f.renderer.exitFrozenCheckpoint();
  });

  it('rejects an already pending requestDevice initialization without issuing a device-free diagnostic receipt', async () => {
    const f = await rig();let release!: (value: GPUDevice | null) => void;
    vi.spyOn(atelierSim, 'requestDevice').mockImplementation(() => new Promise<GPUDevice | null>(resolve => { release = resolve; }));
    const internals = f.renderer as unknown as { ensureSim(): Promise<unknown>; simulationInitializations: number };
    const initializing = internals.ensureSim();
    expect(internals.simulationInitializations).toBe(1);
    await expect(f.renderer.presentFrozenCheckpoint(await f.request())).rejects.toThrow('fresh');
    expect(f.pins).not.toHaveBeenCalled();release(null);
    await expect(initializing).rejects.toThrow('WebGPU is unavailable');expect(internals.simulationInitializations).toBe(0);
  });
  it('rechecks actual solver/device absence immediately before publishing after async hashing', async () => {
    const f = await rig();let release!:()=>void;
    f.pins.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
    const pending = f.renderer.presentFrozenCheckpoint(await f.request());
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    Object.assign(f.renderer, { device: {} });release();
    await expect(pending).rejects.toThrow('changed');expect(f.geometry.getAttribute('position').getX(0)).toBe(2);
  });

});
