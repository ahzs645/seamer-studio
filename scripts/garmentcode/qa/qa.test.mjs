import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWindowMotion, sampleEligibility, sampleGeometryPassed, auditMotionWindows } from './motion-window-audit.mjs';
import { auditParticleTrajectory, trajectoryNumericBytes, trajectorySourceHashes, TRAJECTORY_FORMAT } from './particle-trajectory-audit.mjs';
import { createHash } from 'node:crypto';
import { readFrozenSample } from './frozen-sample.mjs';
import { evaluateAcceptance } from './evaluate-acceptance.mjs';
import { requiresSourceAssemblyEvidence } from './source-assembly-evidence.mjs';
import { auditShoulderWear } from './shoulder-wear-guard.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function acceptedEvidence() {
  const manifest = { runHalted:false, frozen: '/fixture/final.json', requiredCoveredRegions: ['waist'], shoulderApplicable: false, openingsApplicable: false, waistbandApplicable: false,
    sewing: { fullyEnabled: true }, freshness: { fromArrangement: true, cachedParticlesUsed: 0, initialGeometryVerified: true, currentBodyRevisionVerified: true, currentAssemblyRevisionVerified: true, currentPatternSourceVerified: true },
    release: { windows: [0, 1].map(i => ({ fromFrame:i*8,toFrame:(i+1)*8,fromSeconds: i * .128, toSeconds: (i + 1) * .128, intervalSeconds: .128, rmsDisplacementMm: .5, maxDisplacementMm: 1.5,
      fullyReleasedForEntireWindow: true, observedFrameCount: 9, temporarySupportWeightsNonzero: 0, fixedAnchorWeightsNonzero: 0,
      bodyContacts: true, surfaceContacts: true, selfContacts: true, selfSurfaceContacts: true, runtimeSafe: true, halted: false, maxSeamGapMm: 2, fullySewn: true, gravity: [0, -9.8, 0] })) } };
  const reports = { f: { simulationConfig:{subSteps:40},clothPositions: [0, 1, 0, 1], bodyPositions: [0, 1, 0], simulatedSecondsPerFrame: .016,frame:16,simulatedSeconds:.256,runtimeSafe:true,halted:false,bodyContacts:true,surfaceContacts:true,selfContacts:true,selfSurfaceContacts:true,temporarySupportWeightsNonzero:0,fixedAnchorWeightsNonzero:0,fullySewn:true,gravity:[0,-9.8,0] },
    r: { fixture: manifest.frozen, bodyBoundaryEdges: 0, bodyNonmanifoldEdges: 0, parityDisagreements: 0, insideParticleCount: 0, intersectingClothFaces: 0, maxSeamGapMm: 2, regions: { waist: { available: true, coveredClothFaces: 1 } } },
    s: { fixture: manifest.frozen, nonadjacentPenetrations: 0, unclosedPairedSeamContacts: 0, closedPairedSeamContacts: 0, seamNeighborhoodMm: 5, seamClosureMm: 3 },
    render: { frozenSource: manifest.frozen, maxCoordinateErrorMm: 0, maxAvatarCoordinateErrorMm: 0, errors: [] } };
  for (const w of manifest.release.windows) Object.assign(w,{motionMetric:'maximum-all-frame-pairs',comparedFramePairs:36,sampleFrames:Array.from({length:9},(_,i)=>w.fromFrame+i)});
  reports.motion={fixture:manifest.frozen,passed:true,sourceBindingVerified:true,errors:[],samples:Array.from({length:17},(_,frame)=>({frame,passed:true,eligible:true,waist:true,geometry:{passed:true}})),windows:manifest.release.windows.map(w=>({...w,allSampleGuardsPassed:true,passed:true}))};
  reports.motion.trajectories=Array.from({length:16},(_,i)=>({fromFrame:i,toFrame:i+1,passed:true,binaryVerified:true,sourceBindingVerified:true,endpointBindingVerified:true,errors:[],geometry:{safe:true,trajectory:{valid:true,inspectedSubsteps:40}}}));
  return { manifest, reports };
}
function completeSourceEvidence() {
  const e = acceptedEvidence();
  e.reports.f.sourceStretchPolicy = { policy:'source-authored-seam-stretch-v1' };
  e.reports.f.sourceAssemblyComplete = true;
  e.reports.f.maxSeamGapMm = 2;
  for (const window of e.manifest.release.windows) window.sourceAssemblyComplete = true;
  e.reports.motion.sourceAssemblyRequired = true;
  for (const sample of e.reports.motion.samples) sample.sourceAssemblyComplete = true;
  return e;
}
test('complete source eligibility adds no changed motion or native acceptance thresholds', () => {
  assert.equal(evaluateAcceptance(completeSourceEvidence().manifest, completeSourceEvidence().reports).accepted,true);
  const native=acceptedEvidence();assert.equal(evaluateAcceptance(native.manifest,native.reports).accepted,true);
});
for (const value of [false,null,undefined,1,'true']) test('final source completion '+String(value)+' cannot certify a completed source drape',()=>{
  const e=completeSourceEvidence();e.reports.f.sourceAssemblyComplete=value;
  assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
});
for (const window of [0,1]) for (const value of [false,undefined]) test('source release window '+window+' requires actual completion '+String(value),()=>{
  const e=completeSourceEvidence();e.manifest.release.windows[window].sourceAssemblyComplete=value;
  assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
});
for (const index of [0,1,7,8,9,15,16]) test('source settling sample '+index+' cannot hide incomplete assembly behind a final complete flag',()=>{
  const e=completeSourceEvidence();delete e.reports.motion.samples[index].sourceAssemblyComplete;
  assert.equal(e.reports.f.sourceAssemblyComplete,true);
  assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
});
test('an old motion report cannot silently bypass actual source completion auditing',()=>{
  const e=completeSourceEvidence();delete e.reports.motion.sourceAssemblyRequired;
  assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
});
test('every one of the17 actual source sample observations requires exact completion',()=>{
  const e=completeSourceEvidence();
  for(let frame=0;frame<17;frame++){
    const sample={...e.reports.f,frame};assert.equal(sampleEligibility(sample),true);
    for(const incomplete of [false,null,undefined,1,'true']) assert.equal(sampleEligibility({...sample,sourceAssemblyComplete:incomplete}),false);
  }
});
test('source completion does not bypass physical support and contacts or impose a native marker',()=>{
  const native={...acceptedEvidence().reports.f,maxSeamGapMm:2};assert.equal(sampleEligibility(native),true);
  const source=completeSourceEvidence().reports.f;
  for(const unsafe of [{temporarySupportWeightsNonzero:1},{selfSurfaceContacts:false},{fullySewn:false}])
    assert.equal(sampleEligibility({...source,...unsafe}),false);
});
test('complete support-free, fully colliding evidence can pass fixed limits', () => {
  const e = acceptedEvidence(); assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted, true);
});
for (const flag of ['bodyContacts','surfaceContacts','selfContacts','selfSurfaceContacts','runtimeSafe','halted']) {
  for (const missing of [false,true]) test(`${missing?'missing':'unsafe'} release ${flag} rejects`, () => {
    const e=acceptedEvidence(); for(const w of e.manifest.release.windows) {if(missing) delete w[flag]; else w[flag]=flag==='halted';}
    assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
  });
}
for (const change of [e=>e.manifest.release.windows[0].observedFrameCount=8,e=>e.manifest.release.windows[1].fromSeconds=.129,e=>e.manifest.release.windows[0].temporarySupportWeightsNonzero=1,e=>e.manifest.release.windows[0].maxSeamGapMm=3.01,e=>e.manifest.freshness.currentAssemblyRevisionVerified=false,e=>e.reports.render.frozenSource='/fixture/other.json',e=>e.reports.r.regions.waist.coveredClothFaces=0,e=>delete e.manifest.requiredCoveredRegions]) {
  test('incomplete or mismatched physical evidence is rejected',()=>{const e=acceptedEvidence();change(e);assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);});
}
function shoulderFixture() {
  const f={pattern:{body:{garmentCodeBody:{measurementsCm:{height:176,head_l:26,neck_w:18,shoulder_w:36}}},pieces:[],seams:[]},assemblySupport:{groups:[]},seamPairs:[],sourceArrangedPositions:[],clothPositions:[],bodyPositions:[],bodyIndices:[]};
  for(const side of [-1,1]) {
    const prefix=side<0?'right':'left', ids=[];
    for(const suffix of ['f','b']) f.pattern.pieces.push({id:prefix+suffix,mainPaths:[{id:prefix+suffix+'neck',name:'neck'},{id:prefix+suffix+'sh',name:'shoulder'},{id:prefix+suffix+'arm',name:'armhole'}]});
    for(const x of [.11,.17]) for(const z of [-.06,.06]) {ids.push(f.clothPositions.length/4);f.sourceArrangedPositions.push(side*x,1.45,z,1);f.clothPositions.push(side*x,1.455,0,1);}
    f.pattern.seams.push({id:prefix,fromPaths:[{id:prefix+'fsh'}],toPaths:[{id:prefix+'bsh'}]});
    f.seamPairs.push({seamId:prefix,pairs:ids});f.assemblySupport.groups.push({id:prefix,kind:'shoulder',seamPairs:ids});
    const n=f.bodyPositions.length/3;f.bodyPositions.push(side*.09,1.45,-.08,side*.19,1.45,-.08,side*.19,1.45,.08,side*.09,1.45,.08);f.bodyIndices.push(n,n+1,n+2,n,n+2,n+3);
  }
  const n=f.bodyPositions.length/3;f.bodyPositions.push(0,1.5,-.05,0,1.5,-.05,0,1.5,-.05);f.bodyIndices.push(n,n+1,n+2);
  f.bodyAnatomicalReferences={neckSideToShoulder:{coordinates:[{faceIndex:0,u:1,v:0,w:0},{faceIndex:0,u:0,v:1,w:0}],points:[[-.09,1.45,-.08],[-.19,1.45,-.08]]},neckToWaistBack:{coordinates:[{faceIndex:4,u:1,v:0,w:0},{faceIndex:4,u:0,v:1,w:0}],points:[[0,1.5,-.05],[0,1.5,-.05]]}};
  return f;
}
test('bilateral source shoulder stitches resting within 5mm of actual skin pass',()=>assert.equal(auditShoulderWear(shoulderFixture()).allShoulderPairsWorn,true));
test('anatomically worn source shoulder can move medially beyond 10mm from flat seed',()=>{
  const f=shoulderFixture();
  for(let i=0;i<f.sourceArrangedPositions.length;i+=4) f.sourceArrangedPositions[i]+=Math.sign(f.sourceArrangedPositions[i])*.04;
  const report=auditShoulderWear(f);
  assert.equal(report.allShoulderPairsWorn,true);
  assert.ok(report.rows.every(r=>Math.abs(r.sourceSeedXDriftMm)>39));
});
for(const [name,change] of [
  ['floor',f=>{for(let i=1;i<f.clothPositions.length;i+=4)f.clothPositions[i]=.005;}],
  ['off body',f=>{for(let i=2;i<f.clothPositions.length;i+=4)f.clothPositions[i]=.20;}],
  ['upper arm mislabeled shoulder',f=>{for(let i=0;i<f.clothPositions.length;i+=4){f.clothPositions[i]*=3;f.sourceArrangedPositions[i]*=3;}for(let i=0;i<f.bodyPositions.length;i+=3)f.bodyPositions[i]*=3;for(const r of Object.values(f.bodyAnatomicalReferences))for(const p of r.points)p[0]*=3;}],
  ['missing source topology',f=>f.assemblySupport.groups=[]],
  ['lost one shoulder',f=>{f.pattern.seams.pop();f.seamPairs.pop();f.assemblySupport.groups.pop();}]
  ,['wrong anatomical side',f=>{for(let i=0;i<f.clothPositions.length;i+=4)f.clothPositions[i]*=-1;}]
  ,['cross-neck paired endpoints',f=>{for(let i=0;i<f.clothPositions.length;i+=8)f.clothPositions[i]*=-1;}]
  ,['neck substituted for shoulder',f=>{for(let i=0;i<f.clothPositions.length;i+=4)f.clothPositions[i]=Math.sign(f.clothPositions[i])*.04;}]
]) test(`${name} cannot satisfy worn shoulder evidence`,()=>{const f=shoulderFixture();change(f);assert.equal(auditShoulderWear(f).allShoulderPairsWorn,false);});
test('assembly-local closed contact cannot exempt an open whole seam at final acceptance',()=>{
  const e=acceptedEvidence();e.reports.s.unclosedPairedSeamContacts=1;assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
});
test('finite remote folds are not disguised by matching panel owners or an unrelated seam',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'garment-qa-'));
  try {
    const f={clothPositions:[-.02,0,0,1,.02,0,0,1,0,.02,0,1,0,-.01,-.02,1,0,.015,.02,1,0,.025,-.02,1,.1,0,0,1,.1,0,0,1,.1,.03,0,1,.1,.03,0,1],clothTriangles:[0,1,2,0,3,4,5,0],pieces:[{pieceId:'a',start:0,count:3},{pieceId:'b',start:3,count:3}],pattern:{pieces:[{id:'a',name:'front'},{id:'b',name:'back'}]},seamPairs:[{seamId:'unrelated',pairs:[6,7,8,9]}]};
    await writeFile(join(dir,'f.json'),JSON.stringify(f));await writeFile(join(dir,'r.json'),JSON.stringify({selfCrossingCandidates:[{faces:[0,1]}]}));
    execFileSync(process.execPath,[fileURLToPath(new URL('./inspect-all-self-contacts.mjs',import.meta.url)),join(dir,'f.json'),join(dir,'r.json'),join(dir,'out.json')]);
    const out=JSON.parse(await readFile(join(dir,'out.json'),'utf8'));assert.equal(out.nonadjacentPenetrations,1);assert.ok(out.rows[0].intersectionEndpoints.length>=2);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('an empty or unilateral wrist report does not claim clean emergence',()=>{
  for(const sides of [{},{Left:{bodyCutPointCount:1,bodyCutPointsOutsideOpening:0,minimumProjectedOpeningClearanceMm:1,handIntersectingClothFaces:0,wristForearmIntersectingClothFaces:0,maxHemJoinGapMm:1}}]) {
    const e=acceptedEvidence(); e.manifest.openingsApplicable=true; e.reports.o={fixture:e.manifest.frozen,sides};
    assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
  }
});
test('shoulder report binding and actual rows are mandatory, not just an asserted pass flag',()=>{
  const e=acceptedEvidence();e.manifest.shoulderApplicable=true;e.reports.shoulder={...auditShoulderWear(shoulderFixture()),fixture:e.manifest.frozen};
  assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,true);
  e.reports.shoulder.rows[0].surfaceClearanceMm=10.01;
  assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
  e.reports.shoulder={...auditShoulderWear(shoulderFixture()),fixture:'/fixture/other.json'};
  assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
});
test('assembly-local contact requires the same corresponding stitch segment and local gap',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'garment-local-qa-'));
  try {
    const f={clothPositions:[0,0,0,1,0,.02,0,1,.01,.01,0,1,0,0,.001,1,0,.02,.001,1,-.01,.01,.001,1,.1,0,0,1,.1,0,.1,1,.1,.02,0,1,.1,.02,.1,1],clothTriangles:[0,1,2,0,3,4,5,0],seamPairs:[{seamId:'s',pairs:[0,3,1,4,6,7,8,9]}]};
    const row={classification:'paired-seam contact before closure',faces:[0,1],intersectionEndpoints:[[0,.01,.0005]],adjacentSeams:[{seamId:'s',allIntersectionEndpointsWithinSeamNeighborhood:true,maxSeamGapMm:100}]};
    async function probe() {
      await writeFile(join(dir,'f.json'),JSON.stringify(f));await writeFile(join(dir,'r.json'),JSON.stringify({rows:[row]}));
      execFileSync(process.execPath,[fileURLToPath(new URL('./local-seam-gap-probe.mjs',import.meta.url)),join(dir,'f.json'),join(dir,'r.json'),join(dir,'out.json')]);
      return JSON.parse(await readFile(join(dir,'out.json'),'utf8'));
    }
    assert.equal((await probe()).locallyClosed,1);
    f.clothPositions[3*4+2]=.004;f.clothPositions[4*4+2]=.004;
    assert.equal((await probe()).locallyNotClosed,1);
    row.intersectionEndpoints=[[.1,.01,.05]];
    assert.equal((await probe()).locallyNotClosed,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('old release windows cannot certify a later frozen frame or halted snapshot',()=>{
  for(const change of [e=>{e.reports.f.frame=17;e.reports.f.simulatedSeconds=.272;},e=>e.reports.f.halted=true,e=>delete e.reports.f.runtimeSafe,e=>e.manifest.release.windows[0].toFrame=7]) {
    const e=acceptedEvidence();change(e);assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
  }
});

test('JSON nulls cannot masquerade as observed zero motion, gaps, or rendered error',()=>{
  for(const change of [e=>e.manifest.release.windows[0].rmsDisplacementMm=null,e=>e.manifest.release.windows[0].maxDisplacementMm=null,e=>e.manifest.release.windows[0].maxSeamGapMm=null,e=>e.reports.r.maxSeamGapMm=null,e=>e.reports.render.maxCoordinateErrorMm=null,e=>e.reports.render.maxAvatarCoordinateErrorMm=null,e=>e.reports.f.clothPositions=[],e=>e.reports.f.bodyPositions=[]]) {
    const e=acceptedEvidence();change(e);assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
  }
});

test('a safe rollback snapshot cannot certify a halted or unknown overall run',()=>{
  for(const value of [true,null,undefined]) {const e=acceptedEvidence();e.manifest.runHalted=value;assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);}
});

// A closed, submicrometre slab gives a real entry and exit; UV-style duplicated vertices
// must still merge duplicate triangle hits on the same face diagonal.
import { Vector3,Triangle,Ray } from 'three';
import { finiteRayHit,countFiniteRayHits } from './body-parity.mjs';
function slabRayHits(y,z) {
  const hits=[],ray=new Ray(new Vector3(0,y,z),new Vector3(1,0,0));
  for(const [x,flip]of[[1,true],[1+4.174e-7,false]]) {
    const a=new Vector3(x,-.5,-.5),b=new Vector3(x,.5,-.5),c=new Vector3(x,.5,.5),d=new Vector3(x,-.5,.5);
    for(const v of [[a,b,c],[a,c,d]]) {
      const tri=new Triangle(...(flip?v.toReversed():v)),at=new Vector3();
      if(ray.intersectTriangle(tri.a,tri.b,tri.c,false,at))hits.push(finiteRayHit(tri,ray,at));
    }
  }
  return hits;
}
test('submicrometre real interior entry and exit remain two crossings',()=>{
  const hits=slabRayHits(.137,.233);assert.equal(hits.length,2);assert.ok(hits[1].distance-hits[0].distance<1e-6);assert.equal(countFiniteRayHits(hits),2);
});
test('same physical shared diagonal duplicate hits coalesce across separate vertex objects',()=>{
  const hits=slabRayHits(0,0);assert.equal(hits.length,4);assert.equal(countFiniteRayHits(hits),2);
});
test('opposing entry/exit orientations never merge on one geometric boundary feature',()=>{
  const hit=slabRayHits(0,0)[0];assert.equal(countFiniteRayHits([hit,{...hit,orientation:-hit.orientation}]),2);
});

test('anatomical references must be present and reproduce actual frozen body anchors',()=>{
  for(const change of [f=>delete f.bodyAnatomicalReferences,f=>delete f.bodyAnatomicalReferences.neckSideToShoulder.coordinates,f=>f.bodyAnatomicalReferences.neckSideToShoulder.points[0][0]+=.02,f=>f.bodyAnatomicalReferences.neckSideToShoulder.coordinates[0].u=-1]) {const f=shoulderFixture();change(f);assert.equal(auditShoulderWear(f).allShoulderPairsWorn,false);}
});
test('back-neck trace length cannot be mistaken for physical neck diameter',()=>{
  const f=shoulderFixture();f.pattern.body.garmentCodeBody.measurementsCm.neck_w=60;assert.equal(auditShoulderWear(f).allShoulderPairsWorn,true);
});

test('returning oscillation cannot pass zero endpoint displacement',()=>{
  const samples=Array.from({length:9},(_,frame)=>({frame,clothPositions:[frame===4?.0011:0,0,0,1]}));
  const m=computeWindowMotion(samples);assert.equal(m.endpointRmsDisplacementMm,0);assert.ok(m.rmsDisplacementMm>1);assert.equal(m.comparedFramePairs,36);
});
test('opposite excursions detect total motion even when each offset is below maximum',()=>{
  const samples=Array.from({length:9},(_,frame)=>({frame,clothPositions:Array.from({length:100},(_,i)=>[i===0?(frame===3?.002:frame===5?-.002:0):0,0,0,1]).flat()}));
  const m=computeWindowMotion(samples);assert.equal(m.endpointMaxDisplacementMm,0);assert.ok(m.maxDisplacementMm>3);assert.ok(m.rmsDisplacementMm<1);
});
test('bounded all-pair motion passes with exactly nine consecutive samples',()=>{
  const samples=Array.from({length:9},(_,frame)=>({frame,clothPositions:[frame%2?.0004:-.0004,0,0,1]}));
  assert.ok(computeWindowMotion(samples).rmsDisplacementMm<1);assert.throws(()=>computeWindowMotion(samples.slice(1)));samples[4].frame++;assert.throws(()=>computeWindowMotion(samples));
});
test('intermediate unsafe geometry and absent pairwise audit cannot certify final acceptance',()=>{
  for(const change of [e=>delete e.reports.motion,e=>e.reports.motion.samples[4].passed=false,e=>e.reports.motion.windows[0].rmsDisplacementMm=1.1,e=>e.reports.motion.fixture='/other.json',e=>delete e.manifest.release.windows[0].sampleFrames]){const e=acceptedEvidence();change(e);assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);}
  const e=acceptedEvidence();assert.equal(sampleGeometryPassed(e.manifest,{r:{...e.reports.r,positionsFinite:true},s:e.reports.s}).passed,true);e.reports.r.intersectingClothFaces=1;assert.equal(sampleGeometryPassed(e.manifest,{r:{...e.reports.r,positionsFinite:true},s:e.reports.s}).passed,false);
});
test('compact frozen samples never inherit runtime safety or release observations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'garment-motion-'));try{await writeFile(join(dir,'static.json'),JSON.stringify({bodyPositions:[0,0,0],runtimeSafe:true,halted:false,temporarySupportWeightsNonzero:0}));await writeFile(join(dir,'sample.json'),JSON.stringify({staticSource:'static.json',frame:1,clothPositions:[0,0,0,1]}));const f=await readFrozenSample(join(dir,'sample.json'));assert.deepEqual(f.bodyPositions,[0,0,0]);assert.equal(f.runtimeSafe,undefined);assert.equal(sampleEligibility(f),false);await writeFile(join(dir,'sample.json'),JSON.stringify({staticSource:'static.json',bodyPositions:[1,0,0]}));await assert.rejects(readFrozenSample(join(dir,'sample.json')));}finally{await rm(dir,{recursive:true,force:true});}
});
test('legacy motion evidence rejects normally without fabricated intermediate samples',async()=>{
 const report=await auditMotionWindows({frozen:'/missing.json',release:{windows:[{},{}]}},'/unused');assert.equal(report.passed,false);assert.ok(report.errors.length);
});
test('independent sample auditor recomputes coordinates and checks every intermediate geometry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'garment-window-audit-'));
 try{
  const base={inputSha256:'a'.repeat(64),sourceFingerprints:{test:'b'.repeat(64)},simulationConfig:{subSteps:40},id:'motion-test-only',pattern:{settings3d:{globalParticleDistanceOverride:15},body:{garmentCodeBody:{measurementsCm:{height:176,head_l:26,waist_line:36.8,hips_line:23,crotch_hip_diff:8}}},pieces:[{id:'probe',name:'motion test only',mainPaths:[]}],seams:[]},bodyPositions:[-.01,0,-.01,.01,0,-.01,0,0,.01,0,1.76,0],bodyIndices:[0,2,1,0,1,3,1,2,3,2,0,3],clothTriangles:[0,1,2,0],pieces:[{pieceId:'probe',start:0,count:3}],seamPairs:[],seams:Array(12).fill(-1),joints:{},simulatedSecondsPerFrame:.016};
  const state={runtimeSafe:true,halted:false,bodyContacts:true,surfaceContacts:true,selfContacts:true,selfSurfaceContacts:true,temporarySupportWeightsNonzero:0,fixedAnchorWeightsNonzero:0,fullySewn:true,maxSeamGapMm:0,gravity:[0,-9.8,0]};
  const files=[];for(let frame=0;frame<17;frame++){const file=join(dir,'frame-'+frame+'.json'),d=frame%2*.0004;await writeFile(file,JSON.stringify({...base,...state,frame,simulatedSeconds:frame*.016,clothPositions:Array.from(Float32Array.from([.20+d,1.13,0,1,.21+d,1.13,0,1,.20+d,1.14,0,1]))}));files.push({frame,file});}
  for(let i=1;i<files.length;i++){const previous=JSON.parse(await readFile(files[i-1].file,'utf8')),current=JSON.parse(await readFile(files[i].file,'utf8'));await attachTestTrajectory(dir,previous,current);await writeFile(files[i].file,JSON.stringify(current));}
  const manifest={frozen:files[16].file,motionSamples:{staticSource:files[0].file,samples:files},release:{windows:[0,8].map(fromFrame=>({fromFrame,toFrame:fromFrame+8,intervalSeconds:.128,sampleFrames:Array.from({length:9},(_,i)=>fromFrame+i)}))},openingsApplicable:false,shoulderApplicable:false,waistbandApplicable:false,requiredCoveredRegions:['waist']};
  const pass=await auditMotionWindows(manifest,join(dir,'audits'));assert.equal(pass.passed,true,JSON.stringify(pass.errors));assert.equal(pass.samples.length,17);assert.ok(pass.windows.every(w=>w.rmsDisplacementMm<1&&w.comparedFramePairs===36));
  const middle=JSON.parse(await readFile(files[4].file,'utf8'));middle.clothPositions[0]=0;middle.clothPositions[1]=.4;await writeFile(files[4].file,JSON.stringify(middle));
  const failed=await auditMotionWindows(manifest,join(dir,'audits-failed'));assert.equal(failed.passed,false);assert.ok(failed.windows[0].maxDisplacementMm>3);assert.equal(failed.windows[0].endpointMaxDisplacementMm,0);assert.equal(failed.samples.find(s=>s.frame===4).geometry.body,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

const bytesSha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function attachTestTrajectory(dir,previous,current,mutate) {
 const subSteps=current.simulationConfig.subSteps, samples=Array.from({length:subSteps+1},(_,step)=>Float32Array.from(current.clothPositions.map((value,index)=>previous.clothPositions[index]+(value-previous.clothPositions[index])*step/subSteps)));
 if(mutate)mutate(samples);
 const bytes=Buffer.concat(samples.map(p=>trajectoryNumericBytes(p))),file=join(dir,'trajectory-'+current.frame+'.f32');await writeFile(file,bytes);
 current.particleTrajectory={file,sha256:bytesSha(bytes),format:TRAJECTORY_FORMAT,sampleCount:subSteps+1,subSteps,particleCount:current.clothPositions.length/4,fromFrame:previous.frame,toFrame:current.frame,stepIndices:Array.from({length:subSteps+1},(_,i)=>i),byteLength:bytes.length,inputSha256:current.inputSha256,...trajectorySourceHashes(current),startPositionsSha256:bytesSha(trajectoryNumericBytes(samples[0])),endPositionsSha256:bytesSha(trajectoryNumericBytes(samples.at(-1)))};
 return {samples,bytes,file};
}
function trajectoryTestFrozen(frame=0){return{frame,inputSha256:'a'.repeat(64),sourceFingerprints:{test:'b'.repeat(64)},simulationConfig:{subSteps:40},bodyPositions:[0,0,0,1,0,0,0,1,0,0,0,1],bodyIndices:[0,2,1,0,1,3,1,2,3,2,0,3],clothTriangles:[0,1,2,0],seams:Array(12).fill(-1),seamPairs:[],clothPositions:[2,0,0,1,2,1,0,1,2,0,1,1]};}
test('packed corrected trajectory requires real finite-safe intermediates, not clear endpoints alone',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'garment-trajectory-'));try{
 const previous=trajectoryTestFrozen(),current=trajectoryTestFrozen(1);await attachTestTrajectory(dir,previous,current);
 let report=await auditParticleTrajectory(previous,current,join(dir,'frame1.json'));assert.equal(report.passed,true,JSON.stringify(report));assert.equal(report.geometry.trajectory.inspectedSubsteps,40);
 await attachTestTrajectory(dir,previous,current,samples=>{samples[20][0]=.2;samples[20][1]=.2;samples[20][2]=.2;});report=await auditParticleTrajectory(previous,current,join(dir,'frame1.json'));assert.equal(report.passed,false);assert.ok(report.geometry.insideParticleCount>0);assert.ok(report.geometry.sweptBodyCrossingParticleCount>0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
for(const [label,change] of [['missing',c=>delete c.particleTrajectory],['skipped substep',c=>c.particleTrajectory.stepIndices[5]=6],['source hash',c=>c.particleTrajectory.sourceFingerprintsSha256='0'.repeat(64)],['body topology hash',c=>c.particleTrajectory.bodyIndicesSha256='0'.repeat(64)],['binary SHA',c=>c.particleTrajectory.sha256='0'.repeat(64)],['endpoint hash',c=>c.particleTrajectory.endPositionsSha256='0'.repeat(64)],['header sample count',c=>c.particleTrajectory.sampleCount=40]])test('packed trajectory rejects '+label,async()=>{const dir=await mkdtemp(join(tmpdir(),'garment-trace-bad-'));try{const previous=trajectoryTestFrozen(),current=trajectoryTestFrozen(1);await attachTestTrajectory(dir,previous,current);change(current);assert.equal((await auditParticleTrajectory(previous,current,join(dir,'frame1.json'))).passed,false);}finally{await rm(dir,{recursive:true,force:true});}});
for(const [label,mutate]of[['NaN',s=>s[5][0]=NaN],['inverse mass',s=>s[5][3]=2],['published endpoint mismatch',s=>s.at(-1)[0]=2.1]])test('packed trajectory rejects '+label,async()=>{const dir=await mkdtemp(join(tmpdir(),'garment-trace-bad-'));try{const previous=trajectoryTestFrozen(),current=trajectoryTestFrozen(1);await attachTestTrajectory(dir,previous,current,mutate);assert.equal((await auditParticleTrajectory(previous,current,join(dir,'frame1.json'))).passed,false);}finally{await rm(dir,{recursive:true,force:true});}});
test('packed trajectory rejects truncated bytes even with the updated file SHA',async()=>{const dir=await mkdtemp(join(tmpdir(),'garment-trace-bad-'));try{const previous=trajectoryTestFrozen(),current=trajectoryTestFrozen(1),a=await attachTestTrajectory(dir,previous,current);const truncated=a.bytes.subarray(0,-4);await writeFile(a.file,truncated);current.particleTrajectory.sha256=bytesSha(truncated);assert.equal((await auditParticleTrajectory(previous,current,join(dir,'frame1.json'))).passed,false);}finally{await rm(dir,{recursive:true,force:true});}});
test('asserted motion pass cannot hide missing or unsafe substep audit',()=>{for(const change of [m=>delete m.trajectories,m=>m.trajectories[4].passed=false,m=>m.trajectories[4].endpointBindingVerified=false,m=>m.trajectories[4].geometry.trajectory.inspectedSubsteps=39]){const e=acceptedEvidence();change(e.reports.motion);assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);}});
test('substep sweeps reject true tunnelling even when every stored point is outside',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'garment-trace-sweep-'));try{
 const previous=trajectoryTestFrozen(),current=trajectoryTestFrozen(1);
 previous.clothPositions=[2,.125,.125,1];current.clothPositions=[2,.125,.125,1];previous.clothTriangles=[];current.clothTriangles=[];previous.seams=[-1,-1,-1,-1];current.seams=[-1,-1,-1,-1];
 await attachTestTrajectory(dir,previous,current,samples=>{samples[20][0]=-2;});
 const report=await auditParticleTrajectory(previous,current,join(dir,'frame1.json'));
 assert.equal(report.passed,false);assert.equal(report.geometry.insideParticleCount,0);assert.equal(report.geometry.bodyCrossingTriangleCount,0);assert.ok(report.geometry.sweptBodyCrossingParticleCount>0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('a fully observed safe curved path is distinguished from its crossing coarse chord',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'garment-trace-curve-'));try{
 const previous=trajectoryTestFrozen(),current=trajectoryTestFrozen(1);
 previous.clothPositions=[2,.125,.125,1];current.clothPositions=[-2,.125,.125,1];previous.clothTriangles=[];current.clothTriangles=[];previous.seams=[-1,-1,-1,-1];current.seams=[-1,-1,-1,-1];
 await attachTestTrajectory(dir,previous,current,samples=>{for(let i=0;i<samples.length;i++){const x=i<=10?2:i<=30?2-(i-10)*.2:-2,y=i<=10?.125+i*.1875:i<=30?2:2-(i-30)*.1875;samples[i][0]=x;samples[i][1]=y;}});
 const report=await auditParticleTrajectory(previous,current,join(dir,'frame1.json'));assert.equal(report.passed,true,JSON.stringify(report));assert.equal(report.geometry.sweptBodyCrossingParticleCount,0);
 const {createTrajectoryGuard}=await import('./particle-trajectory-audit.mjs');const coarse=(await createTrajectoryGuard(current)).inspect(current.clothPositions,previous.clothPositions);assert.equal(coarse.safe,false);assert.ok(coarse.sweptBodyCrossingParticleCount>0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

// Genuine initial SI provenance drives these policy/consumer controls; acceptedEvidence
// remains a synthetic evaluator unit fixture, never a passing actual garment claim.
const genuineSIMetadata = JSON.parse(await readFile(new URL('./fixtures/source-si-acceptance-metadata.json', import.meta.url), 'utf8'));
for (const metadata of genuineSIMetadata.fixtures) {
  test(metadata.id+' SI metadata cannot bypass completion when legacy stretch policy is absent', () => {
    const e=completeSourceEvidence(); delete e.reports.f.sourceStretchPolicy;
    Object.assign(e.reports.f,structuredClone(metadata),{sourceAssemblyRequired:false,sourceAssemblyComplete:false});
    assert.equal(sampleEligibility(e.reports.f),false);
    assert.equal(evaluateAcceptance(e.manifest,e.reports).gates.find(g=>g.name==='finalSupportFreeRuntimeSafe').status,'fail');
    for(const complete of [null,undefined,1,'true']) {
      e.reports.f.sourceAssemblyComplete=complete;
      assert.equal(sampleEligibility(e.reports.f),false);
    }
    e.reports.f.sourceAssemblyComplete=true;
    assert.equal(sampleEligibility(e.reports.f),true);
    assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,true);
    e.reports.motion.samples[7].sourceAssemblyComplete=false;
    assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
  });
}
test('manifest explicit assembly requirement cannot be disabled by a native-looking sample',()=>{
  const e=acceptedEvidence();e.manifest.sourceAssemblyRequired=true;
  assert.equal(sampleEligibility({...e.reports.f,maxSeamGapMm:2},e.manifest),false);
  assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
});
test('SI completion does not hide support or bilateral wrist failure',()=>{
  const e=completeSourceEvidence();delete e.reports.f.sourceStretchPolicy;
  e.reports.f.sourcePhysicalMaterialPolicy=genuineSIMetadata.fixtures[1].sourcePhysicalMaterialPolicy;
  assert.equal(sampleEligibility({...e.reports.f,temporarySupportWeightsNonzero:1}),false);
  e.manifest.openingsApplicable=true;e.reports.o={fixture:e.manifest.frozen,sides:Object.fromEntries(['Left','Right'].map(side=>[side,{bodyCutPointCount:3,bodyCutPointsOutsideOpening:0,minimumProjectedOpeningClearanceMm:0,handIntersectingClothFaces:0,wristForearmIntersectingClothFaces:0,maxHemJoinGapMm:2}]))};
  assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,true);
  e.reports.o.sides.Right.minimumProjectedOpeningClearanceMm=-.001;
  assert.equal(evaluateAcceptance(e.manifest,e.reports).gates.find(g=>g.name==='wristOpenings').status,'fail');
});
test('compact SI samples bind policy and execution context but never inherit completion or frame receipts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'garment-si-policy-'));
 try {
  const base={...genuineSIMetadata.fixtures[0],sourcePhysicalMembrane:{policySha256:'a'},sourceDeltaPolicy:{revision:'delta'},sourceJointEnginePolicy:{revision:'joint'},sourceJointPressureBinding:{receiptSha256:'b'},sourceExecutionBinding:{hostSha256:'c'},bodyPositions:[0,0,0],sourceAssemblyRequired:true,sourceAssemblyComplete:true,physicalBackendFrameCommitReceipt:{committed:true}};
  await writeFile(join(dir,'static.json'),JSON.stringify(base));
  await writeFile(join(dir,'sample.json'),JSON.stringify({staticSource:'static.json',frame:1,clothPositions:[0,0,0,1]}));
  const sample=await readFrozenSample(join(dir,'sample.json'));
  for(const key of ['sourcePhysicalMembrane','sourceDeltaPolicy','sourceJointEnginePolicy','sourceJointPressureBinding','sourceExecutionBinding','sourceBodyMetadata'])assert.deepEqual(sample[key],base[key]);
  assert.equal(sample.sourceAssemblyComplete,undefined);assert.equal(sample.physicalBackendFrameCommitReceipt,undefined);
  for(const key of ['sourcePhysicalMaterialPolicy','sourcePhysicalMembrane','sourceDeltaPolicy','sourceJointEnginePolicy','sourceJointPressureBinding','sourceExecutionBinding','sourceBodyMetadata','bodyPositions']){
   await writeFile(join(dir,'sample.json'),JSON.stringify({staticSource:'static.json',frame:1,[key]:null}));
   await assert.rejects(readFrozenSample(join(dir,'sample.json')),new RegExp('immutable '+key));
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

for(const key of ['sourceDeltaPolicy','sourcePhysicalMaterialPolicySha256','sourceJointPressureBinding','sourceExecutionBinding'])test('source-only '+key+' alone cannot bypass mandatory completion',()=>{
 const e=acceptedEvidence();e.reports.f[key]=key.endsWith('Sha256')?'a'.repeat(64):{policy:'source-only-unit-provenance'};
 e.reports.f.sourceAssemblyRequired=false;
 assert.equal(requiresSourceAssemblyEvidence(e.reports.f),true);
 assert.equal(sampleEligibility({...e.reports.f,maxSeamGapMm:2}),false);
 assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,false);
});
test('native absent/null source provenance remains native and explicitfalse has no new requirement',()=>{
 const native={sourceAssemblyRequired:false,sourceDeltaPolicy:null,sourcePhysicalMaterialPolicy:null,sourceJointEnginePolicy:null,sourceJointPressureBinding:null,sourceExecutionBinding:null};
 assert.equal(requiresSourceAssemblyEvidence(native),false);
 const e=acceptedEvidence();Object.assign(e.reports.f,native);assert.equal(evaluateAcceptance(e.manifest,e.reports).accepted,true);
});
