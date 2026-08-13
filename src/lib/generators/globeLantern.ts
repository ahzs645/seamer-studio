// Globe lantern generator: parameters in, a full Pattern out.
//
// Two constructions produce the same globe and the choice is not cosmetic. A HELIX is one
// continuous ribbon whose flat shape is a double spiral, split into mat-sized pieces only because
// cutters are small; its seam is one long spiral. STACKED RINGS are separate closed bands, each an
// annular sector, joined by ordinary ring-to-ring seams. Rings are much less fiddly to sew, and
// nothing in the brief requires a helix — so both are built and the choice stays with the maker.
//
// The wire is the structure and the cloth is the skin. Each coil's upper edge carries a wire
// channel, which is what produces the ribbed lantern look — stiff helical ribs with the cloth
// bulging slightly between them — and what makes the form hold at all. Because the flat cut edge
// already carries the correct in-plane curvature, straight wire fed into the channel takes that
// curve on its own: forming is pure out-of-plane bending, the easy direction to bend by hand.

import {
  createEmptyPattern,
  type Assembly,
  type ConstrainablePath,
  type ConstrainablePoint,
  type Material,
  type Pattern,
  type Piece,
  type PiecePath,
  type Seam,
  type WireChannel
} from '@seamer/pattern-model';
import {
  developRing,
  helixAtCoil,
  helixOffset,
  integrateHelix,
  meridian,
  openingSpan,
  ringFlatPoint,
  sampleMeridian,
  surfacePoint,
  TAU,
  type HelixCurve,
  type Meridian,
  type Vec2
} from './globeLanternGeometry';

export type GlobeLanternMode = 'helix' | 'rings';

export interface GlobeLanternParams {
  mode: GlobeLanternMode;
  /** Outside diameter of the finished globe (mm). */
  width: number;
  /** Outside height of the finished globe (mm). */
  height: number;
  /** Ring diameter of the top opening (mm). */
  topOpen: number;
  /** Ring diameter of the bottom opening (mm). */
  botOpen: number;
  /** Finished strip width — what shows between seams (mm). */
  strip: number;
  /** Seam allowance on ordinary edges (mm). */
  seamAllowance: number;
  /** Extra cut width on the wire edge, folded back over the wire (mm). */
  channelWidth: number;
  wireDiameter: number;
  /** 0..100 — how hard the wire holds its curve. */
  wireStiffness: number;
  /** g/m of wire. Annealed aluminium at 1.5 mm is about 4.8. */
  wireLinearMass: number;
  /** Usable cutting-mat area (mm). Helix pieces are split to fit; rings are not split. */
  matWidth: number;
  matLength: number;
  /** Overlap at piece joins (mm) — carried into the join seam allowance. */
  join: number;
}

export const DEFAULT_GLOBE_LANTERN: GlobeLanternParams = {
  mode: 'rings',
  width: 300,
  height: 300,
  topOpen: 60,
  botOpen: 90,
  strip: 28,
  seamAllowance: 6,
  channelWidth: 8,
  wireDiameter: 1.5,
  wireStiffness: 85,
  wireLinearMass: 4.8,
  matWidth: 292,
  matLength: 597,
  join: 20
};

export interface GlobeLanternStats {
  mode: GlobeLanternMode;
  coils: number;
  /** Total sewn strip length (mm) — the helix ribbon, or the rings' circumferences summed. */
  stripLength: number;
  /** Helical/ring wire plus the two openings (mm). */
  wireLength: number;
  hoopLengths: [number, number];
  fabricArea: number; // m²
  pieceCount: number;
  seamCount: number;
  /** Worst per-coil seam ease the fabric has to take up (fraction). Helix only. */
  ease: number;
  oversizePieces: number;
}

export interface GlobeLanternResult {
  pattern: Pattern;
  stats: GlobeLanternStats;
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 *  Intermediate form — polylines and 2D->3D samples, before the schema
 * ------------------------------------------------------------------ */

interface GenEdge {
  key: string;
  name: string;
  poly: Vec2[];
  wire?: WireChannel;
  seamAllowance?: number;
}

interface GenPiece {
  key: string;
  name: string;
  edges: GenEdge[];
  /** stride 5: x2d(mm), y2d(mm), x3d(m), y3d(m), z3d(m) */
  samples: number[];
  particleDistance: number;
}

interface GenSeamRef { edge: string; reversed?: boolean }
interface GenSeam { key: string; name: string; from: GenSeamRef; to: GenSeamRef; step: string }

interface GenModel {
  pieces: GenPiece[];
  seams: GenSeam[];
  stepOrder: { id: string; label: string }[];
  stats: GlobeLanternStats;
  warnings: string[];
}

const AZIMUTH_STEPS = 96;

function wireChannel(params: GlobeLanternParams, closed: boolean): WireChannel {
  return {
    channelWidth: params.channelWidth,
    diameter: params.wireDiameter,
    stiffness: params.wireStiffness,
    linearMass: params.wireLinearMass,
    closed
  };
}

function polylineLength(poly: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < poly.length; i++) total += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
  return total;
}

function bbox(points: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function translate(piece: GenPiece, dx: number, dy: number): void {
  for (const edge of piece.edges) for (const p of edge.poly) { p.x += dx; p.y += dy; }
  for (let i = 0; i < piece.samples.length; i += 5) { piece.samples[i] += dx; piece.samples[i + 1] += dy; }
}

/** Stack the pieces down the plan so nothing overlaps and the layout reads in sewing order. */
function layOut(pieces: GenPiece[]): void {
  let cursorY = 0;
  for (const piece of pieces) {
    const box = bbox(piece.edges.flatMap((e) => e.poly));
    translate(piece, -box.minX, -box.minY + cursorY);
    cursorY += box.h + 20;
  }
}

/* ------------------------------------------------------------------ *
 *  RINGS
 * ------------------------------------------------------------------ */

function buildRings(params: GlobeLanternParams, M: Meridian, mS: number, mE: number): GenModel {
  const w = params.strip;
  const warnings: string[] = [];
  const pieces: GenPiece[] = [];
  const seams: GenSeam[] = [];
  const stepOrder: { id: string; label: string }[] = [];

  const bandCount = Math.max(2, Math.round((mE - mS) / w));
  const bandArc = (mE - mS) / bandCount;
  if (Math.abs(bandArc - w) > w * 0.02) {
    warnings.push(
      `Strip width rounded to ${bandArc.toFixed(1)} mm so ${bandCount} rings fill the globe exactly.`
    );
  }

  const bands = Array.from({ length: bandCount }, (_, k) => ({
    m0: mS + k * bandArc,
    m1: mS + (k + 1) * bandArc,
    dev: developRing(M, mS + k * bandArc, mS + (k + 1) * bandArc)
  }));

  /** Flat extent of one arc of a band, cut allowances included. */
  const arcExtent = (band: typeof bands[number], segments: number) => {
    const grow = params.seamAllowance + params.channelWidth;
    const pts: Vec2[] = [];
    for (let i = 0; i <= 48; i++) {
      const psi = (i / 48 / segments) * TAU;
      pts.push(ringFlatPoint(band.dev, band.m0, psi), ringFlatPoint(band.dev, band.m1, psi));
    }
    const box = bbox(pts);
    return { w: box.w + 2 * grow, h: box.h + 2 * grow };
  };

  // A closed ring 942 mm around does not fit a 12x24" mat, so rings split into arcs like the helix
  // splits into lengths — the extra joins are the price of a cutter. One segment count for every
  // band, because ring-to-ring seams pair segment i to segment i and that only works if the two
  // rings are divided the same way.
  const pad = 12;
  const matLong = params.matLength - pad;
  const matShort = params.matWidth - pad;
  let segments = 1;
  while (segments < 64) {
    const fitsAll = bands.every((band) => {
      const e = arcExtent(band, segments);
      return (e.w <= matLong && e.h <= matShort) || (e.h <= matLong && e.w <= matShort);
    });
    if (fitsAll) break;
    segments++;
  }
  const oversize = bands.filter((band) => {
    const e = arcExtent(band, segments);
    return !((e.w <= matLong && e.h <= matShort) || (e.h <= matLong && e.w <= matShort));
  }).length;
  if (segments > 1) {
    warnings.push(
      `Each ring is cut in ${segments} arcs to fit the mat, so every ring carries ${segments} joins instead of one.`
    );
  }

  let stripLength = 0;
  let fabricArea = 0;

  for (let k = 0; k < bandCount; k++) {
    const { m0, m1, dev } = bands[k];
    const isTop = k === 0;
    const isBottom = k === bandCount - 1;
    const steps = Math.max(8, Math.round(AZIMUTH_STEPS / segments));

    for (let sgi = 0; sgi < segments; sgi++) {
      const psi0 = (sgi / segments) * TAU;
      const psi1 = ((sgi + 1) / segments) * TAU;
      const key = `ring${k}s${sgi}`;
      const label = segments === 1 ? `Ring ${k + 1}` : `Ring ${k + 1} arc ${sgi + 1}`;

      const upper: Vec2[] = [];
      const lower: Vec2[] = [];
      for (let i = 0; i <= steps; i++) {
        const psi = psi0 + ((psi1 - psi0) * i) / steps;
        upper.push(ringFlatPoint(dev, m0, psi));
        lower.push(ringFlatPoint(dev, m1, psi));
      }
      const endB = [upper[upper.length - 1], lower[lower.length - 1]].map((p) => ({ ...p }));
      const endA = [lower[0], upper[0]].map((p) => ({ ...p }));

      // loop: upper psi0->psi1, end at psi1 (m0->m1), lower psi1->psi0, end at psi0 (m1->m0)
      const edges: GenEdge[] = [
        {
          key: `${key}-upper`,
          name: isTop ? 'Top opening' : `${label} upper`,
          poly: upper,
          wire: wireChannel(params, segments === 1 && isTop),
          seamAllowance: params.seamAllowance + params.channelWidth
        },
        { key: `${key}-endB`, name: `${label} join (end)`, poly: endB },
        { key: `${key}-lower`, name: isBottom ? 'Bottom opening' : `${label} lower`, poly: lower.slice().reverse() },
        { key: `${key}-endA`, name: `${label} join (start)`, poly: endA }
      ];
      if (isBottom) {
        edges[2].wire = wireChannel(params, segments === 1);
        edges[2].seamAllowance = params.seamAllowance + params.channelWidth;
      }

      // 2D -> 3D samples across the band, so the studio shows the globe before anything simulates.
      const samples: number[] = [];
      const rows = 4;
      for (let ri = 0; ri <= rows; ri++) {
        const m = m0 + ((m1 - m0) * ri) / rows;
        for (let i = 0; i <= steps; i++) {
          const psi = psi0 + ((psi1 - psi0) * i) / steps;
          const flat = ringFlatPoint(dev, m, psi);
          const p3 = surfacePoint(M, m, psi);
          samples.push(flat.x, flat.y, p3.x / 1000, p3.y / 1000, p3.z / 1000);
        }
      }

      pieces.push({
        key,
        name: label,
        edges,
        samples,
        particleDistance: Math.max(4, Math.min(10, bandArc / 3))
      });

      stripLength += polylineLength(upper);
      fabricArea += (polylineLength(upper) * (bandArc + 2 * params.seamAllowance + params.channelWidth)) / 1e6;

      // close the ring: this arc's end joins the next arc's start, wrapping at the last
      const nextSeg = (sgi + 1) % segments;
      seams.push({
        key: `${key}-join`,
        name: segments === 1 ? `Ring ${k + 1} join` : `${label} to arc ${nextSeg + 1}`,
        from: { edge: `${key}-endB` },
        to: { edge: `ring${k}s${nextSeg}-endA`, reversed: true },
        step: `ring-${k}`
      });

      if (k > 0) {
        seams.push({
          key: `${key}-to-prev`,
          name: `Ring ${k} to ring ${k + 1}${segments === 1 ? '' : ` (arc ${sgi + 1})`}`,
          from: { edge: `ring${k - 1}s${sgi}-lower`, reversed: true },
          to: { edge: `${key}-upper` },
          step: `join-${k}`
        });
      }
    }

    stepOrder.push({ id: `ring-${k}`, label: `Close ring ${k + 1}` });
    if (k > 0) stepOrder.push({ id: `join-${k}`, label: `Join ring ${k} to ring ${k + 1}` });
  }

  // steps must run in sewing order: close a ring, then join it to the one above
  stepOrder.sort((a, b) => {
    const rank = (id: string) => {
      const [kind, index] = id.split('-');
      return Number(index) * 2 + (kind === 'ring' ? 0 : 1);
    };
    return rank(a.id) - rank(b.id);
  });

  if (oversize > 0) {
    warnings.push(
      `${oversize} ring${oversize === 1 ? '' : 's'} still exceed the mat at ${segments} arcs. Widen the mat, or cut those by hand.`
    );
  }

  layOut(pieces);

  const topR = sampleMeridian(M, mS).r;
  const botR = sampleMeridian(M, mE).r;
  return {
    pieces,
    seams,
    stepOrder,
    warnings,
    stats: {
      mode: 'rings',
      coils: bandCount,
      stripLength,
      wireLength: stripLength,
      hoopLengths: [TAU * topR, TAU * botR],
      fabricArea,
      pieceCount: pieces.length,
      seamCount: seams.length,
      ease: 0,
      oversizePieces: oversize * segments
    }
  };
}

/* ------------------------------------------------------------------ *
 *  HELIX
 * ------------------------------------------------------------------ */

/** Largest piece span, in coils. See `helixSplits` for why it cannot reach a full turn. */
const MAX_PIECE_COILS = 0.75;

/**
 * Where to break the ribbon.
 *
 * Two constraints, and the first is not obvious. Consecutive turns of the developed spiral sit
 * |rho(m+w) - rho(m)| apart, which on a sphere is w*sec^2(phi) — never less than the finished width,
 * but AT the equator exactly equal to it. The turns are tangent there: the ribbon tiles the plane
 * with no gap. So a piece spanning a whole turn has a boundary that touches itself, and no
 * triangulator can mesh it. Pieces therefore stop short of one coil regardless of mat size.
 *
 * Second, the seam. An upper edge spanning [c, d] is sewn to the lower edge spanning [c+1, d+1], so
 * unless every split has a partner exactly one coil away the two sides of the spiral seam stop
 * lining up. Splitting at multiples of 1/K makes that closure automatic — 1/K divides 1 — which is
 * why the subdivision is uniform rather than chosen per piece.
 */
function helixSplits(curve: HelixCurve, params: GlobeLanternParams): { splits: number[]; breaks: number[]; tooBig: number } {
  const w = params.strip;
  const hp = w / 2 + params.seamAllowance + params.channelWidth;
  const hm = w / 2 + params.seamAllowance;
  const pad = 6;
  const matLong = params.matLength - pad * 2;
  const matShort = params.matWidth - pad * 2;
  const maxCoil = curve.stations[curve.stations.length - 1].coil;

  /** Extent of the cut outline over [c0, c1], measured along its own chord. */
  const extent = (c0: number, c1: number): { long: number; short: number } => {
    const a = helixAtCoil(curve, c0);
    const b = helixAtCoil(curve, c1);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const steps = 120;
    for (let i = 0; i <= steps; i++) {
      const st = helixAtCoil(curve, c0 + ((c1 - c0) * i) / steps);
      for (const u of [hp, -hm]) {
        const p = helixOffset(st, u);
        const dx = p.x - a.x, dy = p.y - a.y;
        const rx = dx * cos - dy * sin;
        const ry = dx * sin + dy * cos;
        if (rx < minX) minX = rx;
        if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry;
        if (ry > maxY) maxY = ry;
      }
    }
    return { long: maxX - minX, short: maxY - minY };
  };
  const fits = (c0: number, c1: number): boolean => {
    if (c1 - c0 > MAX_PIECE_COILS + 1e-9) return false;
    const e = extent(c0, c1);
    return e.long <= matLong && e.short <= matShort;
  };

  // Uniform subdivision fine enough that a single segment fits the mat everywhere.
  let K = 4;
  const segmentFits = (k: number): boolean => {
    for (let i = 0; i < Math.ceil(maxCoil * k); i++) {
      const c0 = i / k;
      const c1 = Math.min((i + 1) / k, maxCoil);
      if (c1 - c0 < 1e-9) continue;
      const e = extent(c0, c1);
      if (e.long > matLong || e.short > matShort) return false;
    }
    return true;
  };
  while (K < 64 && !segmentFits(K)) K *= 2;

  const quantum = 1 / K;
  const splits: number[] = [];
  for (let i = 0; i * quantum < maxCoil - 1e-9; i++) splits.push(i * quantum);
  splits.push(maxCoil);

  // Greedily group segments into pieces: as many as fit the mat and stay under a turn.
  const breaks: number[] = [0];
  let start = 0;
  let tooBig = 0;
  while (start < splits.length - 1) {
    let end = start + 1;
    while (end < splits.length - 1 && fits(splits[start], splits[end + 1])) end++;
    if (end === start + 1 && !fits(splits[start], splits[end])) tooBig++;
    if (splits[end] < maxCoil - 1e-9) breaks.push(splits[end]);
    start = end;
  }
  breaks.push(maxCoil);

  return {
    splits,
    breaks: [...new Set(breaks.map((b) => Math.round(b * 1e6) / 1e6))].sort((p, q) => p - q),
    tooBig
  };
}

function buildHelix(params: GlobeLanternParams, M: Meridian, mS: number, mE: number): GenModel | null {
  const w = params.strip;
  const curve = integrateHelix(M, w, mS, mE);
  if (!curve) return null;

  const warnings: string[] = [];
  const { splits, breaks, tooBig } = helixSplits(curve, params);
  if (tooBig > 0) {
    warnings.push(
      `${tooBig} piece${tooBig === 1 ? '' : 's'} still exceed the mat at the finest subdivision. Widen the mat or the strip.`
    );
  }

  // segment j spans splits[j]..splits[j+1]; pieces group consecutive segments between breaks
  const segCount = splits.length - 1;
  const breakIndex = (c: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < splits.length; i++) {
      const d = Math.abs(splits[i] - c);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  const pieceStarts = [...new Set(breaks.map(breakIndex))].sort((p, q) => p - q).filter((i) => i < segCount);
  if (pieceStarts[0] !== 0) pieceStarts.unshift(0);
  const maxCoil = splits[splits.length - 1];

  const sampleEdge = (c0: number, c1: number, u: number): Vec2[] => {
    const steps = Math.max(6, Math.ceil((c1 - c0) * 64));
    const out: Vec2[] = [];
    for (let i = 0; i <= steps; i++) out.push(helixOffset(helixAtCoil(curve, c0 + ((c1 - c0) * i) / steps), u));
    return out;
  };

  const pieces: GenPiece[] = [];
  const seams: GenSeam[] = [];
  const stepOrder: { id: string; label: string }[] = [];
  const upperKeyBySeg: string[] = new Array(segCount);
  const lowerKeyBySeg: string[] = new Array(segCount);

  for (let pi = 0; pi < pieceStarts.length; pi++) {
    const segA = pieceStarts[pi];
    const segB = (pi + 1 < pieceStarts.length ? pieceStarts[pi + 1] : segCount) - 1;
    if (segB < segA) continue;
    const key = `strip${pi}`;
    const upperEdges: GenEdge[] = [];
    const lowerEdges: GenEdge[] = [];

    for (let j = segA; j <= segB; j++) {
      const c0 = splits[j];
      const c1 = splits[j + 1];
      const upKey = `${key}-u${j}`;
      const loKey = `${key}-l${j}`;
      upperKeyBySeg[j] = upKey;
      lowerKeyBySeg[j] = loKey;
      upperEdges.push({
        key: upKey,
        name: `Coil ${c0.toFixed(2)}–${c1.toFixed(2)} upper`,
        poly: sampleEdge(c0, c1, w / 2),
        wire: wireChannel(params, false),
        seamAllowance: params.seamAllowance + params.channelWidth
      });
      lowerEdges.push({ key: loKey, name: `Coil ${c0.toFixed(2)}–${c1.toFixed(2)} lower`, poly: sampleEdge(c0, c1, -w / 2) });
    }

    const cStart = splits[segA];
    const cEnd = splits[segB + 1];
    const endCap: Vec2[] = [helixOffset(helixAtCoil(curve, cEnd), w / 2), helixOffset(helixAtCoil(curve, cEnd), -w / 2)];
    const startCap: Vec2[] = [helixOffset(helixAtCoil(curve, cStart), -w / 2), helixOffset(helixAtCoil(curve, cStart), w / 2)];

    const edges: GenEdge[] = [
      ...upperEdges,
      { key: `${key}-end`, name: 'Piece join (end)', poly: endCap, seamAllowance: params.seamAllowance + params.join / 2 },
      ...lowerEdges.slice().reverse().map((e) => ({ ...e, poly: e.poly.slice().reverse() })),
      { key: `${key}-start`, name: 'Piece join (start)', poly: startCap, seamAllowance: params.seamAllowance + params.join / 2 }
    ];

    const samples: number[] = [];
    const rows = 3;
    const cols = Math.max(8, Math.ceil((cEnd - cStart) * 48));
    for (let ci = 0; ci <= cols; ci++) {
      const st = helixAtCoil(curve, cStart + ((cEnd - cStart) * ci) / cols);
      for (let ri = 0; ri <= rows; ri++) {
        const u = -w / 2 + (w * ri) / rows;
        const flat = helixOffset(st, u);
        const p3 = surfacePoint(M, st.m + u, st.psi);
        samples.push(flat.x, flat.y, p3.x / 1000, p3.y / 1000, p3.z / 1000);
      }
    }

    pieces.push({
      key,
      name: `Piece ${pi + 1}`,
      edges,
      samples,
      particleDistance: Math.max(4, Math.min(10, w / 3))
    });
  }

  // The spiral seam: upper span [c, d] meets the lower span one coil along. Split closure
  // guarantees the partner span exists and is a single segment.
  for (let j = 0; j < segCount; j++) {
    const c0 = splits[j];
    const partner = splits.findIndex((c) => Math.abs(c - (c0 + 1)) < 1e-4);
    if (partner < 0 || partner >= segCount) continue;
    if (!upperKeyBySeg[j] || !lowerKeyBySeg[partner]) continue;
    const coil = Math.floor(c0);
    const step = `coil-${coil}`;
    if (!stepOrder.some((s) => s.id === step)) stepOrder.push({ id: step, label: `Wind on coil ${coil + 1}` });
    seams.push({
      key: `spiral-${j}`,
      name: `Spiral seam ${c0.toFixed(2)}–${splits[j + 1].toFixed(2)}`,
      from: { edge: upperKeyBySeg[j] },
      to: { edge: lowerKeyBySeg[partner] },
      step
    });
  }

  for (let pi = 1; pi < pieces.length; pi++) {
    const step = 'piece-joins';
    if (!stepOrder.some((s) => s.id === step)) stepOrder.unshift({ id: step, label: 'Join the pieces end to end' });
    seams.push({
      key: `piecejoin-${pi}`,
      name: `Join piece ${pi} to piece ${pi + 1}`,
      from: { edge: `strip${pi - 1}-end` },
      to: { edge: `strip${pi}-start`, reversed: true },
      step
    });
  }

  layOut(pieces);

  if (pieces.length > 40) {
    warnings.push(`${pieces.length} pieces. A wider strip or a bigger mat cuts that down sharply.`);
  }
  warnings.push(
    'The pattern is a double spiral: it curves one way above the equator, straightens, and curves back below it. Do not mirror one half.'
  );

  const topR = sampleMeridian(M, mS).r;
  const botR = sampleMeridian(M, mE).r;
  const fabricArea = (curve.length * (w + params.seamAllowance * 2 + params.channelWidth)) / 1e6;
  return {
    pieces,
    seams,
    stepOrder,
    warnings,
    stats: {
      mode: 'helix',
      coils: curve.turns,
      stripLength: curve.length,
      wireLength: curve.length * 1.02,
      hoopLengths: [TAU * topR, TAU * botR],
      fabricArea,
      pieceCount: pieces.length,
      seamCount: seams.length,
      ease: curve.ease,
      oversizePieces: 0
    }
  };
}

/* ------------------------------------------------------------------ *
 *  Intermediate form -> Pattern
 * ------------------------------------------------------------------ */

function toPattern(model: GenModel, params: GlobeLanternParams): Pattern {
  const pattern = createEmptyPattern();
  pattern.name = `Globe lantern ${Math.round(params.width)}×${Math.round(params.height)}`;
  pattern.seamAllowance = params.seamAllowance;
  pattern.enable3d = true;
  pattern.settings3d.showSeams = true;
  pattern.settings3d.avatarEnabled = false;
  pattern.settings3d.showAvatar = false;

  const points: ConstrainablePoint[] = [];
  const paths: ConstrainablePath[] = [];
  const pieces: Piece[] = [];
  const seams: Seam[] = [];

  const pointIds = new Map<string, string>();
  const pointId = (p: Vec2): string => {
    const key = `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
    const existing = pointIds.get(key);
    if (existing) return existing;
    const id = `GLPoint_${points.length}`;
    pointIds.set(key, id);
    points.push({ id, name: id, x: p.x, y: p.y });
    return id;
  };

  const material: Material = {
    ...(pattern.materials[0] ?? ({} as Material)),
    id: 'GLMaterial',
    name: 'Lantern cloth',
    frontTexture: null,
    backTexture: null,
    useSeparateBackSide: false,
    stretchWarpValue: 18,
    stretchWeftValue: 18,
    bendValue: 6,
    thickness: 0.25,
    weight: 90,
    roughness: 0.85,
    metalness: 0,
    specularIntensity: 0.2,
    opacity: 1,
    normalScale: 1,
    alphaCutoff: 0.5,
    libraryItemId: null,
    libraryVersion: null,
    libraryUpdatedAt: null
  };
  pattern.materials = [material];

  const originId = 'GLOrigin';
  points.push({ id: originId, name: 'origin', x: 0, y: 0 });

  const edgeToPiecePath = new Map<string, string>();

  for (const gp of model.pieces) {
    const mainPaths: PiecePath[] = [];
    for (const edge of gp.edges) {
      if (edge.poly.length < 2) continue;
      const pathId = `GLPath_${edge.key}`;
      const pathPoints = edge.poly.map((p) => ({ id: pointId(p) }));
      paths.push({
        id: pathId,
        name: edge.name,
        pathType: 'line',
        pathPoints,
        basePoint: pathPoints[0].id,
        version: 1
      });
      const ppId = `GLPP_${edge.key}`;
      edgeToPiecePath.set(edge.key, ppId);
      mainPaths.push({
        id: ppId,
        name: edge.name,
        path: pathId,
        from: pathPoints[0].id,
        to: pathPoints[pathPoints.length - 1].id,
        reversed: false,
        notches: [],
        ...(edge.seamAllowance !== undefined ? { seamAllowance: edge.seamAllowance } : {}),
        ...(edge.wire ? { wire: edge.wire } : {})
      });
    }
    if (mainPaths.length < 3) continue;

    pieces.push({
      id: `GLPiece_${gp.key}`,
      name: gp.name,
      label: null,
      type: 'dynamic',
      materialId: material.id,
      origin: { id: `GLO_${gp.key}`, name: '', x: 0, y: 0 },
      originPoint: originId,
      position: { x: 0, y: 0 },
      rotation: 0,
      grainVector: { id: `GLG_${gp.key}`, name: '', x: 0, y: 1 },
      text: null,
      rightPieces: 1,
      leftPieces: 0,
      mirrorLeftPiecesAxis: 'X',
      mirrorX: false,
      mirrorY: false,
      seamAllowanceInside: false,
      hideEditorPoints: true,
      mainPaths,
      internalPaths: [],
      settings3d: {
        arrangement: {
          mode: 'flat',
          cylinderName: '',
          uDegrees: 0,
          v: 0.5,
          uOffsetMm: 0,
          vOffsetMm: 0,
          radialOffsetMm: 0,
          use2DPosition: true,
          positionChanged: false,
          matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          position: [0, 0, 0]
        },
        enable3d: true,
        frozen: false,
        flipNormals: false,
        filterExternalCollisionsByClothNormal: false,
        collisionLayer: 0,
        particleDistance: gp.particleDistance,
        // The generator knows exactly where every point of the flat piece lands on the globe, so it
        // ships that map as the piece's drape. The studio then shows the finished lantern straight
        // away and the solver only has to relax it, instead of being asked to fold a sphere out of
        // a flat spiral — which nothing in the physics would drive it to do.
        savedPositions: gp.samples
      }
    });
  }

  for (const gs of model.seams) {
    const from = edgeToPiecePath.get(gs.from.edge);
    const to = edgeToPiecePath.get(gs.to.edge);
    if (!from || !to) continue;
    seams.push({
      id: `GLSeam_${gs.key}`,
      name: gs.name,
      fromPaths: [{ id: from, mirrored: false, reversed: !!gs.from.reversed }],
      toPaths: [{ id: to, mirrored: false, reversed: !!gs.to.reversed }]
    });
  }

  const stepSeams = new Map<string, string[]>();
  for (const gs of model.seams) {
    const id = `GLSeam_${gs.key}`;
    if (!seams.some((s) => s.id === id)) continue;
    const list = stepSeams.get(gs.step) ?? [];
    list.push(id);
    stepSeams.set(gs.step, list);
  }
  const assembly: Assembly = {
    steps: model.stepOrder
      .filter((step) => (stepSeams.get(step.id)?.length ?? 0) > 0)
      .map((step) => ({ id: step.id, label: step.label, seamIds: stepSeams.get(step.id)! })),
    settleFrames: 10
  };

  pattern.points = points;
  pattern.paths = paths;
  pattern.pieces = pieces;
  pattern.seams = seams;
  pattern.assembly = assembly;
  return pattern;
}

/* ------------------------------------------------------------------ *
 *  Entry point
 * ------------------------------------------------------------------ */

export function generateGlobeLantern(input: Partial<GlobeLanternParams> = {}): GlobeLanternResult {
  const params: GlobeLanternParams = { ...DEFAULT_GLOBE_LANTERN, ...input };
  const a = params.width / 2;
  const b = params.height / 2;
  const M = meridian(a, b);
  const { mS, mE } = openingSpan(M, a, params.topOpen, params.botOpen);

  if (mE - mS < params.strip * 2) {
    throw new Error('The openings leave less than two coils. Reduce them, or reduce the strip width.');
  }

  const model = params.mode === 'helix'
    ? buildHelix(params, M, mS, mE)
    : buildRings(params, M, mS, mE);
  if (!model) throw new Error('Could not integrate the strip for these parameters.');

  return {
    pattern: toPattern(model, params),
    stats: model.stats,
    warnings: model.warnings
  };
}

/** Cutting and assembly notes, mirroring what the pattern actually contains. */
export function globeLanternNotes(params: GlobeLanternParams, stats: GlobeLanternStats): string {
  const mm = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} m` : `${Math.round(v)} mm`);
  const lines = [
    `GLOBE LANTERN — ${stats.mode === 'helix' ? 'helical strip' : 'stacked rings'}`,
    '',
    `Body                ${params.width} × ${params.height} mm`,
    `Top opening         ${params.topOpen} mm      Bottom opening   ${params.botOpen} mm`,
    `Finished strip      ${params.strip} mm`,
    `Seam allowance      ${params.seamAllowance} mm; wire edge ${params.seamAllowance + params.channelWidth} mm`,
    '',
    `Coils               ${stats.coils.toFixed(1)}`,
    `Sewn length         ${mm(stats.stripLength)}`,
    `Wire                ${mm(stats.wireLength)} at ${params.wireDiameter} mm, plus hoops of ${mm(stats.hoopLengths[0])} and ${mm(stats.hoopLengths[1])}`,
    `Fabric              ${stats.fabricArea.toFixed(2)} m² of cut strip`,
    `Pieces              ${stats.pieceCount}      Seams ${stats.seamCount}`,
    ...(stats.ease > 0 ? [`Worst seam ease     ${(stats.ease * 100).toFixed(2)} % per coil (the fabric takes this up)`] : []),
    '',
    'Order of work',
    ' 1. Cut every piece. Keep them in order — they are not interchangeable.',
    ' 2. Press the wire channel back along the marked edge and stitch it, leaving the ends open.',
    ' 3. Feed the wire through as you go. It needs no in-plane bending: the cut edge already',
    '    carries the right curve, so forming is only bending out of the plane of the cloth.',
    ' 4. Sew each new coil to the coil before it, right sides together.',
    ' 5. Finish both openings with a closed wire hoop of the length above.',
    '',
    'Notes',
    ' · Stagger the wire joins away from the fabric piece joins.',
    ' · Annealed aluminium or copper around 1.2–2 mm holds a bend without fighting the form.',
    ' · Cut with the strip length on the bias if you want the seams to ease more readily.'
  ];
  return lines.join('\n');
}
