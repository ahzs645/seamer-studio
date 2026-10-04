/** Finite segment/triangle contact; w<0 denotes no intersection. Used for both body and cloth. */
export const finiteContactsWGSL = /* wgsl */ `
fn segmentTriangleHit(start: vec3f, end: vec3f, a: vec3f, b: vec3f, c: vec3f) -> vec4f {
  let direction = end - start;
  let ab = b - a; let ac = c - a;
  let p = cross(direction, ac);
  let determinant = dot(ab, p);
  if (abs(determinant) < 1e-12) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let inverse = 1.0 / determinant;
  let origin = start - a;
  let u = dot(origin, p) * inverse;
  let q = cross(origin, ab);
  let v = dot(direction, q) * inverse;
  let time = dot(ac, q) * inverse;
  if (u < -1e-5 || v < -1e-5 || u + v > 1.00001 || time < -1e-5 || time > 1.00001) {
    return vec4f(0.0, 0.0, 0.0, -1.0);
  }
  return vec4f(start + direction * clamp(time, 0.0, 1.0), clamp(time, 0.0, 1.0));
}
fn pointSegmentDistance(point: vec3f, a: vec3f, b: vec3f) -> f32 {
  let edge = b - a;
  let time = clamp(dot(point - a, edge) / max(dot(edge, edge), 1e-12), 0.0, 1.0);
  return distance(point, a + time * edge);
}
fn finiteTrianglesCross(a: vec3f, b: vec3f, c: vec3f, p: vec3f, q: vec3f, r: vec3f) -> bool {
  return segmentTriangleHit(a,b,p,q,r).w >= 0.0 || segmentTriangleHit(b,c,p,q,r).w >= 0.0
    || segmentTriangleHit(c,a,p,q,r).w >= 0.0 || segmentTriangleHit(p,q,a,b,c).w >= 0.0
    || segmentTriangleHit(q,r,a,b,c).w >= 0.0 || segmentTriangleHit(r,p,a,b,c).w >= 0.0;
}`;
