import { Ray, Triangle, Vector3 } from 'three';


export const SOURCE_GATHER_COLLISION_GEOMETRY_REVISION = 'source-free-gather-boundary-v1' as const;
export interface RefinedBoundarySide {
  particles: readonly number[];
  originalMaterialParameters: readonly number[];
  children: readonly { startParticle: number; endParticle: number; boundaryFace: number }[];
}
export interface RefinedSeamIntervalGeometry {
  seamIndex: number;
  originalInterval: number;
  sides: readonly [RefinedBoundarySide, RefinedBoundarySide];
}
export interface SourceGatherCollisionGeometry {
  revision: typeof SOURCE_GATHER_COLLISION_GEOMETRY_REVISION;
  refinementPolicySha256: string;
  /** Original source material coordinates, including numerically derived midpoint coordinates, in metres. */
  sourceMaterialCoordinates: ArrayLike<number>;
  sourceCoordinateStride: 4;
  intervals: readonly RefinedSeamIntervalGeometry[];
}
export function copySourceGatherCollisionGeometry(value: SourceGatherCollisionGeometry): SourceGatherCollisionGeometry {
  return { ...value, sourceMaterialCoordinates: Array.from(value.sourceMaterialCoordinates),
    intervals: value.intervals.map(interval => ({ ...interval, sides: interval.sides.map(side => ({
      particles: Array.from(side.particles), originalMaterialParameters: Array.from(side.originalMaterialParameters),
      children: side.children.map(child => ({ ...child }))
    })) as unknown as [RefinedBoundarySide, RefinedBoundarySide] })) };
}
const edgeKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
const intervalKey = (seam: number, interval: number) => `${seam}:${interval}`;

/** Immutable geometric proof data. Original knots remain the ONLY sewing/activation dictionary. */
export class RefinedSeamGeometry {
  readonly #intervals = new Map<string, RefinedSeamIntervalGeometry>();
  readonly #faceVertices: number[][];
  readonly #epsilon: number;
  constructor(input: CollisionGuardInput, epsilon: number) {
    const geometry = input.sourceGatherCollisionGeometry;
    if (!geometry || input.sourceGatherRefinementRevision !== SOURCE_GATHER_COLLISION_GEOMETRY_REVISION
      || geometry.revision !== input.sourceGatherRefinementRevision || !/^[a-f0-9]{64}$/.test(geometry.refinementPolicySha256)
      || !input.seamPairsBySeam || input.stitchCount === undefined || !geometry.intervals.length
      || geometry.sourceCoordinateStride !== 4
      || geometry.sourceMaterialCoordinates.length !== input.particleCount * geometry.sourceCoordinateStride
      || !Array.from(geometry.sourceMaterialCoordinates).every(Number.isFinite)) throw new Error('Missing or invalid refined source seam geometry');
    for (let id = 0; id < input.particleCount; id++) {
      const owner = geometry.sourceMaterialCoordinates[id * 4 + 3];
      if (!Number.isSafeInteger(owner) || owner < 0) throw new Error('Refined source geometry requires exact nonnegative piece ownership');
    }
    this.#epsilon = epsilon;
    const stride = input.clothTriangleStride ?? 4;
    this.#faceVertices = Array.from({ length: input.clothTriangles.length / stride }, (_, face) =>
      [0, 1, 2].map(corner => input.clothTriangles[face * stride + corner]));
    const edgeFaces = new Map<string, number[]>();
    for (const [face, vertices] of this.#faceVertices.entries()) for (let corner = 0; corner < 3; corner++) {
      const key = edgeKey(vertices[corner], vertices[(corner + 1) % 3]), faces = edgeFaces.get(key) ?? [];
      faces.push(face); edgeFaces.set(key, faces);
    }
    const sewnParticles = new Set(input.seamPairsBySeam.flatMap(group => Array.from(group.pairs)));
    const usedFree = new Set<number>();
    for (const interval of geometry.intervals) {
      const group = input.seamPairsBySeam[interval.seamIndex], k = interval.originalInterval;
      if (!Number.isInteger(interval.seamIndex) || !group || !Number.isInteger(k) || k < 0
        || (k + 1) * 2 + 1 >= group.pairs.length || this.#intervals.has(intervalKey(interval.seamIndex, k))
        || !Array.isArray(interval.sides) || interval.sides.length !== 2) throw new Error('Invalid refined source seam interval');
      const lengths = interval.sides.map(side => side.particles.length);
      if (!((lengths[0] === 3 && lengths[1] === 2) || (lengths[0] === 2 && lengths[1] === 3))) throw new Error('Exactly one free boundary midpoint is required');
      for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
        const side: RefinedBoundarySide = interval.sides[sideIndex], ids = side.particles, parameters = side.originalMaterialParameters;
        if (new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 0 || id >= input.particleCount)
          || parameters.length !== ids.length || parameters.some((u, at) => u !== at / (ids.length - 1))
          || ids[0] !== group.pairs[k * 2 + sideIndex] || ids[ids.length - 1] !== group.pairs[(k + 1) * 2 + sideIndex]
          || side.children.length !== ids.length - 1) throw new Error('Refined path does not match the original paired interval');
        for (let child = 0; child < side.children.length; child++) {
          const record = side.children[child], faces = edgeFaces.get(edgeKey(ids[child], ids[child + 1]));
          if (record.startParticle !== ids[child] || record.endParticle !== ids[child + 1]
            || !Number.isInteger(record.boundaryFace) || faces?.length !== 1 || faces[0] !== record.boundaryFace) {
            throw new Error('Refined child is not its actual unique boundary edge');
          }
          const owner = geometry.sourceMaterialCoordinates[ids[0] * 4 + 3];
          if (ids.some(id => geometry.sourceMaterialCoordinates[id * 4 + 3] !== owner)
            || this.#faceVertices[record.boundaryFace].some(id => geometry.sourceMaterialCoordinates[id * 4 + 3] !== owner)) {
            throw new Error('Refined child boundary crosses original piece ownership');
          }
        }
        if (ids.length === 3) {
          const midpoint = ids[1];
          if (edgeFaces.has(edgeKey(ids[0], ids[2])) || sewnParticles.has(midpoint) || usedFree.has(midpoint)
            || (input.seams && Array.from(input.seams).some((partner, at) => partner === midpoint
              || (Math.floor(at / 4) === midpoint && partner !== -1)))) throw new Error('Refined midpoint is not a unique unsown boundary particle');
          usedFree.add(midpoint);
          for (let axis = 0; axis < 2; axis++) {
            const a = geometry.sourceMaterialCoordinates[ids[0] * geometry.sourceCoordinateStride + axis];
            const b = geometry.sourceMaterialCoordinates[ids[2] * geometry.sourceCoordinateStride + axis];
            const m = geometry.sourceMaterialCoordinates[midpoint * geometry.sourceCoordinateStride + axis];
            // Packing a raw-double midpoint differs from averaging its packed endpoints by float32 roundoff.
            const packingError = 8 * 2 ** -24 * Math.max(1e-6, Math.abs(a), Math.abs(b), Math.abs(m));
            if (Math.abs(m - (a + b) / 2) > packingError) throw new Error('Refined midpoint does not derive from its original source edge');
          }
          if (geometry.sourceCoordinateStride === 4 && ids.some(id => geometry.sourceMaterialCoordinates[id * 4 + 3]
            !== geometry.sourceMaterialCoordinates[ids[0] * 4 + 3])) throw new Error('Refined source boundary crosses piece ownership');
        }
      }
      this.#intervals.set(intervalKey(interval.seamIndex, k), copySourceGatherCollisionGeometry({ ...geometry, intervals: [interval] }).intervals[0]);
    }
  }
  has(seam: number, interval: number): boolean { return this.#intervals.has(intervalKey(seam, interval)); }
  #touches(face: number, boundaryFace: number): boolean {
    const faceVertices = this.#faceVertices[face], boundaryVertices = this.#faceVertices[boundaryFace];
    return !!faceVertices && !!boundaryVertices && faceVertices.some(vertex => boundaryVertices.includes(vertex));
  }
  /** Called only AFTER original actual paired-knot topology and BOTH endpoint activation pass. */
  allows(seam: number, interval: number, face: number, other: number, point: Vector3, positions: ArrayLike<number>): boolean {
    const record = this.#intervals.get(intervalKey(seam, interval));
    if (!record) return false; // Caller may use legacy proof only for an explicitly unrefined interval.
    const at = (id: number) => new Vector3(positions[id * 4], positions[id * 4 + 1], positions[id * 4 + 2]);
    // An unsown midpoint feature cannot become an invented weld even if it drifts toward the band.
    if (record.sides.some(side => side.particles.slice(1, -1).some(id => at(id).distanceToSquared(point) <= this.#epsilon ** 2))) return false;
    for (let cell = 0; cell < 2; cell++) {
      const u0 = cell / 2, u1 = (cell + 1) / 2;
      const segments = record.sides.map(side => side.particles.length === 3 ? cell : 0);
      const children = record.sides.map((side, index) => side.children[segments[index]].boundaryFace);
      if (!((this.#touches(face, children[0]) && this.#touches(other, children[1]))
        || (this.#touches(face, children[1]) && this.#touches(other, children[0])))) continue;
      const values = record.sides.map(side => {
        if (side.particles.length === 3) return [at(side.particles[cell]), at(side.particles[cell + 1])];
        const start = at(side.particles[0]), end = at(side.particles[1]);
        return [start.clone().lerp(end, u0), start.clone().lerp(end, u1)];
      });
      const [a0, a1] = values[0], [b0, b1] = values[1], mid = a0.clone().add(b0).multiplyScalar(.5);
      const delta = a1.clone().add(b1).multiplyScalar(.5).sub(mid), lengthSquared = delta.lengthSq();
      const t = lengthSquared > 0 ? Math.max(0, Math.min(1, point.clone().sub(mid).dot(delta) / lengthSquared)) : 0;
      const a = a0.clone().lerp(a1, t), b = b0.clone().lerp(b1, t);
      if (point.distanceToSquared(a) <= .005 ** 2 && point.distanceToSquared(b) <= .005 ** 2
        && a.distanceToSquared(b) <= .003 ** 2) return true;
    }
    return false;
  }
}


/** A geometry acceptance check, not a contact solver or a fit certificate. */
export interface CollisionGuardInput {
  bodyPositions: ArrayLike<number>;
  bodyIndices: ArrayLike<number>;
  clothTriangles: ArrayLike<number>;
  particleCount: number;
  /** Four partner indices per particle, -1 for unused slots. */
  seams?: ArrayLike<number>;
  /** Ordered pairs from each actual source seam; required for sewn-contact exemptions. */
  seamPairsBySeam?: readonly { seamId?: string; index?: number; pairs: ArrayLike<number>;
    /** Reciprocal first-stamp order, or declared logical timeline slot for an identity pair. */
    stitchIndices?: ArrayLike<number>;
    /** Optional audited provenance; no physical link is created for an identity pair. */
    stitchIndexKinds?: readonly ('identity-logical' | 'reciprocal-first-stamp')[] }[];
  /** Enables request-specific sewing activation verification when supplied. */
  stitchCount?: number;
  sourceGatherRefinementRevision?: typeof SOURCE_GATHER_COLLISION_GEOMETRY_REVISION;
  sourceGatherCollisionGeometry?: SourceGatherCollisionGeometry;
  bodyPositionStride?: number;
  bodyTriangleStride?: number;
  clothTriangleStride?: number;
}
/** Immutable for one complete solver trajectory. Mask entries use the compiled seam-group order. */
export interface CollisionSeamActivation {
  revision: number;
  activeSeams: Uint32Array;
  sewnUpTo: number;
}
export interface CollisionGuardOptions {
  checkSelfIntersections?: boolean;
  /** Numerical tolerance in metres; this is not a permissive penetration depth. */
  epsilon?: number;
  maxRecordedIssues?: number;
}
export interface CollisionGuardReport {
  safe: boolean;
  finite: boolean;
  bodyClosed: boolean;
  insideParticleCount: number;
  bodyCrossingTriangleCount: number;
  selfCrossingPairCount: number;
  sweptBodyCrossingParticleCount: number;
  insideParticles: number[];
  bodyCrossingTriangles: number[];
  selfCrossingPairs: [number, number][];
  sweptBodyCrossingParticles: number[];
  rayDisagreementCount: number;
  limitations: readonly string[];
  /** The exact valid activation used to classify every sample, not the next planned stage. */
  seamActivation?: { revision: number; activeSeams: number[]; sewnUpTo: number };
  /** Counts include every feature occurrence at every inspected trajectory sample. */
  trajectory?: {
    valid: boolean;
    expectedSubSteps: number;
    inspectedSubsteps: number;
    firstUnsafeSubstep?: number;
    invalidReason?: 'invalid-substeps' | 'sample-count' | 'invalid-sample' | 'start-mismatch' | 'end-mismatch' | 'mass-mismatch' | 'worker-failure' | 'activation-missing' | 'invalid-seam-activation';
    counts: 'feature-occurrences-across-substeps';
  };
}
const LIMITATIONS = [
  'Finite noncoplanar triangle intersections do not certify collision thickness or coplanar overlap.',
  'Swept particle segments detect vertex tunnelling; continuous moving-edge/moving-face collision detection is not supplied.',
  'Shared mesh vertices are excluded; source seam one-ring contacts require every endpoint within 5mm of both sides of the same actual paired segment, whose corresponding local stitch gap is within 3mm. Other stitches may remain open during assembly.',
  'A clear geometry report does not certify closed seams, anatomical coverage or settling.'
] as const;

/** Fail closed on unavailable/failed proof execution; geometry was not certified. */
export function failedCollisionTrajectoryReport(expectedSubSteps: number, bodyClosed = false): CollisionGuardReport {
  return { safe: false, finite: false, bodyClosed, insideParticleCount: 0, bodyCrossingTriangleCount: 0,
    selfCrossingPairCount: 0, sweptBodyCrossingParticleCount: 0, rayDisagreementCount: 0,
    insideParticles: [], bodyCrossingTriangles: [], selfCrossingPairs: [], sweptBodyCrossingParticles: [],
    limitations: LIMITATIONS, trajectory: { valid: false, expectedSubSteps, inspectedSubsteps: 0,
      counts: 'feature-occurrences-across-substeps', invalidReason: 'worker-failure' } };
}
type Bounds = [number, number, number, number, number, number];
interface Face { triangle: Triangle; bounds: Bounds; id: number; vertices: [number, number, number] }
interface Node { bounds: Bounds; faces?: Face[]; left?: Node; right?: Node }
const point = (p: ArrayLike<number>, i: number, stride: number) => new Vector3(p[i * stride], p[i * stride + 1], p[i * stride + 2]);
function faceBounds(t: Triangle): Bounds {
  return [Math.min(t.a.x, t.b.x, t.c.x), Math.min(t.a.y, t.b.y, t.c.y), Math.min(t.a.z, t.b.z, t.c.z),
    Math.max(t.a.x, t.b.x, t.c.x), Math.max(t.a.y, t.b.y, t.c.y), Math.max(t.a.z, t.b.z, t.c.z)];
}
function makeFaces(p: ArrayLike<number>, indices: ArrayLike<number>, ps: number, ts: number): Face[] {
  const faces: Face[] = [];
  for (let i = 0; i < indices.length; i += ts) {
    const vertices: [number, number, number] = [indices[i], indices[i + 1], indices[i + 2]];
    const triangle = new Triangle(...vertices.map(v => point(p, v, ps)) as [Vector3, Vector3, Vector3]);
    faces.push({ triangle, bounds: faceBounds(triangle), id: i / ts, vertices });
  }
  return faces;
}
function buildTree(faces: Face[]): Node | undefined {
  if (!faces.length) return undefined;
  const bounds: Bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const f of faces) for (let axis = 0; axis < 3; axis++) {
    bounds[axis] = Math.min(bounds[axis], f.bounds[axis]);
    bounds[axis + 3] = Math.max(bounds[axis + 3], f.bounds[axis + 3]);
  }
  if (faces.length <= 8) return { bounds, faces };
  let axis = 0;
  for (let k = 1; k < 3; k++) if (bounds[k + 3] - bounds[k] > bounds[axis + 3] - bounds[axis]) axis = k;
  faces.sort((a, b) => a.bounds[axis] + a.bounds[axis + 3] - b.bounds[axis] - b.bounds[axis + 3]);
  const mid = faces.length >> 1;
  return { bounds, left: buildTree(faces.slice(0, mid)), right: buildTree(faces.slice(mid)) };
}
function overlap(a: Bounds, b: Bounds, eps: number): boolean {
  return a[0] <= b[3] + eps && a[3] + eps >= b[0] && a[1] <= b[4] + eps && a[4] + eps >= b[1] && a[2] <= b[5] + eps && a[5] + eps >= b[2];
}
function query(node: Node | undefined, bounds: Bounds, eps: number, visit: (face: Face) => void): void {
  if (!node || !overlap(node.bounds, bounds, eps)) return;
  if (node.faces) { for (const face of node.faces) if (overlap(face.bounds, bounds, eps)) visit(face); }
  else { query(node.left, bounds, eps, visit); query(node.right, bounds, eps, visit); }
}
function rayBounds(ray: Ray, b: Bounds, eps: number): boolean {
  let near = 0, far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const origin = ray.origin.getComponent(axis), direction = ray.direction.getComponent(axis);
    if (Math.abs(direction) < 1e-15) { if (origin < b[axis] - eps || origin > b[axis + 3] + eps) return false; continue; }
    let a = (b[axis] - eps - origin) / direction, c = (b[axis + 3] + eps - origin) / direction;
    if (a > c) [a, c] = [c, a];
    near = Math.max(near, a); far = Math.min(far, c);
    if (near > far) return false;
  }
  return true;
}
function rayQuery(node: Node | undefined, ray: Ray, eps: number, visit: (face: Face) => void): void {
  if (!node || !rayBounds(ray, node.bounds, eps)) return;
  if (node.faces) { for (const f of node.faces) if (rayBounds(ray, f.bounds, eps)) visit(f); }
  else { rayQuery(node.left, ray, eps, visit); rayQuery(node.right, ray, eps, visit); }
}
function validateIndices(indices: ArrayLike<number>, stride: number, count: number): void {
  if (!Number.isInteger(stride) || stride < 3 || indices.length % stride) throw new Error('Invalid collision guard triangle stride');
  for (let i = 0; i < indices.length; i++) if (i % stride < 3 && (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= count)) throw new Error('Collision guard triangle references an invalid vertex');
}
/** Indexed avatar vertices may duplicate at UV seams: inspect geometric, welded edges. */
function isClosed(faces: Face[], eps: number): boolean {
  const edges = new Map<string, number>();
  const key = (p: Vector3) => [p.x, p.y, p.z].map(v => Math.round(v / eps)).join(',');
  for (const f of faces) {
    const v = [f.triangle.a, f.triangle.b, f.triangle.c].map(key);
    if (new Set(v).size < 3) return false;
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3], edge = a < b ? a + '/' + b : b + '/' + a;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  return faces.length > 0 && [...edges.values()].every(n => n === 2);
}

interface RaySurfaceHit { distance: number; feature: string | null; orientation: number }

/** Numerical duplicate hits belong to an actual shared mesh feature. Nearby interior
 * intersections can be real entry/exit pairs and must never be distance-deduplicated. */
function rayHitFeature(triangle: Triangle, at: Vector3, barycentric: Vector3): string | null {
  triangle.getBarycoord(at, barycentric);
  const weights = [barycentric.x, barycentric.y, barycentric.z], vertices = [triangle.a, triangle.b, triangle.c];
  const zeros = weights.map((value, index) => Math.abs(value) <= 1e-10 ? index : -1).filter(index => index >= 0);
  if (!zeros.length) return null;
  const key = (p: Vector3) => `${p.x},${p.y},${p.z}`;
  if (zeros.length >= 2) return 'vertex/' + key(vertices[weights.indexOf(Math.max(...weights))]);
  return 'edge/' + vertices.filter((_v, index) => index !== zeros[0]).map(key).sort().join('/');
}
function distinctRayHitCount(hits: RaySurfaceHit[], origin: Vector3): number {
  const previous = new Map<string, number>();
  hits.sort((a, b) => a.distance - b.distance);
  let count = 0;
  for (const hit of hits) {
    if (!hit.feature) { count++; continue; }
    const key = hit.feature + '/' + hit.orientation, last = previous.get(key);
    // Double-precision intersection roundoff, independent of the physical contact
    // epsilon. Opposite entry/exit orientations always remain separate crossings.
    const tolerance = 1e-10 * Math.max(1, Math.abs(origin.x), Math.abs(origin.y), Math.abs(origin.z), hit.distance);
    if (last === undefined || hit.distance - last > tolerance) count++;
    previous.set(key, hit.distance);
  }
  return count;
}

/**
 * Assembly-only welded contact proof. Both distances and the stitch gap use the
 * SAME parameter on one actual ordered pair of seam-side segments. Final garment
 * acceptance must separately require every stitch of every seam to be closed.
 */
export function isLocallyClosedPairedSeamContact(point: Vector3, leftStart: Vector3, leftEnd: Vector3, rightStart: Vector3, rightEnd: Vector3): boolean {
  const mx = (leftStart.x + rightStart.x) / 2, my = (leftStart.y + rightStart.y) / 2, mz = (leftStart.z + rightStart.z) / 2;
  const dx = (leftEnd.x + rightEnd.x) / 2 - mx, dy = (leftEnd.y + rightEnd.y) / 2 - my, dz = (leftEnd.z + rightEnd.z) / 2 - mz;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point.x - mx) * dx + (point.y - my) * dy + (point.z - mz) * dz) / lengthSquared)) : 0;
  const ax = leftStart.x + t * (leftEnd.x - leftStart.x), ay = leftStart.y + t * (leftEnd.y - leftStart.y), az = leftStart.z + t * (leftEnd.z - leftStart.z);
  const bx = rightStart.x + t * (rightEnd.x - rightStart.x), by = rightStart.y + t * (rightEnd.y - rightStart.y), bz = rightStart.z + t * (rightEnd.z - rightStart.z);
  return (point.x - ax) ** 2 + (point.y - ay) ** 2 + (point.z - az) ** 2 <= .005 ** 2
    && (point.x - bx) ** 2 + (point.y - by) ** 2 + (point.z - bz) ** 2 <= .005 ** 2
    && (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2 <= .003 ** 2;
}

/** Reuse one instance while the source body/topology is unchanged. No input arrays are mutated. */
export class ClothCollisionGuard {
  readonly #input: CollisionGuardInput;
  readonly #epsilon: number;
  readonly #limit: number;
  readonly #self: boolean;
  readonly #activationRequired: boolean;
  readonly #refinedGeometry?: RefinedSeamGeometry;
  readonly #bodyTree?: Node;
  readonly #closed: boolean;
  readonly #selfExclusions = new Map<number, Set<number>>();
  readonly #seamCandidates = new Map<number, Map<number, Map<number, Set<number>>>>();
  readonly #ray = new Ray();
  readonly #hit = new Vector3();
  readonly #delta = new Vector3();
  readonly #directions = [new Vector3(1, .173, .291), new Vector3(-.123, 1, .347), new Vector3(.277, -.193, 1)].map(v => v.normalize());

  constructor(input: CollisionGuardInput, options: CollisionGuardOptions = {}) {
    this.#epsilon = options.epsilon ?? 1e-6;
    this.#limit = options.maxRecordedIssues ?? 64;
    this.#self = options.checkSelfIntersections ?? true;
    if (!(this.#epsilon > 0) || !Number.isFinite(this.#epsilon) || !Number.isInteger(this.#limit) || this.#limit < 0 || !Number.isInteger(input.particleCount) || input.particleCount < 0) throw new Error('Invalid collision guard options');
    const ps = input.bodyPositionStride ?? 3, bs = input.bodyTriangleStride ?? 3, cs = input.clothTriangleStride ?? 4;
    if (!Number.isInteger(ps) || ps < 3 || input.bodyPositions.length % ps || !Array.from(input.bodyPositions).every(Number.isFinite)) throw new Error('Invalid collision guard body positions');
    validateIndices(input.bodyIndices, bs, input.bodyPositions.length / ps);
    validateIndices(input.clothTriangles, cs, input.particleCount);
    if (input.seams && (input.seams.length !== input.particleCount * 4 || !Array.from(input.seams).every(v => v === -1 || (Number.isInteger(v) && v >= 0 && v < input.particleCount)))) throw new Error('Invalid collision guard seam topology');
    for (const seam of input.seamPairsBySeam ?? []) if (seam.pairs.length % 2 || !Array.from(seam.pairs).every(v => Number.isInteger(v) && v >= 0 && v < input.particleCount)) throw new Error('Invalid collision guard ordered seam pairs');
    this.#activationRequired = input.sourceGatherRefinementRevision !== undefined || input.sourceGatherCollisionGeometry !== undefined || input.stitchCount !== undefined || !!input.seamPairsBySeam?.some(group => group.stitchIndices !== undefined);
    if (this.#activationRequired) {
      if (!Number.isSafeInteger(input.stitchCount) || input.stitchCount! < 0 || !input.seamPairsBySeam) throw new Error('Invalid collision guard stitch activation topology');
      const names = new Set<string>();
      for (const [index, group] of input.seamPairsBySeam.entries()) {
        if (!group.seamId || names.has(group.seamId) || group.index !== index || !group.stitchIndices
          || group.stitchIndices.length !== group.pairs.length / 2
          || !Array.from(group.stitchIndices).every(stitch => Number.isSafeInteger(stitch) && stitch >= 0 && stitch < input.stitchCount!)) {
          throw new Error('Invalid collision guard authoritative seam stitch indices');
        }
        if (group.stitchIndexKinds && (group.stitchIndexKinds.length !== group.pairs.length / 2
          || group.stitchIndexKinds.some((kind, at) => kind !== (group.pairs[at * 2] === group.pairs[at * 2 + 1]
            ? 'identity-logical' : 'reciprocal-first-stamp')))) throw new Error('Invalid collision guard stitch provenance');
        names.add(group.seamId);
      }
    }
    this.#input = { ...input, ...(input.sourceGatherCollisionGeometry ? { sourceGatherCollisionGeometry: copySourceGatherCollisionGeometry(input.sourceGatherCollisionGeometry) } : {}), clothTriangles: Array.from(input.clothTriangles), seams: input.seams && Array.from(input.seams),
      seamPairsBySeam: input.seamPairsBySeam?.map(s => ({ ...s, pairs: Array.from(s.pairs),
        ...(s.stitchIndices ? { stitchIndices: Array.from(s.stitchIndices) } : {}),
        ...(s.stitchIndexKinds ? { stitchIndexKinds: s.stitchIndexKinds.slice() } : {}) })) };
    if (input.sourceGatherRefinementRevision !== undefined || input.sourceGatherCollisionGeometry !== undefined) this.#refinedGeometry = new RefinedSeamGeometry(this.#input, this.#epsilon);
    const faces = makeFaces(input.bodyPositions, input.bodyIndices, ps, bs);
    this.#closed = isClosed(faces, this.#epsilon / 10);
    this.#bodyTree = buildTree(faces);
    if (this.#self) this.#prepareSelfExclusions(cs);
  }

  #prepareSelfExclusions(stride: number): void {
    const incident = Array.from({ length: this.#input.particleCount }, () => new Set<number>());
    const neighbors = Array.from({ length: this.#input.particleCount }, (_, i) => new Set([i]));
    const indices = this.#input.clothTriangles;
    for (let i = 0; i < indices.length; i += stride) {
      for (let k = 0; k < 3; k++) {
        const a = indices[i + k]; incident[a].add(i / stride);
        for (let j = 0; j < 3; j++) neighbors[a].add(indices[i + j]);
      }
    }
    const exclude = (a: number, b: number) => {
      if (!this.#selfExclusions.has(a)) this.#selfExclusions.set(a, new Set());
      this.#selfExclusions.get(a)!.add(b);
    };
    // Mesh neighbours share an actual particle. Do not exclude whole panels.
    for (const faces of incident) for (const a of faces) for (const b of faces) exclude(a, b);
    const groups = this.#input.seamPairsBySeam ?? [];
    const candidate = (l: number, r: number, group: number, pairIndex: number) => {
      if (!this.#seamCandidates.has(l)) this.#seamCandidates.set(l, new Map());
      const rows = this.#seamCandidates.get(l)!;
      if (!rows.has(r)) rows.set(r, new Map());
      const groupsForPair = rows.get(r)!;
      if (!groupsForPair.has(group)) groupsForPair.set(group, new Set());
      for (const segment of [pairIndex - 1, pairIndex]) if (segment >= 0 && segment < groups[group].pairs.length / 2 - 1) groupsForPair.get(group)!.add(segment);
    };
    for (let group = 0; group < groups.length; group++) {
      const pairs = groups[group].pairs;
      for (let k = 0; k < pairs.length; k += 2) {
        const a = pairs[k], b = pairs[k + 1], left = new Set<number>(), right = new Set<number>();
        for (const v of neighbors[a]) for (const f of incident[v]) left.add(f);
        for (const v of neighbors[b]) for (const f of incident[v]) right.add(f);
        for (const l of left) for (const r of right) { candidate(l, r, group, k / 2); candidate(r, l, group, k / 2); }
      }
    }
  }

  #segmentCross(a: Vector3, b: Vector3, triangle: Triangle): boolean {
    this.#delta.subVectors(b, a);
    const length = this.#delta.length();
    if (length <= 2 * this.#epsilon) return false;
    this.#ray.set(a, this.#delta.multiplyScalar(1 / length));
    if (!this.#ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, this.#hit)) return false;
    const distance = this.#hit.distanceTo(a);
    return distance > this.#epsilon && distance < length - this.#epsilon;
  }

  #trianglesCross(a: Triangle, b: Triangle): boolean {
    return this.#segmentCross(a.a, a.b, b) || this.#segmentCross(a.b, a.c, b) || this.#segmentCross(a.c, a.a, b)
      || this.#segmentCross(b.a, b.b, a) || this.#segmentCross(b.b, b.c, a) || this.#segmentCross(b.c, b.a, a);
  }

  #emptyReport(): CollisionGuardReport {
    return {
      safe: true, finite: true, bodyClosed: this.#closed, insideParticleCount: 0, bodyCrossingTriangleCount: 0,
      selfCrossingPairCount: 0, sweptBodyCrossingParticleCount: 0, insideParticles: [], bodyCrossingTriangles: [], selfCrossingPairs: [],
      sweptBodyCrossingParticles: [], rayDisagreementCount: 0, limitations: LIMITATIONS
    };
  }

  #activationError(activation?: CollisionSeamActivation): 'activation-missing' | 'invalid-seam-activation' | undefined {
    if (!activation) return this.#activationRequired ? 'activation-missing' : undefined;
    if (!this.#activationRequired || !Number.isSafeInteger(activation.revision) || activation.revision < 0
      || !(activation.activeSeams instanceof Uint32Array)
      || activation.activeSeams.length !== this.#input.seamPairsBySeam!.length
      || !Array.from(activation.activeSeams).every(value => value === 0 || value === 1)
      || !Number.isSafeInteger(activation.sewnUpTo) || activation.sewnUpTo < 0 || activation.sewnUpTo > this.#input.stitchCount!) return 'invalid-seam-activation';
    return undefined;
  }

  inspect(positions: ArrayLike<number>, previousPositions?: ArrayLike<number>, activation?: CollisionSeamActivation): CollisionGuardReport {
    const report = this.#emptyReport();
    if (this.#activationError(activation)) { report.safe = false; report.finite = false; return report; }
    // Copy before classification so a caller cannot change the mask through an aliased buffer.
    const active = activation && { ...activation, activeSeams: activation.activeSeams.slice() };
    if (active) report.seamActivation = { revision: active.revision, activeSeams: Array.from(active.activeSeams), sewnUpTo: active.sewnUpTo };
    const valid = (p: ArrayLike<number>) => p.length === this.#input.particleCount * 4 && Array.from(p).every(Number.isFinite);
    if (!valid(positions) || (previousPositions && !valid(previousPositions))) { report.safe = false; report.finite = false; return report; }
    const p = new Vector3(), closest = new Vector3(), old = new Vector3(), hitBarycentric = new Vector3(), hitNormal = new Vector3();
    for (let i = 0; i < this.#input.particleCount; i++) {
      p.set(positions[i * 4], positions[i * 4 + 1], positions[i * 4 + 2]);
      if (this.#closed) {
        let votes = 0, onSurface = false;
        for (const direction of this.#directions) {
          this.#ray.set(p, direction);
          const hits: RaySurfaceHit[] = [];
          rayQuery(this.#bodyTree, this.#ray, this.#epsilon, face => {
            if (!this.#ray.intersectTriangle(face.triangle.a, face.triangle.b, face.triangle.c, false, this.#hit)) return;
            const d = p.distanceTo(this.#hit);
            if (d <= this.#epsilon) { onSurface = true; return; }
            face.triangle.getNormal(hitNormal);
            hits.push({ distance: d, feature: rayHitFeature(face.triangle, this.#hit, hitBarycentric), orientation: Math.sign(hitNormal.dot(direction)) });
          });
          votes += distinctRayHitCount(hits, p) % 2;
        }
        // Also detect a point just below the surface, independent of ray direction.
        if (votes > 0) query(this.#bodyTree, [p.x - this.#epsilon, p.y - this.#epsilon, p.z - this.#epsilon, p.x + this.#epsilon, p.y + this.#epsilon, p.z + this.#epsilon], this.#epsilon, face => {
          face.triangle.closestPointToPoint(p, closest);
          onSurface ||= closest.distanceTo(p) <= this.#epsilon;
        });
        if (!onSurface && (votes === 1 || votes === 2)) report.rayDisagreementCount++;
        if (!onSurface && votes >= 2) { report.insideParticleCount++; if (report.insideParticles.length < this.#limit) report.insideParticles.push(i); }
      }
      if (previousPositions) {
        old.set(previousPositions[i * 4], previousPositions[i * 4 + 1], previousPositions[i * 4 + 2]);
        const bounds: Bounds = [Math.min(old.x, p.x), Math.min(old.y, p.y), Math.min(old.z, p.z), Math.max(old.x, p.x), Math.max(old.y, p.y), Math.max(old.z, p.z)];
        let crossing = false;
        query(this.#bodyTree, bounds, this.#epsilon, face => { if (!crossing) crossing = this.#segmentCross(old, p, face.triangle); });
        if (crossing) { report.sweptBodyCrossingParticleCount++; if (report.sweptBodyCrossingParticles.length < this.#limit) report.sweptBodyCrossingParticles.push(i); }
      }
    }
    const faces = makeFaces(positions, this.#input.clothTriangles, 4, this.#input.clothTriangleStride ?? 4);
    for (const face of faces) {
      let crossing = false;
      query(this.#bodyTree, face.bounds, this.#epsilon, body => { if (!crossing) crossing = this.#trianglesCross(face.triangle, body.triangle); });
      if (crossing) { report.bodyCrossingTriangleCount++; if (report.bodyCrossingTriangles.length < this.#limit) report.bodyCrossingTriangles.push(face.id); }
    }
    if (this.#self) {
      const tree = buildTree(faces.slice());
      const seams = (this.#input.seamPairsBySeam ?? []).map(group => {
        const sides: [Vector3[], Vector3[]] = [[], []];
        for (let k = 0; k < group.pairs.length; k += 2) {
          const a = point(positions, group.pairs[k], 4), b = point(positions, group.pairs[k + 1], 4);
          sides[0].push(a); sides[1].push(b);
        }
        return { sides };
      });
      for (const face of faces) query(tree, face.bounds, this.#epsilon, other => {
        if (other.id <= face.id || this.#selfExclusions.get(face.id)?.has(other.id)) return;
        const intersections: Vector3[] = [];
        for (const [a, b] of [[face.triangle, other.triangle], [other.triangle, face.triangle]]) {
          for (const [start, end] of [[a.a, a.b], [a.b, a.c], [a.c, a.a]]) {
            if (this.#segmentCross(start, end, b) && !intersections.some(p => p.distanceTo(this.#hit) < this.#epsilon / 10)) intersections.push(this.#hit.clone());
          }
        }
        if (!intersections.length) return;
        const sewnContact = [...(this.#seamCandidates.get(face.id)?.get(other.id) ?? [])].some(([group, segments]) => {
          if (active && active.activeSeams[group] !== 1) return false;
          const seam = seams[group];
          return intersections.every(at => {
            for (const k of segments) {
              const stitches = this.#input.seamPairsBySeam![group].stitchIndices;
              if (active && (!stitches || stitches[k] >= active.sewnUpTo || stitches[k + 1] >= active.sewnUpTo)) continue;
              if (this.#refinedGeometry?.has(group, k)) {
                if (this.#refinedGeometry.allows(group, k, face.id, other.id, at, positions)) return true;
                continue;
              }
              if (isLocallyClosedPairedSeamContact(at, seam.sides[0][k], seam.sides[0][k + 1], seam.sides[1][k], seam.sides[1][k + 1])) return true;
            }
            return false;
          });
        });
        if (!sewnContact) {
          report.selfCrossingPairCount++;
          if (report.selfCrossingPairs.length < this.#limit) report.selfCrossingPairs.push([face.id, other.id]);
        }
      });
    }
    report.safe = report.bodyClosed && report.insideParticleCount === 0 && report.bodyCrossingTriangleCount === 0
      && report.selfCrossingPairCount === 0 && report.sweptBodyCrossingParticleCount === 0 && report.rayDisagreementCount === 0;
    return report;
  }

  /**
   * Bind an actual corrected solver trajectory to its published start and candidate end.
   * Supply initial + EVERY corrected substep (41 samples for 40 substeps), without thinning.
   * All samples retain the same particle order/inverse masses as the immutable topology.
   * Missing, malformed, rebound or truncated traces fail closed before inspection.
   *
   * Every intermediate static body/self geometry and every consecutive particle segment
   * is inspected against this instance's unchanged body BVH. Counts are full occurrences
   * summed across samples; issue examples are bounded unique feature IDs. This is a
   * piecewise-linear particle-path proof, not continuous moving-edge/moving-face CCD.
   */
  inspectTrajectory(
    positions: ArrayLike<number>, previousPositions: ArrayLike<number>,
    trajectory: readonly ArrayLike<number>[] | null | undefined, expectedSubSteps: number, activation?: CollisionSeamActivation
  ): CollisionGuardReport {
    const report = this.#emptyReport();
    report.trajectory = { valid: false, expectedSubSteps, inspectedSubsteps: 0, counts: 'feature-occurrences-across-substeps' };
    report.limitations = [...LIMITATIONS,
      'Trajectory checks inspect every supplied corrected substep and straight consecutive particle segments; they do not infer unrecorded within-substep paths.'];
    const invalid = (reason: NonNullable<CollisionGuardReport['trajectory']>['invalidReason']) => {
      report.safe = false; report.finite = false; report.trajectory!.invalidReason = reason;
      return report;
    };
    const activationError = this.#activationError(activation);
    if (activationError) return invalid(activationError);
    const active = activation && { ...activation, activeSeams: activation.activeSeams.slice() };
    if (active) report.seamActivation = { revision: active.revision, activeSeams: Array.from(active.activeSeams), sewnUpTo: active.sewnUpTo };
    if (!Number.isInteger(expectedSubSteps) || expectedSubSteps < 1) return invalid('invalid-substeps');
    if (!Array.isArray(trajectory) || trajectory.length !== expectedSubSteps + 1) return invalid('sample-count');
    const valid = (sample: ArrayLike<number> | null | undefined) => {
      if (!sample || sample.length !== this.#input.particleCount * 4) return false;
      for (let index = 0; index < sample.length; index++) if (!Number.isFinite(sample[index])) return false;
      return true;
    };
    if (!valid(positions) || !valid(previousPositions) || trajectory.some(sample => !valid(sample))) return invalid('invalid-sample');
    for (let index = 0; index < positions.length; index++) {
      if (trajectory[0][index] !== previousPositions[index]) return invalid('start-mismatch');
      if (trajectory[expectedSubSteps][index] !== positions[index]) return invalid('end-mismatch');
    }
    for (const sample of trajectory) for (let index = 3; index < sample.length; index += 4) {
      if (sample[index] !== previousPositions[index]) return invalid('mass-mismatch');
    }
    report.trajectory.valid = true;
    const countKeys = ['insideParticleCount', 'bodyCrossingTriangleCount', 'selfCrossingPairCount',
      'sweptBodyCrossingParticleCount', 'rayDisagreementCount'] as const;
    const sampleKeys = ['insideParticles', 'bodyCrossingTriangles', 'sweptBodyCrossingParticles'] as const;
    for (let step = 0; step < trajectory.length; step++) {
      const sample = this.inspect(trajectory[step], step > 0 ? trajectory[step - 1] : undefined, active);
      report.trajectory.inspectedSubsteps = step;
      report.safe &&= sample.safe;
      report.finite &&= sample.finite;
      if (!sample.safe && report.trajectory.firstUnsafeSubstep === undefined) report.trajectory.firstUnsafeSubstep = step;
      for (const key of countKeys) report[key] += sample[key];
      for (const key of sampleKeys) for (const id of sample[key]) {
        if (report[key].length < this.#limit && !report[key].includes(id)) report[key].push(id);
      }
      for (const pair of sample.selfCrossingPairs) {
        if (report.selfCrossingPairs.length < this.#limit
          && !report.selfCrossingPairs.some(existing => existing[0] === pair[0] && existing[1] === pair[1])) report.selfCrossingPairs.push(pair);
      }
    }
    return report;
  }
}
