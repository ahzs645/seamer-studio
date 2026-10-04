import {describe,it,expect} from 'vitest';
import {buildSourceStagingPlan,SourceStagingController,type GraphPattern,type SourceStagingBuildData} from './sourceStaging';
function fixture(){
 const placement={sourcePlacement:{worldMatrix:[]}};
 const pattern:GraphPattern={garmentCodeSource:{panelNames:['left_btorso','left_ftorso','left_sleeve_b','left_sleeve_f']},pieces:[0,1,2,3].map(i=>({id:`GC_Piece${i}`,label:i>=2?'arm':'body',settings3d:{arrangement:placement},mainPaths:(i<2?['collar','shoulder','armhole','centre']:['tube','attach']).map(name=>({id:`${i}-${name}`,name}))})),seams:[
  {id:'centre',fromPaths:[{id:'0-centre'}],toPaths:[{id:'1-centre'}]},
  {id:'shoulder',fromPaths:[{id:'0-shoulder'}],toPaths:[{id:'1-shoulder'}]},
  {id:'tube',fromPaths:[{id:'2-tube'}],toPaths:[{id:'3-tube'}]},
  {id:'attach',fromPaths:[{id:'0-armhole'}],toPaths:[{id:'2-attach'}]}
 ]};
 const seams=new Int32Array(8*4).fill(-1),seamOrder=seams.slice();
 for(let i=0;i<4;i++){seams[i*8]=i*2+1;seams[(i*2+1)*4]=i*2;seamOrder[i*8]=i;seamOrder[(i*2+1)*4]=i;}
 const data:SourceStagingBuildData={particleCount:8,seams,seamOrder,stitchCount:4,seamPairsBySeam:pattern.seams.map((s,i)=>({seamId:s.id,index:i,pairs:[i*2,i*2+1]})),seamStitchRanges:pattern.seams.map((s,i)=>({seamId:s.id,start:i,end:i+1}))};
 const scope={sourceBodyActive:true,freshArrangement:true};
 return {pattern,data,scope,positions:new Float32Array(8*4)};
}
const controller=()=>{const f=fixture();return {f,c:new SourceStagingController(buildSourceStagingPlan(f.pattern,f.data,f.scope)!)};};
describe('source semantic structural staging',()=>{
 it('keeps source IDs/numerical order and physical geometry intact',()=>{
  const f=fixture(),before=JSON.stringify(f),plan=buildSourceStagingPlan(f.pattern,f.data,f.scope)!;
  expect(plan.structuralSeamIndices).toEqual([0,1,2]);expect(plan.attachmentSeamIndices).toEqual([3]);
  expect(plan.seamIds).toEqual(['centre','shoulder','tube','attach']);expect(plan.stitchIndices).toEqual([[0],[1],[2],[3]]);
  expect(plan.shoulderPrerequisites[0].seamIndices).toEqual([3,0,1,2]);expect(JSON.stringify(f)).toBe(before);
 });
 it('binds three accepted measured frames; planned next mask never implies accepted completion',()=>{
  const {f,c}=controller();expect(c.acceptedState.allActive).toBe(false);
  const initial=c.capture();expect(initial.stableAcceptedFrames).toBe(0);
  expect(c.observeAccepted(f.positions,c.nextActiveSeamMask)).toBe(false);
  expect(c.observeAccepted(f.positions,c.nextActiveSeamMask)).toBe(false);const second=c.capture();
  expect(c.observeAccepted(f.positions,c.nextActiveSeamMask)).toBe(true);
  expect([...c.nextActiveSeamMask]).toEqual([1,1,1,1]);expect(c.maskRevision).toBe(1);
  expect(c.acceptedState.allActive).toBe(false);expect(c.acceptedState.revision).toBe(0);expect([...c.acceptedState.activeSeamMask]).toEqual([1,1,1,0]);
  c.observeAccepted(f.positions,c.nextActiveSeamMask);expect(c.acceptedState.allActive).toBe(true);expect(c.acceptedState.revision).toBe(1);
  c.restore(second);expect(c.acceptedState.allActive).toBe(false);expect(c.maskRevision).toBe(0);
  second.activeMask.fill(1);expect([...c.nextActiveSeamMask]).toEqual([1,1,1,0]);
 });
 it('an open/nonfinite structural seam resets measured progress',()=>{
  const {f,c}=controller();c.observeAccepted(f.positions,c.nextActiveSeamMask);f.positions[0]=.004;
  c.observeAccepted(f.positions,c.nextActiveSeamMask);expect(c.capture().stableAcceptedFrames).toBe(0);
  f.positions[0]=NaN;c.observeAccepted(f.positions,c.nextActiveSeamMask);expect(c.capture().stableAcceptedFrames).toBe(0);
 });
 it('manual mode restores semantic seams but partial actual prefix cannot claim completion',()=>{
  const {f,c}=controller();c.cancelAutomatic();expect(c.capture().mode).toBe('manual');
  for(let i=0;i<5;i++)c.observeAccepted(f.positions,c.nextActiveSeamMask,3);
  expect(c.capture().stableAcceptedFrames).toBe(0);expect(c.acceptedState.allActive).toBe(false);expect(c.acceptedState.enabledStitchCount).toBe(3);
  c.observeAccepted(f.positions,c.nextActiveSeamMask,4);expect(c.acceptedState.allActive).toBe(true);
 });
 it('same-category repeated partners preserve authoritative first-stamp order; cross-category owners fall back',()=>{
  const f=fixture();f.data.seamPairsBySeam=f.data.seamPairsBySeam.map((seam,i)=>i===1?{...seam,pairs:[0,1]}:seam);
  const plan=buildSourceStagingPlan(f.pattern,f.data,f.scope)!;expect(plan.stitchIndices[1]).toEqual([0]);
  f.data.seamPairsBySeam=f.data.seamPairsBySeam.map((seam,i)=>i===3?{...seam,pairs:[0,1]}:seam);expect(buildSourceStagingPlan(f.pattern,f.data,f.scope)).toBeNull();
 });
 it.each([{sourceBodyActive:false,freshArrangement:true},{sourceBodyActive:true,freshArrangement:false},{sourceBodyActive:true,freshArrangement:true,held:true},{sourceBodyActive:true,freshArrangement:true,cached:true},{sourceBodyActive:true,freshArrangement:true,manualRecording:true}])('preserves nonautomatic lifecycle and malformed legacy seams %j',scope=>{
  const f=fixture();f.data.seamPairsBySeam=[];expect(buildSourceStagingPlan(f.pattern,f.data,scope)).toBeNull();
 });
 it('unknown source roles, explicit assembly, missing paths and asymmetric numerical links fall back',()=>{
  const f=fixture();(f.pattern.garmentCodeSource as {panelNames:string[]}).panelNames[0]='unknown';expect(buildSourceStagingPlan(f.pattern,f.data,f.scope)).toBeNull();
  const explicit=fixture();explicit.pattern.assembly={};expect(buildSourceStagingPlan(explicit.pattern,explicit.data,explicit.scope)).toBeNull();
  const missing=fixture();missing.pattern.seams[0].fromPaths=[{id:'missing'}];expect(buildSourceStagingPlan(missing.pattern,missing.data,missing.scope)).toBeNull();
  const asymmetric=fixture();asymmetric.data.seamOrder[4]=2;expect(buildSourceStagingPlan(asymmetric.pattern,asymmetric.data,asymmetric.scope)).toBeNull();
 });
 it('rejects mismatched accepted gates and malformed rollback before mutating state',()=>{
  const {f,c}=controller(),before=c.capture();expect(()=>c.observeAccepted(f.positions,new Uint32Array(4).fill(1))).toThrow();expect(c.capture()).toEqual(before);
  expect(()=>c.restore({...before,topology:'other'})).toThrow();expect(()=>c.restore({...before,activeMask:new Uint32Array(4).fill(2)})).toThrow();
  expect(()=>c.restore({...before,lastAcceptedMaskRevision:2})).toThrow();expect(c.capture()).toEqual(before);
 });
});
