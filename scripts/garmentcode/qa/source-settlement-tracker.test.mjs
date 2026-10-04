import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const path=new URL('../../check-garment-matrix.mjs',import.meta.url);
const source=readFileSync(path,'utf8'),file=ts.createSourceFile(path.pathname,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const declaration=file.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text==='createSettlementTracker');
const createSettlementTracker=(0,eval)('('+declaration.getText(file).replace(/^export\s+/,'')+')');
const positions=new Float32Array([0,1,0,1]);
const good={fullySewn:true,maxSeamGapMm:0,temporarySupportWeightsNonzero:0,fixedAnchorWeightsNonzero:0,
  bodyContacts:true,surfaceContacts:true,selfContacts:true,selfSurfaceContacts:true,runtimeSafe:true,halted:false,gravity:[0,-9.8,0],
  sourceAssemblyComplete:true,sourceStretchPolicy:{policy:'source-authored-seam-stretch-v1'}};
for(const value of [false,null,undefined,1,'true']) test('actual production source tracker rejects completion '+String(value),()=>{
  const tracker=createSettlementTracker(.016);for(let frame=0;frame<=24;frame++)tracker.observe(frame,positions,{...good,sourceAssemblyComplete:value});
  assert.equal(tracker.motionCandidate,false);assert.equal(tracker.lastObservationEligible,false);assert.deepEqual(tracker.windows,[]);
});
test('actual source tracker requires17 consecutive complete observations without changing native windows',()=>{
  for(const state of [good,{...good,sourceStretchPolicy:undefined,sourceAssemblyComplete:undefined}]){
    const tracker=createSettlementTracker(.016);for(let frame=0;frame<16;frame++)tracker.observe(frame,positions,state);
    assert.equal(tracker.motionCandidate,false);tracker.observe(16,positions,state);assert.equal(tracker.motionCandidate,true);
    assert.deepEqual(tracker.windows.map(window=>[window.fromFrame,window.toFrame,window.comparedFramePairs]),[[0,8,36],[8,16,36]]);
  }
});
test('actual source tracker resets both windows after losing completion',()=>{
  const tracker=createSettlementTracker(.016);for(let frame=0;frame<=8;frame++)tracker.observe(frame,positions,good);
  tracker.observe(9,positions,{...good,sourceAssemblyComplete:false});
  for(let frame=10;frame<26;frame++)tracker.observe(frame,positions,good);
  assert.equal(tracker.motionCandidate,false);tracker.observe(26,positions,good);assert.equal(tracker.motionCandidate,true);
  assert.deepEqual(tracker.windows.slice(-2).map(window=>[window.fromFrame,window.toFrame]),[[10,18],[18,26]]);
});
