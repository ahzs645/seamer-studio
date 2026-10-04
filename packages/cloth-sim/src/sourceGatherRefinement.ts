import type { Pattern } from '@seamer/pattern-model';
import type { ArrangedPiece, SimData } from './build';

export interface ApprovedGatherEvidence {
  /** Exact immutable imported source dictionary/cut identity; no fuzzy display-name binding. */
  sourceIdentity: string;
  /** Real asynchronously verified digest; transient identity above is never persisted in policy. */
  sourceIdentitySha256?: string;
  sourceIdentityEncoding?: 'typed-json-ieee754-f64be-v1' | 'source-identity-json-utf8';
  upstreamProgramSha256: string;
  /** Resolved generator evidence for future output; absent for an explicitly reviewed import. */
  generation?: { upstreamPrograms: { path: string; sha256: string }[]; resolvedDesign: unknown; sourceBody: unknown; stylePath: string };
  provenance: 'authored-gather-metadata' | 'pinned-upstream-gather-interface';
  seams: { seamId: string; longSide: 0 | 1 }[];
}
export interface GatherBuildScope { enabled: boolean; sourceBodyActive: boolean; manualRecording?: boolean; explicitSettings?: boolean; approvedEvidence?: ApprovedGatherEvidence }
export function sourceGatherIdentity(pattern: Pattern): string {
  return JSON.stringify({ source:pattern.garmentCodeSource ? {format:pattern.garmentCodeSource.format,unitsInMeter:pattern.garmentCodeSource.unitsInMeter,panelNames:pattern.garmentCodeSource.panelNames}:null,
    points:pattern.points, paths:pattern.paths,
    pieces:pattern.pieces.map(p=>({id:p.id,mainPaths:p.mainPaths,internalPaths:p.internalPaths,sourcePlacement:p.settings3d.arrangement.sourcePlacement})), seams:pattern.seams });
}
export interface GatherAxialOverride { from: number; to: number; restLengthM: number; compliance: number; longRangeFlag: 0 }
export interface GatherInterval {
  seamIndex: number; seamId: string; originalInterval: number; longSide: 0 | 1;
  originalLongEdge: [number, number]; originalShortEdge: [number, number]; midpoint: number;
  originalFace: number; refinedFaces: number[]; transferredMassKg: [number, number];
  originalAxial: { restLengthM: number; compliance: number };
  rawSourceMidpointMm: { x: number; y: number };
}
export interface SourceGatherRefinement {
  revision: 'source-free-gather-boundary-v1';
  capturedMassPolicy: 'parent-area-allocated-captured-model-mass-v1';
  boundaryAxialPolicy: 'split-original-clamped-rest-and-compliance-v1';
  oldToNew: number[]; originalParticleCount: number; addedParticleCount: number; originalStitchCount: number;
  intervals: GatherInterval[];
  mass: { originalKg: number; refinedDoubleKg: number; refinedPackedKg: number; packedRelativeError: number };
  /** No raw cut/placement or two-sided compression law is edited. */
  sourceCutsChanged: false; compressionLawChanged: false;
  approvedEvidence: Omit<ApprovedGatherEvidence, 'sourceIdentity'>;
}
export interface GatherBoundarySide {
  particles: number[]; originalMaterialParameters: number[];
  children: { startParticle: number; endParticle: number; boundaryFace: number }[];
}
export interface GatherCollisionGeometry {
  revision: SourceGatherRefinement['revision'];
  /** Computed once by the eventual worker/source provenance owner before guard initialization. */
  refinementPolicySha256?: string;
  sourceMaterialCoordinates?: Float32Array;
  sourceCoordinateStride?: 4;
  intervals: { seamIndex: number; originalInterval: number; sides: [GatherBoundarySide, GatherBoundarySide] }[];
}
export interface GatherRefinementResult { arranged: ArrangedPiece[]; policy: SourceGatherRefinement; geometry: GatherCollisionGeometry }
const key = (a: number,b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
type EdgeRow = { a:number;b:number;rest:number;alpha:number;flag:number };
type Selected = { seamIndex:number;seamId:string;interval:number;longSide:0|1;a:number;b:number;shortA:number;shortB:number;piece:number;row:EdgeRow;midpoint?:number };

/** Builds new CPU topology only; never adopts cached/accepted state or starts a solver. */
export function refineSourceGatherArrangement(pattern: Pattern, arranged: readonly ArrangedPiece[], baseline: SimData, scope: GatherBuildScope): GatherRefinementResult | null {
  if (!scope.enabled || !scope.sourceBodyActive || !pattern.garmentCodeSource || pattern.assembly
    || scope.manualRecording || scope.explicitSettings || pattern.settings3d.fixTop
    || arranged.some(ap => ap.fromSaved || ap.frozen)
    || arranged.length !== baseline.pieces.length
    || baseline.pieces.some(sp => sp.pieceId.endsWith('#M'))
    || !scope.approvedEvidence || scope.approvedEvidence.sourceIdentity !== sourceGatherIdentity(pattern)
    || !/^[a-f0-9]{64}$/.test(scope.approvedEvidence.upstreamProgramSha256)
    || !/^[a-f0-9]{64}$/.test(scope.approvedEvidence.sourceIdentitySha256 ?? '')
    || !['typed-json-ieee754-f64be-v1','source-identity-json-utf8'].includes(scope.approvedEvidence.sourceIdentityEncoding ?? '')
    || !['authored-gather-metadata','pinned-upstream-gather-interface'].includes(scope.approvedEvidence.provenance)
    || arranged.some(ap => {
      const piece=pattern.pieces.find(p=>p.id===ap.cloth.pieceId);
      return !piece?.settings3d.arrangement.sourcePlacement || piece.settings3d.arrangement.positionChanged || piece.settings3d.savedDrapeState === 'held';
    })) return null;
  const count=baseline.particleCount,owner=new Int32Array(count).fill(-1),edges=new Map<string,EdgeRow[]>(),incidence=new Map<string,number[]>(),ownership=new Map<string,Set<number>>();
  for(let p=0;p<baseline.pieces.length;p++){
    const sp=baseline.pieces[p];if(sp.count!==arranged[p].cloth.mesh.points.length||sp.pieceId!==arranged[p].cloth.pieceId)throw Error('Baseline source mesh does not match arranged piece');
    owner.fill(p,sp.start,sp.start+sp.count);
  }
  if(owner.some(p=>p<0))throw Error('Source baseline ranges omit particles');
  for(const color of baseline.stretchColors)for(let at=0;at<color.count*4;at+=4){
    const row={a:color.edges[at],b:color.edges[at+1],rest:color.edges[at+2],alpha:color.props[at],flag:color.edges[at+3]},id=key(row.a,row.b);
    const rows=edges.get(id)??[];rows.push(row);edges.set(id,rows);
  }
  for(let t=0;t<baseline.triangleCount;t++)for(let side=0;side<3;side++){
    const a=baseline.triangles[t*4+side],b=baseline.triangles[t*4+(side+1)%3],id=key(a,b),faces=incidence.get(id)??[];
    faces.push(t);incidence.set(id,faces);
  }
  // Every declared join participates, even if its own candidate is equal, malformed or rejected.
  baseline.seamPairsBySeam.forEach((seam,index)=>{
    for(let at=2;at<seam.pairs.length;at+=2)for(const side of [0,1]){
      const a=seam.pairs[at-2+side],b=seam.pairs[at+side];if(a===b)continue;
      const id=key(a,b),owners=ownership.get(id)??new Set<number>();owners.add(index);ownership.set(id,owners);
    }
  });
  const candidates:Selected[]=[];
  baseline.seamPairsBySeam.forEach((seam,seamIndex)=>{
    if(seam.pairs.length<4||seam.pairs.length%2)return;
    const sides:[number[],number[]]=[[],[]];for(let at=0;at<seam.pairs.length;at+=2){sides[0].push(seam.pairs[at]);sides[1].push(seam.pairs[at+1]);}
    if(sides.some(ids=>new Set(ids).size!==ids.length))return;
    const rows:[EdgeRow,EdgeRow][]=[];
    for(let i=1;i<sides[0].length;i++){
      const ids=sides.map(run=>key(run[i-1],run[i])),found=ids.map(id=>edges.get(id));
      if(ids[0]===ids[1]||ids.some(id=>incidence.get(id)?.length!==1)||found.some(list=>list?.length!==1))return;
      const pair=found.map(list=>list![0]) as [EdgeRow,EdgeRow];
      if(pair.some(row=>row.flag!==0||!Number.isFinite(row.rest)||row.rest<=0||!Number.isFinite(row.alpha)||row.alpha<0))return;
      rows.push(pair);
    }
    const lengths=[0,1].map(side=>rows.reduce((sum,row)=>sum+row[side].rest,0));
    const longSide:0|1=lengths[0]>lengths[1]?0:1,shortSide=1-longSide,ratio=lengths[longSide]/lengths[shortSide];
    if((lengths[longSide]-lengths[shortSide])/lengths[longSide]<=.15||lengths[longSide]-lengths[shortSide]<=.01)return;
    const ratios=rows.map(row=>row[longSide].rest/row[shortSide].rest);
    if(ratios.some(value=>value<=1.001)||Math.max(...ratios)-Math.min(...ratios)>ratio*.0001)return;
    const approved=scope.approvedEvidence!.seams.find(entry=>entry.seamId===seam.seamId);
    if(!approved||approved.longSide!==longSide)return;
    const current:Selected[]=[];
    for(let i=1;i<sides[0].length;i++){
      const a=sides[longSide][i-1],b=sides[longSide][i],piece=owner[a],ap=arranged[piece],source=pattern.pieces.find(p=>p.id===ap?.cloth.pieceId);
      if(piece<0||owner[b]!==piece||ownership.get(key(a,b))?.size!==1||source?.mainPaths.some(path=>path.wire)||source?.internalPaths.some(path=>path.wire))return;
      if(!source)return;
      const localA=a-baseline.pieces[piece].start,localB=b-baseline.pieces[piece].start;
      const geometricPaths=[...ap.cloth.edgeParticles.values()];
      if(!geometricPaths.some(run=>run.some((id,at)=>at>0&&key(run[at-1],id)===key(localA,localB))))return;
      if(source.internalPaths.some(path=>(ap.cloth.edgeParticles.get(path.id)??[]).some((id,at,run)=>at>0&&key(run[at-1],id)===key(localA,localB))))return;
      if(Array.from({length:baseline.pieces[piece].count},(_,local)=>baseline.positions[(baseline.pieces[piece].start+local)*4+3]).some(w=>!Number.isFinite(w)||w<=0))return;
      current.push({seamIndex,seamId:seam.seamId,interval:i-1,longSide,a,b,shortA:sides[shortSide][i-1],shortB:sides[shortSide][i],piece,row:rows[i-1][longSide]});
    }
    candidates.push(...current);
  });
  if(!candidates.length)return null;
  const selected=new Map<string,Selected>();for(const c of candidates){if(selected.has(key(c.a,c.b)))return null;selected.set(key(c.a,c.b),c);}
  // This bounded subdivision supports one selected edge per source parent; otherwise unchanged.
  for(let t=0;t<baseline.triangleCount;t++){
    let chosen=0;for(let side=0;side<3;side++)if(selected.has(key(baseline.triangles[t*4+side],baseline.triangles[t*4+(side+1)%3])))chosen++;
    if(chosen>1)return null;
  }
  const oldToNew=new Uint32Array(count),starts:number[]=[],localMidpoints=new Map<Selected,number>();let total=0;
  const output=arranged.map((ap,piece)=>{
    const sp=baseline.pieces[piece],points=ap.cloth.mesh.points.map(p=>({...p}));starts.push(total);
    for(let local=0;local<sp.count;local++)oldToNew[sp.start+local]=total+local;
    for(const c of candidates.filter(c=>c.piece===piece)){
      const a=points[c.a-sp.start],b=points[c.b-sp.start],local=points.length;
      points.push({x:(a.x+b.x)/2,y:(a.y+b.y)/2});localMidpoints.set(c,local);c.midpoint=total+local;
    }
    const placement=(source:Float32Array)=>{
      const positions=new Float32Array(points.length*3);positions.set(source);
      for(const c of candidates.filter(c=>c.piece===piece))for(let axis=0;axis<3;axis++)positions[localMidpoints.get(c)!*3+axis]=(source[(c.a-sp.start)*3+axis]+source[(c.b-sp.start)*3+axis])/2;
      return positions;
    };
    const pathMap=(stitch:boolean)=>new Map([...ap.cloth.edgeParticles].map(([id,run])=>{
      if(stitch)return [id,run.slice()] as [string,number[]];
      const refined:number[]=[];for(let at=0;at<run.length;at++){
        if(at){const chosen=selected.get(key(sp.start+run[at-1],sp.start+run[at]));if(chosen)refined.push(localMidpoints.get(chosen)!);}
        refined.push(run[at]);
      }
      return [id,refined] as [string,number[]];
    }));
    total+=points.length;
    return {...ap,positions3d:placement(ap.positions3d),arranged3d:ap.arranged3d?placement(ap.arranged3d):undefined,
      cloth:{...ap.cloth,mesh:{...ap.cloth.mesh,points,triangles:[] as number[],edges:[] as [number,number][],boundary:[] as number[]},
        edgeParticles:pathMap(false),stitchEdgeParticles:pathMap(true),capturedInverseMass:undefined as Float32Array|undefined,
        gatherAxialOverrides:[] as GatherAxialOverride[]}};
  });
  const oldMass=Float64Array.from({length:count},(_,id)=>baseline.positions[id*4+3]>0?1/baseline.positions[id*4+3]:0),newMass=new Float64Array(total),incidentArea=new Float64Array(count),areas=new Float64Array(baseline.triangleCount);
  for(let id=0;id<count;id++)newMass[oldToNew[id]]=oldMass[id];
  // Source rigid 3D area matches the captured baseline/prototype, before body-aware assembly.
  for(let t=0;t<baseline.triangleCount;t++){
    const ids=Array.from(baseline.triangles.slice(t*4,t*4+3));const p=baseline.positions;
    const ux=p[ids[1]*4]-p[ids[0]*4],uy=p[ids[1]*4+1]-p[ids[0]*4+1],uz=p[ids[1]*4+2]-p[ids[0]*4+2],
      vx=p[ids[2]*4]-p[ids[0]*4],vy=p[ids[2]*4+1]-p[ids[0]*4+1],vz=p[ids[2]*4+2]-p[ids[0]*4+2];
    const area=.5*Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx);if(!Number.isFinite(area)||area<=1e-15)throw Error('Degenerate source parent triangle');
    areas[t]=area;for(const id of ids)incidentArea[id]+=area;
  }
  const intervals:GatherInterval[]=[];let oldFace=0,newFace=0;
  for(let piece=0;piece<output.length;piece++){
    const ap=arranged[piece],sp=baseline.pieces[piece],target=output[piece];
    for(let t=0;t<ap.cloth.mesh.triangles.length;t+=3,oldFace++){
      const ids=ap.cloth.mesh.triangles.slice(t,t+3);let match:Selected|undefined,side=-1;
      for(let e=0;e<3;e++){const chosen=selected.get(key(sp.start+ids[e],sp.start+ids[(e+1)%3]));if(chosen){match=chosen;side=e;}}
      if(!match){target.cloth.mesh.triangles.push(...ids);newFace++;continue;}
      const a=ids[side],b=ids[(side+1)%3],c=ids[(side+2)%3],m=localMidpoints.get(match)!;
      target.cloth.mesh.triangles.push(a,m,c,m,b,c);const children=[newFace++,newFace++];
      const globalA=sp.start+a,globalB=sp.start+b,transferA=.5*oldMass[globalA]*areas[oldFace]/incidentArea[globalA],transferB=.5*oldMass[globalB]*areas[oldFace]/incidentArea[globalB];
      newMass[oldToNew[globalA]]-=transferA;newMass[oldToNew[globalB]]-=transferB;newMass[match.midpoint!]=transferA+transferB;
      const first=oldToNew[match.a]-starts[piece],last=oldToNew[match.b]-starts[piece];
      target.cloth.gatherAxialOverrides.push({from:first,to:m,restLengthM:match.row.rest/2,compliance:match.row.alpha/2,longRangeFlag:0},
        {from:m,to:last,restLengthM:match.row.rest/2,compliance:match.row.alpha/2,longRangeFlag:0});
      intervals.push({seamIndex:match.seamIndex,seamId:match.seamId,originalInterval:match.interval,longSide:match.longSide,
        originalLongEdge:[match.a,match.b],originalShortEdge:[match.shortA,match.shortB],midpoint:match.midpoint!,originalFace:oldFace,refinedFaces:children,
        transferredMassKg:[transferA,transferB],originalAxial:{restLengthM:match.row.rest,compliance:match.row.alpha},rawSourceMidpointMm:{...target.cloth.mesh.points[m]}});
    }
    const uniqueEdges=new Map<string,[number,number]>(),boundarySet=new Set(ap.cloth.mesh.boundary);
    // Preserve constrained/internal non-triangle edges; remove only the refined parent boundary.
    for(const [a,b] of ap.cloth.mesh.edges)if(!selected.has(key(sp.start+a,sp.start+b)))uniqueEdges.set(key(a,b),[a,b]);
    for(const chosen of candidates.filter(c=>c.piece===piece))boundarySet.add(localMidpoints.get(chosen)!);
    for(let t=0;t<target.cloth.mesh.triangles.length;t+=3)for(let e=0;e<3;e++){
      const a=target.cloth.mesh.triangles[t+e],b=target.cloth.mesh.triangles[t+(e+1)%3];uniqueEdges.set(key(a,b),[a,b]);
    }
    target.cloth.mesh.edges=[...uniqueEdges.values()];target.cloth.mesh.boundary=[...boundarySet];target.cloth.mesh.numBoundary=boundarySet.size;
    if(ap.boundaryLocal)target.boundaryLocal=[...new Set([...ap.boundaryLocal,...candidates.filter(c=>c.piece===piece).map(c=>localMidpoints.get(c)!)])];
    if(candidates.some(c=>c.piece===piece)){
      const weights=new Float32Array(target.cloth.mesh.points.length);
      for(let local=0;local<weights.length;local++){const mass=newMass[starts[piece]+local];if(!Number.isFinite(mass)||mass<=0)throw Error('Invalid refined captured model mass');weights[local]=1/mass;}
      // Preserve original packed W bits on vertices with no mass transfer.
      const affected=new Set(candidates.filter(c=>c.piece===piece).flatMap(c=>[c.a-sp.start,c.b-sp.start]));
      for(let local=0;local<sp.count;local++)if(!affected.has(local))weights[local]=baseline.positions[(sp.start+local)*4+3];
      target.cloth.capturedInverseMass=weights;
    }
  }
  // The existing GPU tables have fixed capacities. Do not introduce silent truncation.
  for(let piece=0;piece<output.length;piece++){
    const capacity=(mesh:ArrangedPiece['cloth']['mesh'])=>{
      const degree=Array.from({length:mesh.points.length},()=>new Set<number>()),incident=new Uint32Array(mesh.points.length);
      for(const [a,b] of mesh.edges){degree[a].add(b);degree[b].add(a);}
      for(const id of mesh.triangles)incident[id]++;
      return{degree:degree.map(neighbors=>neighbors.size),incident};
    };
    const before=capacity(arranged[piece].cloth.mesh),after=capacity(output[piece].cloth.mesh);
    if(after.degree.some((n,id)=>n>8&&n>(before.degree[id]??0))||after.incident.some((n,id)=>n>12&&n>(before.incident[id]??0)))return null;
  }
  const boundaryFaces=new Map<string,number[]>();newFace=0;
  for(let piece=0;piece<output.length;piece++)for(let t=0;t<output[piece].cloth.mesh.triangles.length;t+=3,newFace++)for(let side=0;side<3;side++){
    const ids=output[piece].cloth.mesh.triangles,a=starts[piece]+ids[t+side],b=starts[piece]+ids[t+(side+1)%3],id=key(a,b),faces=boundaryFaces.get(id)??[];
    faces.push(newFace);boundaryFaces.set(id,faces);
  }
  const geometry:GatherCollisionGeometry={revision:'source-free-gather-boundary-v1',intervals:intervals.map(interval=>{
    const long=[oldToNew[interval.originalLongEdge[0]],interval.midpoint,oldToNew[interval.originalLongEdge[1]]],short=interval.originalShortEdge.map(id=>oldToNew[id]);
    const side=(particles:number[],u:number[]):GatherBoundarySide=>({particles,originalMaterialParameters:u,children:particles.slice(1).map((b,at)=>{
      const a=particles[at],faces=boundaryFaces.get(key(a,b));if(faces?.length!==1)throw Error('Refined seam geometry lacks an actual unique boundary child');
      return{startParticle:a,endParticle:b,boundaryFace:faces[0]};
    })});
    const longGeometry=side(long,[0,.5,1]),shortGeometry=side(short,[0,1]);
    return{seamIndex:interval.seamIndex,originalInterval:interval.originalInterval,sides:interval.longSide===0?[longGeometry,shortGeometry]:[shortGeometry,longGeometry]};
  })};
  const originalKg=oldMass.reduce((sum,m)=>sum+m,0),refinedDoubleKg=newMass.reduce((sum,m)=>sum+m,0);
  const refinedPackedKg=output.reduce((sum,ap,piece)=>sum+(ap.cloth.capturedInverseMass?.reduce((subtotal,w)=>subtotal+1/w,0)
    ?? Array.from({length:baseline.pieces[piece].count},(_,local)=>oldMass[baseline.pieces[piece].start+local]).reduce((subtotal,m)=>subtotal+m,0)),0);
  return {arranged:output,geometry,policy:{revision:'source-free-gather-boundary-v1',capturedMassPolicy:'parent-area-allocated-captured-model-mass-v1',
    boundaryAxialPolicy:'split-original-clamped-rest-and-compliance-v1',oldToNew:Array.from(oldToNew),originalParticleCount:count,
    addedParticleCount:candidates.length,originalStitchCount:baseline.stitchCount,intervals,mass:{originalKg,refinedDoubleKg,refinedPackedKg,packedRelativeError:Math.abs(refinedPackedKg-originalKg)/originalKg},sourceCutsChanged:false,compressionLawChanged:false,approvedEvidence:((({sourceIdentity: _transientIdentity,...persisted})=>structuredClone(persisted))(scope.approvedEvidence!))}};
}
