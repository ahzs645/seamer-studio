/** Import the explicit panel/edge/stitch schema used by GarmentCode and NeuralTailor.
 * Source parameters are provenance: importing does not recreate Python drafting logic. */
import { createEmptyPattern, type Pattern, type Piece, type ConstrainablePath, type BezierHandle, type Material } from '@seamer/pattern-model';
import { arcAnchors } from '@seamer/pattern-model/utils/arcGeometry';
import { indexPoints, pathSegments, pieceOutline } from '@seamer/pattern-model/utils/patternGeometry';
import { garmentCodeWorldMatrix } from '@seamer/cloth-sim';
import { attachGarmentCodeBody, validateGarmentCodeBody } from '@seamer/avatar';

type XY = [number, number];
type XYZ = [number, number, number];
type RecordValue = Record<string, unknown>;
export interface GarmentCodeFile {
  pattern: { panels: Record<string, unknown>; stitches?: unknown[] };
  properties?: RecordValue;
  parameters?: unknown;
  parameter_order?: unknown;
  constraints?: unknown;
  constraint_order?: unknown;
  name?: string;
}

/** Structural detection deliberately leaves detailed validation to the converter. */
export function isGarmentCodeFormat(value: unknown): value is GarmentCodeFile {
  if (!object(value) || !object(value.pattern)) return false;
  return object(value.pattern.panels);
}

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(message: string): never { throw new Error(`Invalid GarmentCode pattern: ${message}`); }
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number.`);
  return value;
}
function vector(value: unknown, size: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== size) fail(`${label} must contain ${size} coordinates.`);
  return value.map((item, index) => finite(item, `${label}[${index}]`));
}
function handle(v1: XY, v2: XY): BezierHandle {
  return { v1: { x: v1[0], y: v1[1] }, v2: { x: v2[0], y: v2[1] }, sameLength: false, sameAngle: false,
    lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' } };
}
function slot(color: string): Material['frontTexture'] {
  return { url: '', mediaId: null, color, scale: 100, normalUrl: '', normalMediaId: null, normalMapScale: 100,
    opacityUrl: '', opacityMediaId: null, opacityMapScale: 100 };
}

interface ValidPanel {
  name: string;
  label?: string;
  vertices: XY[];
  edges: RecordValue[];
  endpoints: [number, number][];
  translation: XYZ;
  rotation: XYZ;
}

/** Source-local XY remains y-up; the 2D layout is only a translation in millimetres.
 * Source-placement metadata removes that offset before applying the source rigid transform. */
export function convertGarmentCodePattern(value: unknown, name = 'Imported GarmentCode garment'): Pattern {
  if (!isGarmentCodeFormat(value)) fail('expected pattern.panels.');
  const properties = value.properties ?? {};
  if (!object(properties)) fail('properties must be an object.');
  const units = finite(properties.units_in_meter, 'properties.units_in_meter');
  if (units <= 0) fail('units_in_meter must be positive.');
  const scale = 1000 / units;
  if (!Number.isFinite(scale)) fail('units_in_meter is too small.');
  const curvatureCoords = properties.curvature_coords ?? 'relative';
  if (curvatureCoords !== 'relative' && curvatureCoords !== 'absolute') fail('unsupported curvature_coords.');
  if (properties.normalize_panel_translation === true) {
    fail('normalize_panel_translation=true requires upstream normalization before import.');
  }
  const entries = Object.entries(value.pattern.panels);
  if (entries.length === 0 || entries.length > 500) fail('expected between 1 and 500 panels.');
  let totalVertices = 0;
  const panels: ValidPanel[] = entries.map(([panelName, raw]) => {
    if (!panelName.trim() || !object(raw)) fail('each panel needs a name and an object.');
    if (!Array.isArray(raw.vertices) || raw.vertices.length < 3) fail(`panel ${panelName} needs at least three vertices.`);
    totalVertices += raw.vertices.length;
    if (totalVertices > 100000) fail('too many panel vertices.');
    const vertices = raw.vertices.map((v, i) => vector(v, 2, `${panelName}.vertices[${i}]`).map((n) => finite(n * scale, `${panelName} scaled coordinate`)) as XY);
    if (!Array.isArray(raw.edges) || raw.edges.length < 3 || raw.edges.length > 10000) fail(`panel ${panelName} needs a closed edge loop.`);
    const edges = raw.edges.map((edge) => { if (!object(edge)) fail(`invalid edge in ${panelName}.`); return edge; });
    const endpoints = edges.map((edge, i) => {
      const ends = vector(edge.endpoints, 2, `${panelName}.edges[${i}].endpoints`);
      if (ends.some((n) => !Number.isInteger(n) || n < 0 || n >= vertices.length) || ends[0] === ends[1]) fail(`invalid vertex reference in ${panelName} edge ${i}.`);
      const a = vertices[ends[0]], b = vertices[ends[1]];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-7) fail(`zero-length edge in ${panelName} edge ${i}.`);
      return ends as [number, number];
    });
    if (endpoints.some((ends, i) => ends[1] !== endpoints[(i + 1) % endpoints.length][0])) fail(`panel ${panelName} edges do not form an ordered closed boundary.`);
    const translation = vector(raw.translation ?? [0, 0, 0], 3, `${panelName}.translation`).map((n) => finite(n / units, `${panelName} scaled translation`)) as XYZ;
    const rotation = vector(raw.rotation ?? [0, 0, 0], 3, `${panelName}.rotation`) as XYZ;
    if (raw.label !== undefined && raw.label !== null && (typeof raw.label !== 'string' || raw.label.length > 500)) fail(`invalid panel label in ${panelName}.`);
    return { name: panelName, label: typeof raw.label === 'string' ? raw.label : undefined, vertices, edges, endpoints, translation, rotation };
  });
  const pattern = createEmptyPattern();
  pattern.name = typeof value.name === 'string' && value.name.trim() ? value.name : name;
  pattern.description = 'Imported GarmentCode panel geometry and explicit stitches. Source parameters are retained as provenance, without a live drafting link.';
  pattern.lengthUnit = 'mm';
  pattern.viewMode = 'both';
  pattern.enable3d = true;
  pattern.showConstruction = false;
  pattern.graphicsScale = 0.3;
  pattern.materials = [{ id: 'GarmentCodeFabric', name: 'GarmentCode fabric', frontTexture: slot('#6696ac'), backTexture: slot('#6696ac'),
    useSeparateBackSide: false, stretchWarpValue: 12, stretchWeftValue: 14, bendValue: 5, thickness: 0.5, weight: 150,
    roughness: 0.85, metalness: 0, specularIntensity: 0.2, opacity: 1, normalScale: 1, alphaCutoff: 0,
    libraryItemId: null, libraryVersion: null, libraryUpdatedAt: null }];
  pattern.garmentCodeSource = { format: 'garmentcode-json', unitsInMeter: units, properties: structuredClone(properties),
    parameters: structuredClone(value.parameters), parameterOrder: structuredClone(value.parameter_order),
    constraints: structuredClone(value.constraints), constraintOrder: structuredClone(value.constraint_order), panelNames: panels.map((p) => p.name) };
  if (properties.garmentcode_body !== undefined) {
    let measurements: Record<string, number>;
    try { measurements = validateGarmentCodeBody(properties.garmentcode_body); }
    catch (error) { fail(error instanceof Error ? error.message : 'invalid GarmentCode body measurements.'); }
    const fields: Record<string, number> = { age: 35, weight: 150 * 0.453592 };
    const mappings = { height: 'height', bust: 'chestGirth', waist: 'waistGirth', hips: 'hipGirth', arm_length: 'armLength' };
    for (const [key, target] of Object.entries(mappings)) {
      if (Number.isFinite(measurements[key])) fields[target] = measurements[key];
    }
    const legPose = properties.garmentcode_body_pose;
    if (legPose !== undefined && legPose !== 'straight' && legPose !== 'apart') fail('unsupported source body pose.');
    pattern.body = attachGarmentCodeBody({ ...pattern.body, fields, unitType: 'metric', useLegacyDefaultAvatar: false }, measurements, legPose ?? 'straight');
  }
  const pathIds = new Map<string, string[]>();
  const columns = Math.ceil(Math.sqrt(panels.length));
  const cellWidth = Math.max(...panels.map((p) => Math.max(...p.vertices.map((v) => v[0])) - Math.min(...p.vertices.map((v) => v[0])))) + 100;
  const cellHeight = Math.max(...panels.map((p) => Math.max(...p.vertices.map((v) => v[1])) - Math.min(...p.vertices.map((v) => v[1])))) + 100;
  panels.forEach((panel, pi) => {
    const ox = 50 + pi % columns * cellWidth - Math.min(...panel.vertices.map((v) => v[0]));
    const oy = 50 + Math.floor(pi / columns) * cellHeight - Math.min(...panel.vertices.map((v) => v[1]));
    finite(ox, `${panel.name} layout offset`); finite(oy, `${panel.name} layout offset`);
    const pointId = (vi: number) => `GC_P${pi}_V${vi}`;
    panel.vertices.forEach((v, vi) => pattern.points.push({ id: pointId(vi), name: `${panel.name} ${vi}`, x: v[0] + ox, y: v[1] + oy }));
    const originId = `GC_P${pi}_Origin`;
    pattern.points.push({ id: originId, name: '', x: ox, y: oy });
    const piece: Piece = {
      id: `GC_Piece${pi}`, name: panel.name, label: panel.label, type: 'dynamic', materialId: 'GarmentCodeFabric',
      origin: { id: `GC_O${pi}`, name: '', x: ox, y: oy }, originPoint: originId, position: { x: ox, y: oy }, rotation: 0,
      grainVector: { id: `GC_G${pi}`, name: '', x: 0, y: 1 }, text: null, rightPieces: 1, leftPieces: 0, mirrorLeftPiecesAxis: 'X',
      mirrorX: false, mirrorY: false, seamAllowanceInside: false, seamAllowance: 0, mainPaths: [], internalPaths: [],
      settings3d: { enable3d: true, frozen: false, flipNormals: false, filterExternalCollisionsByClothNormal: false, collisionLayer: 0,
        particleDistance: 15, savedPositions: [], savedDrapeState: 'checkpoint', arrangement: { mode: 'flat', cylinderName: 'Torso', uDegrees: 0, v: 0.5,
          uOffsetMm: 0, vOffsetMm: 0, radialOffsetMm: 0, use2DPosition: false, positionChanged: false,
          matrixWorld: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], position: [0,0,0],
          sourcePlacement: { worldMatrix: garmentCodeWorldMatrix(panel.rotation, panel.translation), layoutOffsetMm: { x: ox, y: oy } } } }
    };
    const ppIds: string[] = [];
    panel.edges.forEach((edge, ei) => {
      const [ai, bi] = panel.endpoints[ei];
      const a: XY = [panel.vertices[ai][0] + ox, panel.vertices[ai][1] + oy];
      const b: XY = [panel.vertices[bi][0] + ox, panel.vertices[bi][1] + oy];
      const path: ConstrainablePath = { id: `GC_Path${pi}_${ei}`, name: `${panel.name} edge ${ei}`, pathType: 'line',
        pathPoints: [{ id: pointId(ai) }, { id: pointId(bi) }], basePoint: pointId(ai), version: 1 };
      if (edge.curvature !== undefined && edge.curvature !== null) {
        const curve = edge.curvature;
        let type: string, params: unknown;
        if (Array.isArray(curve)) { type = 'quadratic'; params = [curve]; }
        else if (object(curve) && typeof curve.type === 'string') { type = curve.type; params = curve.params; }
        else fail(`invalid curvature in ${panel.name} edge ${ei}.`);
        if (!Array.isArray(params)) fail(`invalid curve parameters in ${panel.name} edge ${ei}.`);
        if (type === 'quadratic' || type === 'cubic') {
          if (params.length !== (type === 'quadratic' ? 1 : 2)) fail(`invalid ${type} control count in ${panel.name} edge ${ei}.`);
          const cps = params.map((p) => {
            const [u, v] = vector(p, 2, `${panel.name} edge ${ei} control`);
            return curvatureCoords === 'relative'
              ? [a[0] + u * (b[0] - a[0]) - v * (b[1] - a[1]), a[1] + u * (b[1] - a[1]) + v * (b[0] - a[0])] as XY
              : [u * scale + ox, v * scale + oy] as XY;
          });
          const c1 = type === 'quadratic' ? [a[0] + 2 / 3 * (cps[0][0] - a[0]), a[1] + 2 / 3 * (cps[0][1] - a[1])] : cps[0];
          const c2 = type === 'quadratic' ? [b[0] + 2 / 3 * (cps[0][0] - b[0]), b[1] + 2 / 3 * (cps[0][1] - b[1])] : cps[1];
          path.pathType = 'curve';
          path.pathPoints[0].handle = handle([0, 0], [c1[0] - a[0], c1[1] - a[1]]);
          path.pathPoints[1].handle = handle([c2[0] - b[0], c2[1] - b[1]], [0, 0]);
        } else if (type === 'circle') {
          const [sourceRadius, largeArc, sweep] = vector(params, 3, `${panel.name} edge ${ei} arc`);
          if (sourceRadius <= 0 || ![0,1].includes(largeArc) || ![0,1].includes(sweep)) fail(`invalid circle radius/flags in ${panel.name} edge ${ei}.`);
          const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
          // SVG endpoint arcs enlarge undersized radii to half the chord.
          const r = Math.max(finite(sourceRadius * scale, `${panel.name} scaled arc radius`), chord / 2);
          const height = Math.sqrt(Math.max(0, r * r - chord * chord / 4));
          const sign = largeArc === sweep ? -1 : 1;
          const cx = finite((a[0] + b[0]) / 2 - sign * height * (b[1] - a[1]) / chord, `${panel.name} arc center x`);
          const cy = finite((a[1] + b[1]) / 2 + sign * height * (b[0] - a[0]) / chord, `${panel.name} arc center y`);
          const a0 = Math.atan2(a[1] - cy, a[0] - cx);
          let delta = Math.atan2(b[1] - cy, b[0] - cx) - a0;
          if (sweep && delta < 0) delta += 2 * Math.PI;
          if (!sweep && delta > 0) delta -= 2 * Math.PI;
          const anchors = arcAnchors({ x: cx, y: cy }, r, a0, a0 + delta);
          path.pathType = 'curve';
          path.arc = { kind: 'centerArc', centerId: null, cx, cy, r, a0, a1: a0 + delta, closed: false };
          path.pathPoints = anchors.map((anchor, index) => {
            const id = index === 0 ? pointId(ai) : index === anchors.length - 1 ? pointId(bi) : `GC_P${pi}_E${ei}_A${index}`;
            if (index > 0 && index < anchors.length - 1) pattern.points.push({ id, name: '', ...anchor.pos });
            return { id, handle: handle([anchor.v1.x, anchor.v1.y], [anchor.v2.x, anchor.v2.y]) };
          });
        } else fail(`unsupported curve type ${type} in ${panel.name} edge ${ei}.`);
      }
      for (const pp of path.pathPoints) {
        if (pp.handle) for (const control of [pp.handle.v1, pp.handle.v2]) { finite(control.x, `${panel.name} curve x`); finite(control.y, `${panel.name} curve y`); }
      }
      pattern.paths.push(path);
      const id = `GC_PP${pi}_${ei}`;
      ppIds.push(id);
      piece.mainPaths.push({ id, name: typeof edge.label === 'string' ? edge.label : '', path: path.id, from: pointId(ai), to: pointId(bi), reversed: false, notches: [] });
    });
    pathIds.set(panel.name, ppIds);
    pattern.pieces.push(piece);
  });
  // GarmentCode derives each outward normal from its directed boundary. Native cloth rendering
  // uses inward-facing triangle winding, so clockwise source panels must flip their outside flag.
  // This also preserves the source direction for collision sidedness and front/back labels.
  const pointIndex = indexPoints(pattern);
  const pathIndex = new Map(pattern.paths.map((path) => [path.id, path]));
  for (const piece of pattern.pieces) {
    const outline = pieceOutline(pattern, piece, pathIndex, pointIndex, 4);
    const twiceArea = outline.reduce((area, a, index) => {
      const b = outline[(index + 1) % outline.length];
      return area + a.x * b.y - b.x * a.y;
    }, 0);
    piece.settings3d.flipNormals = twiceArea < 0;
  }
  const stitches = value.pattern.stitches ?? [];
  if (!Array.isArray(stitches) || stitches.length > 100000) fail('stitches must be an array.');
  const used = new Set<string>();
  pattern.seams = stitches.map((raw, index) => {
    if (!Array.isArray(raw) || (raw.length !== 2 && raw.length !== 3) || (raw.length === 3 && raw[2] !== 'right_wrong')) fail(`stitch ${index} needs two edge references and optional right_wrong.`);
    const refs = raw.slice(0, 2).map((ref) => {
      if (!object(ref) || typeof ref.panel !== 'string' || typeof ref.edge !== 'number' || !Number.isInteger(ref.edge)) fail(`invalid reference in stitch ${index}.`);
      const id = pathIds.get(ref.panel)?.[ref.edge];
      if (!id) fail(`stitch ${index} references missing panel/edge ${ref.panel}:${ref.edge}.`);
      if (used.has(id)) fail(`edge ${ref.panel}:${ref.edge} is stitched more than once.`);
      used.add(id);
      return { id, mirrored: false, reversed: false };
    });
    refs[1].reversed = raw[2] !== 'right_wrong';
    return { id: `GC_Seam${index}`, name: `Stitch ${index + 1}`, explicitOrientation: true, fromPaths: [refs[0]], toPaths: [refs[1]] };
  });
  frameSourceGarment(pattern);
  return pattern;
}

/** Conservative camera framing from transformed cubic control hulls. This includes a neutral
 * avatar-sized envelope so short garments are shown in context. A narrow desktop split pane
 * (aspect 0.65) determines the fit; ordinary mobile panes have more horizontal room. */
function frameSourceGarment(pattern: Pattern): void {
  pattern.settings3d.sourceCameraFraming = 'viewport';
  const min = [-0.35, 0, -0.25], max = [0.35, 1.9, 0.25];
  const points = indexPoints(pattern);
  const paths = new Map(pattern.paths.map((path) => [path.id, path]));
  for (const piece of pattern.pieces) {
    const source = piece.settings3d.arrangement.sourcePlacement!;
    const m = source.worldMatrix, offset = source.layoutOffsetMm;
    for (const pp of piece.mainPaths) {
      for (const segment of pathSegments(paths.get(pp.path)!, points)) {
        for (const control of [segment.a, segment.c1, segment.c2, segment.b]) {
          const x = (control.x - offset.x) / 1000, y = (control.y - offset.y) / 1000;
          const world = [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13], m[2] * x + m[6] * y + m[14]];
          for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], world[axis]); max[axis] = Math.max(max[axis], world[axis]); }
        }
      }
    }
  }
  const target = min.map((v, axis) => (v + max[axis]) / 2) as XYZ;
  const radius = Math.hypot(...min.map((v, axis) => (max[axis] - v) / 2));
  const halfAngle = Math.atan(Math.tan(pattern.settings3d.cameraFov * Math.PI / 360) * 0.65);
  const distance = Math.max(1.5, radius * 1.08 / Math.sin(halfAngle));
  pattern.settings3d.controlsTarget = target;
  pattern.settings3d.cameraPosition = [target[0] + distance * 0.18, target[1] + distance * 0.08, target[2] + distance * Math.sqrt(1 - 0.18 ** 2 - 0.08 ** 2)];
}
