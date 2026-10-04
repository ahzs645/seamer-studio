import type { SimConfig } from '../config';
import { WORKGROUP_SIZE, closestPointOnTriangleWGSL } from './shaders';
import { finiteContactsWGSL } from './finiteContacts';
import { finiteSelfContactWGSL } from './finiteSelfContact';
import { seamGateWGSL, type SeamGateLayout } from './seamGate';

/** Refit immutable BVH topology from the actual current/previous finite triangles. Each node
 * reduces its own subtree's leaf geometry, avoiding inter-workgroup synchronization and float
 * atomics. A balanced tree performs O(T log T) total work. */
export function refitSurfaceBVHWGSL(): string {
  return /* wgsl */ `
struct Node { low:vec3f,escape:u32,high:vec3f,leaf:u32 };
@group(0) @binding(0) var<storage, read_write> nodes:array<Node>;
@group(0) @binding(1) var<storage, read> ordered:array<u32>;
@group(0) @binding(2) var<storage, read> triangles:array<vec4u>;
@group(0) @binding(3) var<storage, read> positions:array<vec4f>;
@group(0) @binding(4) var<storage, read> previous:array<vec4f>;
@group(0) @binding(5) var<storage, read> ranges:array<vec4u>;
@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid:vec3u) {
  let index=gid.x;if(index>=arrayLength(&nodes)) { return; }
  var low=vec3f(1e30);var high=vec3f(-1e30);
  let first=ranges[index].x;let count=ranges[index].y;
  for(var item=0u;item<count;item++) {
    let tri=triangles[ordered[first+item]];
    low=min(low,min(min(positions[tri.x].xyz,min(positions[tri.y].xyz,positions[tri.z].xyz)),
      min(previous[tri.x].xyz,min(previous[tri.y].xyz,previous[tri.z].xyz))));
    high=max(high,max(max(positions[tri.x].xyz,max(positions[tri.y].xyz,positions[tri.z].xyz)),
      max(previous[tri.x].xyz,max(previous[tri.y].xyz,previous[tri.z].xyz))));
  }
  nodes[index].low=low;nodes[index].high=high;
}`;
}

/** Stackless finite-AABB broad phase. Current and previous bounds cover whole coarse faces,
 * without centroid-radius holes or a global radius expanding thousands of empty hash cells. */
export function initSelfSurfaceCollisionWGSL(cfg: SimConfig, lazyRanking = true, atomicGather = false): string {
  const budget = cfg.numInternalSurfaceCollisionConstraints ?? 32;
  return /* wgsl */ `
struct Node { low:vec3f,escape:u32,high:vec3f,leaf:u32 };
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read> triangles: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> candidates: ${atomicGather ? 'array<atomic<u32>>' : 'array<u32>'};
@group(0) @binding(3) var<storage, read> nodes:array<Node>;
@group(0) @binding(4) var<storage, read> ordered:array<u32>;
@group(0) @binding(5) var<storage, read> previous: array<vec4f>;
fn loadCandidate(at:u32)->u32 { return ${atomicGather ? 'atomicLoad(&candidates[at])' : 'candidates[at]'}; }
fn storeCandidate(at:u32,value:u32) { ${atomicGather ? 'atomicStore(&candidates[at],value)' : 'candidates[at]=value'}; }
${closestPointOnTriangleWGSL}
${finiteContactsWGSL}
const budget = ${budget}u;
const padding = ${cfg.simulationThickness}f;
const eagerRanking=${!lazyRanking};
fn candidateScore(a:vec3f,b:vec3f,c:vec3f,other:u32)->f32 {
  let tri=triangles[other];let p=positions[tri.x].xyz;let q=positions[tri.y].xyz;let r=positions[tri.z].xyz;
  let center=(p+q+r)/3.0;
  var score=distance(center,getClosestPointOnTriangle(a,b,c,center));
  if(finiteTrianglesCross(a,b,c,p,q,r)) { score=-1.0; }
  return score;
}
@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&triangles)) { return; }
  var retainedWords:array<u32,${budget}>;var retainedCount=0u;
  for (var at = 0u; at < budget; at++) {
    let word=loadCandidate(index*budget+at);
    // Zero-side records cannot carry continuation, so they require no remap lookup.
    if((word&0xf0000000u)!=0u && (word&0x0fffffffu)>=2u) { retainedWords[retainedCount]=word;retainedCount++; }
    storeCandidate(index*budget+at,0u);
  }
  let source = triangles[index];
  let a = positions[source.x].xyz; let b = positions[source.y].xyz; let c = positions[source.z].xyz;
  let oldA=previous[source.x].xyz;let oldB=previous[source.y].xyz;let oldC=previous[source.z].xyz;
  let low=min(min(a,min(b,c)),min(oldA,min(oldB,oldC)))-vec3f(padding);
  let high=max(max(a,max(b,c)),max(oldA,max(oldB,oldC)))+vec3f(padding);
  var count=0u;var ranked=eagerRanking;var scores:array<f32,${budget}>;
  var node=0u;
  while(node<arrayLength(&nodes)) {
    let entry=nodes[node];
    if(any(entry.low>high)||any(entry.high<low)) { node=entry.escape;continue; }
    if(entry.leaf==0xffffffffu) { node++;continue; }
    let first=entry.leaf&0x0fffffffu;let leafCount=entry.leaf>>28u;
    for(var item=0u;item<leafCount;item++) {
      let other=ordered[first+item];if(other==index) { continue; }
      let otherTri=triangles[other];
      if (source.x==otherTri.x || source.x==otherTri.y || source.x==otherTri.z
        || source.y==otherTri.x || source.y==otherTri.y || source.y==otherTri.z
        || source.z==otherTri.x || source.z==otherTri.y || source.z==otherTri.z) { continue; }
      let p=positions[otherTri.x].xyz; let q=positions[otherTri.y].xyz; let r=positions[otherTri.z].xyz;
      let oldP=previous[otherTri.x].xyz;let oldQ=previous[otherTri.y].xyz;let oldR=previous[otherTri.z].xyz;
      let targetLow=min(min(p,min(q,r)),min(oldP,min(oldQ,oldR)));
      let targetHigh=max(max(p,max(q,r)),max(oldP,max(oldQ,oldR)));
      if(any(targetLow>high)||any(targetHigh<low)) { continue; }
      if(count<budget) {
        var word=other+2u;
        for(var prior=0u;prior<retainedCount;prior++) {
          if((retainedWords[prior]&0x0fffffffu)==word) { word|=retainedWords[prior]&0xf0000000u;break; }
        }
        storeCandidate(index*budget+count,word);
        if(eagerRanking) { scores[count]=candidateScore(a,b,c,other); }
        count++;
      } else {
        if(!ranked) {
          for(var retained=0u;retained<count;retained++) { scores[retained]=candidateScore(a,b,c,(loadCandidate(index*budget+retained)&0x0fffffffu)-2u); }
          ranked=true;
        }
        let score=candidateScore(a,b,c,other);
        var farthest=0u;
        for(var slot=0u;slot<count;slot++) { if(scores[slot]>scores[farthest]) { farthest=slot; } }
        if(score<scores[farthest]) {
          var word=other+2u;
          for(var prior=0u;prior<retainedCount;prior++) {
              if((retainedWords[prior]&0x0fffffffu)==word) { word|=retainedWords[prior]&0xf0000000u;break; }
          }
          storeCandidate(index*budget+farthest,word);scores[farthest]=score;
        }
      }
    }
    node=entry.escape;
  }
}`;
}

/** Whole-seam closure, rather than a single nearby sewing endpoint, permits local welded contact. */
export function surfaceSeamGapsWGSL(): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read> links: array<u32>;
@group(0) @binding(2) var<storage, read_write> gaps: array<f32>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let seam=gid.x;
  if(seam>=arrayLength(&gaps)) { return; }
  var gap=0.0;
  for(var at=links[seam];at<links[seam+1u];at+=2u) {
    gap=max(gap,distance(positions[links[at]].xyz,positions[links[at+1u]].xyz));
  }
  gaps[seam]=gap;
}`;
}

export function solveSelfSurfaceCollisionWGSL(cfg: SimConfig, allowWarmStart = true, gateLayout?: SeamGateLayout, refinedSeamProof = false): string {
  const budget=cfg.numInternalSurfaceCollisionConstraints ?? 32;
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read> triangles: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> candidates: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> previous: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> corrections: array<vec4f>;
@group(0) @binding(5) var<storage, read> topology: array<u32>;
@group(0) @binding(6) var<storage, read> seamLinks: array<u32>;
@group(0) @binding(7) var<storage, read> seamGaps: array<f32>;
${seamGateWGSL('Gate', gateLayout)}
@group(0) @binding(8) var<uniform> gate: Gate;
${closestPointOnTriangleWGSL}
${finiteContactsWGSL}
const thickness=${cfg.simulationThickness}f;
const maxCorrection=${cfg.maxSurfaceCorrection ?? 0.005}f;
const budget=${budget}u;
${refinedSeamProof ? refinedSeamProofWGSL : ''}fn seamNeighborhoodFor(face:u32, other:u32, point:vec3f, onlySeam:u32) -> u32 {
  var result=0u;
  for(var at=topology[face];at<topology[face+1u];at+=5u) {
    if(topology[at]<other) { continue; }
    if(topology[at]>other) { break; }
    let threshold=topology[at+1u]; let seam=topology[at+4u];
    if(threshold!=0xffffffffu && gate.sewnUpTo<=i32(threshold)) { continue; }
    if(!activeSourceSeam(seam) || !activeSourceSegment(topology[at+3u])) { continue; }
    if(seam==0xffffffffu || seam>=arrayLength(&seamGaps)) { continue; }
    if(onlySeam!=0xffffffffu && seam!=onlySeam) { continue; }
    // This segment pointer was emitted only for an actual paired endpoint connected to BOTH
    // intersecting face one-rings. Ownership elsewhere on the same seam cannot emit it.
    let link=topology[at+2u];
${refinedSeamProof ? `    if((link&0x80000000u)!=0u) {
      result=max(result,refinedSeamNeighborhood(face,other,point,link&0x7fffffffu));
      continue;
    }
` : ''}    let a0=positions[seamLinks[link]].xyz;let b0=positions[seamLinks[link+1u]].xyz;
    let a1=positions[seamLinks[link+2u]].xyz;let b1=positions[seamLinks[link+3u]].xyz;
    let midpoint=(a0+b0)*0.5;let delta=(a1+b1)*0.5-midpoint;
    var t=0.0;let squared=dot(delta,delta);
    if(squared>1e-20) { t=clamp(dot(point-midpoint,delta)/squared,0.0,1.0); }
    let correspondingA=mix(a0,a1,t);let correspondingB=mix(b0,b1,t);
    if(distance(point,correspondingA)<=0.005 && distance(point,correspondingB)<=0.005) {
      result=max(result,select(1u,2u,distance(correspondingA,correspondingB)<=0.003));
    }
  }
  return result;
}
fn seamNeighborhood(face:u32, other:u32, point:vec3f) -> u32 {
  return seamNeighborhoodFor(face,other,point,0xffffffffu);
}
fn expectedFaceContact(face:u32,other:u32,hits:array<vec3f,12>,count:u32) -> bool {
  for(var at=topology[face];at<topology[face+1u];at+=5u) {
    if(topology[at]<other) { continue; }
    if(topology[at]>other) { break; }
    let seam=topology[at+4u];if(seam==0xffffffffu) { continue; }
    var accepted=true;
    for(var hit=0u;hit<count;hit++) {
      if(seamNeighborhoodFor(face,other,hits[hit],seam)!=2u) { accepted=false;break; }
    }
    if(accepted) { return true; }
  }
  return false;
}
const allowWarmStart=${allowWarmStart};
${finiteSelfContactWGSL}`;
}

const REFIT_NODE = 'struct Node { low:vec3f,escape:u32,high:vec3f,leaf:u32 };';

/** Six storage buffers, one invocation per immutable node; only leaves perform ≤8 reductions. */
export function refitSurfaceLeavesWGSL(workgroupSize = WORKGROUP_SIZE): string {
  return `${REFIT_NODE}
@group(0) @binding(0) var<storage,read_write> nodes:array<Node>;
@group(0) @binding(1) var<storage,read> ordered:array<u32>;
@group(0) @binding(2) var<storage,read> triangles:array<vec4u>;
@group(0) @binding(3) var<storage,read> positions:array<vec4f>;
@group(0) @binding(4) var<storage,read> previous:array<vec4f>;
@group(0) @binding(5) var<storage,read> ranges:array<vec4u>;
@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid:vec3u) {
  let index=gid.x;
  if(index>=arrayLength(&nodes)) { return; }
  if(nodes[index].leaf==0xffffffffu) { return; }
  var low=vec3f(1e30); var high=vec3f(-1e30);
  let first=ranges[index].x; let count=ranges[index].y;
  for(var item=0u;item<count;item++) {
    let tri=triangles[ordered[first+item]];
    low=min(low,min(min(positions[tri.x].xyz,min(positions[tri.y].xyz,positions[tri.z].xyz)),
      min(previous[tri.x].xyz,min(previous[tri.y].xyz,previous[tri.z].xyz))));
    high=max(high,max(max(positions[tri.x].xyz,max(positions[tri.y].xyz,positions[tri.z].xyz)),
      max(previous[tri.x].xyz,max(previous[tri.y].xyz,previous[tri.z].xyz))));
  }
  nodes[index].low=low; nodes[index].high=high;
}`;
}

/** Two storage buffers plus16-byte level uniform; each dispatch reads already completed children. */
export function refitSurfaceParentsWGSL(workgroupSize = WORKGROUP_SIZE): string {
  return `${REFIT_NODE}
struct Level { first:u32,count:u32,pad0:u32,pad1:u32 };
@group(0) @binding(0) var<storage,read_write> nodes:array<Node>;
@group(0) @binding(1) var<storage,read> parentIds:array<u32>;
@group(0) @binding(2) var<uniform> level:Level;
@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid:vec3u) {
  if(gid.x>=level.count) { return; }
  let index=parentIds[level.first+gid.x];
  let left=index+1u; let right=nodes[left].escape;
  nodes[index].low=min(nodes[left].low,nodes[right].low);
  nodes[index].high=max(nodes[left].high,nodes[right].high);
}`;
}

/** Preserve canonical pair impulses through incident gathering. Body facet gathering continues
 * to use its own averaging; this self-only accumulator sums compatible finite contact vectors,
 * bounds their total once, and passes a single response to the generic application shader. */
export function gatherSelfSurfaceCorrectionsWGSL(cfg: SimConfig, maxIncident: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage,read> triangles:array<vec4u>;
@group(0) @binding(1) var<storage,read> incident:array<i32>;
@group(0) @binding(2) var<storage,read> faceCorrections:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> particleCorrections:array<vec4f>;
@group(0) @binding(4) var<storage,read> positions:array<vec4f>;
const stride=${maxIncident + 1}u;
const maximum=${cfg.maxSurfaceCorrection ?? .005}f;
@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid:vec3u) {
  let particle=gid.x;if(particle>=arrayLength(&particleCorrections)) { return; }
  var total=vec3f(0.0);
  for(var slot=0u;slot<${maxIncident}u;slot++) {
    let encoded=incident[particle*stride+slot+1u];if(encoded<0) { break; }
    let face=u32(encoded);let tri=triangles[face];
    var corner=0u;
    if(tri.y==particle) { corner=1u; } else if(tri.z==particle) { corner=2u; }
    else if(tri.x!=particle) { continue; }
    total+=faceCorrections[face*3u+corner].xyz;
  }
  let origin=abs(positions[particle].xyz);
  let coordinateScale=max(1.0,max(origin.x,max(origin.y,origin.z)));
  let packedMaximum=max(0.0,maximum-4.0*0.000000059604644775390625*(coordinateScale+maximum));
  let magnitude=length(total);if(magnitude>packedMaximum) { total*=packedMaximum/magnitude; }
  particleCorrections[particle]+=vec4f(total,1.0);
}`;
}

/** Actual piecewise corresponding material paths. The original topology row already proved
 * BOTH original endpoint stamps, active seam mask, and actual paired-knot one-ring topology. */
export const refinedSeamProofWGSL = /* wgsl */ `
fn refinedFaceTouches(face:u32, child:u32) -> bool {
  if(face>=arrayLength(&triangles) || child>=arrayLength(&triangles)) { return false; }
  let a=triangles[face].xyz;let b=triangles[child].xyz;
  return any(a==vec3u(b.x)) || any(a==vec3u(b.y)) || any(a==vec3u(b.z));
}
fn refinedSeamNeighborhood(face:u32,other:u32,point:vec3f,link:u32) -> u32 {
  if(link>arrayLength(&seamLinks) || arrayLength(&seamLinks)-link<10u) { return 0u; }
  let a=vec3u(seamLinks[link],seamLinks[link+1u],seamLinks[link+2u]);
  let b=vec3u(seamLinks[link+3u],seamLinks[link+4u],seamLinks[link+5u]);
  let size=arrayLength(&positions);
  if(a.x>=size || a.z>=size || b.x>=size || b.z>=size
    || (a.y!=0xffffffffu && a.y>=size) || (b.y!=0xffffffffu && b.y>=size)) { return 0u; }
  // Free M never acquires a stitch, even if it drifts onto the corresponding short path.
  if(a.y!=0xffffffffu) { if(dot(point-positions[a.y].xyz,point-positions[a.y].xyz)<=1e-12) { return 0u; } }
  if(b.y!=0xffffffffu) { if(dot(point-positions[b.y].xyz,point-positions[b.y].xyz)<=1e-12) { return 0u; } }
  for(var cell=0u;cell<2u;cell++) {
    let childA=seamLinks[link+6u+cell];let childB=seamLinks[link+8u+cell];
    if(!((refinedFaceTouches(face,childA)&&refinedFaceTouches(other,childB))
      || (refinedFaceTouches(face,childB)&&refinedFaceTouches(other,childA)))) { continue; }
    let u0=f32(cell)*0.5;let u1=f32(cell+1u)*0.5;
    var a0=mix(positions[a.x].xyz,positions[a.z].xyz,u0);var a1=mix(positions[a.x].xyz,positions[a.z].xyz,u1);
    var b0=mix(positions[b.x].xyz,positions[b.z].xyz,u0);var b1=mix(positions[b.x].xyz,positions[b.z].xyz,u1);
    if(a.y!=0xffffffffu) { a0=positions[a.x].xyz;a1=positions[a.y].xyz;if(cell==1u) { a0=positions[a.y].xyz;a1=positions[a.z].xyz; } }
    if(b.y!=0xffffffffu) { b0=positions[b.x].xyz;b1=positions[b.y].xyz;if(cell==1u) { b0=positions[b.y].xyz;b1=positions[b.z].xyz; } }
    let midpoint=(a0+b0)*0.5;let delta=(a1+b1)*0.5-midpoint;let squared=dot(delta,delta);
    var t=0.0;if(squared>0.0) { t=clamp(dot(point-midpoint,delta)/squared,0.0,1.0); }
    let correspondingA=mix(a0,a1,t);let correspondingB=mix(b0,b1,t);
    if(distance(point,correspondingA)<=0.005 && distance(point,correspondingB)<=0.005
      && distance(correspondingA,correspondingB)<=0.003) { return 2u; }
  }
  return 0u;
}
`;
