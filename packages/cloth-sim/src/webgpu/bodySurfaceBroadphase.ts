import type { SimConfig } from '../config';
import { WORKGROUP_SIZE, closestPointOnTriangleWGSL } from './shaders';
import { finiteContactsWGSL } from './finiteContacts';

export interface SurfaceMesh {
  positions: Float32Array;
  triangles: Uint32Array;
  numTriangles: number;
}

export interface SurfaceBVH {
  /** 32-byte nodes: low.xyz, escape:u32, high.xyz, leaf:u32. Integer slots use a Uint32 overlay. */
  nodes: Float32Array;
  triangleIds: Uint32Array;
  /** Per-node vec4u [first ordered triangle, subtree triangle count, 0, 0], for dynamic refitting. */
  ranges: Uint32Array;
  nodeCount: number;
  maxDepth: number;
}

const INTERNAL = 0xffffffff;
const START_MASK = 0x0fffffff;
type Bounds = [number, number, number, number, number, number];
interface Face { id: number; bounds: Bounds; center: [number, number, number] }

/** Balanced static topology with preorder escape links. Querying it needs no GPU stack and never
 * truncates traversal. Bounds enclose the actual finite triangles, including coarse interiors. */
export function buildBodySurfaceBVH(mesh: SurfaceMesh, leafSize = 8): SurfaceBVH {
  if (!Number.isInteger(leafSize) || leafSize < 1 || leafSize > 8) throw new Error('Surface BVH leaf size must be between 1 and 8.');
  if (!Number.isInteger(mesh.numTriangles) || mesh.numTriangles < 0 || mesh.numTriangles > START_MASK
    || mesh.triangles.length !== mesh.numTriangles * 4 || mesh.positions.length % 4
    || !Array.from(mesh.positions).every(Number.isFinite)) throw new Error('Invalid surface BVH mesh.');
  const faces: Face[] = [];
  for (let t = 0; t < mesh.numTriangles; t++) {
    const points: number[][] = [];
    for (let corner = 0; corner < 3; corner++) {
      const index = mesh.triangles[t * 4 + corner];
      if (index >= mesh.positions.length / 4) throw new Error('Surface BVH triangle references an invalid vertex.');
      points.push(Array.from(mesh.positions.subarray(index * 4, index * 4 + 3)));
    }
    const low = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis])));
    const high = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])));
    faces.push({ id: t, bounds: [...low, ...high] as Bounds,
      center: [0, 1, 2].map(axis => (low[axis] + high[axis]) / 2) as [number, number, number] });
  }
  const bounds: Bounds[] = [], metadata: { escape: number; leaf: number }[] = [];
  const ordered: number[] = [], ranges: number[] = [];
  let maxDepth = 0;
  const visit = (items: Face[], depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    const index = bounds.length;
    const box: Bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const face of items) for (let axis = 0; axis < 3; axis++) {
      box[axis] = Math.min(box[axis], face.bounds[axis]);
      box[axis + 3] = Math.max(box[axis + 3], face.bounds[axis + 3]);
    }
    bounds.push(box); metadata.push({ escape: 0, leaf: INTERNAL });
    ranges.push(ordered.length, items.length, 0, 0);
    if (items.length <= leafSize) {
      metadata[index].leaf = ((items.length << 28) | ordered.length) >>> 0;
      for (const face of items) ordered.push(face.id);
    } else {
      let axis = 0;
      for (let k = 1; k < 3; k++) if (box[k + 3] - box[k] > box[axis + 3] - box[axis]) axis = k;
      items.sort((a, b) => a.center[axis] - b.center[axis] || a.id - b.id);
      const middle = Math.floor(items.length / 2);
      visit(items.slice(0, middle), depth + 1); visit(items.slice(middle), depth + 1);
    }
    metadata[index].escape = bounds.length;
  };
  if (faces.length) visit(faces, 1);
  const nodes = new Float32Array(bounds.length * 8);
  const integers = new Uint32Array(nodes.buffer);
  for (let i = 0; i < bounds.length; i++) {
    nodes.set(bounds[i].slice(0, 3), i * 8);
    nodes.set(bounds[i].slice(3), i * 8 + 4);
    integers[i * 8 + 3] = metadata[i].escape;
    integers[i * 8 + 7] = metadata[i].leaf;
  }
  return { nodes, triangleIds: new Uint32Array(ordered), ranges: new Uint32Array(ranges), nodeCount: bounds.length, maxDepth };
}

/** CPU reference for conservative node traversal. Leaves may return extra triangles, never fewer
 * than the finite triangle AABBs overlapping the query. Useful for validating the GPU topology. */
export function queryBodySurfaceBVH(bvh: SurfaceBVH, low: readonly number[], high: readonly number[]): number[] {
  const integers = new Uint32Array(bvh.nodes.buffer, bvh.nodes.byteOffset, bvh.nodes.length);
  const result: number[] = [];
  let index = 0;
  while (index < bvh.nodeCount) {
    const offset = index * 8, escape = integers[offset + 3];
    const overlap = [0, 1, 2].every(axis => bvh.nodes[offset + axis] <= high[axis] && bvh.nodes[offset + axis + 4] >= low[axis]);
    if (!overlap) { index = escape; continue; }
    const leaf = integers[offset + 7];
    if (leaf === INTERNAL) { index++; continue; }
    const first = leaf & START_MASK, count = leaf >>> 28;
    for (let i = 0; i < count; i++) result.push(bvh.triangleIds[first + i]);
    index = escape;
  }
  return result;
}

/** Eight storage buffers, preserving the existing finite contact budget/priority. The conservative
 * BVH query replaces thousands of empty centroid-hash cells per cloth face. */
export function initBodySurfaceBVHCollisionWGSL(cfg: SimConfig, gatherInterval = cfg.externalCollisionGatherInterval, lazyRanking = true): string {
  const budget = cfg.numExternalSurfaceCollisionConstraints ?? cfg.numExternalCollisionConstraintsPerParticle;
  const motion = cfg.maxVelocity * cfg.deltaT * Math.max(0, gatherInterval);
  const padding = cfg.simulationThickness + motion;
  return /* wgsl */ `
struct BodyBVHNode { low:vec3f, escape:u32, high:vec3f, leaf:u32 };
@group(0) @binding(0) var<storage, read> positions:array<vec4f>;
@group(0) @binding(1) var<storage, read> clothTriangles:array<vec4u>;
@group(0) @binding(2) var<storage, read_write> candidates:array<i32>;
@group(0) @binding(3) var<storage, read> nodes:array<BodyBVHNode>;
@group(0) @binding(4) var<storage, read> orderedTriangles:array<u32>;
@group(0) @binding(5) var<storage, read> previous:array<vec4f>;
@group(0) @binding(6) var<storage, read> bodyTriangles:array<vec4u>;
@group(0) @binding(7) var<storage, read> bodyPositions:array<vec4f>;
${closestPointOnTriangleWGSL}
${finiteContactsWGSL}
${lazyRanking ? `// Retained candidates need priority only if another eligible face overflows the budget.
fn bodyCandidateCrosses(bodyIndex:u32, cloth:vec4u)->bool {
  let a=positions[cloth.x].xyz;let b=positions[cloth.y].xyz;let c=positions[cloth.z].xyz;
  let oldA=previous[cloth.x].xyz;let oldB=previous[cloth.y].xyz;let oldC=previous[cloth.z].xyz;
  let body=bodyTriangles[bodyIndex];
  let p=bodyPositions[body.x].xyz;let q=bodyPositions[body.y].xyz;let r=bodyPositions[body.z].xyz;
  return finiteTrianglesCross(a,b,c,p,q,r) || segmentTriangleHit(oldA,a,p,q,r).w>=0.0
    || segmentTriangleHit(oldB,b,p,q,r).w>=0.0 || segmentTriangleHit(oldC,c,p,q,r).w>=0.0;
}
` : ''}
const padding=${padding}f;
const budget=${budget}u;
@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid:vec3u) {
  let index=gid.x;
  if(index>=arrayLength(&clothTriangles)) { return; }
  for(var at=0u;at<budget;at++) { candidates[index*budget+at]=0; }
  let tri=clothTriangles[index];
  let a=positions[tri.x].xyz;let b=positions[tri.y].xyz;let c=positions[tri.z].xyz;
  let oldA=previous[tri.x].xyz;let oldB=previous[tri.y].xyz;let oldC=previous[tri.z].xyz;
  let low=min(min(a,min(b,c)),min(oldA,min(oldB,oldC)))-vec3f(padding);
  let high=max(max(a,max(b,c)),max(oldA,max(oldB,oldC)))+vec3f(padding);
  let actualMovement=max(distance(a,oldA),max(distance(b,oldB),distance(c,oldC)));
  var count=0u;var scores:array<f32,${budget}>;${lazyRanking ? 'var ranked=false;' : ''}
  var nodeIndex=0u;
  while(nodeIndex<arrayLength(&nodes)) {
    let node=nodes[nodeIndex];
    if(any(node.low>high) || any(node.high<low)) { nodeIndex=node.escape;continue; }
    if(node.leaf==0xffffffffu) { nodeIndex++;continue; }
    let first=node.leaf&0x0fffffffu;let size=node.leaf>>28u;
    for(var offset=0u;offset<size;offset++) {
      let bodyIndex=orderedTriangles[first+offset];
      let body=bodyTriangles[bodyIndex];
      let p=bodyPositions[body.x].xyz;let q=bodyPositions[body.y].xyz;let r=bodyPositions[body.z].xyz;
      if(any(min(p,min(q,r))>high) || any(max(p,max(q,r))<low)) { continue; }
      let center=(p+q+r)/3.0;
      let bodyRadius=max(distance(p,center),max(distance(q,center),distance(r,center)));
      let nearest=getClosestPointOnTriangle(a,b,c,center);
      let delta=center-nearest;var score=dot(delta,delta);
      // Any point on a linearly moving face is at most actualMovement from its current face.
      // This bound retains swept contacts without the old global-radius empty-cell search.
      let radius=bodyRadius+padding+actualMovement;
      if(score>radius*radius) { continue; }
      ${lazyRanking ? '' : `if(finiteTrianglesCross(a,b,c,p,q,r) || segmentTriangleHit(oldA,a,p,q,r).w>=0.0
        || segmentTriangleHit(oldB,b,p,q,r).w>=0.0 || segmentTriangleHit(oldC,c,p,q,r).w>=0.0) { score=-1.0; }
      `}
      if(count<budget) { candidates[index*budget+count]=i32(bodyIndex)+2;scores[count]=score;count++; }
      else {
        ${lazyRanking ? `if(!ranked) {
          // Keep the distance scores already computed by the unchanged radius filter.
          // Rank in original insertion order so first-farthest and equal-score ties stay exact.
          for(var at=0u;at<budget;at++) {
            if(bodyCandidateCrosses(u32(candidates[index*budget+at]-2),tri)) { scores[at]=-1.0; }
          }
          ranked=true;
        }
        if(finiteTrianglesCross(a,b,c,p,q,r) || segmentTriangleHit(oldA,a,p,q,r).w>=0.0
          || segmentTriangleHit(oldB,b,p,q,r).w>=0.0 || segmentTriangleHit(oldC,c,p,q,r).w>=0.0) { score=-1.0; }
        ` : ''}
        var farthest=0u;
        for(var at=1u;at<budget;at++) { if(scores[at]>scores[farthest]) { farthest=at; } }
        if(score<scores[farthest]) { candidates[index*budget+farthest]=i32(bodyIndex)+2;scores[farthest]=score; }
      }
    }
    nodeIndex=node.escape;
  }
}`;
}
