/** Source semantic staging: immutable topology and an accepted-frame activation controller. */
/** Source semantic graph; this code does not modify topology or move particles. */
export interface GraphPath { id:string; name?:string }
export interface GraphPiece { id:string; mainPaths:readonly GraphPath[]; settings3d?:{arrangement?:{sourcePlacement?:unknown}} }
export interface GraphSeam { id:string; fromPaths:readonly {id:string}[]; toPaths:readonly {id:string}[] }
export interface GraphPattern { garmentCodeSource?:unknown; assembly?:unknown; pieces:readonly GraphPiece[]; seams:readonly GraphSeam[] }
export interface StageOptions { sourceBodyActive:boolean; held?:boolean; closedCheckpoint?:boolean }
export interface StagedSeamGraph {
  eligible:boolean; reason:string; allSeamIds:string[]; structuralSeamIds:string[]; attachmentSeamIds:string[];
  upperPieceIds:string[]; waistPieceIds:string[]; lowerPieceIds:string[];
  lowerUnits:{pieceIds:string[]; waistPieceIds:string[]; structuralSeamIds:string[]}[];
  shoulderPrerequisites:{shoulderSeamId:string; structuralSeamIds:string[]; attachmentSeamIds:string[]; releasePrerequisiteSeamIds:string[]}[];
}
const sorted=(ids:Iterable<string>)=>[...new Set(ids)].sort();
const hasNeck=(piece:GraphPiece)=>piece.mainPaths.some(path=>/collar|neck/i.test(path.name??''));
function shoulderPath(piece:GraphPiece,pathId:string):boolean {
  const paths=piece.mainPaths,index=paths.findIndex(path=>path.id===pathId); if(index<0||paths.length<3)return false;
  const names=[paths[(index+paths.length-1)%paths.length].name??'',paths[(index+1)%paths.length].name??''];
  return names.some(name=>/collar|neck/i.test(name))&&names.some(name=>/armhole/i.test(name));
}
/** Partition by semantic barrier, then connected components. Original seam IDs remain unordered sets. */
export function inferStagedSeamGraph(pattern:GraphPattern,options:StageOptions):StagedSeamGraph {
  const all=sorted(pattern.seams.map(seam=>seam.id));
  const result:StagedSeamGraph={eligible:false,reason:'',allSeamIds:all,structuralSeamIds:all.slice(),attachmentSeamIds:[],upperPieceIds:[],waistPieceIds:[],lowerPieceIds:[],lowerUnits:[],shoulderPrerequisites:[]};
  const fail=(reason:string)=>({...result,reason});
  if(!pattern.garmentCodeSource||!options.sourceBodyActive)return fail('native-or-inactive-source');
  if(pattern.assembly)return fail('explicit-assembly');
  if(options.held)return fail('explicit-held');
  if(options.closedCheckpoint)return fail('closed-checkpoint');
  if(all.length!==pattern.seams.length)return fail('duplicate-seam-id');
  const pieces=new Map(pattern.pieces.map(piece=>[piece.id,piece]));
  if(pieces.size!==pattern.pieces.length)return fail('duplicate-piece-id');
  const owners=new Map<string,GraphPiece>();
  for(const piece of pattern.pieces)for(const path of piece.mainPaths){if(owners.has(path.id))return fail('ambiguous-path-owner');owners.set(path.id,piece);}
  const waist=new Set(pattern.pieces.filter(piece=>piece.mainPaths.some(path=>path.name==='lower_interface')).map(piece=>piece.id));
  result.waistPieceIds=sorted(waist);
  const edges=new Map<string,string[]>(),adjacency=new Map(pattern.pieces.map(piece=>[piece.id,new Set<string>()]));
  for(const seam of pattern.seams){
    const refs=[...seam.fromPaths,...seam.toPaths];
    if(!seam.fromPaths.length||!seam.toPaths.length||refs.some(ref=>!owners.has(ref.id)))return fail('unresolved-seam-owner');
    const ids=sorted(refs.map(ref=>owners.get(ref.id)!.id));edges.set(seam.id,ids);
    if(ids.some(id=>!pieces.get(id)!.settings3d?.arrangement?.sourcePlacement))return fail('mixed-native-source-pieces');
    for(const id of ids)for(const other of ids)if(other!==id)adjacency.get(id)!.add(other);
  }
  const reach=(seeds:Iterable<string>,allowed:Set<string>)=>{
    const reached=new Set<string>(),queue=[...seeds].filter(id=>allowed.has(id));
    for(let i=0;i<queue.length;i++){const id=queue[i];if(reached.has(id))continue;reached.add(id);for(const next of adjacency.get(id)??[])if(allowed.has(next)&&!reached.has(next))queue.push(next);}
    return reached;
  };
  const nonWaist=new Set([...pieces.keys()].filter(id=>!waist.has(id)));
  const upper=reach(pattern.pieces.filter(hasNeck).map(piece=>piece.id),nonWaist);
  const lower=new Set([...pieces.keys()].filter(id=>!upper.has(id)));
  result.upperPieceIds=sorted(upper);result.lowerPieceIds=sorted(lower);
  // Every lower connected unit must retain a waist support path before upper attachments activate.
  const left=new Set(lower);
  while(left.size){
    const component=reach([left.values().next().value!],lower);for(const id of component)left.delete(id);
    const anchors=sorted([...component].filter(id=>waist.has(id)));
    const seams=sorted([...edges].filter(([,ids])=>ids.every(id=>component.has(id))).map(([id])=>id));
    result.lowerUnits.push({pieceIds:sorted(component),waistPieceIds:anchors,structuralSeamIds:seams});
  }
  result.lowerUnits.sort((a,b)=>a.pieceIds[0].localeCompare(b.pieceIds[0]));
  if(!upper.size)return fail('no-upper-component');
  const attachment:string[]=[];
  for(const [id,ids] of edges){
    if(!ids.some(owner=>upper.has(owner))||!ids.some(owner=>!upper.has(owner)))continue;
    if(ids.some(owner=>!upper.has(owner)&&!waist.has(owner)))return fail('upper-lower-bypass-of-waist');
    // A bypass can absorb the skirt into the neck-connected component. The anatomical
    // lower_interface is the band's upper attachment, never its unlabeled lower hem.
    const seam=pattern.seams.find(seam=>seam.id===id)!;
    const waistRefs=[...seam.fromPaths,...seam.toPaths].filter(ref=>waist.has(owners.get(ref.id)!.id));
    if(waistRefs.some(ref=>owners.get(ref.id)!.mainPaths.find(path=>path.id===ref.id)!.name!=='lower_interface'))return fail('upper-lower-bypass-of-waist');
    attachment.push(id);
  }
  result.attachmentSeamIds=sorted(attachment);result.structuralSeamIds=all.filter(id=>!attachment.includes(id));
  // No staging for standalone upper/lower garments; report support prerequisites separately.
  for(const seam of pattern.seams){
    const refs=[...seam.fromPaths,...seam.toPaths];
    if(!refs.some(ref=>shoulderPath(owners.get(ref.id)!,ref.id)))continue;
    const seed=edges.get(seam.id)![0],component=reach([seed],upper);
    const structural=result.structuralSeamIds.filter(id=>edges.get(id)!.every(owner=>component.has(owner)));
    const attached=result.attachmentSeamIds.filter(id=>edges.get(id)!.some(owner=>component.has(owner)));
    result.shoulderPrerequisites.push({shoulderSeamId:seam.id,structuralSeamIds:structural,attachmentSeamIds:attached,releasePrerequisiteSeamIds:sorted([...structural,...attached])});
  }
  result.shoulderPrerequisites.sort((a,b)=>a.shoulderSeamId.localeCompare(b.shoulderSeamId));
  if(!waist.size)return fail('no-waist-interface');
  if(!attachment.length)return fail('no-upper-waist-attachment');
  if(result.lowerUnits.some(unit=>!unit.waistPieceIds.length))return fail('unsupported-lower-unit');
  result.eligible=true;result.reason='semantic-upper-waist-attachment';return result;
}


/** Partition validated source upper garments into structural units and attachments. */
type Role='shell'|'arm-unit'|'hood-unit'|'lower-unit';
interface SourceRole {pieceId:string;sourcePanelName:string;role:Role;provenance:string}
export interface UpperStagedSeamGraph extends StagedSeamGraph {
 sourceRoles:SourceRole[];upperUnits:{role:Role;pieceIds:string[];structuralSeamIds:string[]}[];
 attachmentGroups:{kind:'arm-to-shell'|'hood-to-shell'|'shell-to-waist';seamIds:string[]}[];
}
const uniqueSorted=(values:Iterable<string>)=>[...new Set(values)].sort();
export function inferUpperStagedSeamGraph(pattern:GraphPattern,options:StageOptions):UpperStagedSeamGraph {
 const base=inferStagedSeamGraph(pattern,options),result:UpperStagedSeamGraph={...base,sourceRoles:[],upperUnits:[],attachmentGroups:[]};
 const fallback=(reason:string)=>({...result,eligible:false,reason,structuralSeamIds:base.allSeamIds.slice(),attachmentSeamIds:[]});
 if(!['no-waist-interface','no-upper-waist-attachment','semantic-upper-waist-attachment'].includes(base.reason))return result;
 const source=pattern.garmentCodeSource as {panelNames?:unknown},names=source?.panelNames;
 if(!Array.isArray(names)||names.length!==pattern.pieces.length||names.some(n=>typeof n!=='string')||new Set(names).size!==names.length)return fallback('unresolved-source-panel-role');
 const pieces=new Map(pattern.pieces.map(p=>[p.id,p])),upper=new Set(base.upperPieceIds),roles=new Map<string,Role>();
 for(let index=0;index<names.length;index++){
  const id='GC_Piece'+index,piece=pieces.get(id) as (GraphPattern['pieces'][number]&{label?:string})|undefined;
  if(!piece)return fallback('unresolved-imported-source-panel-id');
  const nativeName=names[index] as string;
  let role:Role='lower-unit';
  if(upper.has(id)){
   const arm=/(?:^|_)(?:sleeve|cuff)(?:_|$)/i.test(nativeName),hood=/(?:^|_)hood(?:_|$)/i.test(nativeName);
   if(arm&&piece.label!=='arm')return fallback('source-arm-label-conflict');
   if(piece.label==='arm'&&!arm)return fallback('unresolved-source-arm-family');
   role=arm?'arm-unit':hood?'hood-unit':'shell';
  }
  roles.set(id,role);result.sourceRoles.push({pieceId:id,sourcePanelName:nativeName,role,
   provenance:'Immutable source panelNames bound to importer GC_Piece IDs; arm family cross-checked against source arm label. Display names and seam prefix order are ignored.'});
 }
 const owners=new Map(pattern.pieces.flatMap(p=>p.mainPaths.map(path=>[path.id,p.id] as const))),edges=new Map<string,string[]>();
 for(const seam of pattern.seams)edges.set(seam.id,uniqueSorted([...seam.fromPaths,...seam.toPaths].map(p=>owners.get(p.id)!)));
 const groups=new Map<string,string[]>([['arm-to-shell',[]],['hood-to-shell',[]],['shell-to-waist',base.attachmentSeamIds.slice()]]);
 const attachments=new Set(base.attachmentSeamIds);
 for(const [seamId,ids] of edges){
  if(ids.length>2)return fallback('ambiguous-multi-unit-seam');
  const own=uniqueSorted(ids.map(id=>roles.get(id)!));
  if(own.length===1||attachments.has(seamId))continue;
  if(own.includes('shell')&&own.includes('arm-unit')){groups.get('arm-to-shell')!.push(seamId);attachments.add(seamId);}
  else if(own.includes('shell')&&own.includes('hood-unit')){groups.get('hood-to-shell')!.push(seamId);attachments.add(seamId);}
  else return fallback('unsupported-role-attachment');
 }
 result.attachmentSeamIds=uniqueSorted(attachments);result.structuralSeamIds=base.allSeamIds.filter(id=>!attachments.has(id));
 result.attachmentGroups=[...groups].filter(([,ids])=>ids.length).map(([kind,ids])=>({kind:kind as UpperStagedSeamGraph['attachmentGroups'][number]['kind'],seamIds:uniqueSorted(ids)}));
 const pending=new Set(base.upperPieceIds);
 while(pending.size){
  const first=pending.values().next().value!,role=roles.get(first)!,unit=new Set<string>(),queue=[first];
  for(let i=0;i<queue.length;i++){const id=queue[i];if(unit.has(id))continue;unit.add(id);for(const seamId of result.structuralSeamIds){const ids=edges.get(seamId)!;if(ids.includes(id))for(const other of ids)if(upper.has(other)&&roles.get(other)===role&&!unit.has(other))queue.push(other);}}
  for(const id of unit)pending.delete(id);
  result.upperUnits.push({role,pieceIds:uniqueSorted(unit),structuralSeamIds:result.structuralSeamIds.filter(id=>edges.get(id)!.every(p=>unit.has(p)))});
 }
 result.upperUnits.sort((a,b)=>a.pieceIds[0].localeCompare(b.pieceIds[0]));
 const upperStructural=result.structuralSeamIds.filter(id=>edges.get(id)!.every(p=>upper.has(p)));
 result.shoulderPrerequisites=base.shoulderPrerequisites.map(group=>({...group,structuralSeamIds:upperStructural.slice(),attachmentSeamIds:result.attachmentSeamIds.slice(),releasePrerequisiteSeamIds:uniqueSorted([...upperStructural,...result.attachmentSeamIds])}));
 if(!result.attachmentSeamIds.length)return fallback('no-unit-attachments');
 result.eligible=true;result.reason='source-shell-arm-hood-waist-units';return result;
}
export interface SourceStagingScope {
  sourceBodyActive: boolean;
  freshArrangement: boolean;
  held?: boolean;
  manualRecording?: boolean;
  cached?: boolean;
}
export interface SourceStagingBuildData {
  particleCount: number;
  seamPairsBySeam: readonly { seamId: string; index: number; pairs: readonly number[] }[];
  seams: Int32Array;
  seamOrder: Int32Array;
  stitchCount: number;
  seamStitchRanges: readonly { seamId: string; start: number; end: number }[];
}
export interface SourceStagingPlan {
  readonly revision: 1;
  readonly topology: string;
  readonly seamIds: readonly string[];
  readonly structuralSeamIndices: readonly number[];
  readonly attachmentSeamIndices: readonly number[];
  readonly shoulderPrerequisites: readonly { shoulderSeamId: string; seamIndices: readonly number[]; pairs: readonly number[]; stitchIndices: readonly number[] }[];
  readonly pairs: readonly (readonly number[])[];
  /** Actual reciprocal per-link first-stamp indices, not inferred ordinal pair indices. */
  readonly stitchIndices: readonly (readonly number[])[];
  readonly stitchCount: number;
  readonly seamStitchRanges: readonly { seamId: string; start: number; end: number }[];
  readonly provenance: UpperStagedSeamGraph;
}
/** Return null before strict numerical validation for native, unknown and nonautomatic lifecycles. */
export function buildSourceStagingPlan(pattern: GraphPattern, data: SourceStagingBuildData, scope: SourceStagingScope): SourceStagingPlan | null {
  if (!scope.sourceBodyActive || !scope.freshArrangement || scope.held || scope.manualRecording || scope.cached || pattern.assembly) return null;
  const graph = inferUpperStagedSeamGraph(pattern, { sourceBodyActive: scope.sourceBodyActive });
  if (!graph.eligible || graph.sourceRoles.some(role => role.role === 'shell'
    && !/(?:^|_)(?:btorso|ftorso|torso|collar|neckband|placket)(?:_|$)/i.test(role.sourcePanelName))) return null;
  const seamIds = data.seamPairsBySeam.map(seam => seam.seamId);
  const index = new Map(seamIds.map((id, i) => [id, i]));
  if (index.size !== seamIds.length || pattern.seams.length !== seamIds.length || pattern.seams.some(seam => !index.has(seam.id))
    || data.seamPairsBySeam.some((seam, i) => seam.index !== i || !seam.pairs.length || seam.pairs.length % 2
      || seam.pairs.some(particle => !Number.isInteger(particle) || particle < 0 || particle >= data.particleCount))) return null;
  const structuralSeamIndices = graph.structuralSeamIds.map(id => index.get(id)!);
  const attachmentSeamIndices = graph.attachmentSeamIds.map(id => index.get(id)!);
  const structural = new Set(structuralSeamIndices);
  const ownership = new Map<string, boolean>();
  const stitchIndices: number[][] = [];
  for (let seamIndex = 0; seamIndex < seamIds.length; seamIndex++) {
    const seam = data.seamPairsBySeam[seamIndex];
    const indices: number[] = [];
    for (let at = 0; at < seam.pairs.length; at += 2) {
      const a = seam.pairs[at], b = seam.pairs[at + 1], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const category = structural.has(seamIndex);
      if (ownership.has(key) && ownership.get(key) !== category) return null;
      ownership.set(key, category);
      const linkOrder = (from: number, to: number): number | undefined => {
        for (let slot = 0; slot < 4; slot++) if (data.seams[from * 4 + slot] === to) return data.seamOrder[from * 4 + slot];
        return undefined;
      };
      const first = linkOrder(a, b), reciprocal = linkOrder(b, a);
      if (first === undefined || first !== reciprocal || !Number.isInteger(first) || first < 0 || first >= data.stitchCount) return null;
      indices.push(first);
    }
    stitchIndices.push(indices);
  }
  if (data.seamStitchRanges.length !== seamIds.length || data.seamStitchRanges.some(range => !index.has(range.seamId)
    || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > data.stitchCount)) return null;
  const pairs = data.seamPairsBySeam.map(seam => seam.pairs.slice());
  const shoulderPrerequisites = graph.shoulderPrerequisites.map(group => {
    const seamIndices = group.releasePrerequisiteSeamIds.map(id => index.get(id)!);
    return { shoulderSeamId: group.shoulderSeamId, seamIndices,
      pairs: seamIndices.flatMap(i => pairs[i]), stitchIndices: seamIndices.flatMap(i => stitchIndices[i]) };
  });
  const seamStitchRanges = data.seamStitchRanges.map(range => ({ ...range }));
  const topology = JSON.stringify({ revision: 1, seamIds, pairs, stitchIndices, stitchCount: data.stitchCount,
    seamStitchRanges, structuralSeamIndices, attachmentSeamIndices, shoulderPrerequisites });
  return { revision: 1, topology, seamIds, structuralSeamIndices, attachmentSeamIndices, shoulderPrerequisites,
    pairs, stitchIndices, stitchCount: data.stitchCount, seamStitchRanges, provenance: graph };
}

export interface SourceStagingSnapshot {
  readonly topology: string;
  readonly mode: 'automatic' | 'manual';
  readonly phase: 'structural' | 'all';
  readonly stableAcceptedFrames: number;
  readonly maskRevision: number;
  readonly activeMask: Uint32Array;
  readonly lastAcceptedMask: Uint32Array;
  readonly lastAcceptedMaskRevision: number;
  readonly lastAcceptedSewnUpTo: number;
  readonly hasAcceptedFrame: boolean;
}
export interface SourceAssemblyState {
  readonly revision: number;
  readonly phase: 'structural' | 'all';
  readonly stableAcceptedFrames: number;
  readonly activeSeamMask: Uint32Array;
  readonly activeStitchMask: Uint32Array;
  /** Logical timeline stitches; repeated pairs can share one first-stamped physical link. */
  readonly enabledStitchCount: number;
  readonly totalStitchCount: number;
  readonly allActive: boolean;
}
/** Lifecycle only: no particle movement, gravity changes, extra anchors or weakened contacts. */
export class SourceStagingController {
  private state: SourceStagingSnapshot;
  constructor(readonly plan: SourceStagingPlan) {
    const activeMask = new Uint32Array(plan.seamIds.length);
    for (const i of plan.structuralSeamIndices) activeMask[i] = 1;
    this.state = { topology: plan.topology, mode: 'automatic', phase: 'structural', stableAcceptedFrames: 0,
      maskRevision: 0, activeMask, lastAcceptedMaskRevision: 0, lastAcceptedMask: activeMask.slice(), lastAcceptedSewnUpTo: 0, hasAcceptedFrame: false };
  }
  capture(): SourceStagingSnapshot {
    return { ...this.state, activeMask: this.state.activeMask.slice(), lastAcceptedMask: this.state.lastAcceptedMask.slice() };
  }
  restore(snapshot: SourceStagingSnapshot): void {
    const validMask = (mask: Uint32Array) => mask.length === this.plan.seamIds.length && mask.every(value => value === 0 || value === 1);
    if (snapshot.topology !== this.plan.topology || !validMask(snapshot.activeMask) || !validMask(snapshot.lastAcceptedMask)
      || !Number.isInteger(snapshot.stableAcceptedFrames) || snapshot.stableAcceptedFrames < 0
      || !Number.isInteger(snapshot.maskRevision) || snapshot.maskRevision < 0 || !['automatic', 'manual'].includes(snapshot.mode)
      || !['structural', 'all'].includes(snapshot.phase) || !Number.isInteger(snapshot.lastAcceptedSewnUpTo)
      || snapshot.lastAcceptedSewnUpTo < 0 || snapshot.lastAcceptedSewnUpTo > this.plan.stitchCount
      || !Number.isInteger(snapshot.lastAcceptedMaskRevision) || snapshot.lastAcceptedMaskRevision < 0
      || snapshot.lastAcceptedMaskRevision > snapshot.maskRevision
      || typeof snapshot.hasAcceptedFrame !== 'boolean' || snapshot.phase === 'all' && snapshot.activeMask.some(value => value !== 1)
      || snapshot.mode === 'automatic' && snapshot.phase === 'structural'
        && snapshot.activeMask.some((value, i) => value !== Number(this.plan.structuralSeamIndices.includes(i)))) {
      throw new Error('Invalid source staging rollback snapshot');
    }
    this.state = { ...snapshot, activeMask: snapshot.activeMask.slice(), lastAcceptedMask: snapshot.lastAcceptedMask.slice() };
  }
  get nextActiveSeamMask(): Uint32Array { return this.state.activeMask.slice(); }
  get maskRevision(): number { return this.state.maskRevision; }
  private validGate(mask: Uint32Array, prefix: number): void {
    if (mask.length !== this.plan.seamIds.length || mask.some(value => value !== 0 && value !== 1)
      || !Number.isInteger(prefix) || prefix < 0 || prefix > this.plan.stitchCount) throw new Error('Invalid source staging frame gate');
  }
  private seamGap(index: number, positions: Float32Array): number {
    let max = 0;
    const pairs = this.plan.pairs[index];
    for (let j = 0; j < pairs.length; j += 2) {
      const a = pairs[j] * 4, b = pairs[j + 1] * 4;
      const gap = Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
      if (!Number.isFinite(gap)) return Infinity;
      max = Math.max(max, gap);
    }
    return max;
  }
  /** Call only after strict acceptance. The returned next mask is not current-frame evidence. */
  observeAccepted(positions: Float32Array, usedMask: Uint32Array, sewnUpTo = this.plan.stitchCount): boolean {
    this.validGate(usedMask, sewnUpTo);
    if (usedMask.some((value, i) => value !== this.state.activeMask[i])) throw new Error('Accepted frame gate differs from staged attempt');
    this.state = { ...this.state, lastAcceptedMask: usedMask.slice(), lastAcceptedMaskRevision: this.state.maskRevision, lastAcceptedSewnUpTo: sewnUpTo, hasAcceptedFrame: true };
    if (this.state.mode === 'manual' || this.state.phase === 'all') return false;
    const closed = this.plan.structuralSeamIndices.every(i => usedMask[i] === 1
      && this.plan.stitchIndices[i].every(stitch => stitch < sewnUpTo) && this.seamGap(i, positions) <= .003);
    const stableAcceptedFrames = closed ? this.state.stableAcceptedFrames + 1 : 0;
    if (stableAcceptedFrames >= 3) {
      this.state = { ...this.state, phase: 'all', stableAcceptedFrames, maskRevision: this.state.maskRevision + 1,
        activeMask: new Uint32Array(this.plan.seamIds.length).fill(1) };
      return true;
    }
    this.state = { ...this.state, stableAcceptedFrames };
    return false;
  }
  /** Manual mode restores every semantic seam; the original numerical prefix remains authoritative. */
  cancelAutomatic(): void {
    this.state = { ...this.state, mode: 'manual', phase: 'all', stableAcceptedFrames: 0, maskRevision: this.state.maskRevision + 1,
      activeMask: new Uint32Array(this.plan.seamIds.length).fill(1), hasAcceptedFrame: false };
  }
  get acceptedState(): SourceAssemblyState {
    const activeSeamMask = this.state.lastAcceptedMask.slice(), activeStitchMask = new Uint32Array(this.plan.stitchCount);
    for (const range of this.plan.seamStitchRanges) {
      if (!activeSeamMask[this.plan.seamIds.indexOf(range.seamId)]) continue;
      for (let stitch = range.start; stitch < Math.min(range.end, this.state.lastAcceptedSewnUpTo); stitch++) activeStitchMask[stitch] = 1;
    }
    const enabledStitchCount = activeStitchMask.reduce((count, value) => count + value, 0);
    const allActive = this.state.hasAcceptedFrame && activeSeamMask.every(value => value === 1)
      && this.state.lastAcceptedSewnUpTo === this.plan.stitchCount;
    return { revision: this.state.lastAcceptedMaskRevision, phase: allActive ? 'all' : 'structural', stableAcceptedFrames: this.state.stableAcceptedFrames,
      activeSeamMask, activeStitchMask, enabledStitchCount, totalStitchCount: this.plan.stitchCount, allActive };
  }
}
