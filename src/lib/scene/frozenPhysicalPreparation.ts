import type {PreparedCloth} from '@seamer/cloth-sim';
import type {Pattern} from '@seamer/pattern-model';
import {prepareSourcePhysicalMembrane,validateSourcePhysicalMembrane,type SourceSheetAssignment,type PreparedSourceMembrane} from '../sourcePhysicalRender/sourcePhysicalMembrane';
import {actualPhysicalInverseMassBits} from '../sourcePhysicalRender/actualPhysicalMassBits.mjs';
import {canonicalSha256} from '$lib/utils/sourceGatherEvidence';
export interface FrozenPhysicalMaterialEvidence {
 sourcePhysicalMaterialPolicySha256?:string;
 sourcePhysicalMaterialPreparationPolicy?:{pieces:SourceSheetAssignment[];[key:string]:unknown};
 sourcePhysicalMaterialPolicy?:{policySha256:string;revision:string;[key:string]:unknown};
}
/** Reconstruct material on a PRIVATE copy of actual finalized app geometry.
 * No XYZ, cut/rest/body/topology/support/holds/document/completion mutation. */
export async function prepareFrozenPhysicalMaterial(evidence:FrozenPhysicalMaterialEvidence,pattern:Pattern,prepared:PreparedCloth):Promise<PreparedCloth>{
 const has=[evidence.sourcePhysicalMaterialPolicySha256,evidence.sourcePhysicalMaterialPreparationPolicy,evidence.sourcePhysicalMaterialPolicy].some(value=>value!==undefined);
 if(!has)return prepared;
 const hash=evidence.sourcePhysicalMaterialPolicySha256,policy=evidence.sourcePhysicalMaterialPreparationPolicy,executed=evidence.sourcePhysicalMaterialPolicy;
 if(!hash||!/^[a-f0-9]{64}$/.test(hash)||!policy||!executed||executed.policySha256!==hash||executed.revision!=='source-objective-SI-membrane-benchmark-v3'||!Array.isArray(policy.pieces)||!policy.pieces.length)throw Error('Complete exact frozen SI policy required');
 if(!prepared.collisionSafety||!pattern.garmentCodeSource)throw Error('Frozen SI rendering requires actual source geometry');
 const assignments=policy.pieces.map(({pieceId,grainDirection,parameters})=>({pieceId,grainDirection,parameters}));
 for(const a of assignments){const piece=pattern.pieces.find(p=>p.id===a.pieceId.replace(/#M$/,''));if(!piece||!Object.is(a.grainDirection[0],piece.grainVector.x)||!Object.is(a.grainDirection[1],piece.grainVector.y))throw Error('Frozen SI grain differs from authored source');}
 const simData=await prepareSourcePhysicalMembrane(prepared.simData,assignments),material=validateSourcePhysicalMembrane(simData);
 if(!material||material.policySha256!==hash||await canonicalSha256((simData as typeof simData & {sourcePhysicalMembrane:PreparedSourceMembrane}).sourcePhysicalMembrane.policy)!==await canonicalSha256(policy))throw Error('Frozen SI policy differs from actual prepared source');
 actualPhysicalInverseMassBits(simData); // Exact lowercase bytehex, actualW/fixed -0.
 const before=prepared.simData.positions,after=simData.positions;
 for(let i=0;i<before.length;i++)if(i%4!==3||before[i]===0)if(!Object.is(before[i],after[i]))throw Error('Frozen SI preparation changed actual XYZ/fixed holds');
 return{...prepared,simData};
}
