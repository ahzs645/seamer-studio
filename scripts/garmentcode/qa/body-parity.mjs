import { Vector3 } from 'three';

const BARYCENTRIC_ROUNDOFF = 1e-10;
const DISTANCE_ROUNDOFF_M = 1e-10;
/** Geometric identity is exact frozen-coordinate identity, including duplicate UV vertex indices. */
function coordinateKey(p) { return [p.x,p.y,p.z].join(','); }
export function finiteRayHit(triangle, ray, hit) {
  const bary = triangle.getBarycoord(hit,new Vector3()).toArray();
  const corners = [triangle.a,triangle.b,triangle.c];
  const zero = bary.map((v,i)=>Math.abs(v)<=BARYCENTRIC_ROUNDOFF ? i : -1).filter(i=>i>=0);
  let feature = null;
  if(zero.length===1) feature='edge:'+corners.filter((_,i)=>i!==zero[0]).map(coordinateKey).sort().join('/');
  else if(zero.length>=2) feature='vertex:'+coordinateKey(corners[bary.indexOf(Math.max(...bary))]);
  const normal = triangle.getNormal(new Vector3());
  return { distance:hit.distanceTo(ray.origin),roundoffScale:Math.max(1,Math.abs(ray.origin.x),Math.abs(ray.origin.y),Math.abs(ray.origin.z)),feature,orientation:Math.sign(normal.dot(ray.direction)),barycentric:bary,position:hit.toArray() };
}
/** A real entry and exit remain two crossings even when separated by less than a micrometre.
 * Only the same actual boundary feature, same oriented crossing, and machine-scale same hit merge. */
export function countFiniteRayHits(hits) {
  const boundaries = new Map();let count=0;
  for(const hit of hits) {
    if(!hit.feature) {count++;continue;}
    const key=hit.feature+'|'+hit.orientation;
    const prior=boundaries.get(key)??[];
    if(prior.some(distance=>Math.abs(distance-hit.distance)<=DISTANCE_ROUNDOFF_M*Math.max(hit.roundoffScale??1,Math.abs(distance),Math.abs(hit.distance)))) continue;
    prior.push(hit.distance);boundaries.set(key,prior);count++;
  }
  return count;
}
