import { Ray, Triangle, Vector3 } from 'three';
import { isLocallyClosedPairedSeamContact, type CollisionGuardInput } from './collisionGuard';

type Vec = [number, number, number];
type Polynomial = [number, number, number, number];
type Bounds = [number, number, number, number, number, number];
interface MovingPoint { start: Vec; end: Vec }
interface MovingFace { id: number; vertices: [number, number, number]; points: [MovingPoint, MovingPoint, MovingPoint]; bounds: Bounds }
interface Node { bounds: Bounds; faces?: MovingFace[]; left?: Node; right?: Node }
export type ContinuousCollisionFeature = 'vertex-face' | 'edge-edge' | 'coplanar-interval' | 'indeterminate' | 'initial-penetration';
export interface ContinuousCollisionEvent {
  kind: 'body' | 'self';
  clothTriangle: number;
  otherTriangle: number;
  feature: ContinuousCollisionFeature;
  /** Normalized lower bound in the supplied linear-motion interval. */
  timeOfImpact: number;
  /** Present when contact persists throughout an analytically partitioned interval. */
  intervalEnd?: number;
  point: Vec;
  segment?: number;
}
export interface ContinuousCollisionReport {
  safe: boolean;
  finite: boolean;
  bodyContactCount: number;
  selfContactCount: number;
  indeterminateContactCount: number;
  earliestTimeOfImpact: number | null;
  events: ContinuousCollisionEvent[];
  segmentCount: number;
  interpolation: 'piecewise-linear';
  limitations: readonly string[];
}
export interface ContinuousCollisionOptions {
  checkSelfIntersections?: boolean;
  epsilon?: number;
  maxRecordedEvents?: number;
  /** Initial contacts are normally handled by the discrete acceptance guard. */
  includeInitialContacts?: boolean;
}
interface FeatureEvent { feature: ContinuousCollisionFeature; time: number; intervalEnd?: number; point: Vec; boundFeatures?: MovingPoint[][] }
const LIMITATIONS = [
  'Every supplied interval is interpolated linearly. Frame endpoint chords cannot certify an unknown curved substep trajectory; supply actual substep boundaries.',
  'This checks zero-thickness finite vertex/face and edge/edge contacts; it does not certify a positive collision clearance.',
  'Coplanar contacts use polynomial event partitions. Degenerate unresolved cases are conservatively reported rather than accepted.',
  'Moving coplanar sewing contacts are exempt only when their whole-contact-feature seam-neighborhood bound is proved; unresolved contacts may conservatively reject a valid assembly.',
  'Only features sharing actual mesh particle indices are excluded; a shared triangle corner does not exempt its other features.',
  'Geometry safety alone does not certify source-body agreement, closed seams, anatomical coverage or settling.'
] as const;
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (p: MovingPoint, time: number): Vec => add(p.start, scale(sub(p.end, p.start), time));
const distance = (a: Vec, b: Vec) => Math.hypot(...sub(a, b));
const read = (positions: ArrayLike<number>, index: number, stride: number): Vec => [positions[index * stride], positions[index * stride + 1], positions[index * stride + 2]];
const evaluate = (p: Polynomial, t: number) => ((p[3] * t + p[2]) * t + p[1]) * t + p[0];
const uniqueTimes = (times: number[]) => times.sort((a, b) => a - b).filter((t, k, all) => k === 0 || t - all[k - 1] > 1e-10);

/** Isolate all real roots on [0,1], including repeated/tangent roots via derivative extrema. */
function roots(polynomial: Polynomial): { roots: number[]; coplanar: boolean } {
  const magnitude = Math.max(...polynomial.map(Math.abs));
  if (magnitude <= 1e-24) return { roots: [], coplanar: true };
  const p = polynomial.map(c => c / magnitude) as Polynomial;
  let degree = 3;
  while (degree > 0 && Math.abs(p[degree]) < 1e-14) degree--;
  if (degree === 0) return { roots: [], coplanar: false };
  let critical: number[] = [];
  if (degree === 3) {
    const a = 3 * p[3], b = 2 * p[2], c = p[1], discriminant = b * b - 4 * a * c;
    if (discriminant >= -1e-14) {
      const d = Math.sqrt(Math.max(0, discriminant));
      const q = -.5 * (b + (b >= 0 ? d : -d));
      critical = Math.abs(q) > 1e-15 ? [q / a, c / q] : [-b / (2 * a)];
    }
  } else if (degree === 2) critical = [-p[1] / (2 * p[2])];
  const times = uniqueTimes([0, ...critical.filter(t => t > 0 && t < 1), 1]);
  const found = times.filter(t => Math.abs(evaluate(p, t)) <= 1e-11);
  for (let k = 1; k < times.length; k++) {
    let left = times[k - 1], right = times[k], fLeft = evaluate(p, left), fRight = evaluate(p, right);
    if (fLeft * fRight >= 0) continue;
    for (let iteration = 0; iteration < 64 && right - left > 1e-12; iteration++) {
      const middle = (left + right) / 2, value = evaluate(p, middle);
      if (value * fLeft <= 0) { right = middle; fRight = value; }
      else { left = middle; fLeft = value; }
    }
    found.push((left + right) / 2);
  }
  return { roots: uniqueTimes(found), coplanar: false };
}
function coplanarity(a: MovingPoint, b: MovingPoint, c: MovingPoint, d: MovingPoint): Polynomial {
  const r0 = sub(b.start, a.start), s0 = sub(c.start, a.start), t0 = sub(d.start, a.start);
  const r1 = sub(sub(b.end, a.end), r0), s1 = sub(sub(c.end, a.end), s0), t1 = sub(sub(d.end, a.end), t0);
  return [dot(r0, cross(s0, t0)), dot(r1, cross(s0, t0)) + dot(r0, cross(s1, t0)) + dot(r0, cross(s0, t1)),
    dot(r1, cross(s1, t0)) + dot(r1, cross(s0, t1)) + dot(r0, cross(s1, t1)), dot(r1, cross(s1, t1))];
}
function normalPolynomial(a: MovingPoint, b: MovingPoint, c: MovingPoint): [Vec, Vec, Vec] {
  const u0 = sub(b.start, a.start), v0 = sub(c.start, a.start), u1 = sub(sub(b.end, a.end), u0), v1 = sub(sub(c.end, a.end), v0);
  return [cross(u0, v0), add(cross(u1, v0), cross(u0, v1)), cross(u1, v1)];
}
function chooseAxis(polynomials: [Vec, Vec, Vec][]): number | undefined {
  const scores = [0, 0, 0];
  for (const polynomial of polynomials) for (let axis = 0; axis < 3; axis++) scores[axis] += polynomial.reduce((sum, coefficient) => sum + Math.abs(coefficient[axis]), 0);
  const best = scores.indexOf(Math.max(...scores));
  return scores[best] > 1e-24 ? best : undefined;
}
function orientation(a: MovingPoint, b: MovingPoint, c: MovingPoint, axis: number): Polynomial {
  const p = normalPolynomial(a, b, c);
  return [p[0][axis], p[1][axis], p[2][axis], 0];
}
function pointOnFace(point: Vec, face: [Vec, Vec, Vec], epsilon: number): { hit: boolean; degenerate: boolean } {
  const area = cross(sub(face[1], face[0]), sub(face[2], face[0]));
  if (dot(area, area) <= epsilon ** 4) return { hit: false, degenerate: true };
  const triangle = new Triangle(...face.map(p => new Vector3(...p)) as [Vector3, Vector3, Vector3]);
  const closest = triangle.closestPointToPoint(new Vector3(...point), new Vector3());
  return { hit: distance(point, [closest.x, closest.y, closest.z]) <= epsilon, degenerate: false };
}
function edgeContact(a: Vec, b: Vec, c: Vec, d: Vec, epsilon: number): { hit: boolean; point: Vec } {
  const u = sub(b, a), v = sub(d, c), w = sub(a, c), aa = dot(u, u), bb = dot(u, v), cc = dot(v, v), dd = dot(u, w), ee = dot(v, w);
  let s = 0, t = 0;
  if (aa <= epsilon * epsilon && cc <= epsilon * epsilon) return { hit: distance(a, c) <= epsilon, point: scale(add(a, c), .5) };
  if (aa <= epsilon * epsilon) t = Math.max(0, Math.min(1, ee / cc));
  else if (cc <= epsilon * epsilon) s = Math.max(0, Math.min(1, -dd / aa));
  else {
    const normal = cross(u, v), denominator = dot(normal, normal);
    // Cross products avoid cancellation in aa*cc-bb*bb for almost parallel edges.
    s = denominator > 0 ? Math.max(0, Math.min(1, dot(cross(sub(c, a), v), normal) / denominator)) : 0;
    t = (bb * s + ee) / cc;
    if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -dd / aa)); }
    else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (bb - dd) / aa)); }
  }
  const first = add(a, scale(u, s)), second = add(c, scale(v, t));
  return { hit: distance(first, second) <= epsilon, point: scale(add(first, second), .5) };
}

/** Partition a coplanar interval at every analytical orientation-change event. */
function partitionEvents(polynomials: Polynomial[], test: (time: number) => Vec | undefined, includeInitial: boolean): FeatureEvent[] {
  const times = uniqueTimes([0, 1, ...polynomials.flatMap(p => roots(p).roots)]), events: FeatureEvent[] = [];
  for (const time of times) {
    if (!includeInitial && time <= 1e-10) continue;
    const point = test(time);
    if (point) events.push({ feature: 'edge-edge', time, point });
  }
  for (let k = 1; k < times.length; k++) {
    const left = times[k - 1], right = times[k], point = test((left + right) / 2);
    if (point) events.push({ feature: 'coplanar-interval', time: left, intervalEnd: right, point });
  }
  return events;
}
function vertexFace(vertex: MovingPoint, face: [MovingPoint, MovingPoint, MovingPoint], epsilon: number, includeInitial: boolean): FeatureEvent[] {
  if (!overlap(bounds([vertex]), bounds(face), epsilon)) return [];
  const result = roots(coplanarity(face[0], face[1], face[2], vertex));
  const test = (time: number) => {
    const p = lerp(vertex, time), triangle = face.map(v => lerp(v, time)) as [Vec, Vec, Vec];
    return pointOnFace(p, triangle, epsilon).hit ? p : undefined;
  };
  if (!result.coplanar) return result.roots.filter(t => includeInitial || t > 1e-10).flatMap(time => {
    const p = lerp(vertex, time), check = pointOnFace(p, face.map(v => lerp(v, time)) as [Vec, Vec, Vec], epsilon);
    return check.hit || check.degenerate ? [{ feature: check.degenerate ? 'indeterminate' : 'vertex-face', time, point: p } as FeatureEvent] : [];
  });
  const axis = chooseAxis([normalPolynomial(...face)]);
  if (axis === undefined) return [{ feature: 'indeterminate', time: 0, intervalEnd: 1, point: vertex.start }];
  return partitionEvents([orientation(face[0], face[1], face[2], axis), orientation(face[0], face[1], vertex, axis), orientation(face[1], face[2], vertex, axis), orientation(face[2], face[0], vertex, axis)], test, includeInitial)
    .map(event => ({ ...event, feature: event.feature === 'coplanar-interval' ? event.feature : 'vertex-face', boundFeatures: [[vertex]] }));
}
function edgeBounds(event: FeatureEvent, a: MovingPoint, b: MovingPoint, c: MovingPoint, d: MovingPoint, epsilon: number): FeatureEvent {
  const boundFeatures: MovingPoint[][] = [[a, b], [c, d]];
  if (event.intervalEnd !== undefined) {
    for (const [first, otherFirst] of [[a, b], [b, a]]) for (const [second, otherSecond] of [[c, d], [d, c]]) {
      if (distance(first.start, second.start) > 1e-12 || distance(first.end, second.end) > 1e-12) continue;
      const middle = (event.time + event.intervalEnd) / 2;
      if (distance(lerp(first, middle), event.point) > epsilon) continue;
      const r0 = sub(otherFirst.start, first.start), s0 = sub(otherSecond.start, second.start);
      const r1 = sub(sub(otherFirst.end, first.end), r0), s1 = sub(sub(otherSecond.end, second.end), s0);
      const normal = [cross(r0, s0), add(cross(r1, s0), cross(r0, s1)), cross(r1, s1)];
      const nonparallel = [0, 1, 2].some(axis => {
        const polynomial: Polynomial = [normal[0][axis], normal[1][axis], normal[2][axis], 0], zero = roots(polynomial);
        return !zero.coplanar && Math.abs(evaluate(polynomial, event.time)) > 1e-20 && Math.abs(evaluate(polynomial, event.intervalEnd!)) > 1e-20 && !zero.roots.some(t => t >= event.time && t <= event.intervalEnd!);
      });
      const directionDot: Polynomial = [dot(r0, s0), dot(r1, s0) + dot(r0, s1), dot(r1, s1), 0];
      const extrema = [event.time, event.intervalEnd];
      if (directionDot[2] !== 0) {
        const critical = -directionDot[1] / (2 * directionDot[2]);
        if (critical > event.time && critical < event.intervalEnd) extrema.push(critical);
      }
      const opposite = extrema.every(time => evaluate(directionDot, time) <= 0);
      // Analytically unique shared-endpoint contact throughout this interval.
      if (nonparallel || opposite) boundFeatures.push([first]);
    }
  }
  return { ...event, boundFeatures };
}
function edgeEdge(a: MovingPoint, b: MovingPoint, c: MovingPoint, d: MovingPoint, epsilon: number, includeInitial: boolean): FeatureEvent[] {
  if (!overlap(bounds([a, b]), bounds([c, d]), epsilon)) return [];
  const result = roots(coplanarity(a, b, c, d));
  const test = (time: number) => {
    const contact = edgeContact(lerp(a, time), lerp(b, time), lerp(c, time), lerp(d, time), epsilon);
    return contact.hit ? contact.point : undefined;
  };
  if (!result.coplanar) return result.roots.filter(t => includeInitial || t > 1e-10).flatMap(time => {
    const point = test(time);
    return point ? [{ feature: 'edge-edge', time, point } as FeatureEvent] : [];
  });
  const axis = chooseAxis([normalPolynomial(a, b, c), normalPolynomial(a, b, d), normalPolynomial(c, d, a), normalPolynomial(c, d, b)]);
  if (axis !== undefined) return partitionEvents([orientation(a, b, c, axis), orientation(a, b, d, axis), orientation(c, d, a, axis), orientation(c, d, b, axis)], test, includeInitial).map(event => edgeBounds(event, a, b, c, d, epsilon));
  // Entirely collinear trajectories: endpoint order changes are linear events.
  const points = [a, b, c, d], polynomials: Polynomial[] = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) for (let component = 0; component < 3; component++) {
    const start = points[i].start[component] - points[j].start[component], end = points[i].end[component] - points[j].end[component];
    polynomials.push([start, end - start, 0, 0]);
  }
  return partitionEvents(polynomials, test, includeInitial).map(event => edgeBounds(event, a, b, c, d, epsilon));
}
function bounds(points: MovingPoint[]): Bounds {
  const b: Bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const point of points) for (const p of [point.start, point.end]) for (let axis = 0; axis < 3; axis++) { b[axis] = Math.min(b[axis], p[axis]); b[axis + 3] = Math.max(b[axis + 3], p[axis]); }
  return b;
}
function overlap(a: Bounds, b: Bounds, eps: number): boolean {
  for (let axis = 0; axis < 3; axis++) if (a[axis] > b[axis + 3] + eps || b[axis] > a[axis + 3] + eps) return false;
  return true;
}
function buildTree(faces: MovingFace[]): Node | undefined {
  if (!faces.length) return undefined;
  const b: Bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const f of faces) for (let axis = 0; axis < 3; axis++) { b[axis] = Math.min(b[axis], f.bounds[axis]); b[axis + 3] = Math.max(b[axis + 3], f.bounds[axis + 3]); }
  if (faces.length <= 8) return { bounds: b, faces };
  let axis = 0;
  for (let k = 1; k < 3; k++) if (b[k + 3] - b[k] > b[axis + 3] - b[axis]) axis = k;
  faces.sort((a, c) => a.bounds[axis] + a.bounds[axis + 3] - c.bounds[axis] - c.bounds[axis + 3]);
  const mid = faces.length >> 1;
  return { bounds: b, left: buildTree(faces.slice(0, mid)), right: buildTree(faces.slice(mid)) };
}
function query(node: Node | undefined, b: Bounds, epsilon: number, visit: (face: MovingFace) => void): void {
  if (!node || !overlap(node.bounds, b, epsilon)) return;
  if (node.faces) { for (const face of node.faces) if (overlap(face.bounds, b, epsilon)) visit(face); }
  else { query(node.left, b, epsilon, visit); query(node.right, b, epsilon, visit); }
}
function makeFaces(first: ArrayLike<number>, last: ArrayLike<number>, indices: ArrayLike<number>, ps: number, ts: number): MovingFace[] {
  const faces: MovingFace[] = [];
  for (let k = 0; k < indices.length; k += ts) {
    const vertices: [number, number, number] = [indices[k], indices[k + 1], indices[k + 2]];
    const points = vertices.map(index => ({ start: read(first, index, ps), end: read(last, index, ps) })) as [MovingPoint, MovingPoint, MovingPoint];
    faces.push({ id: k / ts, vertices, points, bounds: bounds(points) });
  }
  return faces;
}

/** Optional continuous contact screen. It never changes solver positions or enables itself. */
export class ContinuousClothCollisionGuard {
  readonly #input: CollisionGuardInput;
  readonly #bodyTree?: Node;
  readonly #epsilon: number;
  readonly #limit: number;
  readonly #self: boolean;
  readonly #initial: boolean;
  readonly #seamCandidates = new Map<number, Map<number, Map<number, Set<number>>>>();

  constructor(input: CollisionGuardInput, options: ContinuousCollisionOptions = {}) {
    this.#epsilon = options.epsilon ?? 1e-7; this.#limit = options.maxRecordedEvents ?? 64;
    this.#self = options.checkSelfIntersections ?? true; this.#initial = options.includeInitialContacts ?? false;
    if (!Number.isFinite(this.#epsilon) || this.#epsilon <= 0 || !Number.isInteger(this.#limit) || this.#limit < 0 || !Number.isInteger(input.particleCount) || input.particleCount < 0) throw new Error('Invalid continuous collision guard options');
    const ps = input.bodyPositionStride ?? 3, bs = input.bodyTriangleStride ?? 3, cs = input.clothTriangleStride ?? 4;
    if (!Number.isInteger(ps) || ps < 3 || input.bodyPositions.length % ps || !Array.from(input.bodyPositions).every(Number.isFinite)) throw new Error('Invalid continuous collision guard body positions');
    const validIndices = (indices: ArrayLike<number>, stride: number, count: number) => Number.isInteger(stride) && stride >= 3 && indices.length % stride === 0 && Array.from(indices).every((v, i) => i % stride >= 3 || (Number.isInteger(v) && v >= 0 && v < count));
    if (!validIndices(input.bodyIndices, bs, input.bodyPositions.length / ps) || !validIndices(input.clothTriangles, cs, input.particleCount)) throw new Error('Invalid continuous collision guard triangle topology');
    for (const group of input.seamPairsBySeam ?? []) if (group.pairs.length % 2 || !Array.from(group.pairs).every(v => Number.isInteger(v) && v >= 0 && v < input.particleCount)) throw new Error('Invalid continuous collision guard seam pairs');
    this.#input = { ...input, clothTriangles: Array.from(input.clothTriangles), seamPairsBySeam: input.seamPairsBySeam?.map(s => ({ pairs: Array.from(s.pairs) })) };
    this.#bodyTree = buildTree(makeFaces(input.bodyPositions, input.bodyPositions, input.bodyIndices, ps, bs));
    if (this.#self) this.#prepareTopology(cs);
  }

  #prepareTopology(stride: number): void {
    const incident = Array.from({ length: this.#input.particleCount }, () => new Set<number>());
    const neighbors = Array.from({ length: this.#input.particleCount }, (_, i) => new Set([i]));
    const indices = this.#input.clothTriangles;
    for (let k = 0; k < indices.length; k += stride) for (let j = 0; j < 3; j++) {
      const a = indices[k + j]; incident[a].add(k / stride);
      for (let l = 0; l < 3; l++) neighbors[a].add(indices[k + l]);
    }
    const groups = this.#input.seamPairsBySeam ?? [];
    const candidate = (l: number, r: number, group: number, pairIndex: number) => {
      if (!this.#seamCandidates.has(l)) this.#seamCandidates.set(l, new Map());
      const rows = this.#seamCandidates.get(l)!;
      if (!rows.has(r)) rows.set(r, new Map());
      const groupsForPair = rows.get(r)!;
      if (!groupsForPair.has(group)) groupsForPair.set(group, new Set());
      for (const segment of [pairIndex - 1, pairIndex]) if (segment >= 0 && segment < groups[group].pairs.length / 2 - 1) groupsForPair.get(group)!.add(segment);
    };
    for (const [group, seam] of (this.#input.seamPairsBySeam ?? []).entries()) for (let k = 0; k < seam.pairs.length; k += 2) {
      const left = new Set<number>(), right = new Set<number>();
      for (const v of neighbors[seam.pairs[k]]) for (const face of incident[v]) left.add(face);
      for (const v of neighbors[seam.pairs[k + 1]]) for (const face of incident[v]) right.add(face);
      for (const l of left) for (const r of right) { candidate(l, r, group, k / 2); candidate(r, l, group, k / 2); }
    }
  }

  #pairEvents(a: MovingFace, b: MovingFace, sharedMeshTopology = false): FeatureEvent[] {
    const events: FeatureEvent[] = [];
    // Proper initial crossings are invalid even when initial touching contacts are
    // excluded. Check other features of triangles that share only a mesh corner.
    const ray = new Ray(), hit = new Vector3();
    for (const [first, second] of [[a, b], [b, a]]) {
      const target = new Triangle(...second.points.map(p => new Vector3(...p.start)) as [Vector3, Vector3, Vector3]);
      for (let i = 0; i < 3; i++) {
        const start = new Vector3(...first.points[i].start), end = new Vector3(...first.points[(i + 1) % 3].start), direction = end.clone().sub(start), length = direction.length();
        if (length <= 2 * this.#epsilon) continue;
        ray.set(start, direction.multiplyScalar(1 / length));
        if (ray.intersectTriangle(target.a, target.b, target.c, false, hit) && hit.distanceTo(start) > this.#epsilon && hit.distanceTo(start) < length - this.#epsilon) events.push({ feature: 'initial-penetration', time: 0, point: [hit.x, hit.y, hit.z] });
      }
    }
    for (let i = 0; i < 3; i++) if (!sharedMeshTopology || !b.vertices.includes(a.vertices[i])) events.push(...vertexFace(a.points[i], b.points, this.#epsilon, this.#initial));
    for (let i = 0; i < 3; i++) if (!sharedMeshTopology || !a.vertices.includes(b.vertices[i])) events.push(...vertexFace(b.points[i], a.points, this.#epsilon, this.#initial));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const aIndices = [a.vertices[i], a.vertices[(i + 1) % 3]], bIndices = [b.vertices[j], b.vertices[(j + 1) % 3]];
      if (sharedMeshTopology && aIndices.some(v => bIndices.includes(v))) continue;
      events.push(...edgeEdge(a.points[i], a.points[(i + 1) % 3], b.points[j], b.points[(j + 1) % 3], this.#epsilon, this.#initial));
    }
    return events.sort((a, b) => a.time - b.time || Number(b.feature === 'indeterminate') - Number(a.feature === 'indeterminate'));
  }

  #sewnContact(a: MovingFace, b: MovingFace, event: FeatureEvent, first: ArrayLike<number>, last: ArrayLike<number>): boolean {
    if (event.feature === 'indeterminate') return false;
    return [...(this.#seamCandidates.get(a.id)?.get(b.id) ?? [])].some(([group, segments]) => {
      const pairs = this.#input.seamPairsBySeam![group].pairs;
      const at = (particle: number, time: number) => lerp({ start: read(first, particle, 4), end: read(last, particle, 4) }, time);
      const sidesAt = (time: number): [Vec[], Vec[]] => {
        const sides: [Vec[], Vec[]] = [[], []];
        for (let k = 0; k < pairs.length; k += 2) { sides[0].push(at(pairs[k], time)); sides[1].push(at(pairs[k + 1], time)); }
        return sides;
      };
      const startSides = sidesAt(event.time);
      const locallyClosed = () => {
        for (const k of segments) if (isLocallyClosedPairedSeamContact(new Vector3(...event.point), new Vector3(...startSides[0][k]), new Vector3(...startSides[0][k + 1]), new Vector3(...startSides[1][k]), new Vector3(...startSides[1][k + 1]))) return true;
        return false;
      };
      if (event.intervalEnd === undefined) return locallyClosed();
      const stationary = [...a.points, ...b.points].every(v => distance(v.start, v.end) === 0)
        && Array.from(pairs).every(p => distance(read(first, p, 4), read(last, p, 4)) === 0);
      if (stationary) return locallyClosed();
      const endSides = sidesAt(event.intervalEnd);
      // A fixed corresponding parameter on ONE actual paired segment bounds
      // both side distances and the local stitch gap throughout the interval.
      // Convexity proves the interval; no selected-time sampling exemption.
      return (event.boundFeatures ?? [[...a.points, ...b.points]]).some(feature => {
        for (const k of segments) {
          const a0 = startSides[0][k], a1 = startSides[0][k + 1], b0 = startSides[1][k], b1 = startSides[1][k + 1];
          const ae0 = endSides[0][k], ae1 = endSides[0][k + 1], be0 = endSides[1][k], be1 = endSides[1][k + 1];
          const midpoint = scale(add(a0, b0), .5), direction = sub(scale(add(a1, b1), .5), midpoint), lengthSquared = dot(direction, direction);
          let bounded = true;
          for (const vertex of feature) {
            const p0 = lerp(vertex, event.time), p1 = lerp(vertex, event.intervalEnd!);
            const fraction = lengthSquared > 0 ? Math.max(0, Math.min(1, dot(sub(p0, midpoint), direction) / lengthSquared)) : 0;
            const l0 = add(a0, scale(sub(a1, a0), fraction)), r0 = add(b0, scale(sub(b1, b0), fraction));
            const l1 = add(ae0, scale(sub(ae1, ae0), fraction)), r1 = add(be0, scale(sub(be1, be0), fraction));
            if (distance(p0, l0) > .005 || distance(p0, r0) > .005 || distance(p1, l1) > .005 || distance(p1, r1) > .005 || distance(l0, r0) > .003 || distance(l1, r1) > .003) { bounded = false; break; }
          }
          if (bounded) return true;
        }
        return false;
      });
    });
  }

  inspect(first: ArrayLike<number>, last: ArrayLike<number>): ContinuousCollisionReport {
    const report: ContinuousCollisionReport = { safe: true, finite: true, bodyContactCount: 0, selfContactCount: 0, indeterminateContactCount: 0, earliestTimeOfImpact: null, events: [], segmentCount: 1, interpolation: 'piecewise-linear', limitations: LIMITATIONS };
    if (first.length !== this.#input.particleCount * 4 || last.length !== first.length || !Array.from(first).every(Number.isFinite) || !Array.from(last).every(Number.isFinite)) { report.safe = false; report.finite = false; return report; }
    const faces = makeFaces(first, last, this.#input.clothTriangles, 4, this.#input.clothTriangleStride ?? 4);
    const record = (kind: 'body' | 'self', a: MovingFace, b: MovingFace, event: FeatureEvent) => {
      if (kind === 'body') report.bodyContactCount++; else report.selfContactCount++;
      if (event.feature === 'indeterminate') report.indeterminateContactCount++;
      report.earliestTimeOfImpact = Math.min(report.earliestTimeOfImpact ?? Infinity, event.time);
      const recorded: ContinuousCollisionEvent = { kind, clothTriangle: a.id, otherTriangle: b.id, feature: event.feature, timeOfImpact: event.time, intervalEnd: event.intervalEnd, point: event.point };
      if (report.events.length < this.#limit) report.events.push(recorded);
      else if (this.#limit > 0) {
        let latest = 0;
        for (let k = 1; k < report.events.length; k++) if (report.events[k].timeOfImpact > report.events[latest].timeOfImpact) latest = k;
        if (event.time < report.events[latest].timeOfImpact) report.events[latest] = recorded;
      }
    };
    for (const face of faces) query(this.#bodyTree, face.bounds, this.#epsilon, body => {
      const event = this.#pairEvents(face, body)[0];
      if (event) record('body', face, body, event);
    });
    if (this.#self) {
      const tree = buildTree(faces.slice());
      for (const face of faces) query(tree, face.bounds, this.#epsilon, other => {
        if (other.id <= face.id) return;
        const event = this.#pairEvents(face, other, true).find(event => !this.#sewnContact(face, other, event, first, last));
        if (event) record('self', face, other, event);
      });
    }
    report.events.sort((a, b) => a.timeOfImpact - b.timeOfImpact);
    report.safe = report.bodyContactCount === 0 && report.selfContactCount === 0;
    return report;
  }

  /** Supply the actual solver boundaries when its frame path contains several substeps. */
  inspectTrajectory(boundaries: readonly ArrayLike<number>[]): ContinuousCollisionReport {
    if (boundaries.length < 2) throw new Error('Continuous guard needs at least two trajectory boundaries');
    const result: ContinuousCollisionReport = { safe: true, finite: true, bodyContactCount: 0, selfContactCount: 0, indeterminateContactCount: 0, earliestTimeOfImpact: null, events: [], segmentCount: boundaries.length - 1, interpolation: 'piecewise-linear', limitations: LIMITATIONS };
    for (let segment = 0; segment < boundaries.length - 1; segment++) {
      const report = this.inspect(boundaries[segment], boundaries[segment + 1]);
      result.safe &&= report.safe; result.finite &&= report.finite;
      result.bodyContactCount += report.bodyContactCount; result.selfContactCount += report.selfContactCount; result.indeterminateContactCount += report.indeterminateContactCount;
      if (report.earliestTimeOfImpact !== null) result.earliestTimeOfImpact = Math.min(result.earliestTimeOfImpact ?? Infinity, (segment + report.earliestTimeOfImpact) / result.segmentCount);
      for (const event of report.events) if (result.events.length < this.#limit) result.events.push({ ...event, segment, timeOfImpact: (segment + event.timeOfImpact) / result.segmentCount, intervalEnd: event.intervalEnd === undefined ? undefined : (segment + event.intervalEnd) / result.segmentCount });
    }
    return result;
  }
}
