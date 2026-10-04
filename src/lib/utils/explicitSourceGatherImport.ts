/** Explicit original authored-source import; trust is supplied by deployment code. */
import type {Pattern} from '@seamer/pattern-model';
import {sourceGatherIdentity} from '@seamer/cloth-sim';
import {isGarmentCodeFormat} from './importGarmentCode';
import {approveGeneratedGather,canonicalSha256,decodeOriginalGatherDocument,encodeOriginalGatherDocument} from './sourceGatherEvidence';
import {sourceGatherRegistry} from './sourceGatherPreparation';
import {PINNED_GATHER_PROGRAMS} from './pinnedGatherPrograms';
export interface ExplicitSourceImportOwner {
 stillCurrent:()=>boolean;
 confirmImport:(options:{title:string;message:string;confirmLabel:string;cancelLabel:string})=>Promise<boolean>;
}
export async function importExplicitSourceGather(raw:unknown,pattern:Pattern,owner:ExplicitSourceImportOwner):Promise<Pattern|null>{
 if(!isGarmentCodeFormat(raw)||raw.properties?.garmentcode_gather_evidence===undefined)return pattern;
 const savedRaw=encodeOriginalGatherDocument(raw),original=decodeOriginalGatherDocument(savedRaw),document=structuredClone(pattern),identity=sourceGatherIdentity(pattern),body=JSON.stringify(pattern.body),rawText=JSON.stringify(savedRaw),rawSha=await canonicalSha256(savedRaw);
 const guardedCurrent=()=>owner.stillCurrent()===true&&sourceGatherIdentity(pattern)===identity&&JSON.stringify(pattern.body)===body&&JSON.stringify(encodeOriginalGatherDocument(raw))===rawText;
 const current=async()=>{if(!guardedCurrent()||await canonicalSha256(encodeOriginalGatherDocument(raw))!==rawSha||!guardedCurrent())throw Error('The document changed during source import. Choose the file again.');};
 await current();
 // Validate claimed programs, full original cuts, resolved style/body and gathers
 // before asking. This pure check cannot add a registry entry or approval ledger.
 const trust={origin:'explicit-authored-import' as const,...PINNED_GATHER_PROGRAMS};
 const checked=await approveGeneratedGather(original,document,trust);await current();
 if(!checked.provenance||!checked.scope.approvedEvidence)throw Error('This file has no verified source sewing information.');
 const confirmed=await owner.confirmImport({title:'Import verified source',message:'This file contains verified source sewing information. Import its original panels and body measurements with those sewing details?',confirmLabel:'Import verified source',cancelLabel:'Cancel'});
 await current();if(!confirmed)return null;
 const provenance=await sourceGatherRegistry.register(original,document,trust,guardedCurrent);await current();
 if(!provenance||!document.garmentCodeSource)throw Error('Source import verification failed.');
 document.garmentCodeSource.gatherProvenance=provenance;document.garmentCodeSource.gatherSourceDocument=savedRaw;
 return document;
}
