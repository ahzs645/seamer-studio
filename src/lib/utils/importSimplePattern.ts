// Import the simplified Seamer export format (pieces with explicit `boundary` polylines,
// `sewLines`, `grain`, `materialId`) into the full Pattern schema used by the renderer.
//
// This format lacks 3D placement (cylinder/u/v) and seam-pairing IDs. We recover preserved drafting
// edge groupings first, apply known legacy presets when the piece signature is unambiguous, and use
// conservative arrangement/seam heuristics for other files.

import { createEmptyPattern, type Pattern, type ConstrainablePoint, type ConstrainablePath, type Piece, type Material, type Seam, type PiecePath } from '@seamer/pattern-model';
import { buildPieceCloth, computeSeamEdgeIntervals } from '@seamer/cloth-sim';

type XY = [number, number];

export interface SimplePiece {
  name: string;
  origin?: XY;
  grain?: XY;
  materialId?: string;
  boundary: XY[][]; // ordered edge segments, each a polyline
  sewLines: XY[][];
}
export interface SimpleFile {
  name?: string;
  description?: string;
  pieces: SimplePiece[];
}

export function isSimpleFormat(json: unknown): json is SimpleFile {
  if (!json || typeof json !== 'object') return false;
  const o = json as Record<string, unknown>;
  return Array.isArray(o.pieces) && o.pieces.length > 0 &&
    !!(o.pieces[0] as Record<string, unknown>)?.boundary && !Array.isArray((o.pieces[0] as Record<string, unknown>)?.mainPaths);
}

/** Reject an import before it replaces the editor document when its enabled 3D pieces cannot be
 * triangulated. This uses the same boundary builder and seam interval allocation as the renderer. */
export function assertPatternBuildable3d(pattern: Pattern): void {
  if (pattern.enable3d === false) return;
  const enabled = pattern.pieces.filter((piece) =>
    piece.type === 'dynamic' && piece.settings3d.enable3d !== false
  );
  if (enabled.length === 0) return;
  const intervals = computeSeamEdgeIntervals(pattern);
  for (const piece of enabled) {
    let cloth;
    try {
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

function len(poly: XY[]): number {
  let s = 0;
  for (let i = 1; i < poly.length; i++) s += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  return s;
}
function mid(poly: XY[]): XY {
  const a = poly[0], b = poly[poly.length - 1];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
function dist(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

type LegacyPreset = 'pencil-skirt' | null;

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

export function convertSimplePattern(json: SimpleFile): Pattern {
  const pattern = createEmptyPattern();
  pattern.name = json.name ?? 'Imported Pattern';
  pattern.description = json.description ?? '';
  pattern.lengthUnit = 'mm';
  const preset = detectLegacyPreset(json);

  const points: ConstrainablePoint[] = [];
  const paths: ConstrainablePath[] = [];
  const pieces: Piece[] = [];
  const materialsMap = new Map<string, Material>();
  const seams: Seam[] = [];

  // dedup points by rounded coordinate
  const pointMap = new Map<string, string>();
  let pointCounter = 0;
  const pt = (xy: XY): string => {
    const k = `${xy[0].toFixed(2)},${xy[1].toFixed(2)}`;
    const existing = pointMap.get(k);
    if (existing) return existing;
    const id = `P${pointCounter++}`;
    points.push({ id, name: id, x: xy[0], y: xy[1] });
    pointMap.set(k, id);
    return id;
  };

  const matId = (label: string | undefined): string => {
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

  // collect sewLine descriptors for global pairing
  interface SewRef { pieceIdx: number; ppId: string; length: number; midpoint: XY; }
  const allSew: SewRef[] = [];
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

    // boundary -> one ConstrainablePath + PiecePath per segment
    const mainPaths: PiecePath[] = [];
    const segMids: { ppId: string; mid: XY; length: number }[] = [];
    const currentPiecePathIds: string[] = [];
    boundaryEdges.forEach((seg, si) => {
      const pathId = `Path_${pi}_${si}`;
      const pathPoints = seg.map((q) => ({ id: pt(q) }));
      paths.push({ id: pathId, name: pathId, pathType: 'line', pathPoints, basePoint: pathPoints[0]?.id ?? null, version: 1 });
      const ppId = `PP_${pi}_${si}`;
      currentPiecePathIds.push(ppId);
      mainPaths.push({ id: ppId, name: '', path: pathId, from: pathPoints[0].id, to: pathPoints[pathPoints.length - 1].id, reversed: false, notches: [] });
      segMids.push({ ppId, mid: mid(seg), length: len(seg) });
    });
    piecePathIds.push(currentPiecePathIds);

    // map each sewLine to its nearest boundary PiecePath
    sp.sewLines.forEach((sl) => {
      const m = mid(sl);
      let best = segMids[0];
      let bd = Infinity;
      for (const s of segMids) { const d = dist(m, s.mid); if (d < bd) { bd = d; best = s; } }
      if (best) allSew.push({ pieceIdx: pi, ppId: best.ppId, length: len(sl), midpoint: m });
    });

    // heuristic arrangement
    const isLeg = looksLikeTrousers && h > 1.6 * w;
    const leftSide = cx < gMidX;
    let legOrdinal = 0;
    if (isLeg) { legOrdinal = leftSide ? legSeen.left++ : legSeen.right++; }
    const arrangement = preset === 'pencil-skirt'
      ? pencilSkirtArrangement(pi)
      : inferArrangement(looksLikeTrousers, isLeg, leftSide, legOrdinal, cx, gMinX, gMaxX);

    const grain = sp.grain ?? [0, 1];
    const origin: XY = sp.origin ?? [cx, cy];
    const originPoint = pt(origin);
    pieces.push({
      id: `Piece_${pi}`,
      name: sp.name || `Piece ${pi + 1}`,
      type: 'dynamic',
      materialId: matId(sp.materialId),
      // Legacy boundary coordinates are already in placed-plan space. Referencing the legacy
      // origin as the piece origin and placing the piece at that same coordinate makes the modern
      // piece transform an identity transform instead of translating the geometry a second time.
      origin: { id: `O${pi}`, name: '', x: origin[0], y: origin[1] },
      originPoint,
      position: { x: origin[0], y: origin[1] },
      rotation: 0,
      grainVector: { id: `G${pi}`, name: '', x: grain[0], y: grain[1] },
      text: null,
      rightPieces: 1, leftPieces: 0, mirrorLeftPiecesAxis: 'X', mirrorX: false, mirrorY: false,
      seamAllowanceInside: false,
      mainPaths,
      internalPaths: [],
      settings3d: {
        arrangement,
        enable3d: true, frozen: false, flipNormals: preset === 'pencil-skirt' && (pi === 1 || pi === 3),
        filterExternalCollisionsByClothNormal: false, collisionLayer: 0,
        particleDistance: 14,
        savedPositions: []
      }
    });
  });

  if (preset === 'pencil-skirt') {
    seams.push(...pencilSkirtSeams(piecePathIds));
  } else {
    // Pair sewLines across different pieces by closest length (fallback for unidentified files).
    const used = new Array(allSew.length).fill(false);
    for (let i = 0; i < allSew.length; i++) {
      if (used[i]) continue;
      let bestJ = -1, bestDiff = 12; // mm tolerance
      for (let j = 0; j < allSew.length; j++) {
        if (used[j] || j === i || allSew[j].pieceIdx === allSew[i].pieceIdx) continue;
        const diff = Math.abs(allSew[j].length - allSew[i].length);
        if (diff < bestDiff) { bestDiff = diff; bestJ = j; }
      }
      if (bestJ === -1) continue;
      used[i] = used[bestJ] = true;
      seams.push({
        id: `Seam_${i}`,
        name: '',
        fromPaths: [{ id: allSew[i].ppId, mirrored: false, reversed: false }],
        toPaths: [{ id: allSew[bestJ].ppId, mirrored: false, reversed: false }]
      });
    }
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
  return pattern;
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

function inferArrangement(trousers: boolean, isLeg: boolean, leftSide: boolean, legOrdinal: number, cx: number, gMinX: number, gMaxX: number) {
  // Torso cylinder runs neck(v=0) -> hips(v=1); leg cylinders run hip(v=0) -> knee(v=1).
  const base = { ...arrangementBase(), radialOffsetMm: 10 };
  if (isLeg) {
    // two panels per leg: first -> front (u 0), second -> back (u 180)
    return { ...base, cylinderName: leftSide ? 'LeftUpperLeg' : 'RightUpperLeg', uDegrees: legOrdinal % 2 === 0 ? 0 : 180, v: 0.45 };
  }
  if (trousers) {
    // waistband: wrap the hips (bottom of the torso cylinder)
    return { ...base, cylinderName: 'Torso', uDegrees: leftSide ? 0 : 180, v: 0.92 };
  }
  // generic garment (dress/top): wrap around the torso, u from x-position, sit mid-torso
  const u = ((cx - (gMinX + gMaxX) / 2) / Math.max(1, gMaxX - gMinX)) * 180;
  return { ...base, cylinderName: 'Torso', uDegrees: u, v: 0.55 };
}
