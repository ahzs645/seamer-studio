// Import the simplified Seamer export format (pieces with explicit `boundary` polylines,
// `sewLines`, `grain`, `materialId`) into the full Pattern schema used by the renderer.
//
// This format lacks 3D placement (cylinder/u/v) and seam-pairing IDs, so arrangement and seams are
// inferred heuristically: pieces are assigned to body cylinders by grain + bounding box (legs by
// x-sign for trousers, torso otherwise); sewLines are paired across pieces by matching length.

import { createEmptyPattern, type Pattern, type ConstrainablePoint, type ConstrainablePath, type Piece, type Material, type Seam, type PiecePath } from '@seamer/pattern-model';

type XY = [number, number];

interface SimplePiece {
  name: string;
  origin?: XY;
  grain?: XY;
  materialId?: string;
  boundary: XY[][]; // ordered edge segments, each a polyline
  sewLines: XY[][];
}
interface SimpleFile {
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

export function convertSimplePattern(json: SimpleFile): Pattern {
  const pattern = createEmptyPattern();
  pattern.name = json.name ?? 'Imported Pattern';
  pattern.description = json.description ?? '';
  pattern.lengthUnit = 'mm';

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
      materialsMap.set(key, {
        id: key,
        name: key,
        frontTexture: slot(PALETTE[idx % PALETTE.length]),
        backTexture: slot(PALETTE[idx % PALETTE.length]),
        useSeparateBackSide: false,
        stretchWarpValue: 12, stretchWeftValue: 14, bendValue: 5,
        thickness: 0.5, weight: 150,
        roughness: 0.85, metalness: 0.05, specularIntensity: 0.2,
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

  // classify pieces for arrangement (trousers: waistbands vs legs; front/back split per side)
  const gMidX = (gMinX + gMaxX) / 2;
  const legSeen = { left: 0, right: 0 };

  json.pieces.forEach((sp, pi) => {
    const box = pieceBox[pi];
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const h = box.maxY - box.minY;
    const w = box.maxX - box.minX;

    // boundary -> one ConstrainablePath + PiecePath per segment
    const mainPaths: PiecePath[] = [];
    const segMids: { ppId: string; mid: XY; length: number }[] = [];
    sp.boundary.forEach((seg, si) => {
      const pathId = `Path_${pi}_${si}`;
      const pathPoints = seg.map((q) => ({ id: pt(q) }));
      paths.push({ id: pathId, name: pathId, pathType: 'line', pathPoints, basePoint: pathPoints[0]?.id ?? null, version: 1 });
      const ppId = `PP_${pi}_${si}`;
      mainPaths.push({ id: ppId, name: '', path: pathId, from: pathPoints[0].id, to: pathPoints[pathPoints.length - 1].id, reversed: false, notches: [] });
      segMids.push({ ppId, mid: mid(seg), length: len(seg) });
    });

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
    const arrangement = inferArrangement(looksLikeTrousers, isLeg, leftSide, legOrdinal, cx, gMinX, gMaxX);

    const grain = sp.grain ?? [0, 1];
    pieces.push({
      id: `Piece_${pi}`,
      name: sp.name || `Piece ${pi + 1}`,
      type: 'dynamic',
      materialId: matId(sp.materialId),
      origin: { id: `O${pi}`, name: '', x: sp.origin?.[0] ?? cx, y: sp.origin?.[1] ?? cy },
      originPoint: '',
      position: { x: cx, y: cy },
      rotation: 0,
      grainVector: { id: `G${pi}`, name: '', x: grain[0], y: grain[1] },
      text: null,
      rightPieces: 1, leftPieces: 0, mirrorLeftPiecesAxis: 'X', mirrorX: false, mirrorY: false,
      seamAllowanceInside: false,
      mainPaths,
      internalPaths: [],
      settings3d: {
        arrangement,
        enable3d: true, frozen: false, flipNormals: false,
        filterExternalCollisionsByClothNormal: false, collisionLayer: 0,
        particleDistance: 22, // coarser mesh for imported garments (keeps the sim interactive)
        savedPositions: []
      }
    });
  });

  // pair sewLines across different pieces by closest length (greedy)
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

function inferArrangement(trousers: boolean, isLeg: boolean, leftSide: boolean, legOrdinal: number, cx: number, gMinX: number, gMaxX: number) {
  // Torso cylinder runs neck(v=0) -> hips(v=1); leg cylinders run hip(v=0) -> knee(v=1).
  const base = { mode: 'curved' as const, uOffsetMm: 0, vOffsetMm: 0, radialOffsetMm: 10, use2DPosition: false, positionChanged: false, matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], position: [0, 0, 0] };
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
