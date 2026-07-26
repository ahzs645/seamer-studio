// On-mesh body measurement segments (the original's GeneratedMeasurementSegment): compute the 3D
// polyline a measurement follows on the avatar — girths as horizontal mesh slices (convex "tape"
// hull, or the raw contour when followContour), straight segments between mesh anchors, floor and
// vertical distances. Anchors are barycentric face coordinates from the base model.

export interface MeasureAnchor {
  faceIndex: number;
  u: number;
  v: number;
  w: number;
}

export interface MeasureSegmentDef {
  name: string;
  type: 'girth' | 'arc' | 'straight' | 'floor' | 'vertical_distance' | string;
  coordinates?: MeasureAnchor[];
  followContour?: boolean;
  planeOffset?: number;
  zOffset?: number;
}

export interface MeasureSegment {
  points: [number, number, number][];
  closed: boolean;
  lengthM: number;
}

type V3 = [number, number, number];

function vertexOf(vertices: Float32Array, i: number): V3 {
  return [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
}

/** Resolve a barycentric face anchor to a 3D point on the posed mesh. */
export function anchorPoint(a: MeasureAnchor, vertices: Float32Array, indices: Uint32Array): V3 | null {
  const f = a.faceIndex * 3;
  if (f + 2 >= indices.length) return null;
  const A = vertexOf(vertices, indices[f]);
  const B = vertexOf(vertices, indices[f + 1]);
  const C = vertexOf(vertices, indices[f + 2]);
  return [
    a.u * A[0] + a.v * B[0] + a.w * C[0],
    a.u * A[1] + a.v * B[1] + a.w * C[1],
    a.u * A[2] + a.v * B[2] + a.w * C[2]
  ];
}

function polylineLength(pts: V3[], closed: boolean): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  }
  if (closed && pts.length > 2) {
    const a = pts[pts.length - 1], b = pts[0];
    len += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return len;
}

/**
 * Slice the mesh with the horizontal plane y=h near the anchor region and return the loop the tape
 * would follow: intersection points ordered by angle about the slice centroid; convex hull in the
 * XZ plane unless `followContour` (a tape measure bridges concavities).
 *
 * `nearXZ`/`maxRadius`: girths like the thigh slice a plane that also crosses the OTHER leg —
 * intersections further than maxRadius from the anchor centroid are discarded first.
 */
function sliceGirth(
  vertices: Float32Array,
  indices: Uint32Array,
  h: number,
  nearXZ: [number, number],
  followContour: boolean
): V3[] {
  const pts: { x: number; z: number }[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const tri = [vertexOf(vertices, indices[t]), vertexOf(vertices, indices[t + 1]), vertexOf(vertices, indices[t + 2])];
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      const da = a[1] - h, db = b[1] - h;
      if ((da > 0) === (db > 0)) continue;
      const f = da / (da - db);
      pts.push({ x: a[0] + (b[0] - a[0]) * f, z: a[2] + (b[2] - a[2]) * f });
    }
  }
  if (pts.length < 3) return [];
  // keep the connected region around the anchors (a thigh plane also slices the other leg)
  let cx = nearXZ[0], cz = nearXZ[1];
  let kept = pts;
  for (let pass = 0; pass < 2; pass++) {
    const ds = kept.map((p) => Math.hypot(p.x - cx, p.z - cz)).sort((a, b) => a - b);
    const maxR = (ds[Math.floor(ds.length * 0.5)] || 0.2) * 2.5; // 2.5× the median radius
    kept = kept.filter((p) => Math.hypot(p.x - cx, p.z - cz) <= maxR);
    if (kept.length < 3) return [];
    cx = kept.reduce((s, p) => s + p.x, 0) / kept.length;
    cz = kept.reduce((s, p) => s + p.z, 0) / kept.length;
  }
  let loop: { x: number; z: number }[];
  if (followContour) {
    loop = [...kept].sort((a, b) => Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx));
  } else {
    // convex hull (Andrew's monotone chain) in XZ — the pulled-straight tape
    const sorted = [...kept].sort((a, b) => a.x - b.x || a.z - b.z);
    const cross = (o: { x: number; z: number }, p: { x: number; z: number }, q: { x: number; z: number }) =>
      (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
    const lower: typeof sorted = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper: typeof sorted = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    loop = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  }
  return loop.map((p) => [p.x, h, p.z] as V3);
}

/** The 3D polyline of a measurement on the posed mesh, or null when it can't be computed. */
export function measurementSegment(
  def: MeasureSegmentDef,
  vertices: Float32Array,
  indices: Uint32Array
): MeasureSegment | null {
  const anchors = (def.coordinates ?? [])
    .map((a) => anchorPoint(a, vertices, indices))
    .filter((p): p is V3 => !!p);
  if (anchors.length === 0) return null;

  if (def.type === 'girth' || def.type === 'arc') {
    const h = anchors.reduce((s, p) => s + p[1], 0) / anchors.length + (def.planeOffset ?? 0);
    const cx = anchors.reduce((s, p) => s + p[0], 0) / anchors.length;
    const cz = anchors.reduce((s, p) => s + p[2], 0) / anchors.length;
    const loop = sliceGirth(vertices, indices, h, [cx, cz], !!def.followContour);
    if (loop.length < 3) return null;
    // an 'arc' uses only the half of the loop nearer the anchors (e.g. back arcs)
    if (def.type === 'arc') {
      const half = loop.filter((p) => Math.hypot(p[0] - cx, p[2] - cz) <= 0.6 * Math.max(...loop.map((q) => Math.hypot(q[0] - cx, q[2] - cz))) * 2);
      const open = half.length >= 2 ? half : loop;
      return { points: open, closed: false, lengthM: polylineLength(open, false) };
    }
    return { points: loop, closed: true, lengthM: polylineLength(loop, true) };
  }

  if (def.type === 'straight') {
    if (anchors.length < 2) return null;
    return { points: anchors, closed: false, lengthM: polylineLength(anchors, false) };
  }

  if (def.type === 'floor') {
    const a = anchors[0];
    const pts: V3[] = [a, [a[0], 0, a[2]]];
    return { points: pts, closed: false, lengthM: a[1] };
  }

  if (def.type === 'vertical_distance') {
    if (anchors.length < 2) return null;
    const [a, b] = anchors;
    const pts: V3[] = [a, [a[0], b[1], a[2]]];
    return { points: pts, closed: false, lengthM: Math.abs(a[1] - b[1]) };
  }

  return null;
}
