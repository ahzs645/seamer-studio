// Seamer pattern schema — realigned to the original application's data model.
// All 2D coordinates are in millimeters; the 3D renderer divides by 1000 to get meters.
// This file is the single source of truth consumed by the 2D canvas, the panels and the
// 3D renderer (avatar reconstruction, arrangement, triangulation and cloth simulation).

export interface Formula {
  formula: string;
  unit: 'inch' | 'cm' | 'mm' | 'degrees' | 'radians' | string;
}

/**
 * Optional parametric construction for a point. When present the solver computes the point's
 * position from formulas (referencing variables + body measurements); otherwise x/y are fixed.
 * Formula strings are evaluated in mm/degrees.
 */
export type PointConstraint =
  | { type: 'offset'; from: string; dxFormula: string; dyFormula: string; unit?: string }
  | { type: 'lengthAngle'; from: string; lengthFormula: string; angleFormula: string; lengthUnit?: string; angleUnit?: string }
  // sliding: a point ON a path, by a distance formula from an anchor, or by a fixed arc-length fraction
  | { type: 'sliding'; path: string; positionFormula?: string; from?: string; unit?: string; fraction?: number }
  // mirror: a point reflected across the line defined by `axisPath`'s endpoints (referenced/mirror copies)
  | { type: 'mirror'; source: string; axisPath: string }
  // intersection: a point at the crossing of two rays, each from an anchor at a formula-driven angle
  // (the source draws direction-only paths — basePoint + angle, no length — that meet at this point)
  | { type: 'intersection'; a: string; aAngleFormula: string; b: string; bAngleFormula: string; aAngleUnit?: string; bAngleUnit?: string };

export interface ConstrainablePoint {
  id: string;
  name: string;
  x: number; // millimeters (solved value, or fixed when no constraint)
  y: number; // millimeters
  constraint?: PointConstraint; // parametric construction (optional)
  layerId?: string; // layer membership (defaults to the 'default' layer)
}

/** A 2D vector used for grain direction / piece origin (carries an id+name in the data). */
export interface NamedVector {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface Variable {
  id: string; // e.g. "var_89ti3xo9e"
  name: string; // human name, e.g. "waist_width"
  description?: string; // optional notes about how the variable is used
  type: 'number' | 'boolean' | 'enum' | 'string' | 'length' | 'angle' | string;
  value: number | null; // cached resolved value (null = recompute from formula)
  valueFormula: Formula;
  isEditable: boolean;
  isVisible: boolean;
  options: unknown[];
  unitType: string;
  overrideValue?: string | number | null; // transient: enum option / value forced by a loaded grade anchor
}

/** Cubic Bézier control tangents stored on a curve path point (offsets in mm, relative to anchor). */
export interface BezierHandle {
  v1: { x: number; y: number }; // incoming control offset
  v2: { x: number; y: number }; // outgoing control offset
  sameLength: boolean;
  sameAngle: boolean;
  lengthFormula: Formula;
  angleFormula: Formula;
}

export interface PathPoint {
  id: string; // ConstrainablePoint id
  handle?: BezierHandle;
}

export interface SlidingPoint {
  id: string; // ConstrainablePoint id (its resolved x/y is stored in points[])
  positionFormula?: Formula;
  positionType?: 'along' | string;
  positionFrom?: string; // ConstrainablePoint id the offset is measured from
}

export interface ConstrainablePath {
  id: string;
  name: string;
  layerId?: string; // layer membership (defaults to the 'default' layer)
  pathType: 'line' | 'curve' | 'referenced' | string;
  pathPoints: PathPoint[];
  slidingPoints?: SlidingPoint[];
  basePoint?: string | null;
  version: number;
  lengthFormula?: Formula;
  angleFormula?: Formula;
  // referenced-path only:
  referencedPath?: string;
  referencedFromPoint?: string;
  referencedToPoint?: string;
  mirrorX?: boolean;
  mirrorY?: boolean;
  mirrorLine?: string;
  // parametric-arc metadata kept by the arc/circle tools so radius/angles stay editable after the
  // curve is baked. `centerId` (when set) ties the arc to a live construction point; re-baking
  // rewrites this path's anchor positions/handles in place (point ids are preserved).
  arc?: ArcParams;
}

/** Parametric definition of a baked arc/circle/ellipse path (angles in radians, CCW positive).
 *  True ellipses carry rx/ry (+ rotation); `r` remains for circles and as the legacy radius. */
export interface ArcParams {
  kind: 'circle' | 'centerArc' | 'threePointArc';
  centerId?: string | null;
  cx: number;
  cy: number;
  r: number;
  rx?: number; // ellipse: x radius (defaults to r)
  ry?: number; // ellipse: y radius (defaults to r)
  rotation?: number; // ellipse axis rotation, radians (default 0)
  a0: number;
  a1: number;
  closed: boolean;
}

export type NotchType = 'single' | 'double' | 'slit' | 'tee';
export interface Notch {
  id?: string;
  position?: number;
  size?: number;
  type?: NotchType; // 'double'/'tee' read as balance notches
  // Anchored placement (the original's "Distance from point"): when set, the notch sits `distance`
  // mm along the edge from the referenced endpoint (must be the edge's from/to point) and the
  // parametric `position` is ignored.
  referencePointId?: string;
  distance?: number; // mm from the reference point along the edge
  distanceFormula?: PropertyFormula; // formula-driven distance (the original's notchLengthFormula)
  [k: string]: unknown;
}

/**
 * How the seam-allowance corner at the *end* of a boundary edge is finished where it meets the
 * neighbouring edge (the original's full corner vocabulary, Seamly/Valentina lineage):
 *  - 'intersection' (default): extend both allowance offsets until they cross, capped at maxLength
 *  - 'radius': round the corner with the given radius
 *  - 'byLength': cut the corner square at a fixed distance from the seam line
 *  - 'noJoin': no corner material — the allowance pinches back to the true corner point
 *  - 'firstEdgeSymmetry' / 'secondEdgeSymmetry': cut along the first/second original edge
 *    mirrored across the opposite offset edge (fold-back matching corners)
 *  - 'firstEdgeRightAngle' / 'secondEdgeRightAngle': cut perpendicular to the first/second edge
 *    through the true corner (square hem corners)
 */
export type SeamCornerJoinType =
  | 'intersection'
  | 'radius'
  | 'byLength'
  | 'noJoin'
  | 'firstEdgeSymmetry'
  | 'secondEdgeSymmetry'
  | 'firstEdgeRightAngle'
  | 'secondEdgeRightAngle';

/** A formula-driven numeric property (the original's *Formula fields): empty formula = inactive,
 *  the plain numeric field applies. Lengths evaluate in `unit` (default mm); angles in degrees. */
export interface PropertyFormula {
  formula: string;
  unit?: 'mm' | 'cm' | 'inch' | 'degrees' | 'none' | string;
}

/** A boundary edge of a piece: a span of a ConstrainablePath between two points. */
export interface PiecePath {
  id: string; // PiecePath_xxx — distinct id used by seams
  name: string;
  path: string; // ConstrainablePath id supplying the geometry
  from: string; // ConstrainablePoint id
  to: string; // ConstrainablePoint id
  reversed: boolean;
  isMirrorLine?: boolean;
  notches: Notch[];
  // internal paths only: dart/fold dihedral angle in degrees (0 = flat seam line, no fold)
  foldAngle?: number;
  // internal paths only: bake this style line into the 3D fabric texture (default true)
  showIn3d?: boolean;
  // per-edge seam-allowance width override in mm (undefined => use the piece/pattern allowance)
  seamAllowance?: number;
  // seam-allowance corner finishing (all optional; undefined => 'intersection' with no cap):
  seamCornerJoinType?: SeamCornerJoinType;
  cornerRadius?: number; // mm — used when join type is 'radius'
  seamCornerMaxLength?: number; // mm — cap for the 'intersection' miter
  seamCornerLength?: number; // mm — fixed corner length for 'byLength'
  // formula-driven twins (evaluated on every redraft; empty formula = the number above applies):
  seamAllowanceFormula?: PropertyFormula;
  cornerRadiusFormula?: PropertyFormula;
  seamCornerLengthFormula?: PropertyFormula;
  seamCornerMaxLengthFormula?: PropertyFormula;
  // Whether the seam allowance wraps/covers the corner at the edge's start/end point. Default true
  // (covered = the allowance extends to meet the neighbour). When false, the allowance is cut back
  // flush at that endpoint (a clean square end). Faithful to the source's per-edge "Cover seam
  // allowance at start/end" toggles.
  coverSeamAllowanceStart?: boolean;
  coverSeamAllowanceEnd?: boolean;
}

export interface PieceArrangement {
  mode: 'curved' | 'flat' | string;
  cylinderName: string; // body cylinder to attach to, e.g. "Torso"
  uDegrees: number; // circumferential angle on the cylinder (deg)
  v: number; // axial param (0 = startBone end, 1 = endBone end)
  uOffsetMm: number; // tangential nudge around the cylinder (mm)
  vOffsetMm: number; // axial nudge along the cylinder (mm)
  radialOffsetMm: number; // push outward from the surface (mm)
  use2DPosition: boolean; // true => ignore cylinder, lay flat in 2D plane
  positionChanged: boolean;
  matrixWorld: number[]; // 16-float column-major saved group transform (meters)
  position: number[]; // 3-float translation extracted from matrixWorld (meters)
}

export interface PieceSettings3D {
  arrangement: PieceArrangement;
  enable3d: boolean;
  frozen: boolean; // exclude from simulation (pinned)
  flipNormals: boolean;
  filterExternalCollisionsByClothNormal: boolean;
  collisionLayer: number;
  particleDistance?: number | null; // per-piece mesh resolution override (mm)
  // flat per-particle cache of the settled rest state, stride 5: [x2d, y2d, x3d, y3d, z3d]
  // x2d/y2d in mm, x3d/y3d/z3d in meters.
  savedPositions: number[];
}

/** A construction marker placed inside a piece (drill hole / punch), in piece-local drafting mm. */
export interface PieceMarker {
  id: string;
  type: 'drill' | 'punch';
  x: number;
  y: number;
}

/** A construction point local to a dynamic piece (the original's "piece point"): drafting-space
 *  coordinates that travel with the piece, usable as reference markers for internal drafting. */
export interface PiecePoint {
  id: string; // PiecePoint_xxx
  name: string;
  x: number; // drafting mm (transformed by the piece placement like the rest of its geometry)
  y: number;
}

export interface Piece {
  id: string;
  name: string;
  layerId?: string; // layer membership (defaults to the 'default' layer)
  type: 'dynamic' | string; // "dynamic" => closed simulatable cloth piece
  materialId: string;
  origin: NamedVector; // piece-local origin in 2D mm
  originPoint: string; // ConstrainablePoint id of the origin
  position: { x: number; y: number }; // piece placement on the 2D canvas (mm)
  rotation: number; // degrees
  grainVector: NamedVector; // fabric grain direction (default {x:0,y:1})
  // formula-driven twins (evaluated on every redraft): rotation/grain in degrees; condition
  // evaluating to 0 hides the piece (the original's conditionFormula)
  rotationFormula?: PropertyFormula;
  grainFormula?: PropertyFormula;
  conditionFormula?: PropertyFormula;
  text: string | null;
  rightPieces: number;
  leftPieces: number;
  mirrorLeftPiecesAxis: 'X' | 'Y' | string;
  mirrorX: boolean;
  mirrorY: boolean;
  seamAllowanceInside: boolean;
  seamAllowance?: number; // mm — per-piece override of pattern.seamAllowance (undefined => pattern default)
  useMaterialScaling?: boolean; // when true, scale this piece by its material's shrinkage % (cut compensation)
  // When true the mainPaths describe HALF the piece, drafted on one side of the first main edge;
  // the full outline is produced by mirroring across that first edge (a "cut on fold" / first-edge
  // symmetry, faithful to the source's firstEdgeSymmetry flag). Default false.
  firstEdgeSymmetry?: boolean;
  mainPaths: PiecePath[]; // ordered boundary loop
  internalPaths: PiecePath[]; // darts / internal seams / fold lines
  markers?: PieceMarker[]; // drill holes / punch markers (piece-local mm)
  piecePoints?: PiecePoint[]; // piece-local construction points (dynamic pieces only)
  settings3d: PieceSettings3D;
  hidden?: boolean; // object-browser visibility toggle (omitted = visible)
}

export interface TextureSlot {
  url: string;
  mediaId: string | null;
  color: string; // hex tint; used as base color when there is no map
  scale: number; // physical tile size in mm (texture repeats every `scale` mm)
  normalUrl: string;
  normalMediaId: string | null;
  normalMapScale: number;
  opacityUrl: string;
  opacityMediaId: string | null;
  opacityMapScale: number;
}

export interface Material {
  id: string;
  name: string;
  frontTexture: TextureSlot | null;
  backTexture: TextureSlot | null;
  useSeparateBackSide: boolean;
  // cloth simulation params (UI scale 0..100):
  stretchWarpValue: number;
  stretchWeftValue: number;
  bendValue: number;
  thickness: number; // mm
  // 3D-only visual shell thickness (mm): >0 extrudes front/back faces apart and closes the edge
  // with a darkened side strip (the original's visualizationThickness). 0/undefined = single sheet.
  visualizationThickness?: number;
  weight: number; // g/m²
  // shrinkage compensation: fabric shrinks by this % after washing/pressing, so pieces cut from
  // it are scaled UP by this amount (about the piece origin) when the piece opts in via
  // `useMaterialScaling`. Horizontal = weft/width, vertical = warp/length. Undefined => 0%.
  shrinkageHorizontalPercentage?: number;
  shrinkageVerticalPercentage?: number;
  // PBR params:
  roughness: number;
  metalness: number;
  specularIntensity: number;
  opacity: number;
  normalScale: number;
  alphaCutoff: number;
  libraryItemId: string | null;
  libraryVersion: number | null;
  libraryUpdatedAt: string | null;
  currentPreset?: string | null; // name of the applied MaterialPreset (null/undefined => Custom)
}

export interface SeamRef {
  id: string; // PiecePath id
  mirrored: boolean;
  reversed: boolean;
}

export interface Seam {
  id: string;
  name: string;
  fromPaths: SeamRef[];
  toPaths: SeamRef[];
}

/** A persistent measurement annotation created with the 2D Measure tool. */
export interface Measurement {
  id: string;
  name: string;
  /** 'distance' (default) measures fromPoint→toPoint; 'angle' measures the angle at viaPoint. */
  kind?: 'distance' | 'angle';
  fromPointId: string;
  /** Angle measurements only: the vertex point. */
  viaPointId?: string;
  toPointId: string;
  /** Target value — mm for distance, degrees for angle. When set, the label shows the deviation. */
  targetMm: number | null;
}

export interface Body {
  // Map of measurement name -> value. Always includes age (years), height, weight.
  // Lengths are in the unit indicated by unitType (imperial => inch/lb, metric => cm/kg).
  fields: Record<string, number>;
  gender: 'female' | 'male' | string;
  unitType: 'imperial' | 'metric' | string;
  bodyColor: string; // hex
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  order: number;
  style: unknown | null;
}

export interface PatternSettings3D {
  cameraFov: number;
  cameraPosition: [number, number, number];
  controlsTarget: [number, number, number];
  gravity: [number, number, number];
  avatarEnabled: boolean;
  showAvatar: boolean;
  showArrangementPoints: boolean;
  showTriangles: boolean;
  showSeams: boolean;
  lightingMode: 'flat' | 'hdri' | 'studio1' | 'studio2' | 'sunset' | string;
  bokehFStop: number;
  n8aoEnabled: boolean;
  n8aoRadius: number;
  n8aoDistanceFalloff: number;
  n8aoIntensity: number;
  smaaScale: number;
  forceLowEndHardware: boolean;
  handleSelfCollisions: boolean;
  debugFocusPoint: boolean;
  // mesh density override for EVERY piece (mm between particles; 0/undefined = per-piece settings)
  globalParticleDistanceOverride?: number;
  // debug: pin the topmost particles of each piece in place while simulating
  fixTop?: boolean;
  /**
   * Experimental: also drape a mirrored 3D instance of each piece cut as a left/right pair
   * (`leftPieces > 0`). Off by default — when off the 3D drape is unchanged (one instance per piece).
   * Mirror instances register their seam edges under `#M` keys, so seam refs with `mirrored: true`
   * connect to them. Unverified against the live GPU sim; enable per pattern to try it.
   */
  drapeMirroredPieces?: boolean;
}

/** A graded size: a proportional scale (about each piece origin) + a swatch colour. */
export interface GradeSize {
  id: string;
  name: string;
  scale: number; // proportional fallback grade (1.0 = base) when no formula constraints exist
  color: string; // overlay swatch colour
  values?: Record<string, number>; // per-size variable value overrides (variableId -> value) for true grading
}
/**
 * Grading-by-example ("alterations"). A track picks a numeric *driver* variable and stores point/handle
 * position deltas sampled at discrete driver values; the geometry morphs by linearly interpolating those
 * deltas as the driver changes (the formula solver gives the base shape, alterations add the sculpted
 * deviation). Faithful to the source: additive deltas, implicit zero sample, clamp past the end samples.
 */
export interface AlterationDelta {
  points: Record<string, { x: number; y: number }>; // pointId -> position offset (mm)
  handles: Record<string, { v1: { x: number; y: number }; v2: { x: number; y: number } }>; // `${pathId}:${pointId}` -> handle offset
}
export interface AlterationSample {
  id: string;
  driverValue: number;
  deltaGeometry: AlterationDelta;
}
export interface AlterationTrack {
  id: string;
  name: string;
  enabled: boolean;
  driverVariableId: string | null; // the numeric Variable whose value drives this alteration
  samples: AlterationSample[]; // kept sorted by driverValue
}
/** A named baseline state you edit relative to, optionally bound to enum "category" selections. */
export interface GradeAnchor {
  id: string;
  name: string;
  driverValue: number;
  categories: Record<string, string>; // enum variableId -> selected option (multi-axis grading)
  geometry: AlterationDelta; // baseline geometry snapshot (offsets from the formula base)
}
export interface GradingProfile {
  sizes: GradeSize[];
  alterationTracks?: AlterationTrack[];
  anchors?: GradeAnchor[];
  mainDriverVariableId?: string | null; // default driver for new tracks / anchor capture
  categoryVariableIds?: string[]; // enum variables used as grading axes
  previewAlterationTrackId?: string | null; // transient: when set, only this track applies (UI preview)
  // persistent imported RUL grade-rule table (serializable; the original's GradingProfile)
  rulTable?: {
    name: string;
    isNumeric: boolean;
    units: string;
    sizes: string[];
    sampleSize: string;
    rules: Record<string, { dx: number; dy: number }[]>;
  } | null;
  // per-point grade-rule bindings (the original's grade anchors): point follows its rule per size
  rulAnchors?: { pointId: string; ruleNumber: number }[];
}

export interface PatternImage {
  id: string;
  url: string; // data URL or remote
  x: number; // centre, mm (plan space)
  y: number;
  width: number; // mm
  height: number; // mm
  rotation?: number; // degrees
  opacity?: number; // 0..1
  layerId?: string;
  [k: string]: unknown;
}

export interface PatternText {
  id: string;
  value: string;
  x: number; // mm (plan space)
  y: number;
  fontSize?: number; // mm
  color?: string; // hex
  align?: 'left' | 'center' | 'right';
  rotation?: number; // degrees
  layerId?: string;
  [k: string]: unknown;
}

export interface Pattern {
  id: string;
  name: string;
  description: string;
  lengthUnit: 'inch' | 'cm' | 'mm';
  angleUnit: 'degrees' | 'radians';
  defaultNotchSize: number; // mm
  defaultNotchType?: NotchType; // glyph used for new notches
  isPublic: boolean;
  pointLabeling: 'numeric' | 'alphabetic' | string;
  pointPrefix: string;

  points: ConstrainablePoint[];
  variables: Variable[];
  paths: ConstrainablePath[];
  pieces: Piece[];
  seams: Seam[];
  materials: Material[];
  // Optional for patterns saved before the Measure tool existed.
  measurements?: Measurement[];

  seamAllowance: number; // mm
  versionName: string;
  versionId: string;
  versionNumber: number;
  softwareVersion: string;
  currentSize: string;
  images: PatternImage[];
  frozenSnapshot: unknown | null;
  texts: PatternText[];
  body: Body;
  layers: Layer[];
  currentLayerId: string;
  useBodyMeasurementsForSizes: boolean;
  gradingProfile: GradingProfile | null;
  markerSettings: unknown | null;

  graphicsOffset: { x: number; y: number };
  graphicsScale: number; // 2D canvas px-per-mm zoom
  enable3d: boolean;
  showCompass: boolean;
  showGrid: boolean;
  snapToGrid: boolean;
  snapToGuides: boolean;
  showPieceNames: boolean;
  // Show fabric texture fills on the 2D pieces (default on). The original's show2dTextures.
  show2dTextures?: boolean;
  // Show the saved Measure-tool annotations on the 2D canvas (default on).
  showMeasurements?: boolean;
  // Show construction geometry (points/paths not used by any piece). When false the 2D canvas hides
  // helper/reference geometry to declutter the view. Faithful to the source's showConstruction flag.
  showConstruction?: boolean;
  viewMode: '2d' | '3d' | 'both';
  interactionMode: 'fast' | 'accurate' | string;
  settings3d: PatternSettings3D;
  // small JPEG data URL of the 2D layout, refreshed on save, shown on the pattern list
  thumbnailUrl?: string | null;
  hasChanged: boolean;
}

export interface PatternSummary {
  id: string;
  name: string;
  description: string;
  is3d: boolean;
  thumbnailUrl: string | null;
  updatedAt: string;
  ownerUserId: string;
  organizationId: string | null;
  organization: unknown | null;
  owner: {
    id: string;
    firstName: string;
    lastName: string | null;
    email: string;
    image: string | null;
  };
}

export function defaultPatternSettings3D(): PatternSettings3D {
  return {
    cameraFov: 54.43,
    cameraPosition: [0.49, 0.83, 0.84],
    controlsTarget: [0.095, 0.77, 0.053],
    gravity: [0, -9.8, 0],
    avatarEnabled: true,
    showAvatar: true,
    showArrangementPoints: false,
    showTriangles: false,
    showSeams: true,
    lightingMode: 'flat',
    bokehFStop: 11,
    n8aoEnabled: false,
    n8aoRadius: 0.6,
    n8aoDistanceFalloff: 1.5,
    n8aoIntensity: 5,
    smaaScale: 2,
    forceLowEndHardware: false,
    handleSelfCollisions: true,
    debugFocusPoint: false
  };
}

export function createEmptyPattern(): Pattern {
  return {
    id: crypto.randomUUID(),
    name: 'New Pattern',
    description: '',
    lengthUnit: 'inch',
    angleUnit: 'degrees',
    defaultNotchSize: 6.35,
    defaultNotchType: 'single',
    isPublic: false,
    pointLabeling: 'numeric',
    pointPrefix: 'A',
    points: [],
    variables: [],
    paths: [],
    pieces: [],
    seams: [],
    materials: [],
    measurements: [],
    seamAllowance: 12.7,
    versionName: 'Initial',
    versionId: crypto.randomUUID(),
    versionNumber: 1,
    softwareVersion: '1.0.0',
    currentSize: '',
    images: [],
    frozenSnapshot: null,
    texts: [],
    body: {
      fields: { age: 35, height: 65, weight: 150 },
      gender: 'female',
      unitType: 'imperial',
      bodyColor: '#b58a6a'
    },
    layers: [{ id: 'default', name: 'Default', visible: true, locked: false, order: 0, style: null }],
    currentLayerId: 'default',
    useBodyMeasurementsForSizes: false,
    gradingProfile: null,
    markerSettings: null,
    graphicsOffset: { x: 0, y: 0 },
    graphicsScale: 0.31,
    enable3d: true,
    showCompass: false,
    showGrid: true,
    snapToGrid: false,
    snapToGuides: false,
    showPieceNames: true,
    showMeasurements: true,
    showConstruction: true,
    viewMode: 'both',
    interactionMode: 'fast',
    settings3d: defaultPatternSettings3D(),
    hasChanged: false
  };
}

/** Eager singleton kept for components that import a constant; prefer createEmptyPattern(). */
export const EMPTY_PATTERN: Pattern = createEmptyPattern();
