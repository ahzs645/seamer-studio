import type { Body } from '@seamer/pattern-model';
import { createSkeleton, jointWorldPositions, type BaseModel } from '@seamer/body-model';
import { anchorPoint, type MeasureSegmentDef } from './bodyMeasurements3d';

const required = ['height', 'head_l', 'waist_line', 'hips_line', 'shoulder_w'] as const;

/** Geometry-changing inputs only: paint, labels and UI state do not invalidate a fit. */
export function garmentCodeAvatarSignature(body: Body): string {
  return JSON.stringify({ gender: body.gender, unitType: body.unitType,
    fields: Object.entries(body.fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    legacy: body.useLegacyDefaultAvatar === true });
}

export function validateGarmentCodeBody(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GarmentCode body measurements must be an object.');
  const entries = Object.entries(value);
  if (entries.length > 100 || entries.some(([key, n]) => !/^[a-z][a-z_]*$/.test(key) || typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error('GarmentCode body measurements must contain finite numeric measurements.');
  }
  const body = Object.fromEntries(entries) as Record<string, number>;
  if (required.some(key => !(body[key] > 0 && body[key] <= 400)) || !(body.shoulder_incl >= 0 && body.shoulder_incl <= 90)) {
    throw new Error('GarmentCode body is missing supported height, head, torso or shoulder measurements.');
  }
  const neck = body.height - body.head_l;
  const waist = neck - body.waist_line;
  const hips = waist - body.hips_line;
  if (!(hips > 0 && waist > hips && neck > waist && body.height > neck)) {
    throw new Error('GarmentCode body landmark levels must form a physically supported ordering.');
  }
  if (body.arm_pose_angle !== undefined && !(body.arm_pose_angle >= 0 && body.arm_pose_angle <= 90)) {
    throw new Error('GarmentCode arm pose must be between 0 and 90 degrees.');
  }
  return body;
}

/** Sign after the caller has finished mapping fields and selecting gender/units. */
export function attachGarmentCodeBody(body: Body, measurements: unknown, legPose: 'straight' | 'apart' = 'straight'): Body {
  if (legPose !== 'straight' && legPose !== 'apart') throw new Error('Unsupported GarmentCode leg pose.');
  return { ...body, garmentCodeBody: { measurementsCm: validateGarmentCodeBody(measurements),
    avatarSignature: garmentCodeAvatarSignature(body), legPose } };
}

export function activeGarmentCodeBody(body: Body): Record<string, number> | null {
  const source = body.garmentCodeBody;
  if (!source || source.avatarSignature !== garmentCodeAvatarSignature(body)) return null;
  return validateGarmentCodeBody(source.measurementsCm);
}

type Knot = { source: number; target: number };
const smoothstep = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

function landmarks(vertices: Float32Array, indices: Uint32Array, model: BaseModel, name: string): [number, number, number][] {
  const definition = (model.measurements as MeasureSegmentDef[]).find(m => m.name === name);
  const points = definition?.coordinates?.map(a => anchorPoint(a, vertices, indices));
  if (!points?.length || points.some(p => !p || p.some(n => !Number.isFinite(n)))) throw new Error(`Cannot calibrate GarmentCode ${name} landmarks.`);
  return points as [number, number, number][];
}
const averageY = (points: [number, number, number][]) => points.reduce((sum, p) => sum + p[1], 0) / points.length;

/** Resolve separate horizontal contour components, then select the central torso.
 * Limb loops remain separate even where their heights overlap the waist or bust. */
function horizontalRings(vertices: Float32Array, indices: Uint32Array, height: number) {
  const cutHeight = height + 5e-8; // Avoid a cut passing exactly through an indexed vertex.
  const points: { x: number; z: number }[] = [];
  const parent: number[] = [];
  const nodes = new Map<string, number>();
  const segments: [number, number][] = [];
  const find = (node: number): number => {
    while (parent[node] !== node) { parent[node] = parent[parent[node]]; node = parent[node]; }
    return node;
  };
  for (let i = 0; i < indices.length; i += 3) {
    const triangle = [indices[i], indices[i + 1], indices[i + 2]], intersections: number[] = [];
    for (let edge = 0; edge < 3; edge++) {
      const ai = triangle[edge], bi = triangle[(edge + 1) % 3], a = ai * 3, b = bi * 3;
      const da = vertices[a + 1] - cutHeight, db = vertices[b + 1] - cutHeight;
      if ((da > 0) === (db > 0) || da === db) continue;
      const key = ai < bi ? `${ai}_${bi}` : `${bi}_${ai}`;
      let node = nodes.get(key);
      if (node === undefined) {
        const t = da / (da - db);
        node = points.length; nodes.set(key, node); parent.push(node);
        points.push({ x: vertices[a] + (vertices[b] - vertices[a]) * t,
          z: vertices[a + 2] + (vertices[b + 2] - vertices[a + 2]) * t });
      }
      intersections.push(node);
    }
    if (intersections.length === 2) {
      parent[find(intersections[0])] = find(intersections[1]);
      segments.push([intersections[0], intersections[1]]);
    }
  }
  const groups = new Map<number, typeof points>();
  for (let i = 0; i < points.length; i++) {
    const root = find(i), group = groups.get(root) ?? [];
    group.push(points[i]); groups.set(root, group);
  }
  const cross = (a: typeof points[0], b: typeof points[0], c: typeof points[0]) =>
    (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const half = (sequence: typeof points) => {
    const hull: typeof points = [];
    for (const p of sequence) {
      while (hull.length > 1 && cross(hull.at(-2)!, hull.at(-1)!, p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop(); return hull;
  };
  const perimeters = new Map<number, number>();
  const degree = new Uint16Array(points.length);
  for (const [ai, bi] of segments) {
    const a = points[ai], b = points[bi], root = find(ai);
    perimeters.set(root, (perimeters.get(root) ?? 0) + Math.hypot(a.x - b.x, a.z - b.z));
    degree[ai]++; degree[bi]++;
  }
  const open = new Set<number>();
  for (let i = 0; i < degree.length; i++) if (degree[i] !== 2) open.add(find(i));
  return [...groups.entries()].filter(([, group]) => group.length >= 3).map(([root, group]) => {
    group.sort((a, b) => a.x - b.x || a.z - b.z);
    const hull = [...half(group), ...half([...group].reverse())];
    let length = 0, area = 0, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      length += Math.hypot(b.x - a.x, b.z - a.z);
      area += a.x * b.z - b.x * a.z;
      minZ = Math.min(minZ, a.z); maxZ = Math.max(maxZ, a.z);
    }
    return { height, length, perimeter: perimeters.get(root) ?? 0, closed: !open.has(root),
      centerX: (group[0].x + group.at(-1)!.x) / 2, minX: group[0].x, maxX: group.at(-1)!.x,
      area: Math.abs(area), centerZ: (minZ + maxZ) / 2,
      central: group[0].x < 0 && group.at(-1)!.x > 0 };
  });
}

function torsoRing(vertices: Float32Array, indices: Uint32Array, height: number) {
  const candidates = horizontalRings(vertices, indices, height)
    .filter(candidate => candidate.central).sort((a, b) => b.area - a.area);
  if (!candidates.length) throw new Error('Cannot measure a connected GarmentCode torso cross-section.');
  return candidates[0];
}

export function measureGarmentCodeTorsoGirths(vertices: Float32Array, indices: Uint32Array, model: BaseModel): Record<string, number> {
  return Object.fromEntries([['bust', 'chestGirth'], ['waist', 'waistGirth'], ['hips', 'hipGirth']].map(([name, measurement]) =>
    [name, torsoRing(vertices, indices, averageY(landmarks(vertices, indices, model, measurement))).length * 100]));
}

function fitTorsoGirths(vertices: Float32Array, indices: Uint32Array, model: BaseModel, source: Record<string, number>, shoulderY: number, preserveArms = false) {
  const excluded = preserveArms ? new Set(['left_arm', 'left_lower_arm', 'right_arm', 'right_lower_arm'].flatMap(part => (model.bodyParts[part] ?? []).flatMap(face => [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]]))) : null;
  const names = [['hips', 'hipGirth'], ['waist', 'waistGirth'], ['bust', 'chestGirth']]
    .filter(([name]) => Number.isFinite(source[name]) && source[name] > 0);
  if (!names.length) return;
  for (let iteration = 0; iteration < 5; iteration++) {
    const rings = names.map(([name, measurement]) => ({ ...torsoRing(vertices, indices,
      averageY(landmarks(vertices, indices, model, measurement))), target: source[name] / 100 }));
    if (rings.every(ring => Math.abs(ring.target - ring.length) < 0.001)) return;
    const factors = rings.map(ring => ring.target / ring.length);
    if (factors.some(factor => !Number.isFinite(factor) || factor < 0.65 || factor > 1.5)) {
      throw new Error(`GarmentCode girths exceed the supported avatar calibration range (${rings.map((ring, index) =>
        `${names[index][0]} ${(ring.length * 100).toFixed(1)}→${(ring.target * 100).toFixed(1)} cm`).join(', ')}).`);
    }
    const profile = [
      { height: rings[0].height - 0.2, factor: 1, centerZ: rings[0].centerZ },
      ...rings.map((ring, index) => ({ height: ring.height, factor: factors[index], centerZ: ring.centerZ })),
      { height: shoulderY, factor: 1, centerZ: rings.at(-1)!.centerZ }
    ];
    if (profile.some((node, i) => i > 0 && node.height <= profile[i - 1].height)) throw new Error('Unsupported GarmentCode girth landmark ordering.');
    for (let i = 0; i < vertices.length; i += 3) {
      if (excluded?.has(i / 3)) continue;
      const y = vertices[i + 1];
      if (y <= profile[0].height || y >= profile.at(-1)!.height) continue;
      let segment = 0;
      while (segment < profile.length - 2 && y > profile[segment + 1].height) segment++;
      const a = profile[segment], b = profile[segment + 1];
      const weight = smoothstep((y - a.height) / (b.height - a.height));
      const factor = a.factor + (b.factor - a.factor) * weight;
      const centerZ = a.centerZ + (b.centerZ - a.centerZ) * weight;
      vertices[i] *= factor;
      vertices[i + 2] = centerZ + (vertices[i + 2] - centerZ) * factor;
    }
  }
  const actual = measureGarmentCodeTorsoGirths(vertices, indices, model);
  if (names.some(([name]) => Math.abs(actual[name] - source[name]) > 0.5)) {
    throw new Error('GarmentCode girth calibration did not converge within five millimetres.');
  }
}


/** Source arm_length is measured from the shoulder surface tip to the wrist,
 * rather than from the lower shoulder joint. Fit the axial limb span; preserve
 * radial dimensions and translate vertices past the wrist together with the hand. */
function fitArmSpans(vertices: Float32Array, indices: Uint32Array, model: BaseModel, source: Record<string, number>) {
  if (!(source.arm_length > 0) || !(source.arm_pose_angle >= 0 && source.arm_pose_angle <= 90)) return;
  for (let iteration = 0; iteration < 5; iteration++) {
  const joints = jointWorldPositions(createSkeleton(model, vertices), {});
  const shoulders = landmarks(vertices, indices, model, 'shoulderWidth');
  for (const side of ['Left', 'Right'] as const) {
    const sign = side === 'Left' ? 1 : -1;
    const tip = shoulders.reduce((a, b) => sign * a[0] > sign * b[0] ? a : b);
    const shoulder = joints.get(`mixamorig${side}Arm`), wrist = joints.get(`mixamorig${side}Hand`);
    if (!shoulder || !wrist) throw new Error('Cannot calibrate GarmentCode arm joints.');
    const angle = source.arm_pose_angle * Math.PI / 180, length = source.arm_length / 100;
    const target = [tip[0] + sign * Math.cos(angle) * length, tip[1] - Math.sin(angle) * length, wrist[2]];
    const axis = wrist.map((n, i) => n - shoulder[i]);
    const span = Math.hypot(...axis), targetSpan = Math.hypot(...target.map((n, i) => n - shoulder[i]));
    const scale = targetSpan / span;
    if (Math.abs(targetSpan - span) < 0.0001) continue;
    if (!Number.isFinite(scale) || scale < 0.7 || scale > 1.4) throw new Error('GarmentCode arm length exceeds the supported avatar calibration range.');
    const direction = axis.map(n => n / span);
    const part = side === 'Left' ? 'left' : 'right';
    const faces = [...(model.bodyParts[`${part}_arm`] ?? []), ...(model.bodyParts[`${part}_lower_arm`] ?? [])];
    const arm = new Set(faces.flatMap(face => [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]]));
    for (const vertex of arm) {
      const at = vertex * 3;
      const distance = direction.reduce((sum, n, i) => sum + (vertices[at + i] - shoulder[i]) * n, 0);
      const delta = (scale - 1) * Math.max(0, Math.min(span, distance));
      for (let i = 0; i < 3; i++) vertices[at + i] += direction[i] * delta;
    }
  }
  }
}

/** The pinned source's apart body abducts each leg by approximately four degrees:
 * paired source vertices move outward 55 mm at 10 cm and 27 mm at 50 cm, fading
 * to zero at the hips. Use that profile on our topology, keeping all Y/Z levels
 * and upper-body vertices unchanged. This approximates the pose, not source skin. */
function fitApartLegPose(vertices: Float32Array, indices: Uint32Array, model: BaseModel, source: Record<string, number>) {
  const hipY = averageY(landmarks(vertices, indices, model, 'hipGirth'));
  const proportion = source.height / 171.99;
  const pivotY = hipY + 0.03 * proportion;
  const fadeStart = hipY - 0.06 * proportion;
  const arms = new Set(['left_arm', 'left_lower_arm', 'right_arm', 'right_lower_arm']
    .flatMap(part => (model.bodyParts[part] ?? []).flatMap(face => [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]])));
  for (let at = 0; at < vertices.length; at += 3) {
    const y = vertices[at + 1], x = vertices[at];
    if (y >= hipY || arms.has(at / 3)) continue;
    const fade = 1 - smoothstep((y - fadeStart) / (hipY - fadeStart));
    // Preserve the central groin junction continuously instead of tearing it
    // into two sides. Below the groin, separate leg loops receive full movement.
    const side = Math.sign(x) * smoothstep(Math.abs(x) / (0.012 * proportion));
    vertices[at] += side * (pivotY - y) * Math.tan(4 * Math.PI / 180) * fade;
  }
}

/** Upper-thigh contours on this topology. Source leg_circ uses an isolated
 * horizontal ring near the groin with downward plane optimization. Our anchors
 * differ, so sample the largest closed loop within 30 mm below our crotch. */
function upperThighRings(vertices: Float32Array, indices: Uint32Array, model: BaseModel) {
  const crotchY = averageY(landmarks(vertices, indices, model, 'crotchHeight'));
  const candidates = Array.from({ length: 7 }, (_, i) => horizontalRings(vertices, indices, crotchY - 0.001 - i * 0.005)).flat();
  return [1, -1].map(sign => candidates.filter(ring => ring.closed && !ring.central && sign * ring.centerX > 0 &&
    Math.abs(ring.centerX) < 0.3 && ring.perimeter > 0.2 && ring.perimeter < 1.2)
    .sort((a, b) => b.perimeter - a.perimeter)[0]);
}

export function measureGarmentCodeUpperThighGirths(vertices: Float32Array, indices: Uint32Array, model: BaseModel): number[] {
  return upperThighRings(vertices, indices, model).map(ring => ring ? ring.perimeter * 100 : Number.NaN);
}

function calibrateUpperThighGirths(vertices: Float32Array, indices: Uint32Array, model: BaseModel, source: Record<string, number>) {
  if (!(source.leg_circ > 0) || !(model.measurements as MeasureSegmentDef[]).some(m => m.name === 'crotchHeight' && m.coordinates?.length)) return;
  const hipY = averageY(landmarks(vertices, indices, model, 'hipGirth'));
  const kneeJoints = jointWorldPositions(createSkeleton(model, vertices), {});
  for (let iteration = 0; iteration < 4; iteration++) {
    const rings = upperThighRings(vertices, indices, model);
    if (rings.some(ring => !ring)) return; // Missing/unsupported native landmarks retain their shape.
    if (rings.every(ring => Math.abs(ring!.perimeter - source.leg_circ / 100) < 0.001)) return;
    const factors = rings.map(ring => source.leg_circ / 100 / ring!.perimeter);
    const knees = ['Left', 'Right'].map(side => kneeJoints.get(`mixamorig${side}Leg`)?.[1]);
    if (factors.some(factor => !Number.isFinite(factor) || factor < 0.8 || factor > 1.25) ||
        knees.some((knee, side) => knee === undefined || !(knee < rings[side]!.height && rings[side]!.height < hipY))) return;
    for (let side = 0; side < 2; side++) {
      const ring = rings[side]!, sign = side === 0 ? 1 : -1;
      const factor = factors[side], kneeY = knees[side]!;
      const verticesInLeg = new Set((model.bodyParts[side === 0 ? 'left_leg' : 'right_leg'] ?? [])
        .flatMap(face => [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]]));
      for (const vertex of verticesInLeg) {
        const at = vertex * 3, y = vertices[at + 1];
        if (y <= kneeY || y >= hipY || sign * vertices[at] <= 0) continue;
        const weight = y < ring.height ? smoothstep((y - kneeY) / (ring.height - kneeY)) :
          1 - smoothstep((y - ring.height) / (hipY - ring.height));
        // Protect the central groin junction when two leg parts share vertices.
        const centerFade = smoothstep(Math.abs(vertices[at]) / 0.02);
        const scale = 1 + (factor - 1) * weight * centerFade;
        vertices[at] = ring.centerX + (vertices[at] - ring.centerX) * scale;
        vertices[at + 2] = ring.centerZ + (vertices[at + 2] - ring.centerZ) * scale;
      }
    }
  }
  // This is a bounded approximation; unsupported shapes retain a finite mesh.
  // Unlike torso girths, source/native groin planes are not equivalent anchors.
}

function fitUpperThighGirths(vertices: Float32Array, indices: Uint32Array, model: BaseModel, source: Record<string, number>) {
  if (!(source.leg_circ > 0)) return;
  const candidate = vertices.slice();
  calibrateUpperThighGirths(candidate, indices, model, source);
  // Shared groin vertices make very large radius changes unsafe. Commit only a
  // continuous, nonfolding deformation; retain the source stance otherwise.
  for (let at = 0; at < vertices.length; at += 3) {
    if (vertices[at] * candidate[at] < 0) return;
  }
  const normal = (points: Float32Array, at: number) => {
    const a = indices[at] * 3, b = indices[at + 1] * 3, c = indices[at + 2] * 3;
    const ux = points[b] - points[a], uy = points[b + 1] - points[a + 1], uz = points[b + 2] - points[a + 2];
    const vx = points[c] - points[a], vy = points[c + 1] - points[a + 1], vz = points[c + 2] - points[a + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  for (let at = 0; at < indices.length; at += 3) {
    const before = normal(vertices, at), after = normal(candidate, at);
    const lengths = Math.hypot(...before) * Math.hypot(...after);
    if (!(lengths > 1e-24) || before.reduce((sum, n, i) => sum + n * after[i], 0) / lengths < 0.25) return;
  }
  vertices.set(candidate);
}

/** Monotone cubic interpolation retains exact knot levels without sharp scale transitions. */
function verticalMap(knots: Knot[], endTangent?: number): (y: number) => number {
  const slopes = knots.slice(1).map((k, i) => (k.target - knots[i].target) / (k.source - knots[i].source));
  if (slopes.some(slope => !Number.isFinite(slope) || slope < 0.25 || slope > 4)) {
    throw new Error('GarmentCode body proportions exceed the supported avatar calibration range.');
  }
  const tangents = knots.map((_, i) => i === 0 ? slopes[0] : i === knots.length - 1 ? slopes.at(-1)! :
    2 * slopes[i - 1] * slopes[i] / (slopes[i - 1] + slopes[i]));
  if (endTangent !== undefined) tangents[tangents.length - 1] = endTangent;
  return y => {
    let i = 0;
    while (i < knots.length - 2 && y > knots[i + 1].source) i++;
    const a = knots[i], b = knots[i + 1], h = b.source - a.source;
    const t = Math.max(0, Math.min(1, (y - a.source) / h));
    return (2 * t ** 3 - 3 * t ** 2 + 1) * a.target + (t ** 3 - 2 * t ** 2 + t) * h * tangents[i]
      + (-2 * t ** 3 + 3 * t ** 2) * b.target + (t ** 3 - t ** 2) * h * tangents[i + 1];
  };
}

/** Explicit approximation of source dimensions on our existing body topology.
 * It aligns ground/crown, neck/waist/hip/crotch levels and shoulder tips; it does not reproduce
 * GarmentCode's original mesh. Available torso tape girths fit within five millimetres
 * in the rest shape; posing can change those girths. Extreme shoulder slopes retain
 * the model's shoulder profile. Explicit apart metadata approximates source leg
 * stance and bounded upper-thigh girths; unsupported lower-body targets retain
 * their existing profile. Native bodies pass through. */
export function fitGarmentCodeAvatar(vertices: Float32Array, indices: Uint32Array, model: BaseModel, body: Body): Float32Array {
  const source = activeGarmentCodeBody(body);
  if (!source) return vertices;
  const anchors = (name: string) => landmarks(vertices, indices, model, name);
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < vertices.length; i += 3) { minY = Math.min(minY, vertices[i]); maxY = Math.max(maxY, vertices[i]); }
  const shoulders = anchors('shoulderWidth');
  const left = shoulders.reduce((a, b) => a[0] > b[0] ? a : b);
  const right = shoulders.reduce((a, b) => a[0] < b[0] ? a : b);
  const shoulderY = (left[1] + right[1]) / 2;
  const neckY = averageY(anchors('neckGirth'));
  const waistY = averageY(anchors('waistGirth'));
  const neckTarget = (source.height - source.head_l) / 100;
  const waistTarget = neckTarget - source.waist_line / 100;
  const shoulderTarget = neckTarget - Math.tan(source.shoulder_incl * Math.PI / 180) * source.shoulder_w / 200;
  const knots: Knot[] = [
    { source: minY, target: 0 },
    { source: averageY(anchors('hipGirth')), target: waistTarget - source.hips_line / 100 },
    { source: waistY, target: waistTarget },
    { source: neckY, target: neckTarget },
    { source: maxY, target: source.height / 100 }
  ];
  // Python supports horizontal and very steep shoulders. Collapsing or reversing the
  // neck/shoulder region would damage the avatar, so those cases retain its shoulder shape.
  if (shoulderTarget > waistTarget && shoulderTarget < neckTarget) {
    knots.splice(3, 0, { source: shoulderY, target: shoulderTarget });
  }
  if (source.bust_line > 0) {
    const bustLine = source.vert_bust_line > 0 ? (2 * source.vert_bust_line + source.bust_line) / 3 : source.bust_line;
    const bustTarget = neckTarget - bustLine / 100;
    if (bustTarget > waistTarget && bustTarget < neckTarget && bustTarget < (shoulderTarget > waistTarget ? shoulderTarget : neckTarget)) {
      knots.splice(3, 0, { source: averageY(anchors('chestGirth')), target: bustTarget });
    }
  }
  if (knots.some((k, i) => !Number.isFinite(k.source) || (i > 0 && k.source <= knots[i - 1].source + 1e-5))) {
    throw new Error('Avatar landmarks do not support GarmentCode body calibration.');
  }
  // Source shoulder_incl is the angle from the lateral neck surface to the
  // shoulder surface against the horizontal XZ plane. head_l ends at the nape;
  // neck_w is a back-neck trace length, so neither supplies a neck X origin.
  const neckSideDefinition = (model.measurements as MeasureSegmentDef[]).find(m => m.name === 'neckSideToShoulder');
  const neckSide = neckSideDefinition?.coordinates?.[0] && anchorPoint(neckSideDefinition.coordinates[0], vertices, indices);
  const shoulderKnot = knots.find(knot => Math.abs(knot.source - shoulderY) < 1e-8);
  if (shoulderKnot && neckSide?.every(Number.isFinite) && neckSide[1] > shoulderY && source.shoulder_incl > 0 && source.shoulder_incl < 80) {
    const widthRatio = source.shoulder_w / 100 / (left[0] - right[0]);
    const widthScale = Math.max(0.5, Math.min(2, widthRatio));
    const weight = neckSide[1] <= shoulderY ? smoothstep((neckSide[1] - waistY) / (shoulderY - waistY)) :
      1 - smoothstep((neckSide[1] - shoulderY) / (neckY - shoulderY));
    const neckX = neckSide[0] * (1 + (widthScale - 1) * weight);
    const tip = neckSide[0] < 0 ? right : left;
    const horizontalSpan = Math.hypot(tip[0] * widthScale - neckX, tip[2] - neckSide[2]);
    if (horizontalSpan > 0 && Number.isFinite(horizontalSpan)) {
      // The neck-side Y itself depends on the monotone shoulder/neck profile.
      // Solve that dependency without changing the nape, torso or crown knots.
      for (let iteration = 0; iteration < 12; iteration++) {
        try {
          const profile = verticalMap(knots);
          const target = profile(neckSide[1]) - Math.tan(source.shoulder_incl * Math.PI / 180) * horizontalSpan;
          if (!(target > waistTarget && target < neckTarget)) break;
          verticalMap(knots.map(knot => knot === shoulderKnot ? { ...knot, target } : knot));
          shoulderKnot.target = target;
        } catch { break; } // Missing/unsupported anatomical proportions retain the prior profile.
      }
    }
  }
  let mapY: (y: number) => number;
  try { mapY = verticalMap(knots); }
  catch {
    // Extreme but legal drafting requests remain importable: preserve topology with
    // a uniform vertical fit rather than forcing incompatible anatomical levels.
    mapY = y => (y - minY) / (maxY - minY) * source.height / 100;
  }
  let lowerBodyMap: ((y: number) => number) | null = null;
  // Source crotch depth is measured down from the hip line. Fit only below
  // that line, preserving the existing torso/arm map and its hip derivative.
  // Unsupported depth/anchors leave the native lower-body profile unchanged.
  const crotchDefinition = (model.measurements as MeasureSegmentDef[]).find(m => m.name === 'crotchHeight');
  const crotchPoints = crotchDefinition?.coordinates?.map(a => anchorPoint(a, vertices, indices));
  if (source.crotch_hip_diff > 0 && crotchPoints?.length && crotchPoints.every(p => p && p.every(Number.isFinite))) {
    const crotchY = averageY(crotchPoints as [number, number, number][]);
    const hip = knots[1], crotchTarget = hip.target - source.crotch_hip_diff / 100;
    const lowerSlope = crotchTarget / (crotchY - minY);
    const upperSlope = (hip.target - crotchTarget) / (hip.source - crotchY);
    const epsilon = 1e-6;
    const hipTangent = (mapY(hip.source + epsilon) - mapY(hip.source - epsilon)) / (2 * epsilon);
    if (crotchY > minY + 1e-5 && crotchY < hip.source - 1e-5 && crotchTarget > 0 && crotchTarget < hip.target &&
        lowerSlope >= 0.25 && lowerSlope <= 4 && upperSlope >= 0.25 && upperSlope <= 4 &&
        hipTangent > 0 && hipTangent <= 3 * upperSlope && Math.abs(mapY(hip.source) - hip.target) < 1e-6) {
      const lowerMap = verticalMap([{ source: minY, target: 0 }, { source: crotchY, target: crotchTarget }, hip], hipTangent);
      lowerBodyMap = y => y < hip.source ? lowerMap(y) : mapY(y);
    }
  }
  const widthRatio = source.shoulder_w / 100 / (left[0] - right[0]);
  if (!Number.isFinite(widthRatio)) throw new Error('Cannot calibrate GarmentCode shoulder width.');
  const widthScale = Math.max(0.5, Math.min(2, widthRatio));
  const fitted = vertices.slice();
  // Resting hands/forearms overlap lower-body heights but are not pelvis landmarks.
  const armVertices = lowerBodyMap ? new Set(['left_arm', 'left_lower_arm', 'right_arm', 'right_lower_arm']
    .flatMap(part => (model.bodyParts[part] ?? []).flatMap(face => [indices[face * 3], indices[face * 3 + 1], indices[face * 3 + 2]]))) : null;
  for (let i = 0; i < fitted.length; i += 3) {
    const y = vertices[i + 1];
    const weight = y <= shoulderY ? smoothstep((y - waistY) / (shoulderY - waistY)) :
      1 - smoothstep((y - shoulderY) / (neckY - shoulderY));
    fitted[i] *= 1 + (widthScale - 1) * weight;
    fitted[i + 1] = lowerBodyMap && !armVertices!.has(i / 3) ? lowerBodyMap(y) : mapY(y);
  }
  fitTorsoGirths(fitted, indices, model, source, mapY(shoulderY));
  fitArmSpans(fitted, indices, model, source);
  if (body.garmentCodeBody?.legPose === 'apart') {
    fitApartLegPose(fitted, indices, model, source);
    fitUpperThighGirths(fitted, indices, model, source);
  }
  return fitted;
}

/** Candidate feedback uses true posed central tape rings; its radial operation
 * excludes limbs and does not alter source measurements or the requested skin. */
export function refitSourcePosedTorsoGirths(vertices: Float32Array, indices: Uint32Array, model: BaseModel, source: Record<string, number>, posed: Record<string, number>): void {
  const rest = measureGarmentCodeTorsoGirths(vertices, indices, model);
  const adjusted = { ...source };
  for (const key of ['bust', 'waist', 'hips']) adjusted[key] = rest[key] * source[key] / posed[key];
  const shoulderY = averageY(landmarks(vertices, indices, model, 'shoulderWidth'));
  fitTorsoGirths(vertices, indices, model, adjusted, shoulderY, true);
}
