/** Invocation-local finite material-point contact projection. No cross-face writes. */
export const finiteSelfContactWGSL = /* wgsl */ `
// Uses only invocation-local data. Existing eight storage buffers plus uniform gate suffice.
// Existing finite hit collection, topology, active gate, and EVERY-endpoint local seam proof stay.
struct Witness {
  a: vec3f,
  b: vec3f,
  normal: vec3f,
  oldGap: f32,
  uncertainty: f32,
  valid: u32,
  owner: u32,
};
struct Response {
  a: array<vec3f, 3>,
  b: array<vec3f, 3>,
};
fn finiteBarycentric(tri: array<vec3f,3>, p: vec3f) -> vec3f {
  let ab=tri[1]-tri[0];let ac=tri[2]-tri[0];let ap=p-tri[0];
  let aa=dot(ab,ab);let bb=dot(ab,ac);let cc=dot(ac,ac);
  let det=aa*cc-bb*bb;
  if(det<=1e-20) { return vec3f(0.0); }
  let y=(cc*dot(ap,ab)-bb*dot(ap,ac))/det;
  let z=(aa*dot(ap,ac)-bb*dot(ap,ab))/det;
  let weights=max(vec3f(1.0-y-z,y,z),vec3f(0.0));
  return weights/max(dot(weights,vec3f(1.0)),1e-20);
}
fn baryPoint(tri: array<vec3f,3>, weights: vec3f) -> vec3f {
  return tri[0]*weights.x+tri[1]*weights.y+tri[2]*weights.z;
}
// Arithmetic side uncertainty only: no body/cloth safety or physical clearance tolerance.
fn gramCondition(tri:array<vec3f,3>)->f32 {
  let ab=tri[1]-tri[0];let ac=tri[2]-tri[0];
  let aa=dot(ab,ab);let bb=dot(ab,ac);let cc=dot(ac,ac);
  let gamma16=16.0*0.000000059604644775390625/(1.0-16.0*0.000000059604644775390625);
  let lower=aa*cc-bb*bb-gamma16*(aa*cc+bb*bb);
  if(lower<=0.0) { return 1e30; }
  return (aa+cc)*(aa+cc)/lower;
}
fn materialHistoryUncertainty(a:array<vec3f,3>,b:array<vec3f,3>,oldA:array<vec3f,3>,oldB:array<vec3f,3>,hit:vec3f,weightsA:vec3f,weightsB:vec3f)->f32 {
  var scale=max(abs(hit.x),max(abs(hit.y),abs(hit.z)));
  for(var k=0u;k<3u;k++) {
    let value=max(max(abs(a[k]),abs(b[k])),max(abs(oldA[k]),abs(oldB[k])));
    scale=max(scale,max(value.x,max(value.y,value.z)));
  }
  let spanA=length(oldA[1]-oldA[0])+length(oldA[2]-oldA[0]);
  let spanB=length(oldB[1]-oldB[0])+length(oldB[2]-oldB[0]);
  let ab=oldB[1]-oldB[0];let ac=oldB[2]-oldB[0];let area=length(cross(ab,ac));
  if(area<=1e-20) { return 1e30; }
  let normalCondition=length(ab)*length(ac)/area;
  let relative=length(baryPoint(oldA,weightsA)-baryPoint(oldB,weightsB));
  let u=0.000000059604644775390625;
  return max(1e-7,16.0*u*scale+32.0*u*((1.0+gramCondition(a))*spanA+(1.0+gramCondition(b))*spanB)+16.0*u*normalCondition*relative);
}
fn canonicalFaces(aId:u32,bId:u32,aLayer:u32,bLayer:u32) -> vec2u {
  if(aLayer>bLayer || (aLayer==bLayer && aId<bId)) { return vec2u(aId,bId); }
  return vec2u(bId,aId);
}
fn finiteCrossingWitness(a:array<vec3f,3>,b:array<vec3f,3>,
  oldA:array<vec3f,3>,oldB:array<vec3f,3>,hit:vec3f,lowerLayerKinematic:bool,targetOutsideFlipped:bool,continuedSides:u32) -> Witness {
  var result=Witness(vec3f(0.0),vec3f(0.0),vec3f(0.0),0.0,0.0,0u,1u);
  result.a=finiteBarycentric(a,hit);result.b=finiteBarycentric(b,hit);
  if(dot(result.a,vec3f(1.0))<0.5 || dot(result.b,vec3f(1.0))<0.5) { return result; }
  // The finite FACE containing an interior intersection point supplies the edge/face
  // normal. A target edge through the source interior must not use the target's unrelated
  // plane normal. Native warm starts and authored unequal layers keep their target policy.
  if(!allowWarmStart && !lowerLayerKinematic) {
    let sourceInterior=min(result.a.x,min(result.a.y,result.a.z))>1e-5;
    let targetInterior=min(result.b.x,min(result.b.y,result.b.z))>1e-5;
    if(sourceInterior==targetInterior) { result.owner=2u;return result; }
    result.owner=select(1u,0u,sourceInterior);
  }
  var owner=b;var oldOwner=oldB;
  if(result.owner==0u) { owner=a;oldOwner=oldA; }
  let oldRaw=cross(oldOwner[1]-oldOwner[0],oldOwner[2]-oldOwner[0]);
  let raw=cross(owner[1]-owner[0],owner[2]-owner[0]);
  if(length(raw)<=1e-12 || (!lowerLayerKinematic && length(oldRaw)<=1e-12)) { return result; }
  var normal=normalize(raw);var oldNormal=normal;
  if(length(oldRaw)>1e-12) { oldNormal=normalize(oldRaw); }
  if(dot(normal,oldNormal)<0.0) { normal=-normal; }
  // At an actual finite crossing both CURRENT material points identify the same witness.
  // Transport relative motion without subtracting rounded metre-scale reconstructions.
  let movementA=array<vec3f,3>(oldA[0]-a[0],oldA[1]-a[1],oldA[2]-a[2]);
  let movementB=array<vec3f,3>(oldB[0]-b[0],oldB[1]-b[1],oldB[2]-b[2]);
  result.oldGap=dot(baryPoint(movementA,result.a)-baryPoint(movementB,result.b),oldNormal);
  if(result.owner==0u) {
    result.uncertainty=materialHistoryUncertainty(b,a,oldB,oldA,hit,result.b,result.a);
  } else {
    result.uncertainty=materialHistoryUncertainty(a,b,oldA,oldB,hit,result.a,result.b);
  }
  if(lowerLayerKinematic) {
    result.normal=normal*select(1.0,-1.0,targetOutsideFlipped);
  } else {
    let side=(continuedSides>>(28u+2u*result.owner))&3u;
    if(side==3u) { return result; }
    if(side==0u && abs(result.oldGap)<=result.uncertainty) { return result; }
    let positive=select(result.oldGap>0.0,side==1u,side!=0u);
    result.normal=normal*select(-1.0,1.0,positive);
  }
  result.valid=1u;
  return result;
}
// Equal-layer proof checks all endpoints separately for each actual owning face. Source-owner
// and target-owner signs may differ; neither may reinterpret the other's side bits. Conflicting
// or uncertain history stays unresolved. Both invocations share canonical roles and hit order.
fn finiteClosestWitness(a:array<vec3f,3>,b:array<vec3f,3>,
  oldB:array<vec3f,3>,closestA:vec3f,closestB:vec3f,thickness:f32,lowerLayerKinematic:bool,targetOutsideFlipped:bool) -> Witness {
  let delta=closestA-closestB;let distance=length(delta);
  var result=Witness(vec3f(0.0),vec3f(0.0),vec3f(0.0),0.0,0.0,0u,1u);
  if(distance>=thickness || distance<=1e-9) { return result; }
  result.a=finiteBarycentric(a,closestA);result.b=finiteBarycentric(b,closestB);
  result.normal=delta/distance;
  if(lowerLayerKinematic) {
    let raw=cross(b[1]-b[0],b[2]-b[0]);if(length(raw)<=1e-12) { return result; }
    var normal=normalize(raw);
    let oldRaw=cross(oldB[1]-oldB[0],oldB[2]-oldB[0]);
    if(length(oldRaw)>1e-12 && dot(normal,oldRaw)<0.0) { normal=-normal; }
    result.normal=normal*select(1.0,-1.0,targetOutsideFlipped);
  }
  result.valid=1u;return result;
}
// closestA/B must come from the actual minimum among six vertex/finite-face plus nine
// finite edge/edge closest pairs, as in the CPU reference. Negative infinite plane is insufficient.
fn sharedResponse(w:Witness,a:array<vec3f,3>,b:array<vec3f,3>,
  inverseA:vec3f,inverseB:vec3f,lowerLayerKinematic:bool,thickness:f32,maxCorrection:f32) -> Response {
  var result:Response;
  for(var k=0u;k<3u;k++) { result.a[k]=vec3f(0.0);result.b[k]=vec3f(0.0); }
  if(w.valid==0u) { return result; }
  let massB=select(inverseB,vec3f(0.0),lowerLayerKinematic);
  let denominator=dot(inverseA,w.a*w.a)+dot(massB,w.b*w.b);
  if(denominator<=0.0) { return result; }
  let depth=max(0.0,thickness-dot(baryPoint(a,w.a)-baryPoint(b,w.b),w.normal));
  let lambda=depth/denominator;
  let amplitudeA=inverseA*w.a*lambda;let amplitudeB=massB*w.b*lambda;
  let largest=max(max(amplitudeA.x,max(amplitudeA.y,amplitudeA.z)),
    max(amplitudeB.x,max(amplitudeB.y,amplitudeB.z)));
  // Common pair scale preserves compatible opposite responses and immovable masses.
  let factor=min(1.0,maxCorrection/max(largest,1e-20));
  for(var k=0u;k<3u;k++) {
    result.a[k]=w.normal*amplitudeA[k]*factor;
    result.b[k]=-w.normal*amplitudeB[k]*factor;
  }
  return result;
}
/** Nonnegative coupled witness multipliers prevent highly correlated endpoints from each
 * applying a full clearance impulse. All six virtual corners share one net recovery bound. */
fn coupledResponse(w:array<Witness,9>,count:u32,a:array<vec3f,3>,b:array<vec3f,3>,
  inverseA:vec3f,inverseB:vec3f,lowerLayerKinematic:bool,thickness:f32,maximum:f32)->Response {
  if(count==1u) { return sharedResponse(w[0],a,b,inverseA,inverseB,lowerLayerKinematic,thickness,maximum); }
  var result:Response;
  let massB=select(inverseB,vec3f(0.0),lowerLayerKinematic);
  var gram:array<f32,81>;var depth:array<f32,9>;var lambda:array<f32,9>;
  for(var i=0u;i<count;i++) {
    lambda[i]=0.0;
    depth[i]=max(0.0,thickness-dot(baryPoint(a,w[i].a)-baryPoint(b,w[i].b),w[i].normal));
    for(var j=0u;j<count;j++) {
      gram[i*9u+j]=(dot(inverseA,w[i].a*w[j].a)+dot(massB,w[i].b*w[j].b))*dot(w[i].normal,w[j].normal);
    }
  }
  for(var sweep=0u;sweep<32u;sweep++) {
    for(var i=0u;i<count;i++) {
      let diagonal=gram[i*9u+i];if(diagonal<=0.0) { continue; }
      var value=0.0;for(var j=0u;j<count;j++) { value+=gram[i*9u+j]*lambda[j]; }
      lambda[i]=max(0.0,lambda[i]+(depth[i]-value)/diagonal);
    }
  }
  var largest=0.0;
  for(var k=0u;k<3u;k++) {
    result.a[k]=vec3f(0.0);result.b[k]=vec3f(0.0);
    for(var i=0u;i<count;i++) {
      result.a[k]+=w[i].normal*(inverseA[k]*w[i].a[k]*lambda[i]);
      result.b[k]-=w[i].normal*(massB[k]*w[i].b[k]*lambda[i]);
    }
    largest=max(largest,max(length(result.a[k]),length(result.b[k])));
  }
  let factor=min(1.0,maximum/max(largest,1e-20));
  for(var k=0u;k<3u;k++) { result.a[k]*=factor;result.b[k]*=factor; }
  return result;
}
// Each face invocation accumulates ONLY result.a or result.b for its own three corners.
// No invocation writes another face/particle; use the existing incident-face gather pass.
// Do not average independently by face degree: it breaks the shared contact-point response.
// After gathering all vectors at a particle, clamp the TOTAL to maxCorrection and apply once.
// Fixed masses stay zero. Refresh finite candidates/witnesses after every application.

fn closestSegmentPair(a:vec3f,b:vec3f,p:vec3f,q:vec3f)->array<vec3f,2> {
  let d1=b-a;let d2=q-p;let relative=a-p;
  let aa=dot(d1,d1);let ee=dot(d2,d2);let ff=dot(d2,relative);
  var s=0.0;var t=0.0;
  if(aa<=1e-20 && ee<=1e-20) { return array<vec3f,2>(a,p); }
  if(aa<=1e-20) { t=clamp(ff/ee,0.0,1.0); }
  else {
    let cc=dot(d1,relative);
    if(ee<=1e-20) { s=clamp(-cc/aa,0.0,1.0); }
    else {
      let bb=dot(d1,d2);let det=aa*ee-bb*bb;
      if(det>1e-12*aa*ee) { s=clamp((bb*ff-cc*ee)/det,0.0,1.0); }
      t=(bb*s+ff)/ee;
      if(t<0.0) { t=0.0;s=clamp(-cc/aa,0.0,1.0); }
      else if(t>1.0) { t=1.0;s=clamp((bb-cc)/aa,0.0,1.0); }
    }
  }
  return array<vec3f,2>(a+d1*s,p+d2*t);
}
fn closestFinitePair(a:array<vec3f,3>,b:array<vec3f,3>)->array<vec3f,2> {
  var result=array<vec3f,2>(a[0],getClosestPointOnTriangle(b[0],b[1],b[2],a[0]));
  var best=dot(result[0]-result[1],result[0]-result[1]);
  for(var k=0u;k<3u;k++) {
    let closestBPoint=getClosestPointOnTriangle(b[0],b[1],b[2],a[k]);
    let d=a[k]-closestBPoint;let squared=dot(d,d);
    if(squared<best) { best=squared;result=array<vec3f,2>(a[k],closestBPoint); }
    let source=getClosestPointOnTriangle(a[0],a[1],a[2],b[k]);
    let reverse=source-b[k];let reversedSquared=dot(reverse,reverse);
    if(reversedSquared<best) { best=reversedSquared;result=array<vec3f,2>(source,b[k]); }
    for(var j=0u;j<3u;j++) {
      let pair=closestSegmentPair(a[k],a[(k+1u)%3u],b[j],b[(j+1u)%3u]);
      let delta=pair[0]-pair[1];let separation=dot(delta,delta);
      if(separation<best) { best=separation;result=pair; }
    }
  }
  return result;
}
// Reciprocal retained words share independent owner proofs: low28 stores faceID+2; bits28/29
// store source-owner side and bits30/31 target-owner side (0unknown,1positive,2negative,3invalid).
// Unknown inherits a proved side; conflicting signs invalidate that SAME owner, never guessing.
fn reconcilePairSeed(ownSlot:u32,otherSlot:u32,proposal:u32)->u32 {
  var bits=(atomicLoad(&candidates[ownSlot])|atomicLoad(&candidates[otherSlot])|proposal)&0xf0000000u;
  atomicOr(&candidates[ownSlot],bits);atomicOr(&candidates[otherSlot],bits);
  bits=(atomicLoad(&candidates[ownSlot])|atomicLoad(&candidates[otherSlot]))&0xf0000000u;
  if(((bits>>28u)&3u)==3u || ((bits>>30u)&3u)==3u) { atomicOr(&candidates[ownSlot],bits);atomicOr(&candidates[otherSlot],bits); }
  return bits;
}
fn clearSeparatedPairSeed(ownSlot:u32,otherSlot:u32) {
  atomicAnd(&candidates[ownSlot],0x0fffffffu);atomicAnd(&candidates[otherSlot],0x0fffffffu);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid:vec3u) {
  let index=gid.x;if(index>=arrayLength(&triangles)) { return; }
  for(var k=0u;k<3u;k++) { corrections[index*3u+k]=vec4f(0.0); }
  let own=triangles[index];
  var total:array<vec3f,3>;
  for(var slot=0u;slot<budget;slot++) {
    let word=atomicLoad(&candidates[index*budget+slot]);let encoded=word&0x0fffffffu;if(encoded<2u) { break; }
    let other=encoded-2u;let otherTri=triangles[other];
    var reciprocal=false;var reciprocalSlot=0u;
    for(var retained=0u;retained<budget;retained++) {
      let reverse=atomicLoad(&candidates[other*budget+retained])&0x0fffffffu;if(reverse<2u) { break; }
      if(reverse==index+2u) { reciprocal=true;reciprocalSlot=other*budget+retained;break; }
    }
    if(!reciprocal) { continue; }
    let roles=canonicalFaces(index,other,own.w&0x7fffffffu,otherTri.w&0x7fffffffu);
    let sourceTri=triangles[roles.x];let targetTri=triangles[roles.y];
    let sourceIds=array<u32,3>(sourceTri.x,sourceTri.y,sourceTri.z);
    let targetIds=array<u32,3>(targetTri.x,targetTri.y,targetTri.z);
    var a=array<vec3f,3>(positions[sourceIds[0]].xyz,positions[sourceIds[1]].xyz,positions[sourceIds[2]].xyz);
    var b=array<vec3f,3>(positions[targetIds[0]].xyz,positions[targetIds[1]].xyz,positions[targetIds[2]].xyz);
    let oldA=array<vec3f,3>(previous[sourceIds[0]].xyz,previous[sourceIds[1]].xyz,previous[sourceIds[2]].xyz);
    let oldB=array<vec3f,3>(previous[targetIds[0]].xyz,previous[targetIds[1]].xyz,previous[targetIds[2]].xyz);
    let inverseA=vec3f(positions[sourceIds[0]].w,positions[sourceIds[1]].w,positions[sourceIds[2]].w);
    let inverseB=vec3f(positions[targetIds[0]].w,positions[targetIds[1]].w,positions[targetIds[2]].w);
    let lowerLayerKinematic=(sourceTri.w&0x7fffffffu)!=(targetTri.w&0x7fffffffu);
    let outsideFlipped=(targetTri.w&0x80000000u)!=0u;
    var hits:array<vec3f,9>;var count=0u;
    for(var edge=0u;edge<3u;edge++) {
      for(var direction=0u;direction<2u;direction++) {
        var hit:vec4f;
        if(direction==0u) { hit=segmentTriangleHit(a[edge],a[(edge+1u)%3u],b[0],b[1],b[2]); }
        else { hit=segmentTriangleHit(b[edge],b[(edge+1u)%3u],a[0],a[1],a[2]); }
        if(hit.w<0.0) { continue; }
        var duplicate=false;
        for(var at=0u;at<count;at++) { if(distance(hits[at],hit.xyz)<1e-7) { duplicate=true; } }
        if(!duplicate) { hits[count]=hit.xyz;count++; }
      }
    }
    var proofHits:array<vec3f,12>;var proofCount=0u;
    for(var edge=0u;edge<3u;edge++) {
      let currentA=segmentTriangleHit(a[edge],a[(edge+1u)%3u],b[0],b[1],b[2]);
      let currentB=segmentTriangleHit(b[edge],b[(edge+1u)%3u],a[0],a[1],a[2]);
      let sweptA=segmentTriangleHit(oldA[edge],a[edge],b[0],b[1],b[2]);
      let sweptB=segmentTriangleHit(oldB[edge],b[edge],a[0],a[1],a[2]);
      if(currentA.w>=0.0) { proofHits[proofCount]=currentA.xyz;proofCount++; }
      if(currentB.w>=0.0) { proofHits[proofCount]=currentB.xyz;proofCount++; }
      if(sweptA.w>=0.0) { proofHits[proofCount]=sweptA.xyz;proofCount++; }
      if(sweptB.w>=0.0) { proofHits[proofCount]=sweptB.xyz;proofCount++; }
    }
    // Both former directional seam-proof sets must pass. A canonical pair cannot apply
    // only one half of an impulse because the opposite face waived a different swept hit.
    if(proofCount>0u && expectedFaceContact(roles.x,roles.y,proofHits,proofCount)) { continue; }
    let initialA=a;let initialB=b;
    var coordinateScale=1.0;
    for(var corner=0u;corner<3u;corner++) {
      let magnitude=max(abs(a[corner]),abs(b[corner]));
      coordinateScale=max(coordinateScale,max(magnitude.x,max(magnitude.y,magnitude.z)));
    }
    // Reserve only Float32 world-addition roundoff so PACKED motion stays within the unchanged
    // physical recovery maximum; this never enlarges a contact/seam acceptance tolerance.
    let packedMaximum=max(0.0,maxCorrection-4.0*0.000000059604644775390625*(coordinateScale+maxCorrection));
    var continuedSide=0u;
    if(!lowerLayerKinematic) { continuedSide=reconcilePairSeed(index*budget+slot,reciprocalSlot,0u); }
    if(((continuedSide>>28u)&3u)==3u || ((continuedSide>>30u)&3u)==3u) { continue; }
    // The seed is proved once against validated old geometry, then retained across every parent
    // contact pass in this substep. Gather remaps by face ID; the engine clears at the next step.
    // Atomic words avoid racing reciprocal ID reads against another face's seed publication.
    for(var inner=0u;inner<select(8u,1u,allowWarmStart);inner++) {
      var witnesses:array<Witness,9>;var usable=true;
    var positive=array<bool,2>(false,false);
    var negative=array<bool,2>(false,false);
    var present=array<bool,2>(false,false);
    if(count>0u) {
      for(var at=0u;at<count;at++) {
        witnesses[at]=finiteCrossingWitness(a,b,oldA,oldB,hits[at],lowerLayerKinematic,outsideFlipped,continuedSide);
        if(witnesses[at].valid==0u) { usable=false; }
        let owner=witnesses[at].owner;
        if(owner<2u) {
          present[owner]=true;
          positive[owner]=positive[owner] || witnesses[at].oldGap>witnesses[at].uncertainty;
          negative[owner]=negative[owner] || witnesses[at].oldGap< -witnesses[at].uncertainty;
        }
      }
      if(!lowerLayerKinematic) {
        for(var owner=0u;owner<2u;owner++) {
          let side=(continuedSide>>(28u+2u*owner))&3u;
          if(side==0u && positive[owner] && negative[owner]) { usable=false; }
        }
      }
      // A source assembly never invents a side when its actual material history is ambiguous.
      // Native cached meshes historically use the previous face-side convention. Restrict that
      // compatibility fallback to finite witnesses, leaving distant plane-negative corners alone.
      if(allowWarmStart && !lowerLayerKinematic && continuedSide==0u && (!usable || finiteTrianglesCross(oldA[0],oldA[1],oldA[2],oldB[0],oldB[1],oldB[2]))) {
        let oldRaw=cross(oldB[1]-oldB[0],oldB[2]-oldB[0]);
        let raw=cross(b[1]-b[0],b[2]-b[0]);
        if(length(oldRaw)>1e-12 && length(raw)>1e-12) {
          var normal=normalize(raw);if(dot(normal,oldRaw)<0.0) { normal=-normal; }
          let center=(oldA[0]+oldA[1]+oldA[2])/3.0;
          normal*=select(-1.0,1.0,dot(center-oldB[0],normal)>=0.0);
          for(var at=0u;at<count;at++) {
            witnesses[at].a=finiteBarycentric(a,hits[at]);witnesses[at].b=finiteBarycentric(b,hits[at]);
            witnesses[at].normal=normal;witnesses[at].valid=1u;
          }
          usable=true;
        }
      }
      if(!usable) {
        if(!lowerLayerKinematic) {
          // Ambiguous ownership or conflicting/uncertain first material proof cannot create
          // a contact direction. Mark the shared pair unresolved for this bounded substep.
          continuedSide=reconcilePairSeed(index*budget+slot,reciprocalSlot,0xf0000000u);
        }
        break;
      }
      if(!lowerLayerKinematic) {
        var proposal=0u;
        for(var owner=0u;owner<2u;owner++) {
          if(!present[owner] || ((continuedSide>>(28u+2u*owner))&3u)!=0u) { continue; }
          if(allowWarmStart) {
            let oldNormal=normalize(cross(oldB[1]-oldB[0],oldB[2]-oldB[0]));
            proposal|=select(2u,1u,dot(witnesses[0].normal,oldNormal)>=0.0)<<30u;
          } else {
            proposal|=select(2u,1u,positive[owner])<<(28u+2u*owner);
          }
        }
        continuedSide=reconcilePairSeed(index*budget+slot,reciprocalSlot,proposal);
        if(((continuedSide>>28u)&3u)==3u || ((continuedSide>>30u)&3u)==3u) { break; }
      }
    } else {
      let pair=closestFinitePair(a,b);
      if(distance(pair[0],pair[1])>=thickness) {
        clearSeparatedPairSeed(index*budget+slot,reciprocalSlot);break;
      }
      if(seamNeighborhood(roles.x,roles.y,(pair[0]+pair[1])*0.5)!=0u) { break; }
      witnesses[0]=finiteClosestWitness(a,b,oldB,pair[0],pair[1],thickness,lowerLayerKinematic,outsideFlipped);
      if(witnesses[0].valid==0u) { break; }
      count=1u;
    }
    let response=coupledResponse(witnesses,count,a,b,inverseA,inverseB,lowerLayerKinematic,thickness,packedMaximum);
    var maximum=0.0;
    for(var k=0u;k<3u;k++) {
      a[k]+=response.a[k];b[k]+=response.b[k];
      maximum=max(maximum,max(length(a[k]-initialA[k]),length(b[k]-initialB[k])));
    }
    if(maximum>packedMaximum) {
      let scale=packedMaximum/maximum;
      for(var k=0u;k<3u;k++) { a[k]=initialA[k]+(a[k]-initialA[k])*scale;b[k]=initialB[k]+(b[k]-initialB[k])*scale; }
      break;
    }
    // Recompute finite witnesses against the bounded virtual pair. No other particle is written.
    count=0u;
    for(var edge=0u;edge<3u;edge++) {
      for(var direction=0u;direction<2u;direction++) {
        var hit:vec4f;
        if(direction==0u) { hit=segmentTriangleHit(a[edge],a[(edge+1u)%3u],b[0],b[1],b[2]); }
        else { hit=segmentTriangleHit(b[edge],b[(edge+1u)%3u],a[0],a[1],a[2]); }
        if(hit.w<0.0) { continue; }
        var duplicate=false;
        for(var at=0u;at<count;at++) { if(distance(hits[at],hit.xyz)<1e-7) { duplicate=true; } }
        if(!duplicate) { hits[count]=hit.xyz;count++; }
      }
    }
    if(count==0u) { break; }
    }
    for(var k=0u;k<3u;k++) {
      if(index==roles.x) { total[k]+=a[k]-initialA[k]; }
      else { total[k]+=b[k]-initialB[k]; }
    }
  }
  for(var k=0u;k<3u;k++) { corrections[index*3u+k]=vec4f(total[k],1.0); }
}

`;
