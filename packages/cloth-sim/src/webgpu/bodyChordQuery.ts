/** Immutable, one-binding body BVH for an ALREADY PROVED interior chord.
 * Does not classify arbitrary points using a face plane, and does not alter source policy. */
export interface BodyChordSurfaceBVH {
  nodes: Float32Array;
  triangleIds: Uint32Array;
  nodeCount: number;
}

export const BODY_CHORD_HEADER_WORDS = 4;
export const BODY_CHORD_NODE_WORDS = 8;

/** Header [nodeCount,nodeOffsetWords,orderedOffsetWords,orderedCount], followed by exactly
 * the existing BVH's 32-byte node records and then its ordered finite triangle IDs. */
export function packBodyChordBVH(bvh: BodyChordSurfaceBVH, bodyTriangleCount: number): Uint32Array {
  if (!Number.isInteger(bodyTriangleCount) || bodyTriangleCount < 0
    || !Number.isInteger(bvh.nodeCount) || bvh.nodeCount < 0
    || bvh.nodes.length !== bvh.nodeCount * BODY_CHORD_NODE_WORDS
    || bvh.triangleIds.length !== bodyTriangleCount
    || (bvh.nodeCount === 0) !== (bodyTriangleCount === 0)) throw new Error('Invalid body chord BVH dimensions');
  const orderedOffset = BODY_CHORD_HEADER_WORDS + bvh.nodes.length;
  const total = orderedOffset + bvh.triangleIds.length;
  if (total > 0xffffffff) throw new Error('Body chord BVH exceeds addressable u32 layout');
  const nodeWords = new Uint32Array(bvh.nodes.buffer, bvh.nodes.byteOffset, bvh.nodes.length);
  const covered = new Uint8Array(bvh.triangleIds.length);
  for (let node = 0; node < bvh.nodeCount; node++) {
    const at = node * BODY_CHORD_NODE_WORDS;
    const escape = nodeWords[at + 3], leaf = nodeWords[at + 7];
    if (escape <= node || escape > bvh.nodeCount) throw new Error('Invalid body chord BVH escape');
    for (let axis = 0; axis < 3; axis++) {
      const low = bvh.nodes[at + axis], high = bvh.nodes[at + axis + 4];
      if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) throw new Error('Invalid body chord BVH bounds');
    }
    if (leaf !== 0xffffffff) {
      const first = leaf & 0x0fffffff, count = leaf >>> 28;
      if (count < 1 || count > 8 || first + count > bvh.triangleIds.length) throw new Error('Invalid body chord BVH leaf');
      for (let at = first; at < first + count; at++) {
        if (covered[at]) throw new Error('Overlapping body chord BVH leaves');
        covered[at] = 1;
      }
    }
  }
  if (covered.some(value => value !== 1) || bvh.triangleIds.some(id => id >= bodyTriangleCount)
    || new Set(bvh.triangleIds).size !== bodyTriangleCount) throw new Error('Invalid body chord ordered triangle IDs');
  const packed = new Uint32Array(total);
  packed.set([bvh.nodeCount, BODY_CHORD_HEADER_WORDS, orderedOffset, bvh.triangleIds.length]);
  packed.set(nodeWords, BODY_CHORD_HEADER_WORDS);
  packed.set(bvh.triangleIds, orderedOffset);
  return packed;
}

/** Add to the finite body-face shader, which already has seven storage bindings0..6.
 * Existing symbols: bodyTriangles, bodyPositions, getClosestPointOnTriangle, thickness.
 * The query's input MUST come from actual finite entering+exiting body intersections;
 * entry/exit seeds are re-evaluated finite triangles, never rounded prior closest points. */
export function bodyChordNearestWGSL(): string {
  return /* wgsl */ `
@group(0) @binding(7) var<storage, read> packedBodyChordBVH: array<u32>;
struct BodyChordNearest {
  point: vec3f,
  distance: f32,
  normal: vec3f,
  face: u32,
  previousGap: f32,
  valid: u32,
  previousOutside: u32,
  p0: u32,
};
fn bodyChordBoxDistance2(point: vec3f, low: vec3f, high: vec3f) -> f32 {
  let offset=max(max(low-point,point-high),vec3f(0.0));
  return dot(offset,offset);
}
fn nearestFiniteBodyForInteriorChord(insidePoint: vec3f, previousMaterialPoint: vec3f,
  entryFace: u32, exitFace: u32) -> BodyChordNearest {
  var result: BodyChordNearest;
  result.point=insidePoint;result.distance=0.0;result.normal=vec3f(0.0);
  result.face=0xffffffffu;result.previousGap=0.0;result.valid=0u;result.previousOutside=0u;result.p0=0u;
  if(arrayLength(&packedBodyChordBVH)<4u) { return result; }
  let nodeCount=packedBodyChordBVH[0u];let nodeStart=packedBodyChordBVH[1u];
  let orderedStart=packedBodyChordBVH[2u];let orderedCount=packedBodyChordBVH[3u];
  var best=3.40282e38f;var nearest=insidePoint;var face=0xffffffffu;
  let seeds=array<u32,2>(entryFace,exitFace);
  for(var seed=0u;seed<2u;seed++) {
    let id=seeds[seed];if(id>=arrayLength(&bodyTriangles)) { continue; }
    let tri=bodyTriangles[id];let a=bodyPositions[tri.x].xyz;
    let b=bodyPositions[tri.y].xyz;let c=bodyPositions[tri.z].xyz;
    if(length(cross(b-a,c-a))<=1e-12) { continue; }
    let q=getClosestPointOnTriangle(a,b,c,insidePoint);let delta=q-insidePoint;
    let dist2=dot(delta,delta);if(dist2<best) { best=dist2;nearest=q;face=id; }
  }
  var node=0u;
  loop {
    if(node>=nodeCount) { break; }
    let at=nodeStart+node*8u;
    let low=bitcast<vec3f>(vec3u(packedBodyChordBVH[at],packedBodyChordBVH[at+1u],packedBodyChordBVH[at+2u]));
    let high=bitcast<vec3f>(vec3u(packedBodyChordBVH[at+4u],packedBodyChordBVH[at+5u],packedBodyChordBVH[at+6u]));
    let escape=packedBodyChordBVH[at+3u];let leaf=packedBodyChordBVH[at+7u];
    // Same conservative arithmetic envelope as the existing complete finite point query.
    // The upper bound always comes from an actual current finite triangle projection.
    let padding=max(1e-12,2.0*sqrt(best)*0.000001);
    if(bodyChordBoxDistance2(insidePoint,low,high)>best+padding) { node=escape;continue; }
    if(leaf==0xffffffffu) { node++;continue; }
    let first=leaf&0x0fffffffu;let count=leaf>>28u;
    for(var local=0u;local<count;local++) {
      if(first+local>=orderedCount) { return result; }
      let id=packedBodyChordBVH[orderedStart+first+local];
      if(id>=arrayLength(&bodyTriangles)) { return result; }
      let tri=bodyTriangles[id];let a=bodyPositions[tri.x].xyz;
      let b=bodyPositions[tri.y].xyz;let c=bodyPositions[tri.z].xyz;
      if(length(cross(b-a,c-a))<=1e-12) { continue; }
      let q=getClosestPointOnTriangle(a,b,c,insidePoint);let delta=q-insidePoint;
      let dist2=dot(delta,delta);if(dist2<best) { best=dist2;nearest=q;face=id; }
    }
    node=escape;
  }
  if(face==0xffffffffu || best<=1e-16 || best>=3.40282e38f) { return result; }
  let distance=sqrt(best);let normal=(nearest-insidePoint)/distance;
  result.point=nearest;result.distance=distance;result.normal=normal;result.face=face;
  result.previousGap=dot(previousMaterialPoint-nearest,normal);result.valid=1u;
  // A negative escape direction is not an outside material-side proof, even when its
  // nearest skin feature is physically valid. Source contacts withhold that direction;
  // other finite witnesses or a later requery may establish a supported direction.
  result.previousOutside=select(0u,1u,result.previousGap>=0.0);
  return result;
}
`;
}
