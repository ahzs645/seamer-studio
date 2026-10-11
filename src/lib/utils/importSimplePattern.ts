// Import the simplified Seamer export format (pieces with explicit `boundary` polylines,
// `sewLines`, `grain`, `materialId`) into the full Pattern schema used by the renderer.
//
// This format lacks 3D placement (cylinder/u/v) and seam-pairing IDs. We recover preserved drafting
// edge groupings first, apply known legacy presets when the piece signature is unambiguous, and use
// conservative arrangement/seam heuristics for other files.

import { createEmptyPattern, type Pattern, type ConstrainablePoint, type ConstrainablePath, type Piece, type Material, artworkDraftPoint, pieceCutCounts, type PieceArtwork, type ColorwayState, type Seam, type PiecePath } from '@seamer/pattern-model';
import { indexPaths, indexPoints, pieceOutline, piecePathPolyline, pieceTransform, pieceInverseTransform, type Vec2 } from '@seamer/pattern-model/utils/patternGeometry';
import { buildPieceCloth, computeSeamEdgeIntervals } from '@seamer/cloth-sim';
import { simplifyPolyline } from '@atelier/geometry';

type XY = [number, number];

export interface SimplePiece {
  name: string;
  origin?: XY;
  grain?: XY;
  grainVector?: XY;
  materialId?: string | null;
  boundary: XY[][]; // ordered edge segments, each a polyline
  sewLines: XY[][];
  cutBoundary?: XY[] | null;
  cutPaths?: XY[][];
  internalLines?: XY[][];
  notches?: XY[][];
  drillHoles?: XY[];
  text?: string | null;
  description?: string;
  rotation?: number;
  rightPieces?: number;
  leftPieces?: number;
  mirrorLeftPiecesAxis?: 'X' | 'Y' | string;
  [key: string]: unknown;
}
export interface SimpleFile {
  name?: string;
  description?: string;
  itemId?: string | null;
  pieces: SimplePiece[];
}

export function isSimpleFormat(json: unknown): json is SimpleFile {
  if (!json || typeof json !== 'object') return false;
  const o = json as Record<string, unknown>;
  return Array.isArray(o.pieces) && o.pieces.length > 0 &&
    !!(o.pieces[0] as Record<string, unknown>)?.boundary && !Array.isArray((o.pieces[0] as Record<string, unknown>)?.mainPaths);
}

/** Check the sampled perimeter before tolerant legacy triangulation can hide crossed edges. */
function outlineSelfIntersects(outline: Vec2[]): boolean {
  const epsilon = 1e-7;
  const same = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) < epsilon;
  const distinct = outline.filter((point, index) => index === 0 || !same(point, outline[index - 1]));
  // Remove redundant straight-line samples, including a sample exactly on a crossing.
  // This numerical tolerance retains curved outline geometry.
  const loop = simplifyPolyline(distinct, epsilon);
  if (loop.length > 1 && same(loop[0], loop[loop.length - 1])) loop.pop();
  const segments = loop.map((a, index) => {
    const b = loop[(index + 1) % loop.length];
    return { a, b, index, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
  }).sort((a, b) => a.minX - b.minX);
  const orient = (a: Vec2, b: Vec2, c: Vec2) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < segments.length; i++) {
    const left = segments[i];
    for (let j = i + 1; j < segments.length; j++) {
      const right = segments[j];
      // Sorted X bounds avoid comparing distant perimeter segments on large sampled curves.
      if (right.minX > left.maxX + epsilon) break;
      if (right.minY > left.maxY + epsilon || right.maxY < left.minY - epsilon) continue;
      const gap = Math.abs(left.index - right.index);
      if (gap === 1 || gap === loop.length - 1) continue;
      const abC = orient(left.a, left.b, right.a), abD = orient(left.a, left.b, right.b);
      const cdA = orient(right.a, right.b, left.a), cdB = orient(right.a, right.b, left.b);
      if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) &&
        ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) {
        // Native garment curves can overlap within the renderer's 1 mm endpoint-stitching
        // tolerance (dart tips and nearly closed folds). Preserve those boundary slivers.
        const leftT = cdA / (cdA - cdB), rightT = abC / (abC - abD);
        const leftMargin = Math.min(leftT, 1 - leftT) * Math.hypot(left.b.x - left.a.x, left.b.y - left.a.y);
        const rightMargin = Math.min(rightT, 1 - rightT) * Math.hypot(right.b.x - right.a.x, right.b.y - right.a.y);
        if (leftMargin > 1 && rightMargin > 1) return true;
      }
    }
  }
  return false;
}

/** Reject an import before it replaces the editor document when its enabled 3D pieces have a
 * crossed outline or cannot be triangulated. Uses the renderer's sampling and seam allocation. */
export function assertPatternBuildable3d(pattern: Pattern): void {
  if (pattern.enable3d === false) return;
  const enabled = pattern.pieces.filter((piece) =>
    piece.type === 'dynamic' && piece.settings3d.enable3d !== false
  );
  if (enabled.length === 0) return;
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const intervals = computeSeamEdgeIntervals(pattern);
  for (const piece of enabled) {
    let cloth;
    try {
      const spacing = Math.min(4, (piece.settings3d.particleDistance ?? 10) / 2);
      if (outlineSelfIntersects(pieceOutline(pattern, piece, paths, points, spacing))) {
        throw new Error('Its boundary crosses itself.');
      }
      cloth = buildPieceCloth(pattern, piece, undefined, intervals);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot import "${pattern.name}": the 3D shape "${piece.name}" is invalid. ${detail}`);
    }
    if (!cloth || cloth.mesh.points.length < 3) {
      throw new Error(`Cannot import "${pattern.name}": the 3D shape "${piece.name}" has no usable cloth mesh.`);
    }
  }
}

const PALETTE = ['#5b6b8c', '#7a6a8f', '#6b8f7a', '#8f7a6a', '#6a8f8f', '#8f6a7a'];

function dist(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

type LegacyPreset = 'pencil-skirt' | null;

/**
 * The old Studio did not treat its bundled pencil skirt as an arbitrary collection of sampled
 * polylines. It recognized this exact legacy export and restored the original editable draft,
 * composite seams, 3D arrangement, materials, and cached drape. Keep that compatibility narrowly
 * fingerprinted so a different four-piece skirt is never silently replaced with the sample.
 */
export function isCanonicalPencilSkirtExport(json: SimpleFile): boolean {
  const expected = [
    { name: 'front', boundary: 29, sewLines: 16, origin: [-1028.3186, 1141.6960] as XY },
    { name: 'back', boundary: 28, sewLines: 16, origin: [687.4675, 1061.5162] as XY },
    { name: 'waistbandfront', boundary: 11, sewLines: 8, origin: [-1221.8327, 1302.4944] as XY },
    { name: 'waistbandback', boundary: 14, sewLines: 8, origin: [936.5692, 1179.2551] as XY }
  ];
  if (json.pieces.length !== expected.length) return false;
  return json.pieces.every((piece, index) => {
    const fingerprint = expected[index];
    const name = piece.name.replace(/[\s_-]/g, '').toLowerCase();
    const origin = piece.origin;
    return name === fingerprint.name &&
      piece.boundary.length === fingerprint.boundary &&
      piece.sewLines.length === fingerprint.sewLines &&
      !!origin && dist(origin, fingerprint.origin) < 0.1 &&
      formsClosedLoop(piece.sewLines);
  });
}

function restoreCanonicalPencilSkirt(json: SimpleFile, canonical: Pattern): Pattern {
  const pattern = structuredClone(canonical);
  pattern.name = json.name ?? pattern.name;
  pattern.description = json.description ?? pattern.description;
  return pattern;
}

function detectLegacyPreset(json: SimpleFile): LegacyPreset {
  const signature = json.pieces.map((piece) => piece.name.replace(/[\s_-]/g, '').toLowerCase());
  return signature.length === 4 &&
    signature[0] === 'front' &&
    signature[1] === 'back' &&
    signature[2] === 'waistbandfront' &&
    signature[3] === 'waistbandback' &&
    json.pieces.map((piece) => piece.sewLines.length).join(',') === '16,16,8,8'
    ? 'pencil-skirt'
    : null;
}

function formsClosedLoop(edges: XY[][]): boolean {
  if (edges.length < 3 || edges.some((edge) => edge.length < 2)) return false;
  for (let i = 0; i < edges.length; i++) {
    const tail = edges[i][edges[i].length - 1];
    const head = edges[(i + 1) % edges.length][0];
    if (dist(tail, head) > 0.05) return false;
  }
  return true;
}

export function convertSimplePattern(json: SimpleFile, canonicalPencilSkirt?: Pattern): Pattern {
  if (canonicalPencilSkirt && isCanonicalPencilSkirtExport(json)) {
    return restoreCanonicalPencilSkirt(json, canonicalPencilSkirt);
  }

  const pattern = createEmptyPattern();
  pattern.name = json.name ?? 'Imported Pattern';
  pattern.description = json.description ?? '';
  pattern.sourceItemId = json.itemId ?? null;
  pattern.lengthUnit = 'mm';
  const preset = detectLegacyPreset(json);

  const points: ConstrainablePoint[] = [];
  const paths: ConstrainablePath[] = [];
  const pieces: Piece[] = [];
  const materialsMap = new Map<string, Material>();
  const seams: Seam[] = [];

  // Deduplicate sampled anchors by coordinate. Raw source pieces are static sampled polylines, so
  // their anchors intentionally have no drafting labels and are hidden by the piece by default.
  const pointMap = new Map<string, string>();
  let pointCounter = 0;
  const pt = (xy: XY): string => {
    const k = `${xy[0].toFixed(2)},${xy[1].toFixed(2)}`;
    const existing = pointMap.get(k);
    if (existing) return existing;
    const id = `P${pointCounter++}`;
    points.push({ id, name: '', x: xy[0], y: xy[1] });
    pointMap.set(k, id);
    return id;
  };

  const matId = (label: string | null | undefined): string => {
    const key = label ?? 'Material';
    if (!materialsMap.has(key)) {
      const idx = materialsMap.size;
      const presetColor = preset === 'pencil-skirt'
        ? (key.toLowerCase().includes('waistband') ? '#fafafa' : '#2d3742')
        : null;
      materialsMap.set(key, {
        id: key,
        name: key,
        frontTexture: slot(presetColor ?? PALETTE[idx % PALETTE.length]),
        backTexture: slot(presetColor ?? PALETTE[idx % PALETTE.length]),
        useSeparateBackSide: false,
        stretchWarpValue: preset === 'pencil-skirt' ? 10 : 12,
        stretchWeftValue: preset === 'pencil-skirt' ? 10 : 14,
        bendValue: preset === 'pencil-skirt' ? 0 : 5,
        thickness: 0.5, weight: 150,
        roughness: preset === 'pencil-skirt' ? 0.8 : 0.85,
        metalness: preset === 'pencil-skirt' ? 0.1 : 0.05,
        specularIntensity: preset === 'pencil-skirt' ? 0.25 : 0.2,
        opacity: 1, normalScale: 1, alphaCutoff: 0,
        libraryItemId: null, libraryVersion: null, libraryUpdatedAt: null
      });
    }
    return key;
  };

  // garment-wide bbox + per-piece bbox (for arrangement heuristics)
  const pieceBox = json.pieces.map((p) => {
    const xs = p.boundary.flat().map((q) => q[0]);
    const ys = p.boundary.flat().map((q) => q[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });
  const gMinX = Math.min(...pieceBox.map((b) => b.minX));
  const gMaxX = Math.max(...pieceBox.map((b) => b.maxX));
  const tallCount = json.pieces.filter((p, i) => (pieceBox[i].maxY - pieceBox[i].minY) > 1.6 * (pieceBox[i].maxX - pieceBox[i].minX)).length;
  const looksLikeTrousers = tallCount >= 4;

  const piecePathIds: string[][] = [];

  // classify pieces for arrangement (trousers: waistbands vs legs; front/back split per side)
  const gMidX = (gMinX + gMaxX) / 2;
  const legSeen = { left: 0, right: 0 };

  json.pieces.forEach((sp, pi) => {
    const box = pieceBox[pi];
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const h = box.maxY - box.minY;
    const w = box.maxX - box.minX;

    // Legacy sewLines form the same closed perimeter as boundary, but preserve the original
    // drafting edge groupings (a sampled curve may span several raw boundary fragments). Prefer
    // those grouped edges so the cloth builder does not treat every curve fragment as a separate
    // constrained edge.
    const boundaryEdges = formsClosedLoop(sp.sewLines) ? sp.sewLines : sp.boundary;

    // `sewLines` are the stitch outline used to triangulate the cloth. `boundary` is the physical
    // cut outline (usually including seam allowance) and remains losslessly attached below.
    const mainPaths: PiecePath[] = [];
    const currentPiecePathIds: string[] = [];
    boundaryEdges.forEach((seg, si) => {
      const pathId = `Path_${pi}_${si}`;
      const pathPoints = seg.map((q) => ({ id: pt(q) }));
      paths.push({ id: pathId, name: pathId, pathType: 'line', pathPoints, basePoint: pathPoints[0]?.id ?? null, version: 1 });
      const ppId = `PP_${pi}_${si}`;
      currentPiecePathIds.push(ppId);
      mainPaths.push({ id: ppId, name: '', path: pathId, from: pathPoints[0].id, to: pathPoints[pathPoints.length - 1].id, reversed: false, notches: [] });
    });
    piecePathIds.push(currentPiecePathIds);

    // Source-only markings which have a native Seamer equivalent become internal piece paths.
    const internalPaths: PiecePath[] = [];
    [...(sp.cutPaths ?? []), ...(sp.internalLines ?? [])].forEach((seg, si) => {
      if (seg.length < 2) return;
      const pathId = `LegacyInternalPath_${pi}_${si}`;
      const pathPoints = seg.map((q) => ({ id: pt(q) }));
      paths.push({ id: pathId, name: '', pathType: 'line', pathPoints, basePoint: pathPoints[0]?.id ?? null, version: 1 });
      internalPaths.push({
        id: `LegacyInternalPP_${pi}_${si}`,
        name: '',
        path: pathId,
        from: pathPoints[0].id,
        to: pathPoints[pathPoints.length - 1].id,
        reversed: false,
        notches: [],
        showIn3d: (sp.internalLines ?? []).includes(seg)
      });
    });

    // heuristic arrangement
    const isLeg = looksLikeTrousers && h > 1.6 * w;
    const leftSide = cx < gMidX;
    let legOrdinal = 0;
    if (isLeg) { legOrdinal = leftSide ? legSeen.left++ : legSeen.right++; }
    const arrangement = preset === 'pencil-skirt'
      ? pencilSkirtArrangement(pi)
      : inferArrangement(looksLikeTrousers, isLeg, leftSide, legOrdinal, cx, gMinX, gMaxX, sp.name);

    const grain = sp.grain ?? sp.grainVector ?? [0, 1];
    const origin: XY = sp.origin ?? [cx, cy];
    const originPoint = pt(origin);
    pieces.push({
      id: `Piece_${pi}`,
      name: sp.name || `Piece ${pi + 1}`,
      label: sp.description ?? null,
      type: 'dynamic',
      materialId: matId(sp.materialId),
      // Legacy boundary coordinates are already in placed-plan space. Referencing the legacy
      // origin as the piece origin and placing the piece at that same coordinate makes the modern
      // piece transform an identity transform instead of translating the geometry a second time.
      origin: { id: `O${pi}`, name: '', x: origin[0], y: origin[1] },
      originPoint,
      position: { x: origin[0], y: origin[1] },
      rotation: sp.rotation ?? 0,
      grainVector: { id: `G${pi}`, name: '', x: grain[0], y: grain[1] },
      text: sp.text ?? null,
      rightPieces: sp.rightPieces ?? 1,
      leftPieces: sp.leftPieces ?? 0,
      mirrorLeftPiecesAxis: sp.mirrorLeftPiecesAxis ?? 'X',
      mirrorX: false, mirrorY: false,
      seamAllowanceInside: false,
      mainPaths,
      internalPaths,
      markers: (sp.drillHoles ?? []).map((q, markerIndex) => ({
        id: `LegacyDrill_${pi}_${markerIndex}`,
        type: 'drill' as const,
        x: q[0],
        y: q[1]
      })),
      legacyGeometry: {
        format: 'seamscape-json',
        boundary: structuredClone(sp.boundary),
        sewLines: structuredClone(sp.sewLines),
        cutBoundary: sp.cutBoundary ? structuredClone(sp.cutBoundary) : null,
        cutPaths: structuredClone(sp.cutPaths ?? []),
        internalLines: structuredClone(sp.internalLines ?? []),
        notches: structuredClone(sp.notches ?? []),
        drillHoles: structuredClone(sp.drillHoles ?? []),
        source: Object.fromEntries(Object.entries(sp).filter(([key]) => ![
          'boundary', 'sewLines', 'cutBoundary', 'cutPaths', 'internalLines', 'notches', 'drillHoles'
        ].includes(key)))
      },
      hideEditorPoints: true,
      settings3d: {
        arrangement,
        enable3d: true, frozen: false, flipNormals: preset === 'pencil-skirt' && (pi === 1 || pi === 3),
        filterExternalCollisionsByClothNormal: false, collisionLayer: 0,
        particleDistance: 10,
        savedPositions: []
      }
    });
  });

  if (preset === 'pencil-skirt') {
    seams.push(...pencilSkirtSeams(piecePathIds));
  }

  pattern.points = points;
  pattern.paths = paths;
  pattern.pieces = pieces;
  pattern.materials = [...materialsMap.values()];
  pattern.seams = seams;
  pattern.body = { fields: { age: 35, height: 65, weight: 150 }, gender: 'female', unitType: 'imperial', bodyColor: '#b58a6a' };
  pattern.graphicsScale = 0.3;
  pattern.viewMode = 'both';
  pattern.enable3d = true;
  pattern.showConstruction = false;
  return pattern;
}

type LegacyMeshSnapshot = NonNullable<Piece['settings3d']['savedMeshSnapshot']>;

/** Decode SeamScape v0.0.1's packed mesh cache. Its first two values are piece-local millimetres.
 * Apply the legacy piece's mirror/rotation so they share the expanded Raw JSON piece's local frame,
 * while retaining piece-local coordinates for source-compatible surface projection. */
function legacySnapshotToSavedPositions(sourcePiece: Piece, snapshot?: LegacyMeshSnapshot): number[] {
  if (!snapshot?.positions) return [];
  try {
    const binary = atob(snapshot.positions);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.byteLength % 20 !== 0) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = bytes.byteLength / 20;
    if (snapshot.vertexCount && snapshot.vertexCount !== count) return [];
    const result = new Array<number>(count * 5);
    const mirrorX = sourcePiece.mirrorX ? -1 : 1;
    const mirrorY = sourcePiece.mirrorY ? -1 : 1;
    const radians = ((sourcePiece.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    for (let index = 0; index < count; index += 1) {
      const offset = index * 20;
      const localX = view.getFloat32(offset, true) * mirrorX;
      const localY = view.getFloat32(offset + 4, true) * mirrorY;
      result[index * 5] = localX * cos - localY * sin;
      result[index * 5 + 1] = localX * sin + localY * cos;
      result[index * 5 + 2] = view.getFloat32(offset + 8, true);
      result[index * 5 + 3] = view.getFloat32(offset + 12, true);
      result[index * 5 + 4] = view.getFloat32(offset + 16, true);
    }
    return result;
  } catch {
    return [];
  }
}

/** Settled positions are project-owned state. A legacy indexed snapshot needs conversion, while a
 * modern stride-5 cache can be retained verbatim; absence must stay absent instead of falling back
 * to cache bundled in a canonical geometry template. */
function legacyPieceSavedPositions(sourcePiece: Piece): number[] {
  const convertedSnapshot = legacySnapshotToSavedPositions(
    sourcePiece,
    sourcePiece.settings3d.savedMeshSnapshot
  );
  if (convertedSnapshot.length > 0) return convertedSnapshot;
  return structuredClone(sourcePiece.settings3d.savedPositions ?? []);
}

/**
 * Combine the two complementary exports produced by the reference Studio:
 *
 * - Raw JSON supplies the exact sampled, already-expanded outlines that the current triangulator can
 *   build reliably.
 * - The full legacy project supplies explicit seam topology, body/material settings, exact 3D
 *   arrangements, and its settled mesh cache.
 *
 * The old full project alone contains editable Bezier spans whose constraints are invalid under the
 * newer triangulator. Keeping its metadata while using the source's own sampled outlines preserves
 * the garment without silently throwing away the information unique to either export.
 */
export function convertSimplePatternWithLegacyProject(
  json: SimpleFile,
  legacyProject: Pattern,
  canonicalPencilSkirt?: Pattern
): Pattern {
  // This fingerprint is the exact bundled editable project, not an interpreted sampled outline.
  // Remapping its already-canonical seam graph back through the Raw JSON only loses orientation.
  if (canonicalPencilSkirt && isCanonicalPencilSkirtExport(json)) {
    const restored = restoreCanonicalPencilSkirt(json, canonicalPencilSkirt);
    const sourcePiecesByName = new Map(legacyProject.pieces.map((piece) => [piece.name, piece]));
    // The canonical template is geometry scaffolding, not an authority for runtime state. Its
    // bundled settled drape must not leak into a source project that has no saved positions: doing
    // so makes Play start from a stale equilibrium instead of the source cylinder arrangement.
    restored.pieces = restored.pieces.map((piece) => {
      const source = sourcePiecesByName.get(piece.name);
      if (!source) return piece;
      return {
        ...piece,
        materialId: source.materialId ?? piece.materialId,
        settings3d: {
          ...piece.settings3d,
          ...structuredClone(source.settings3d),
          savedPositions: legacyPieceSavedPositions(source)
        }
      };
    });
    restored.settings3d = {
      ...restored.settings3d,
      ...structuredClone(legacyProject.settings3d)
    };
    restored.body = {
      ...structuredClone(legacyProject.body),
      useLegacyDefaultAvatar: legacyProject.body.useLegacyDefaultAvatar ?? true
    };
    restored.enable3d = legacyProject.enable3d !== false;
    restored.viewMode = legacyProject.viewMode ?? restored.viewMode;
    if (legacyProject.productionSpec) restored.productionSpec = structuredClone(legacyProject.productionSpec);
    if (legacyProject.productionAutomation) restored.productionAutomation = structuredClone(legacyProject.productionAutomation);
    if (legacyProject.rangePlan) restored.rangePlan = structuredClone(legacyProject.rangePlan);
    if (legacyProject.techPack) restored.techPack = structuredClone(legacyProject.techPack);
    if (legacyProject.colorways) restored.colorways = structuredClone(legacyProject.colorways);
    if (legacyProject.artwork) restored.artwork = structuredClone(legacyProject.artwork);
    if (legacyProject.appearanceHistory) restored.appearanceHistory = structuredClone(legacyProject.appearanceHistory);
    if (legacyProject.workspaceLayout) restored.workspaceLayout = structuredClone(legacyProject.workspaceLayout);
    return restored;
  }
  const pattern = convertSimplePattern(json, canonicalPencilSkirt);

  const sourcePiecesByName = new Map(legacyProject.pieces.map((piece) => [piece.name, piece]));
  const sourcePoints = indexPoints(legacyProject);
  const sourcePaths = indexPaths(legacyProject);
  const defaultLegacyMaterialId = legacyProject.materials[0]?.id;
  const sourceOwners = new Map<string, {
    piece: Piece;
    path: PiecePath;
    kind: 'main' | 'internal';
    index: number;
  }>();
  for (const piece of legacyProject.pieces) {
    piece.mainPaths.forEach((path, index) => sourceOwners.set(path.id, { piece, path, kind: 'main', index }));
    piece.internalPaths.forEach((path, index) => sourceOwners.set(path.id, { piece, path, kind: 'internal', index }));
  }

  pattern.pieces = pattern.pieces.map((piece) => {
    const source = sourcePiecesByName.get(piece.name);
    if (!source) return piece;
    const sourceSettings = source.settings3d;
    return {
      ...piece,
      label: source.label ?? piece.label,
      text: source.text ?? piece.text,
      // In SeamScape a null material means the pattern's first/default material. Falling back to
      // Raw JSON here leaves labels such as "Material 4" that do not exist in the UUID material
      // library, causing Seamer's blue-grey missing-material fallback instead of the source white.
      materialId: source.materialId ?? defaultLegacyMaterialId ?? piece.materialId,
      settings3d: {
        ...piece.settings3d,
        ...sourceSettings,
        savedPositions: legacyPieceSavedPositions(source)
      }
    };
  });

  const targetPoints = indexPoints(pattern);
  const targetPiecesByName = new Map(pattern.pieces.map((piece) => [piece.name, piece]));
  const basePieceName = (name: string) => name
    .trim()
    .toLowerCase()
    .replace(/\s*\((?:r|l)\d+\)\s*$/, '');
  const candidatePieces = (sourcePiece: Piece) => {
    const exact = targetPiecesByName.get(sourcePiece.name);
    const base = basePieceName(sourcePiece.name);
    const matching = pattern.pieces.filter((piece) => basePieceName(piece.name) === base);
    return exact ? [exact, ...matching.filter((piece) => piece !== exact)] : matching;
  };
  const reflectAcrossLine = (
    point: { x: number; y: number },
    from: { x: number; y: number },
    to: { x: number; y: number }
  ) => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy || 1;
    const ratio = ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared;
    const projected = { x: from.x + dx * ratio, y: from.y + dy * ratio };
    return { x: 2 * projected.x - point.x, y: 2 * projected.y - point.y };
  };
  const sourceWorldPolyline = (owner: NonNullable<ReturnType<typeof sourceOwners.get>>, mirrored: boolean) => {
    const toWorld = pieceTransform(owner.piece, sourcePoints);
    let polyline = piecePathPolyline(owner.path, sourcePaths, sourcePoints, 4).map(toWorld);
    if (!mirrored) return polyline;
    const mirrorPath = owner.piece.mainPaths.find((path) => path.isMirrorLine);
    const mirrorFrom = mirrorPath && sourcePoints.get(mirrorPath.from);
    const mirrorTo = mirrorPath && sourcePoints.get(mirrorPath.to);
    if (!mirrorFrom || !mirrorTo) return polyline;
    const axisFrom = toWorld(mirrorFrom), axisTo = toWorld(mirrorTo);
    polyline = polyline.map((point) => reflectAcrossLine(point, axisFrom, axisTo));
    return polyline;
  };
  const targetPathEndpoints = (piece: Piece, path: PiecePath) => {
    const from = targetPoints.get(path.from), to = targetPoints.get(path.to);
    if (!from || !to) return null;
    const toWorld = pieceTransform(piece, targetPoints);
    return [toWorld(from), toWorld(to)] as const;
  };
  const bestTargetPath = (
    owner: NonNullable<ReturnType<typeof sourceOwners.get>>,
    reference: Seam['fromPaths'][number]
  ) => {
    const sourcePolyline = sourceWorldPolyline(owner, reference.mirrored);
    const sourceA = sourcePolyline[0], sourceB = sourcePolyline.at(-1);
    if (!sourceA || !sourceB) return null;
    let best: { piece: Piece; path: PiecePath; orientationFlipped: boolean; score: number } | null = null;
    for (const piece of candidatePieces(owner.piece)) {
      const paths = owner.kind === 'main' ? piece.mainPaths : piece.internalPaths;
      for (const path of paths) {
        const endpoints = targetPathEndpoints(piece, path);
        if (!endpoints) continue;
        const [targetA, targetB] = endpoints;
        const forward = Math.hypot(sourceA.x - targetA.x, sourceA.y - targetA.y)
          + Math.hypot(sourceB.x - targetB.x, sourceB.y - targetB.y);
        const reverse = Math.hypot(sourceA.x - targetB.x, sourceA.y - targetB.y)
          + Math.hypot(sourceB.x - targetA.x, sourceB.y - targetA.y);
        const score = Math.min(forward, reverse);
        if (!best || score < best.score) {
          best = { piece, path, orientationFlipped: reverse < forward, score };
        }
      }
    }
    return { best, sourcePolyline };
  };
  const materializedInternalPaths = new Map<string, PiecePath>();
  const materializeInternalPath = (
    owner: NonNullable<ReturnType<typeof sourceOwners.get>>,
    reference: Seam['fromPaths'][number],
    sourcePolyline: Array<{ x: number; y: number }>
  ): PiecePath | null => {
    const cacheKey = `${owner.path.id}:${reference.mirrored ? 'mirrored' : 'base'}`;
    const cached = materializedInternalPaths.get(cacheKey);
    if (cached) return cached;
    const targets = candidatePieces(owner.piece);
    const targetPiece = targets[0];
    if (!targetPiece || sourcePolyline.length < 2) return null;
    const token = `${owner.path.id}_${reference.mirrored ? 'M' : 'B'}`.replace(/[^a-zA-Z0-9_]/g, '_');
    const pathPoints = sourcePolyline.map((point, index) => {
      const id = `LegacySourceInternalPoint_${token}_${index}`;
      pattern.points.push({ id, name: '', x: point.x, y: point.y });
      return { id };
    });
    const pathId = `LegacySourceInternalPath_${token}`;
    const piecePath: PiecePath = {
      id: `LegacySourceInternalPP_${token}`,
      name: owner.path.name ?? '',
      path: pathId,
      from: pathPoints[0].id,
      to: pathPoints.at(-1)!.id,
      reversed: false,
      notches: [],
      showIn3d: true
    };
    pattern.paths.push({
      id: pathId,
      name: owner.path.name ?? '',
      pathType: 'line',
      pathPoints,
      basePoint: pathPoints[0].id,
      version: 1
    });
    targetPiece.internalPaths.push(piecePath);
    materializedInternalPaths.set(cacheKey, piecePath);
    return piecePath;
  };

  const mapReference = (reference: Seam['fromPaths'][number]): Seam['fromPaths'][number] | null => {
    const owner = sourceOwners.get(reference.id);
    if (!owner) return null;
    const exactTargetPiece = targetPiecesByName.get(owner.piece.name);
    // The reference project stores B/F as half pieces with a fold edge. Raw JSON expands those
    // halves into eight explicit perimeter edges: left half is 4..7, reflected right is 3..0.
    if (owner.kind === 'main' && exactTargetPiece
      && owner.piece.mainPaths.length === 5 && exactTargetPiece.mainPaths.length === 8) {
      if (owner.index === 0) return null; // fold line is internal after expansion
      const targetIndex = reference.mirrored ? 4 - owner.index : owner.index + 3;
      const targetPath = exactTargetPiece.mainPaths[targetIndex];
      return targetPath
        ? { id: targetPath.id, mirrored: false, reversed: reference.reversed }
        : null;
    }
    const match = bestTargetPath(owner, reference);
    if (!match) return null;
    if (owner.kind === 'internal') {
      const sourceA = match.sourcePolyline[0], sourceB = match.sourcePolyline.at(-1)!;
      const sourceLength = Math.hypot(sourceB.x - sourceA.x, sourceB.y - sourceA.y);
      const acceptableScore = Math.max(5, sourceLength * 0.25);
      if (!match.best || match.best.score > acceptableScore) {
        const targetPath = materializeInternalPath(owner, reference, match.sourcePolyline);
        return targetPath
          ? { id: targetPath.id, mirrored: false, reversed: reference.reversed }
          : null;
      }
    }
    if (!match.best) return null;
    return {
      id: match.best.path.id,
      mirrored: false,
      reversed: reference.reversed !== match.best.orientationFlipped
    };
  };

  pattern.seams = legacyProject.seams.flatMap((seam) => {
    const fromPaths = seam.fromPaths.map(mapReference).filter((ref): ref is NonNullable<typeof ref> => !!ref);
    const toPaths = seam.toPaths.map(mapReference).filter((ref): ref is NonNullable<typeof ref> => !!ref);
    return fromPaths.length > 0 && toPaths.length > 0 ? [{ ...seam, fromPaths, toPaths }] : [];
  });

  pattern.materials = structuredClone(legacyProject.materials);
  pattern.body = {
    ...structuredClone(legacyProject.body),
    // Direct SSP decoding sets this flag. Keep the fallback for callers that provide an already
    // decoded legacy object (the CLI converter and compatibility tests do this as well).
    useLegacyDefaultAvatar: legacyProject.body.useLegacyDefaultAvatar ?? true
  };

  // Copy authored document data, then remap only owners proven by unique placed geometry.
  // Ambiguous names/copies/frames retain explicit repairable source references.
  const transferable = [
    'lengthUnit', 'angleUnit', 'defaultNotchSize', 'currentSize', 'seamAllowance', 'settings3d',
    'gradingProfile', 'markerSettings', 'productionSpec', 'productionAutomation', 'rangePlan', 'techPack', 'colorways', 'artwork', 'appearanceHistory', 'workspaceLayout', 'graphicsOffset', 'graphicsScale', 'enable3d', 'viewMode',
    'showCompass', 'showGrid', 'snapToGrid', 'snapToGuides', 'showPieceNames', 'useBodyMeasurementsForSizes'
  ] as const;
  const sourceRecord = legacyProject as unknown as Record<string, unknown>;
  const targetRecord = pattern as unknown as Record<string, unknown>;
  for (const key of transferable) {
    if (sourceRecord[key] !== undefined) targetRecord[key] = structuredClone(sourceRecord[key]);
  }

  remapPairedLegacyDocumentOwners(legacyProject, pattern);

  pattern.name = json.name ?? legacyProject.name ?? pattern.name;
  pattern.description = json.description ?? legacyProject.description ?? pattern.description;
  pattern.enable3d = legacyProject.enable3d !== false;
  pattern.viewMode = legacyProject.viewMode ?? (pattern.enable3d ? 'both' : pattern.viewMode);
  return pattern;
}

/** Remap extension owners only after proving a unique name, single cut and matching placed outline.
 * This does not participate in the legacy seam mapper or native JSON/SSP import paths. */
export function remapPairedLegacyDocumentOwners(source: Pattern, target: Pattern): void {
  const sourcePoints = indexPoints(source), targetPoints = indexPoints(target);
  const sourcePaths = indexPaths(source), targetPaths = indexPaths(target);
  const close = (a: Vec2, b: Vec2, epsilon = .2) => Math.hypot(a.x - b.x, a.y - b.y) <= epsilon;
  const distanceToSegment = (p: Vec2, a: Vec2, b: Vec2) => {
    const dx = b.x - a.x, dy = b.y - a.y, denominator = dx * dx + dy * dy;
    const u = denominator ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denominator)) : 0;
    return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
  };
  const bounds = (poly: Vec2[]) => [Math.min(...poly.map(p => p.x)), Math.min(...poly.map(p => p.y)), Math.max(...poly.map(p => p.x)), Math.max(...poly.map(p => p.y))];
  const area = (poly: Vec2[]) => Math.abs(poly.reduce((sum, p, i) => { const q = poly[(i + 1) % poly.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
  const equivalent = (a: Vec2[], b: Vec2[]) => {
    if (a.length < 3 || b.length < 3 || [...a, ...b].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
    const aa = area(a), ab = area(b), ba = bounds(a), bb = bounds(b);
    if (aa < 1e-6 || ab < 1e-6 || Math.abs(aa - ab) > Math.max(2, aa * .005) || ba.some((v, i) => Math.abs(v - bb[i]) > .2)) return false;
    const onBoundary = (points: Vec2[], polygon: Vec2[]) => points.every(p => polygon.some((q, i) => distanceToSegment(p, q, polygon[(i + 1) % polygon.length]) <= .2));
    return onBoundary(a, b) && onBoundary(b, a);
  };
  const ownerMap = new Map<string, { piece: Piece; map: (point: Vec2) => Vec2; reflected: boolean }>();
  for (const owner of source.pieces) {
    if (source.pieces.filter(p => p.name === owner.name).length !== 1 || pieceCutCounts(owner).total !== 1 || owner.useMaterialScaling) continue;
    const candidates = target.pieces.filter(p => p.name === owner.name);
    if (candidates.length !== 1) continue;
    const piece = candidates[0];
    if (pieceCutCounts(piece).total !== 1 || piece.useMaterialScaling || !sourcePoints.has(owner.originPoint) || !targetPoints.has(piece.originPoint)) continue;
    const placedSource = pieceTransform(owner, sourcePoints), placedTarget = pieceTransform(piece, targetPoints);
    const sourceOutline = pieceOutline(source, owner, sourcePaths, sourcePoints, 1).map(placedSource);
    const targetOutline = pieceOutline(target, piece, targetPaths, targetPoints, 1).map(placedTarget);
    if (!equivalent(sourceOutline, targetOutline)) continue;
    const inverse = pieceInverseTransform(piece, targetPoints), map = (point: Vec2) => inverse(placedSource(point));
    const o = map({ x: 0, y: 0 }), x = map({ x: 1, y: 0 }), y = map({ x: 0, y: 1 });
    const ux = { x: x.x - o.x, y: x.y - o.y }, uy = { x: y.x - o.x, y: y.y - o.y };
    const determinant = ux.x * uy.y - ux.y * uy.x;
    if (Math.abs(Math.hypot(ux.x, ux.y) - 1) > 1e-8 || Math.abs(Math.hypot(uy.x, uy.y) - 1) > 1e-8 || Math.abs(ux.x * uy.x + ux.y * uy.y) > 1e-8 || Math.abs(Math.abs(determinant) - 1) > 1e-8) continue;
    ownerMap.set(owner.id, { piece, map, reflected: determinant < 0 });
  }
  const ownerId = (id: string) => ownerMap.get(id)?.piece.id ??
    (target.pieces.some(piece => piece.id === id) ? `UnresolvedLegacyPiece:${id}` : id);
  const remapArtwork = (rows: PieceArtwork[] | undefined) => rows?.map(row => {
    const mapping = ownerMap.get(row.pieceId);
    if (!mapping) return { ...row, pieceId: ownerId(row.pieceId) };
    const center = mapping.map({ x: row.x, y: row.y });
    const top = mapping.map(artworkDraftPoint(row, .5, 0));
    const rotation = Math.atan2(top.y - center.y, top.x - center.x) * 180 / Math.PI - 90;
    const next = { ...row, pieceId: mapping.piece.id, x: center.x, y: center.y, rotation, flipX: Boolean(row.flipX) !== mapping.reflected, zone: row.zone?.map(mapping.map) };
    if (row.repeat) {
      // Every supported lattice is periodic over two rows/columns. Verify one full period
      // against its reflected/rotated lattice before changing the motif's owner/frame.
      const lattice = (art: PieceArtwork, column: number, line: number): Vec2 => {
        const repeat = art.repeat!;
        const dx = (column + (repeat.mode === 'brick' && Math.abs(line % 2) === 1 ? .5 : 0)) * (art.widthMm + repeat.gapXmm);
        const dy = (line + (repeat.mode === 'half-drop' && Math.abs(column % 2) === 1 ? .5 : 0)) * (art.heightMm + repeat.gapYmm);
        const angle = art.rotation * Math.PI / 180;
        return { x: art.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: art.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
      };
      const candidates: Vec2[] = [];
      for (let x = -3; x <= 3; x++) for (let y = -3; y <= 3; y++) candidates.push(lattice(next, x, y));
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) {
        const point = mapping.map(lattice(row, x, y));
        if (!candidates.some(candidate => close(candidate, point, 1e-7))) return { ...row, pieceId: `UnresolvedLegacyArtworkPiece:${row.pieceId}` };
      }
    }
    // Verify the asymmetric image's four exact UV corners, not just its center or bbox.
    if ([[0, 0], [1, 0], [1, 1], [0, 1]].some(([u, v]) => !close(artworkDraftPoint(next, u, v), mapping.map(artworkDraftPoint(row, u, v)), 1e-7))) return { ...row, pieceId: `UnresolvedLegacyArtworkPiece:${row.pieceId}` };
    if (!next.flipX && row.flipX === undefined) delete (next as { flipX?: boolean }).flipX;
    if (!row.zone) delete next.zone;
    return next;
  });
  const remapColorways = (state: ColorwayState | undefined) => state && { ...state, variants: state.variants.map(variant => ({ ...variant, pieces: Object.fromEntries(Object.entries(variant.pieces).map(([id, value]) => [ownerId(id), value])) })) };
  target.artwork = remapArtwork(target.artwork);
  target.colorways = remapColorways(target.colorways);
  if (target.techPack) target.techPack.construction = target.techPack.construction.map(row => ({ ...row, pieceId: row.pieceId ? ownerId(row.pieceId) : null }));
  if (target.appearanceHistory) target.appearanceHistory.versions = target.appearanceHistory.versions.map(version => ({ ...version, pieces: version.pieces.map(row => ({ ...row, id: ownerId(row.id) })), colorways: remapColorways(version.colorways), artwork: remapArtwork(version.artwork) }));
  if (target.productionAutomation) target.productionAutomation.surfaceMeasurements = target.productionAutomation.surfaceMeasurements.map(row => {
    const mapping = ownerMap.get(row.pieceId); if (!mapping) return { ...row, pieceId: ownerId(row.pieceId) };
    // Keep provenance but mark its source snapshot stale; a rebuilt triangulation requires recapture.
    return { ...row, pieceId: mapping.piece.id, from: mapping.map(row.from), to: mapping.map(row.to), captured: row.captured ? { ...row.captured, geometryFingerprint: `Legacy geometry rebuilt; recapture. ${row.captured.geometryFingerprint}` } : undefined };
  });
  // Range entries reference entire saved documents. Only the exact source document link is updated.
  if (target.rangePlan) target.rangePlan.styles = target.rangePlan.styles.map(style => style.patternId === source.id ? { ...style, patternId: target.id } : style);
  // Restore annotations only when all endpoints resolve through one proven piece frame and each
  // endpoint has one exact target point. Shared anchors/multiple owners remain unresolved.
  const ownership = (piece: Piece) => new Set([...piece.mainPaths, ...piece.internalPaths].flatMap(edge => sourcePaths.get(edge.path)?.pathPoints.map(point => point.id) ?? []));
  const sourceOwners = source.pieces.map(piece => ({ piece, ids: ownership(piece) }));
  const annotations = (source.measurements ?? []).flatMap(annotation => {
    const endpointIds = [annotation.fromPointId, annotation.toPointId, ...(annotation.viaPointId ? [annotation.viaPointId] : [])];
    const owners = sourceOwners.filter(owner => endpointIds.every(id => owner.ids.has(id)));
    if (owners.length !== 1 || !ownerMap.has(owners[0].piece.id)) return [];
    const mapping = ownerMap.get(owners[0].piece.id)!;
    const targetIds = new Set([...mapping.piece.mainPaths, ...mapping.piece.internalPaths].flatMap(edge => targetPaths.get(edge.path)?.pathPoints.map(point => point.id) ?? []));
    const points = [...targetIds].map(id => targetPoints.get(id)).filter((point): point is ConstrainablePoint => !!point);
    const remapped = endpointIds.map(id => {
      const point = sourcePoints.get(id); if (!point) return null;
      const position = mapping.map(point), matches = points.filter(candidate => close(candidate, position, 1e-5));
      return matches.length === 1 ? matches[0].id : null;
    });
    if (remapped.some(id => !id)) return [];
    return [{ ...structuredClone(annotation), fromPointId: remapped[0]!, toPointId: remapped[1]!, viaPointId: annotation.viaPointId ? remapped[2]! : annotation.viaPointId }];
  });
  if (annotations.length) target.measurements = annotations;
}

function slot(color: string) {
  return { url: '', mediaId: null, color, scale: 100, normalUrl: '', normalMediaId: null, normalMapScale: 100, opacityUrl: '', opacityMediaId: null, opacityMapScale: 100 };
}

function arrangementBase() {
  return {
    mode: 'curved' as const,
    cylinderName: 'Torso',
    uDegrees: 0,
    v: 0.55,
    uOffsetMm: 0,
    vOffsetMm: 0,
    radialOffsetMm: 0,
    use2DPosition: false,
    positionChanged: false,
    matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    position: [0, 0, 0]
  };
}

function pencilSkirtArrangement(pieceIndex: number) {
  const base = arrangementBase();
  switch (pieceIndex) {
    case 0: return { ...base, uDegrees: 0, v: 1.08, vOffsetMm: -127 };
    case 1: return { ...base, uDegrees: 180, v: 1.08, vOffsetMm: -127 };
    case 2: return { ...base, uDegrees: 0, v: 0.62 };
    default: return { ...base, uDegrees: 180, v: 0.63 };
  }
}

function pencilSkirtSeams(piecePathIds: string[][]): Seam[] {
  const ref = (piece: number, edge: number) => ({
    id: piecePathIds[piece][edge],
    mirrored: false,
    reversed: false
  });
  const seam = (id: string, from: Array<[number, number]>, to: Array<[number, number]>): Seam => ({
    id,
    name: '',
    fromPaths: from.map(([piece, edge]) => ref(piece, edge)),
    toPaths: to.map(([piece, edge]) => ref(piece, edge))
  });

  return [
    // Front/back side seams are split at the transition from straight skirt to hip curve.
    seam('LegacySkirt_SideRightLower', [[0, 1]], [[1, 15]]),
    seam('LegacySkirt_SideRightUpper', [[0, 2]], [[1, 14]]),
    seam('LegacySkirt_SideLeftLower', [[0, 14]], [[1, 2]]),
    seam('LegacySkirt_SideLeftUpper', [[0, 13]], [[1, 3]]),
    // Four darts close within their owning panel.
    seam('LegacySkirt_FrontDartRight', [[0, 4]], [[0, 5]]),
    seam('LegacySkirt_FrontDartLeft', [[0, 10]], [[0, 11]]),
    seam('LegacySkirt_BackDartRight', [[1, 5]], [[1, 6]]),
    seam('LegacySkirt_BackDartLeft', [[1, 11]], [[1, 12]]),
    // Waistband lower edges sew to the skirt waist, skipping the dart intake.
    seam('LegacySkirt_FrontWaistband', [[2, 1], [2, 2], [2, 3], [2, 4]], [[0, 3], [0, 6], [0, 7], [0, 8], [0, 9], [0, 12]]),
    seam('LegacySkirt_BackWaistband', [[3, 2], [3, 3], [3, 4], [3, 5]], [[1, 4], [1, 7], [1, 8], [1, 9], [1, 10], [1, 13]]),
    // Close both waistband side edges.
    seam('LegacySkirt_WaistbandRight', [[2, 0]], [[3, 6]]),
    seam('LegacySkirt_WaistbandLeft', [[2, 5]], [[3, 1]])
  ];
}

function inferArrangement(trousers: boolean, isLeg: boolean, leftSide: boolean, legOrdinal: number, cx: number, gMinX: number, gMaxX: number, pieceName = '') {
  // Torso cylinder runs neck(v=0) -> hips(v=1); leg cylinders run hip(v=0) -> knee(v=1).
  const base = { ...arrangementBase(), radialOffsetMm: 10 };
  if (isLeg) {
    // Common panel names exported by the source carry more information than their arbitrary 2D
    // position. Centre/side front/back panels are distributed around the correct leg instead of
    // stacking at only 0° and 180° (the cause of the pants import's exploded 3D preview).
    const normalized = pieceName.trim().toLowerCase();
    const namedPanel = /^(?:copy of )?(?:c[bf]|s[bf]|piece)(?:\s+(?:left|right))?$/.test(normalized);
    if (namedPanel) {
      const right = normalized.includes('right') || normalized.startsWith('copy of ');
      const panel = normalized.replace(/^copy of /, '').replace(/\s+(?:left|right)$/, '');
      const magnitude = panel.startsWith('c') ? (panel === 'cb' ? 165 : 15)
        : panel.startsWith('s') ? (panel === 'sb' ? 115 : 65)
        : 65;
      const uDegrees = right ? -magnitude : magnitude;
      return {
        ...base,
        mode: 'flat',
        cylinderName: right ? 'RightUpperLeg' : 'LeftUpperLeg',
        uDegrees,
        v: 0.58,
        radialOffsetMm: 18
      };
    }
    // two panels per leg: first -> front (u 0), second -> back (u 180)
    return { ...base, cylinderName: leftSide ? 'LeftUpperLeg' : 'RightUpperLeg', uDegrees: legOrdinal % 2 === 0 ? 0 : 180, v: 0.45 };
  }
  if (trousers) {
    // waistband: wrap the hips (bottom of the torso cylinder)
    const normalized = pieceName.trim().toLowerCase();
    return { ...base, cylinderName: 'Torso', uDegrees: normalized === 'f' ? 0 : normalized === 'b' ? 180 : (leftSide ? 0 : 180), v: 0.92 };
  }
  // generic garment (dress/top): wrap around the torso, u from x-position, sit mid-torso
  const u = ((cx - (gMinX + gMaxX) / 2) / Math.max(1, gMaxX - gMinX)) * 180;
  return { ...base, cylinderName: 'Torso', uDegrees: u, v: 0.55 };
}
