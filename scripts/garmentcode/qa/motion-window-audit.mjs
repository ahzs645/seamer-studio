import { requiresSourceAssemblyEvidence } from './source-assembly-evidence.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFrozenSample, IMMUTABLE_SAMPLE_FIELDS } from './frozen-sample.mjs';
import { auditShoulderWear } from './shoulder-wear-guard.mjs';
import { auditParticleTrajectory, createTrajectoryGuard } from './particle-trajectory-audit.mjs';
const run = promisify(execFile), directory = fileURLToPath(new URL('.',import.meta.url));
export function computeWindowMotion(samples) {
    if (!Array.isArray(samples) || samples.length !== 9) throw Error('Exactly nine observed samples are required');
    const length=samples[0]?.clothPositions?.length;
    if (!length || length%4 || samples.some((s,i)=>!Number.isInteger(s.frame)||s.frame!==samples[0].frame+i||s.clothPositions?.length!==length||!s.clothPositions.every(Number.isFinite))) throw Error('Missing, nonconsecutive, or invalid samples');
    let rms=0,maximum=0,endpointRms=0,endpointMaximum=0,pairs=0;
    for(let a=0;a<9;a++) for(let b=a+1;b<9;b++) {
        let squared=0,maxSquared=0;
        for(let i=0;i<length;i+=4) {
            let d=0;for(let k=0;k<3;k++)d+=(samples[a].clothPositions[i+k]-samples[b].clothPositions[i+k])**2;
            squared+=d;maxSquared=Math.max(maxSquared,d);
        }
        const pairRms=1000*Math.sqrt(squared/(length/4)),pairMax=1000*Math.sqrt(maxSquared);
        rms=Math.max(rms,pairRms);maximum=Math.max(maximum,pairMax);pairs++;
        if(a===0&&b===8){endpointRms=pairRms;endpointMaximum=pairMax;}
    }
    return {motionMetric:'maximum-all-frame-pairs',comparedFramePairs:pairs,rmsDisplacementMm:rms,maxDisplacementMm:maximum,endpointRmsDisplacementMm:endpointRms,endpointMaxDisplacementMm:endpointMaximum};
}
export function sampleEligibility(f, manifest) {
    return (!requiresSourceAssemblyEvidence(f, manifest)||f.sourceAssemblyComplete===true)&&f.runtimeSafe===true&&f.halted===false&&f.bodyContacts===true&&f.surfaceContacts===true&&f.selfContacts===true&&f.selfSurfaceContacts===true&&f.temporarySupportWeightsNonzero===0&&f.fixedAnchorWeightsNonzero===0&&f.fullySewn===true&&Number.isFinite(f.maxSeamGapMm)&&f.maxSeamGapMm<=3&&Array.isArray(f.gravity)&&f.gravity.length===3&&f.gravity.every((v,i)=>Number.isFinite(v)&&Math.abs(v-[0,-9.8,0][i])<1e-8);
}
export function sampleGeometryPassed(manifest,{r,s,o,shoulder}) {
    const body=r?.positionsFinite===true&&r.bodyBoundaryEdges===0&&r.bodyNonmanifoldEdges===0&&r.parityDisagreements===0&&r.insideParticleCount===0&&r.intersectingClothFaces===0&&Number.isFinite(r.maxSeamGapMm)&&r.maxSeamGapMm<=3;
    const self=s?.nonadjacentPenetrations===0&&s.unclosedPairedSeamContacts===0&&s.seamNeighborhoodMm<=5&&s.seamClosureMm<=3;
    const coverage=Array.isArray(manifest.requiredCoveredRegions)&&manifest.requiredCoveredRegions.length>0&&manifest.requiredCoveredRegions.every(name=>r?.regions?.[name]?.available===true&&r.regions[name].coveredClothFaces>0);
    const openings=manifest.openingsApplicable===false||(manifest.openingsApplicable===true&&['Left','Right'].every(side=>{const a=o?.sides?.[side];return a?.bodyCutPointCount>0&&a.bodyCutPointsOutsideOpening===0&&Number.isFinite(a.minimumProjectedOpeningClearanceMm)&&a.minimumProjectedOpeningClearanceMm>=0&&a.handIntersectingClothFaces===0&&a.wristForearmIntersectingClothFaces===0&&Number.isFinite(a.maxHemJoinGapMm)&&a.maxHemJoinGapMm<=3;}));
    const worn=manifest.shoulderApplicable===false||(manifest.shoulderApplicable===true&&shoulder?.anatomicalReferencesVerified===true&&shoulder.bilateralSemanticCoverage===true&&shoulder.allShoulderPairsWorn===true&&shoulder.rows?.length>0&&shoulder.rows.every(r=>r.sourceSpanVerified===true&&r.shoulderCap&&Number.isFinite(r.surfaceClearanceMm)&&r.surfaceClearanceMm<=10&&Number.isFinite(r.heightLossMm)&&r.heightLossMm<=10));
    return {passed:!!(body&&self&&coverage&&openings&&worn),body:!!body,self:!!self,coverage:!!coverage,openings:!!openings,worn:!!worn};
}
export async function auditMotionWindows(manifest,outputDirectory) {
    const report={fixture:manifest.frozen,method:'Independent exact nine-sample all-frame-pair motion and per-sample finite geometry audit',passed:false,sourceBindingVerified:false,windows:[],samples:[],trajectories:[],errors:[]};
    try {
        const selected=manifest.release?.windows?.slice(-2),description=manifest.motionSamples;
        if(selected?.length!==2||!description?.staticSource||!Array.isArray(description.samples))throw Error('Missing two exact sampled release windows');
        const base=await readFrozenSample(description.staticSource),final=await readFrozenSample(manifest.frozen),byFrame=new Map();
        for(const ref of description.samples){if(!Number.isInteger(ref.frame)||typeof ref.file!=='string'||byFrame.has(ref.frame))throw Error('Invalid or duplicate sample reference');const f=await readFrozenSample(ref.file);if(f.frame!==ref.frame)throw Error('Sample frame annotation mismatch');byFrame.set(ref.frame,{f,file:ref.file});}
        const expectedFrames=[...new Set(selected.flatMap(w=>Array.from({length:9},(_,i)=>w.fromFrame+i)))];
        if(expectedFrames.length!==17||byFrame.size!==17||expectedFrames.some(n=>!byFrame.has(n))||selected[0].toFrame!==selected[1].fromFrame||selected[1].toFrame!==final.frame)throw Error('Samples must cover exactly two contiguous final eight-frame windows');
        for(const key of IMMUTABLE_SAMPLE_FIELDS){if(JSON.stringify(base[key])!==JSON.stringify(final[key]))throw Error('Final static-source mismatch '+key);for(const {f} of byFrame.values())if(JSON.stringify(f[key])!==JSON.stringify(base[key]))throw Error('Sample static-source mismatch '+key);}
        const last=byFrame.get(final.frame).f;if(JSON.stringify(last.clothPositions)!==JSON.stringify(final.clothPositions))throw Error('Final sample coordinates differ from final frozen checkpoint');
        report.sourceBindingVerified=true;report.staticSource=description.staticSource;
        report.sourceAssemblyRequired=requiresSourceAssemblyEvidence(final, manifest);
        await mkdir(outputDirectory,{recursive:true});
        for(const n of expectedFrames){
            const {f,file}=byFrame.get(n),stem=join(outputDirectory,'motion-sample-'+n),rfile=stem+'-regions.json',sfile=stem+'-self.json',ofile=stem+'-openings.json',shfile=stem+'-shoulders.json';
            await run(process.execPath,[join(directory,'region-guard.mjs'),file,rfile],{maxBuffer:1024*1024});
            await run(process.execPath,[join(directory,'inspect-all-self-contacts.mjs'),file,rfile,sfile],{maxBuffer:1024*1024});
            let o=null,shoulder=null;
            if(manifest.openingsApplicable===true){await run(process.execPath,[join(directory,'open-sleeve-guard.mjs'),file,ofile],{maxBuffer:1024*1024});o=JSON.parse(await readFile(ofile,'utf8'));}
            if(manifest.shoulderApplicable===true){shoulder=auditShoulderWear(f,file);await writeFile(shfile,JSON.stringify(shoulder,null,2));}
            const r=JSON.parse(await readFile(rfile,'utf8')),s=JSON.parse(await readFile(sfile,'utf8')),geometry=sampleGeometryPassed(manifest,{r,s,o,shoulder});
            let waist=true;
            if(manifest.waistbandApplicable===true){const w=manifest.waistSupport;waist=Array.isArray(w?.particles)&&w.particles.length>0&&w.semanticTargetYs?.length===w.particles.length&&w.firstFullyReleasedYs?.length===w.particles.length&&w.particles.every((id,i)=>Number.isInteger(id)&&Number.isFinite(f.clothPositions[id*4+1])&&Number.isFinite(w.semanticTargetYs[i])&&Number.isFinite(w.firstFullyReleasedYs[i])&&Math.abs(f.clothPositions[id*4+1]-w.semanticTargetYs[i])<=.01&&Math.abs(f.clothPositions[id*4+1]-w.firstFullyReleasedYs[i])<=.01);}
            const sha256=createHash('sha256').update(await readFile(file)).digest('hex');
            report.samples.push({frame:n,file,sha256,sourceAssemblyComplete:f.sourceAssemblyComplete??null,eligible:sampleEligibility(f, manifest),geometry,waist,passed:sampleEligibility(f, manifest)&&geometry.passed&&waist,reports:{regionGuard:rfile,selfContacts:sfile,openingGuard:o?ofile:null,shoulderGuard:shoulder?shfile:null}});
        }
        const trajectoryGuard=await createTrajectoryGuard(final);
        for(let i=1;i<expectedFrames.length;i++){
            const before=byFrame.get(expectedFrames[i-1]),after=byFrame.get(expectedFrames[i]);
            const trajectory=await auditParticleTrajectory(before.f,after.f,after.file,trajectoryGuard);
            const file=join(outputDirectory,'particle-trajectory-'+after.f.frame+'.json');
            await writeFile(file,JSON.stringify(trajectory,null,2));report.trajectories.push({...trajectory,report:file});
        }
        for(const w of selected){const frames=Array.from({length:9},(_,i)=>w.fromFrame+i);if(w.toFrame!==w.fromFrame+8||JSON.stringify(w.sampleFrames)!==JSON.stringify(frames))throw Error('Window sample IDs are missing or incorrect');const samples=frames.map(n=>byFrame.get(n).f),metrics=computeWindowMotion(samples),step=final.simulatedSecondsPerFrame;const times=Number.isFinite(step)&&step>0&&samples.every(s=>Number.isFinite(s.simulatedSeconds)&&Math.abs(s.simulatedSeconds-s.frame*step)<1e-9)&&Math.abs(w.intervalSeconds-8*step)<1e-9&&8*step+1e-9>=.128;report.windows.push({fromFrame:w.fromFrame,toFrame:w.toFrame,sampleFrames:frames,...metrics,allSampleGuardsPassed:frames.every(n=>report.samples.find(s=>s.frame===n)?.passed),passed:times&&metrics.rmsDisplacementMm<=1&&metrics.maxDisplacementMm<=3&&frames.every(n=>report.samples.find(s=>s.frame===n)?.passed)});}
        report.passed=report.sourceBindingVerified&&report.windows.length===2&&report.windows.every(w=>w.passed)&&report.trajectories.length===16&&report.trajectories.every(t=>t.passed);
        report.trajectoryMethod='SHA-verified actual corrected substep paths rechecked with the shared CPU finite guard, independently of the GPU solver; this shares the runtime guard algorithm.';
    }catch(error){report.errors.push(error.message);}
    return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const manifest=JSON.parse(await readFile(process.argv[2],'utf8')),report=await auditMotionWindows(manifest,join(dirname(resolve(process.argv[3])),'motion-sample-audits'));await writeFile(process.argv[3],JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,windows:report.windows,sampleCount:report.samples.length,errors:report.errors}));}
