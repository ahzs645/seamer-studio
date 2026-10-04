import type { Pattern } from '@seamer/pattern-model';
import { activeGarmentCodeBody } from '@seamer/avatar';
import { sourceGatherIdentity, type GatherBuildScope } from '@seamer/cloth-sim';
import { approveGeneratedGather, canonicalSha256, decodeOriginalGatherDocument, encodeOriginalGatherDocument, type GatherTrust, type ValidatedGatherProvenance } from './sourceGatherEvidence';

/** Session-owned approvals are not inferred from persisted document flags. The exact source
 * identity lets immutable editor copies reuse approval while a cut/placement edit invalidates it. */
export class GatherPreparationRegistry {
  private readonly entries=new Map<string,{scope:GatherBuildScope;provenance:ValidatedGatherProvenance}>();
  constructor(private readonly ledger?:GatherApprovalLedger) {}
  async register(raw:unknown,pattern:Pattern,trust:GatherTrust,stillCurrent:()=>boolean=()=>true):Promise<ValidatedGatherProvenance|null> {
    if(stillCurrent()!==true)return null;
    const identity=sourceGatherIdentity(pattern),body=JSON.stringify(pattern.body);
    const result=await approveGeneratedGather(decodeOriginalGatherDocument(encodeOriginalGatherDocument(raw)),
      JSON.parse(JSON.stringify(pattern)) as Pattern,structuredClone(trust));
    if(stillCurrent()!==true||sourceGatherIdentity(pattern)!==identity||JSON.stringify(pattern.body)!==body)return null;
    if(result.provenance&&result.scope.approvedEvidence) {
      if(stillCurrent()!==true)return null;
      await this.ledger?.put(result.provenance.evidenceSha256,structuredClone(result.provenance),stillCurrent);
      if(stillCurrent()!==true||sourceGatherIdentity(pattern)!==identity||JSON.stringify(pattern.body)!==body)return null;
      this.entries.set(result.scope.approvedEvidence.sourceIdentity,structuredClone({scope:result.scope,provenance:result.provenance}));
    }
    return result.provenance;
  }
  lookup(pattern:Pattern):GatherBuildScope|undefined {
    if(pattern.pieces.some(piece=>(piece.settings3d as typeof piece.settings3d & {savedSourceGatherIntent?:string}).savedSourceGatherIntent==='manual'))return undefined;
    const entry=this.entries.get(sourceGatherIdentity(pattern));
    if(!entry)return undefined;
    return {...structuredClone(entry.scope),sourceBodyActive:!!activeGarmentCodeBody(pattern.body)};
  }
  clear():void {this.entries.clear();}
  /** A persisted claim is insufficient. Require an earlier explicit local approval, then
   * revalidate original cuts, current imported geometry/body, programs/style and evidence. */
  async revalidateSaved(pattern:Pattern,pins:Omit<GatherTrust,'origin'>,stillCurrent:()=>boolean=()=>true):Promise<ValidatedGatherProvenance|null> {
    const source=pattern.garmentCodeSource as (Pattern['garmentCodeSource'] & {
      gatherSourceDocument?:unknown;gatherProvenance?:ValidatedGatherProvenance})|undefined;
    const claim=source?.gatherProvenance;
    if(!source?.gatherSourceDocument||!claim||!this.ledger||!/^[a-f0-9]{64}$/.test(claim.evidenceSha256))return null;
    const identity=sourceGatherIdentity(pattern),body=JSON.stringify(pattern.body);
    const earlier=await this.ledger.get(claim.evidenceSha256);
    if(!earlier||await canonicalSha256(earlier)!==await canonicalSha256(claim))return null;
    try {
      const raw=decodeOriginalGatherDocument(decodeOriginalGatherDocument(encodeOriginalGatherDocument(source.gatherSourceDocument)));
      const result=await approveGeneratedGather(raw,pattern,{...pins,origin:earlier.origin});
      if(!result.provenance||!result.scope.approvedEvidence||await canonicalSha256(result.provenance)!==await canonicalSha256(earlier)
        ||!stillCurrent()||sourceGatherIdentity(pattern)!==identity||JSON.stringify(pattern.body)!==body)return null;
      this.entries.set(identity,structuredClone({scope:result.scope,provenance:result.provenance}));
      return structuredClone(result.provenance);
    } catch { return null; }
  }
}

export interface GatherApprovalLedger {
  get(evidenceSha256:string):Promise<ValidatedGatherProvenance|null>;
  put(evidenceSha256:string,value:ValidatedGatherProvenance,stillCurrent?:()=>boolean):Promise<void>;
}
/** Only the explicit approval method writes this local ledger. Imported document claims never do. */
export class LocalGatherApprovalLedger implements GatherApprovalLedger {
  async get(hash:string):Promise<ValidatedGatherProvenance|null> {
    try {const value=globalThis.localStorage?.getItem('seamer:approved-source-gather:'+hash);return value?JSON.parse(value):null;}
    catch {return null;}
  }
  async put(hash:string,value:ValidatedGatherProvenance,stillCurrent:()=>boolean=()=>true):Promise<void> {
    if(stillCurrent()!==true)return;
    try {globalThis.localStorage?.setItem('seamer:approved-source-gather:'+hash,JSON.stringify(value));}
    catch { /* Storage unavailable: current session remains valid; reopening needs explicit approval. */ }
  }
}

/** Numerical meshes containing free M nodes cannot resume through the old stride-5 cache
 * decoder, which does not retain the original separate stitch-edge map or captured masses.
 * Reassemble every free source piece together; keep the original document/held intent intact. */
export function compatibleSourceGatherCheckpoint(pattern:Pattern,scope:GatherBuildScope|undefined,
  options:{fromArrangement?:boolean}={}):Pattern {
  const hasRefinedCache=pattern.pieces.some(piece=>!!(piece.settings3d as typeof piece.settings3d & {savedSourceGatherPolicy?:unknown}).savedSourceGatherPolicy);
  const hasCachedPositions=pattern.pieces.some(piece=>piece.settings3d.savedPositions.length>0);
  if(!pattern.garmentCodeSource)return pattern;
  // A deliberate fresh arrangement never reads stride-5 cached points. Do not silently
  // reinterpret a free-midpoint mesh through the old decoder under a new held/manual mode.
  if(options.fromArrangement)return pattern;
  const excluded=!activeGarmentCodeBody(pattern.body)||pattern.pieces.some(piece=>!piece.settings3d.arrangement.sourcePlacement)
    ||scope?.manualRecording||scope?.explicitSettings||pattern.assembly||pattern.settings3d.fixTop
    ||pattern.pieces.some(piece=>piece.settings3d.savedDrapeState==='held'||piece.settings3d.frozen
      ||(piece.settings3d as typeof piece.settings3d & {savedSourceGatherIntent?:string}).savedSourceGatherIntent==='manual');
  if(hasRefinedCache&&hasCachedPositions&&excluded)
    throw new Error('This saved gathered garment needs reassembly. Release its hold or unfreeze it, then reset to its arrangement before changing assembly or simulation settings.');
  if(excluded)return pattern;
  if(!hasRefinedCache&&(!scope?.approvedEvidence?.seams.length||!scope.enabled||!scope.sourceBodyActive))return pattern;
  if(!hasCachedPositions)return pattern;
  return {...pattern,pieces:pattern.pieces.map(piece=>({ ...piece,settings3d:{...piece.settings3d,savedPositions:[],savedMeshSnapshot:undefined,
    savedDrapeState:'checkpoint',savedSourceAssemblyComplete:false}}))};
}

export interface SourceGatherCacheMarker { revision:'source-free-gather-boundary-v1';policySha256:string;sourceCutSha256:string }
/** Marker records actual baked numerical policy; it never grants warm-resume eligibility. */
export function capturedSourceGatherCacheMarker(data:{sourceGatherRefinement?:{revision:'source-free-gather-boundary-v1';approvedEvidence:{sourceIdentitySha256?:string}};
  sourceGatherCollisionGeometry?:{revision:string;refinementPolicySha256?:string}}):SourceGatherCacheMarker|undefined {
  const policy=data.sourceGatherRefinement,geometry=data.sourceGatherCollisionGeometry,cut=policy?.approvedEvidence.sourceIdentitySha256,sha=geometry?.refinementPolicySha256;
  if(!policy||geometry?.revision!==policy.revision||!cut||!sha||!/^[a-f0-9]{64}$/.test(cut)||!/^[a-f0-9]{64}$/.test(sha))return undefined;
  return {revision:policy.revision,policySha256:sha,sourceCutSha256:cut};
}

export interface PreparationToken<T> {prepared:T;sceneRevision:number;bodyRevision:number;resetRevision:number;requestRevision?:number;pattern?:unknown;avatar?:unknown}
export function preparationStillCurrent<T>(token:PreparationToken<T>,current:PreparationToken<T>&{disposed:boolean}):boolean {
  return !current.disposed&&token.prepared===current.prepared&&token.sceneRevision===current.sceneRevision
    &&token.bodyRevision===current.bodyRevision&&token.resetRevision===current.resetRevision
    &&token.requestRevision===current.requestRevision&&token.pattern===current.pattern&&token.avatar===current.avatar;
}
/** Testable async boundary used only for refined geometry; does not create an engine itself. */
export async function finalizeCurrentPreparation<T>(token:PreparationToken<T>,finalize:(prepared:T)=>Promise<T>,
  readCurrent:()=>PreparationToken<T>&{disposed:boolean}):Promise<T|null> {
  const finalized=await finalize(token.prepared);
  return preparationStillCurrent(token,readCurrent())?finalized:null;
}

export const sourceGatherRegistry = new GatherPreparationRegistry(new LocalGatherApprovalLedger());
