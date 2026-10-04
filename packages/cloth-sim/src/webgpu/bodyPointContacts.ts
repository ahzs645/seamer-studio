import type { SimConfig } from '../config';
import { closestPointOnTriangleWGSL } from './shaders';
import { finiteContactsWGSL } from './finiteContacts';

/** Observe corrected substep endpoints without changing solver state or advancing time. */
export function captureCollisionSubstepWGSL(): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> trajectory: array<vec4f>;
struct Params { substep: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if(gid.x>=arrayLength(&positions)) { return; }
  trajectory[params.substep*arrayLength(&positions)+gid.x]=positions[gid.x];
}`;
}

/** Exact finite nearest-feature and entering sweep queries, without a candidate-count cutoff.
 * Four vec4s per particle hold closest point/signed distance, outward escape/validity,
 * and a finite entering-sweep correction/validity. Static welded pseudonormals classify edges. */
export function gatherBodyPointContactsWGSL(): string {
  return /* wgsl */ `
struct Node { low: vec3f, escape: u32, high: vec3f, leaf: u32 };
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> contacts: array<vec4f>;
@group(0) @binding(2) var<storage, read> nodes: array<Node>;
@group(0) @binding(3) var<storage, read> ordered: array<u32>;
@group(0) @binding(4) var<storage, read> triangles: array<vec4u>;
@group(0) @binding(5) var<storage, read> body: array<vec4f>;
@group(0) @binding(6) var<storage, read> previous: array<vec4f>;
@group(0) @binding(7) var<storage, read> featureNormals: array<vec4f>;
${closestPointOnTriangleWGSL}
${finiteContactsWGSL}
fn boxDistance2(point: vec3f, low: vec3f, high: vec3f) -> f32 {
  let delta = max(max(low-point,point-high),vec3f(0.0)); return dot(delta,delta);
}
fn featureNormal(index: u32, a: vec3f, b: vec3f, c: vec3f, point: vec3f, face: vec3f) -> vec3f {
  let ab=b-a; let ac=c-a; let ap=point-a;
  let aa=dot(ab,ab); let bb=dot(ab,ac); let cc=dot(ac,ac);
  let determinant=aa*cc-bb*bb;
  if (determinant<=1e-20) { return vec3f(0.0); }
  let y=(cc*dot(ap,ab)-bb*dot(ap,ac))/determinant;
  let z=(aa*dot(ap,ac)-bb*dot(ap,ab))/determinant;
  let bary=vec3f(1.0-y-z,y,z); let eps=0.00001;
  var slot=6u;
  if (bary.y<=eps && bary.z<=eps) { slot=3u; }
  else if (bary.x<=eps && bary.z<=eps) { slot=4u; }
  else if (bary.x<=eps && bary.y<=eps) { slot=5u; }
  else if (bary.z<=eps) { slot=0u; }
  else if (bary.x<=eps) { slot=1u; }
  else if (bary.y<=eps) { slot=2u; }
  if (slot<6u) { return featureNormals[index*6u+slot].xyz; }
  return face;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index=gid.x; if(index>=arrayLength(&positions)) { return; }
  let base=index*4u;
  let priorFeature=contacts[base+1u].w;
  contacts[base]=vec4f(0.0);contacts[base+1u]=vec4f(0.0);contacts[base+2u]=vec4f(0.0);contacts[base+3u]=vec4f(0.0);
  if(positions[index].w<=0.0) { return; }
  let point=positions[index].xyz; let start=previous[index].xyz;
  let sweepLow=min(point,start); let sweepHigh=max(point,start); let delta=point-start;
  var best=3.40282e38f;var bestTriangle=0u;
  var nearest=vec3f(0.0); var pseudo=vec3f(0.0);
  // Re-evaluate an actual finite triangle, not a rounded prior closest point. The latter
  // can lie microscopically off skin and falsely undercut the nearest-distance upper bound.
  if(priorFeature>0.0 && u32(priorFeature)-1u<arrayLength(&triangles)) {
    let ti=u32(priorFeature)-1u;let tri=triangles[ti];
    let a=body[tri.x].xyz;let b=body[tri.y].xyz;let c=body[tri.z].xyz;
    let raw=cross(b-a,c-a);
    if(length(raw)>1e-12) {
      nearest=getClosestPointOnTriangle(a,b,c,point);let offset=point-nearest;
      best=dot(offset,offset);bestTriangle=ti;
      pseudo=featureNormal(ti,a,b,c,nearest,normalize(raw));
    }
  }
  var sweepTime=2.0; var sweepPoint=vec3f(0.0); var sweepNormal=vec3f(0.0);
  var nodeIndex=0u;
  loop {
    if(nodeIndex>=arrayLength(&nodes)) { break; }
    let node=nodes[nodeIndex];
    let nearby=boxDistance2(point,node.low,node.high)<=best+max(1e-12,2.0*sqrt(best)*0.000001);
    let swept=all(sweepHigh>=node.low) && all(sweepLow<=node.high);
    if(!nearby && !swept) { nodeIndex=node.escape;continue; }
    if(node.leaf==0xffffffffu) { nodeIndex++;continue; }
    let first=node.leaf&0x0fffffffu; let count=node.leaf>>28u;
    for(var at=0u;at<count;at++) {
      let ti=ordered[first+at]; let tri=triangles[ti];
      let a=body[tri.x].xyz;let b=body[tri.y].xyz;let c=body[tri.z].xyz;
      let raw=cross(b-a,c-a); let normalLength=length(raw);
      if(normalLength<=1e-12) { continue; }
      let normal=raw/normalLength;
      // Sweep overlap can retain a leaf whose distance bound cannot improve the nearest
      // feature. Keep all finite sweep tests, but avoid redundant closest-point work there.
      if(nearby) {
        let closest=getClosestPointOnTriangle(a,b,c,point);let offset=point-closest;
        let dist2=dot(offset,offset);
        if(dist2<best) { best=dist2;nearest=closest;pseudo=featureNormal(ti,a,b,c,closest,normal);bestTriangle=ti; }
      }
      if(swept && dot(delta,normal)<-1e-10 && dot(start-a,normal)>=-1e-7) {
        let hit=segmentTriangleHit(start,point,a,b,c);
        if(hit.w>=0.0 && hit.w<sweepTime) { sweepTime=hit.w;sweepPoint=hit.xyz;sweepNormal=normal; }
      }
    }
    nodeIndex=node.escape;
  }
  if(best<3.40282e38f && length(pseudo)>0.5) {
    let dist=sqrt(best);let interior=dot(point-nearest,pseudo)<0.0;
    let signedDistance=select(dist,-dist,interior);
    var escape=pseudo;
    if(dist>1e-9) { escape=select((point-nearest)/dist,(nearest-point)/dist,interior); }
    contacts[base]=vec4f(nearest,signedDistance); contacts[base+1u]=vec4f(escape,f32(bestTriangle+1u));
  }
  if(sweepTime<=1.0) { contacts[base+2u]=vec4f(sweepPoint-point,1.0); }
  if(sweepTime<=1.0) { contacts[base+3u]=vec4f(sweepNormal,1.0); }
}`;
}

export function solveBodyPointContactsWGSL(cfg: SimConfig, maxIncident: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> corrections: array<vec4f>;
@group(0) @binding(2) var<storage, read> contacts: array<vec4f>;
@group(0) @binding(3) var<storage, read> previous: array<vec4f>;
@group(0) @binding(4) var<storage, read> triangles: array<vec4u>;
@group(0) @binding(5) var<storage, read> incident: array<i32>;
const thickness=${cfg.simulationThickness}f;
const maxCorrection=${cfg.maxSurfaceCorrection ?? 0.005}f;
const friction=${cfg.externalCollisionFriction}f;
const stride=${maxIncident + 1}u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index=gid.x;if(index>=arrayLength(&positions) || positions[index].w<=0.0) { return; }
  let nearest=contacts[index*4u];let outward=contacts[index*4u+1u];
  let swept=contacts[index*4u+2u];
  if(outward.w==0.0 && swept.w==0.0) { return; }
  let delta=positions[index].xyz-previous[index].xyz;
  let interior=outward.w>0.0 && nearest.w<0.0;
  var normal=outward.xyz;var penetration=thickness-nearest.w;
  var correction=normal*max(penetration,0.0);
  if(swept.w>0.0) {
    // Return toward the actual first entering feature, then re-query for physical clearance.
    correction=swept.xyz;normal=contacts[index*4u+3u].xyz;penetration=length(correction)+thickness;
    correction+=normal*thickness;
  } else {
    if(penetration<=0.0) { return; }
    if(!interior && dot(delta,normal)>=0.0) { return; }
    let flag=incident[index*stride];
    if(!interior && flag!=0) {
      var clothNormal=vec3f(0.0);
      for(var slot=1u;slot<stride;slot++) {
        let ti=incident[index*stride+slot];if(ti<0) { break; }
        let tri=triangles[u32(ti)];
        let raw=cross(positions[tri.y].xyz-positions[tri.x].xyz,positions[tri.z].xyz-positions[tri.x].xyz);
        if(length(raw)>1e-12) { clothNormal+=normalize(raw); }
      }
      if(flag<0) { clothNormal=-clothNormal; }
      if(length(clothNormal)>1e-5 && dot(clothNormal,normal)<0.0) { return; }
    }
  }
  if(friction>0.0) {
    let tangent=delta-normal*dot(delta,normal);let len=length(tangent);
    if(len>1e-6) { correction-=tangent*(min(len,friction*penetration)/len); }
  }
  let lengthCorrection=length(correction);
  if(lengthCorrection>maxCorrection) { correction*=maxCorrection/lengthCorrection; }
  corrections[index]+=vec4f(correction,1.0);
}`;
}
