import type { PreparedCloth } from '@seamer/cloth-sim';
import { SIM_CONFIG } from '@seamer/cloth-sim';
import { applySourceContactPolicy, type SourceContactConfigOptions } from '@seamer/cloth-sim';
import { SourceStagingController } from '@seamer/cloth-sim';
import { physicalSeamStitchIndices } from '@seamer/cloth-sim';
import type { CollisionSeamActivation } from '@seamer/cloth-sim';

/** Shared authoritative physical link dictionary. Identity pairs are explicitly logical; no
 * ordinal or planned-next mask may masquerade as actual first-stamped sewing evidence. */
export function sourceCollisionPreparation(prepared:PreparedCloth,options:SourceContactConfigOptions={}) {
  const data=prepared.simData;
  const mapped=physicalSeamStitchIndices(data.seams,data.seamOrder,data.seamPairsBySeam,data.seamStitchRanges);
  const dictionary={stitchCount:data.stitchCount,seamPairsBySeam:data.seamPairsBySeam.map((group,index)=>({seamId:group.seamId,index,
    pairs:Array.from(group.pairs),stitchIndices:Array.from(mapped[index]),stitchIndexKinds:Array.from(mapped[index],(_,pair)=>
      group.pairs[pair*2]===group.pairs[pair*2+1]?'identity-logical' as const:'reciprocal-first-stamp' as const)}))};
  const contacts=applySourceContactPolicy(SIM_CONFIG,prepared.contactPolicy??{policy:'unchanged',reason:'not-active-source',materialIds:[],preservedExplicitPadding:[]},options);
  const sourceMode=prepared.collisionSafety&&data.sourceStretchPolicy&&options.sourceStretchSewingMode==='interleaved'?'interleaved':'sequential';
  const explicit=sourceMode!=='sequential'||options.explicitSeamIterations||options.explicitSubstepContactIterations
    ||options.explicitFinalContactIterations||Object.values(options.explicitPadding??{}).some(Boolean)
    ||contacts.contactPolicy.preservedExplicitPadding.length>0||contacts.contactPolicy.preservedExplicitSeamIterations
    ||contacts.contactPolicy.preservedExplicitSubstepContactIterations||contacts.contactPolicy.preservedExplicitFinalContactIterations;
  const controller=data.sourceStaging&&!explicit?new SourceStagingController(data.sourceStaging):null;
  const initialActivation:CollisionSeamActivation={revision:0,activeSeams:controller?.nextActiveSeamMask
    ??new Uint32Array(dictionary.seamPairsBySeam.length).fill(1),sewnUpTo:data.stitchCount};
  return {dictionary,initialActivation};
}

/** Published geometry uses last ACCEPTED context; an unaccepted planned-next activation is
 * deliberately absent from this API. Constructor/reset static proof is separately admissible. */
export function visibleSourceSeamActivation(initial:CollisionSeamActivation,accepted?:CollisionSeamActivation|null,
  currentStaticReport?:{safe:boolean;seamActivation?:{revision:number;activeSeams:ArrayLike<number>;sewnUpTo:number}}|null):CollisionSeamActivation {
  const activation=accepted??(currentStaticReport?.safe?currentStaticReport.seamActivation:undefined)??initial;
  return {revision:activation.revision,activeSeams:Uint32Array.from(activation.activeSeams),sewnUpTo:activation.sewnUpTo};
}

export function visibleSourceCollisionPreparation(prepared:PreparedCloth,options:SourceContactConfigOptions={},
  live?:{prepared:PreparedCloth;simData:PreparedCloth['simData'];lastCollisionSeamActivation:CollisionSeamActivation|null;
    safetyReport:{safe:boolean;seamActivation?:{revision:number;activeSeams:ArrayLike<number>;sewnUpTo:number}}|null}) {
  const context=sourceCollisionPreparation(prepared,options);
  const same=live?.prepared===prepared&&live.simData.triangles===prepared.simData.triangles
    &&live.simData.seams===prepared.simData.seams&&live.simData.seamOrder===prepared.simData.seamOrder;
  return {dictionary:context.dictionary,activation:visibleSourceSeamActivation(context.initialActivation,
    same?live!.lastCollisionSeamActivation:null,same?live!.safetyReport:null)};
}
