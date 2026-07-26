// Pure true-shape nesting core — no DOM, no Pattern dependency — so it runs identically on the
// main thread, in the nesting Web Worker, and under vitest.
//
// Two placement strategies:
//  - 'corners': the original bottom-left fill seeded from placed-piece bbox corners (fast, coarse).
//  - 'nfp':     no-fit-polygon vertex-contact placement. For each placed piece Q (inflated by the
//               gap) and candidate piece P, every translation t = q_vertex − p_vertex puts a vertex
//               of P in contact with a vertex of Q — exactly the vertex set of the no-fit polygon
//               NFP(Q, P) = Q ⊕ (−P). Candidates are searched bottom-left-first and validated with
//               an exact polygon-overlap test, so pieces pack tightly against each other's true
//               shapes (including into concavities) instead of their bounding boxes.
//
// The genetic search (order crossover + rotation mutation) is shared by both strategies and reports
// per-generation progress so a worker host can stream it to the UI.

export interface Vec2 { x: number; y: number }

export interface CoreItem {
  pieceId: string;
  name: string;
  /** cut polygon, normalised to (0,0) (mm) */
  cut: Vec2[];
  /** stitch outline for reference display, same space as `cut` */
  outline: Vec2[];
  instanceId: string;
  area: number;
}

export interface CorePlacement {
  pieceId: string;
  name: string;
  poly: Vec2[];
  outline: Vec2[];
  bbox: { w: number; h: number };
  rotationDeg?: number;
  instanceId?: string;
  /** multi-bin nests: which fabric sheet this piece landed on (0-based) */
  bin?: number;
}

export interface CoreLayout {
  fabricWidthMm: number;
  usedLengthMm: number;
  gapMm: number;
  placements: CorePlacement[];
  efficiency?: number;
  /** multi-bin nests: each sheet's vertical band in the continuous marker space */
  bins?: { startYmm: number; usedLengthMm: number }[];
}

export type NestStrategy = 'corners' | 'nfp';

export type NestGravity = 'bottom' | 'left' | 'right' | 'top';

export interface CoreOptions {
  fabricWidthMm: number;
  gapMm: number;
  rotations: number[];
  generations: number;
  population: number;
  strategy: NestStrategy;
  /** deterministic RNG seed (tests); omit for Math.random seeding */
  seed?: number;
  /** Douglas-Peucker tolerance (mm) for the search copies of dense cut polygons. Default 1. */
  simplifyTolMm?: number;
  /** maximum marker length per fabric sheet (mm); overflow opens a new bin. 0/undefined = unlimited */
  maxLengthMm?: number | null;
  /** which fabric edge pieces snug toward (the original's gravityDirection). Default 'bottom'. */
  gravity?: NestGravity;
}

export interface CoreProgress {
  generation: number;
  generations: number;
  bestLengthMm: number;
  efficiency: number;
}

// ---- small geometry kit (kept local so the worker bundle stays self-contained) -------------------

export function polyBounds(poly: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function rotatePoly(poly: Vec2[], deg: number): Vec2[] {
  if (deg % 360 === 0) return poly.map((p) => ({ ...p }));
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return poly.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
}

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function segIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return ((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0));
}

function pointInPoly(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.y > pt.y) !== (b.y > pt.y)) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** True iff two simple polygons overlap (edge crossing or one contains a vertex of the other). */
export function polysOverlap(a: Vec2[], b: Vec2[]): boolean {
  const ba = polyBounds(a), bb = polyBounds(b);
  if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxY < bb.minY || bb.maxY < ba.minY) return false;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return pointInPoly(a[0], b) || pointInPoly(b[0], a);
}

/** Outward offset of a simple polygon by `dist` (miter joins, clamped). */
export function offsetPoly(poly: Vec2[], dist: number, miterLimit = 4): Vec2[] {
  const n = poly.length;
  if (n < 3 || dist === 0) return poly.map((p) => ({ ...p }));
  let area = 0;
  for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a.x * b.y - b.x * a.y; }
  const ccw = area > 0;
  const unit = (x: number, y: number): Vec2 => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
    const e0 = unit(cur.x - prev.x, cur.y - prev.y);
    const e1 = unit(next.x - cur.x, next.y - cur.y);
    const n0 = ccw ? { x: e0.y, y: -e0.x } : { x: -e0.y, y: e0.x };
    const n1 = ccw ? { x: e1.y, y: -e1.x } : { x: -e1.y, y: e1.x };
    const denom = 1 + (n0.x * n1.x + n0.y * n1.y);
    let mx = (n0.x + n1.x), my = (n0.y + n1.y);
    if (Math.abs(denom) < 1e-6) { mx = n0.x; my = n0.y; }
    else { mx /= denom; my /= denom; }
    const l = Math.hypot(mx, my);
    if (l > miterLimit) { mx = (mx / l) * miterLimit; my = (my / l) * miterLimit; }
    out.push({ x: cur.x + mx * dist, y: cur.y + my * dist });
  }
  return out;
}

/** Douglas-Peucker simplification of a closed polygon (keeps a subset of the input vertices). */
export function simplifyClosedPoly(pts: Vec2[], tolerance: number): Vec2[] {
  if (pts.length <= 4 || tolerance <= 0) return pts.slice();
  const keep = new Uint8Array(pts.length);
  // anchor on the two mutually farthest-ish points so the closed loop splits into two open runs
  let far = 1, farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > farD) { farD = d; far = i; }
  }
  keep[0] = keep[far] = 1;
  const perpDist = (p: Vec2, a: Vec2, b: Vec2) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(l2);
  };
  const run = (i0: number, i1: number) => {
    const stack: [number, number][] = [[i0, i1]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      const len = (b - a + pts.length) % pts.length;
      if (len < 2) continue;
      let worst = -1, worstD = tolerance;
      for (let k = 1; k < len; k++) {
        const i = (a + k) % pts.length;
        const d = perpDist(pts[i], pts[a], pts[b]);
        if (d > worstD) { worstD = d; worst = i; }
      }
      if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
    }
  };
  run(0, far);
  run(far, 0);
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out.length >= 3 ? out : pts.slice();
}

// ---- placement ------------------------------------------------------------------------------------

function normalizeBy(poly: Vec2[], b: { minX: number; minY: number }): Vec2[] {
  return poly.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY }));
}

/** Cap the search polygon's vertex count: NFP candidate generation is O(|Q|·|P|) per placed pair. */
const MAX_SEARCH_VERTS = 48;
function searchPolyOf(cut: Vec2[], tol: number): Vec2[] {
  let out = simplifyClosedPoly(cut, tol);
  let t = tol;
  while (out.length > MAX_SEARCH_VERTS && t < 8) { t *= 1.6; out = simplifyClosedPoly(cut, t); }
  return out;
}

interface RotVariant { full: Vec2[]; outline: Vec2[]; search: Vec2[]; inflated: Vec2[]; test: Vec2[]; w: number; h: number }
interface PreparedItem extends CoreItem {
  /** per-allowed-rotation pre-rotated + normalised polygons (search copy is simplified) */
  variants: Record<number, RotVariant>;
}

// Variant/NFP-geometry cache, persistent across nesting runs (the original's nfpCache): the rotated,
// simplified and gap-inflated polygons depend only on the cut shape + tolerance + rotation + gap, so
// re-nesting after unrelated edits reuses them. Bounded FIFO.
const variantCache = new Map<string, Record<number, RotVariant>>();
const VARIANT_CACHE_MAX = 200;

function variantKey(it: CoreItem, tol: number, rotations: number[], gapMm: number): string {
  const r = (n: number) => Math.round(n * 10);
  return `${rotations.join(',')}|${tol}|${gapMm}|${it.cut.map((p) => `${r(p.x)},${r(p.y)}`).join(';')}`;
}

function prepareItems(items: CoreItem[], tol: number, rotations: number[], gapMm: number): PreparedItem[] {
  return items.map((it) => {
    const key = variantKey(it, tol, rotations, gapMm);
    const cached = variantCache.get(key);
    if (cached) return { ...it, variants: cached };
    const searchCut = searchPolyOf(it.cut, tol);
    const variants: Record<number, RotVariant> = {};
    for (const deg of rotations) {
      const rotFull = rotatePoly(it.cut, deg);
      const b = polyBounds(rotFull);
      const search = normalizeBy(rotatePoly(searchCut, deg), b);
      variants[deg] = {
        full: normalizeBy(rotFull, b),
        outline: normalizeBy(rotatePoly(it.outline, deg), b),
        search,
        // gap-inflated/test copies precomputed at the origin: a translation of the piece is a
        // translation of its offset, so placements only shift these instead of re-offsetting
        inflated: gapMm > 0 ? offsetPoly(search, gapMm) : search,
        test: gapMm > 0 ? offsetPoly(search, gapMm * 0.98) : search,
        w: b.maxX - b.minX,
        h: b.maxY - b.minY
      };
    }
    if (variantCache.size >= VARIANT_CACHE_MAX) {
      const oldest = variantCache.keys().next().value;
      if (oldest !== undefined) variantCache.delete(oldest);
    }
    variantCache.set(key, variants);
    return { ...it, variants };
  });
}

/**
 * Place ordered items bottom-left-first.
 * 'nfp' candidates: vertex contacts against every placed piece's gap-inflated search polygon —
 * the no-fit-polygon vertex set — validated with exact overlap tests before acceptance.
 */
function placeOrdered(
  order: PreparedItem[],
  rotIdx: number[],
  rotations: number[],
  fabricWidthMm: number,
  gapMm: number,
  strategy: NestStrategy,
  maxLengthMm?: number | null,
  gravity: NestGravity = 'bottom'
): { placements: CorePlacement[]; binLengths: number[] } {
  interface Placed { search: Vec2[]; inflated: Vec2[]; test: Vec2[]; bounds: ReturnType<typeof polyBounds> }
  interface Bin { placed: Placed[]; usedLength: number }
  const maxLen = maxLengthMm && maxLengthMm > 0 ? maxLengthMm : Infinity;
  const bins: Bin[] = [{ placed: [], usedLength: gapMm }];
  const placements: CorePlacement[] = [];
  // candidate preference order = which fabric edge pieces snug toward
  const gravityCmp: (a: Vec2, c: Vec2) => number =
    gravity === 'left' ? (a, c) => a.x - c.x || a.y - c.y
    : gravity === 'right' ? (a, c) => c.x - a.x || a.y - c.y
    : gravity === 'top' ? (a, c) => a.y - c.y || c.x - a.x
    : (a, c) => a.y - c.y || a.x - c.x;

  for (let k = 0; k < order.length; k++) {
    const it = order[k];
    const deg = rotations[rotIdx[k] % rotations.length];
    const { full, outline, search, w, h } = it.variants[deg];
    const maxX = fabricWidthMm - w - gapMm;
    const yCap = maxLen - h - gapMm; // a candidate's y must not push the piece past the bin length

    /** Bottom-left-first feasible position within one bin (respecting the length cap), or null. */
    const findSpot = (bin: Bin): Vec2 | null => {
      const placed = bin.placed;
      if (strategy === 'nfp') {
        const candidates: Vec2[] = [{ x: gapMm, y: gapMm }];
        if (gravity === 'right' && maxX > gapMm) candidates.push({ x: maxX, y: gapMm });
        for (const pl of placed) {
          for (const q of pl.inflated) {
            for (const p of search) {
              const x = q.x - p.x, y = q.y - p.y;
              if (x >= gapMm - 1e-9 && x <= maxX + 1e-9 && y >= gapMm - 1e-9 && y <= yCap + 1e-9) candidates.push({ x, y });
            }
          }
          // bbox corner anchors keep row/shelf structure available too
          candidates.push({ x: pl.bounds.maxX + gapMm, y: gapMm }, { x: gapMm, y: pl.bounds.maxY + gapMm });
        }
        candidates.sort(gravityCmp);
        let lastX = NaN, lastY = NaN;
        for (const cnd of candidates) {
          if (cnd.x < gapMm - 1e-9 || cnd.x > maxX + 1e-9 || cnd.y < gapMm - 1e-9 || cnd.y > yCap + 1e-9) continue;
          if (cnd.x === lastX && cnd.y === lastY) continue; // dedupe sorted run
          lastX = cnd.x; lastY = cnd.y;
          const cand = search.map((p) => ({ x: p.x + cnd.x, y: p.y + cnd.y }));
          const cb = polyBounds(cand);
          let ok = true;
          for (const pl of placed) {
            if (cb.maxX < pl.bounds.minX || pl.bounds.maxX < cb.minX || cb.maxY < pl.bounds.minY || pl.bounds.maxY < cb.minY) continue;
            if (polysOverlap(cand, pl.test)) { ok = false; break; }
          }
          if (ok) return cnd;
        }
        return null;
      }
      // original shelf-corner candidate fill
      const xs = new Set<number>([gapMm]);
      const ys = new Set<number>([gapMm]);
      for (const pl of placed) { xs.add(pl.bounds.maxX + gapMm); ys.add(pl.bounds.maxY + gapMm); }
      const sortedYs = [...ys].sort((a, c) => a - c).filter((y) => y <= yCap + 1e-9);
      const sortedXs = [...xs].sort((a, c) => a - c);
      let best: Vec2 | null = null;
      for (const y of sortedYs) {
        for (const x of sortedXs) {
          if (x + w + gapMm > fabricWidthMm) continue;
          const cand = search.map((p) => ({ x: p.x + x, y: p.y + y }));
          const cb = polyBounds(cand);
          let ok = true;
          for (const pl of placed) {
            if (cb.maxX < pl.bounds.minX - gapMm || pl.bounds.maxX < cb.minX - gapMm || cb.maxY < pl.bounds.minY - gapMm || pl.bounds.maxY < cb.minY - gapMm) continue;
            if (polysOverlap(cand, pl.search)) { ok = false; break; }
          }
          if (ok && (!best || y < best.y || (y === best.y && x < best.x))) { best = { x, y }; break; }
        }
        if (best && best.y <= sortedYs[0]) break;
      }
      // single-bin fallback (no length cap): below everything, preserving the original behaviour
      if (!best && maxLen === Infinity) best = { x: gapMm, y: bin.usedLength };
      return best;
    };

    let binIdx = -1;
    let pos: Vec2 | null = null;
    for (let b = 0; b < bins.length && !pos; b++) {
      pos = findSpot(bins[b]);
      if (pos) binIdx = b;
    }
    if (!pos) {
      // open a new bin/sheet (an over-tall piece still gets its own bin at the origin)
      bins.push({ placed: [], usedLength: gapMm });
      binIdx = bins.length - 1;
      pos = { x: gapMm, y: gapMm };
    }

    const bin = bins[binIdx];
    const tr = (poly: Vec2[]) => poly.map((p) => ({ x: p.x + pos!.x, y: p.y + pos!.y }));
    const searchT = tr(search);
    // overlap tests run against a slightly under-inflated copy so exact vertex contacts
    // (candidates sit ON the inflated boundary) aren't rejected by numeric noise. Both copies are
    // precomputed per variant (a translation of the offset = the offset of the translation).
    bin.placed.push({
      search: searchT,
      inflated: tr(it.variants[deg].inflated),
      test: tr(it.variants[deg].test),
      bounds: polyBounds(searchT)
    });
    placements.push({ pieceId: it.pieceId, name: it.name, poly: tr(full), outline: tr(outline), bbox: { w, h }, rotationDeg: deg, instanceId: it.instanceId, bin: binIdx });
    bin.usedLength = Math.max(bin.usedLength, pos.y + h + gapMm);
  }
  return { placements, binLengths: bins.map((b) => b.usedLength) };
}

// ---- genetic ordering search -----------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so worker runs are reproducible under test. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run the full nest (greedy seed + genetic ordering search), reporting per-generation progress. */
export function nestCore(rawItems: CoreItem[], opts: CoreOptions, onProgress?: (p: CoreProgress) => void): CoreLayout {
  const { fabricWidthMm, gapMm, strategy } = opts;
  const rotations = opts.rotations.length ? opts.rotations : [0];
  const generations = Math.max(0, opts.generations);
  const population = Math.max(4, opts.population);
  const rand = rng(opts.seed ?? Math.floor(Math.random() * 0xffffffff));
  const items = prepareItems(rawItems, opts.simplifyTolMm ?? 1, rotations, gapMm);
  if (items.length === 0) return { fabricWidthMm, usedLengthMm: gapMm, gapMm, placements: [], efficiency: 0 };

  const totalArea = items.reduce((s, it) => s + it.area, 0);
  const efficiencyOf = (len: number) => Math.min(1, totalArea / Math.max(1, fabricWidthMm * (len - gapMm)));
  const evaluate = (order: PreparedItem[], rotIdx: number[]) =>
    placeOrdered(order, rotIdx, rotations, fabricWidthMm, gapMm, strategy, opts.maxLengthMm, opts.gravity);
  // fitness: fewer bins first, then total fabric used (single-bin = plain length, as before)
  const fitnessOf = (r: ReturnType<typeof placeOrdered>) =>
    (r.binLengths.length - 1) * 1e6 + r.binLengths.reduce((s, l) => s + l, 0);

  const seedOrder = [...items].sort((a, b) => b.area - a.area);
  const idxOf = new Map(items.map((it, i) => [it.instanceId, i] as const));
  type Chrom = { order: number[]; rot: number[] };
  const toChrom = (ord: PreparedItem[]): Chrom => ({ order: ord.map((it) => idxOf.get(it.instanceId)!), rot: ord.map(() => 0) });
  const fromChrom = (c: Chrom): PreparedItem[] => c.order.map((i) => items[i]);
  const rndInt = (n: number) => Math.floor(rand() * n);

  let pop: Chrom[] = [toChrom(seedOrder)];
  while (pop.length < population) {
    const ord = [...items];
    for (let i = ord.length - 1; i > 0; i--) { const j = rndInt(i + 1); [ord[i], ord[j]] = [ord[j], ord[i]]; }
    pop.push({ order: ord.map((it) => idxOf.get(it.instanceId)!), rot: ord.map(() => rndInt(rotations.length)) });
  }

  const score = (c: Chrom) => fitnessOf(evaluate(fromChrom(c), c.rot));
  let best = pop[0];
  let bestScore = score(best);
  for (const c of pop.slice(1)) { const s = score(c); if (s < bestScore) { best = c; bestScore = s; } }
  const lenOf = (s: number) => s % 1e6; // strip the bin-count term for progress display
  onProgress?.({ generation: 0, generations, bestLengthMm: lenOf(bestScore), efficiency: efficiencyOf(lenOf(bestScore)) });

  for (let g = 0; g < generations; g++) {
    const scored = pop.map((c) => ({ c, s: score(c) })).sort((a, b) => a.s - b.s);
    if (scored[0].s < bestScore) { best = scored[0].c; bestScore = scored[0].s; }
    const elite = scored.slice(0, Math.max(2, Math.floor(population / 4))).map((x) => x.c);
    const next: Chrom[] = [...elite];
    while (next.length < population) {
      const p1 = elite[rndInt(elite.length)], p2 = elite[rndInt(elite.length)];
      const n = p1.order.length, a = rndInt(n), b2 = a + rndInt(n - a);
      const childOrder: number[] = new Array(n).fill(-1);
      const taken = new Set<number>();
      for (let i = a; i <= b2; i++) { childOrder[i] = p1.order[i]; taken.add(p1.order[i]); }
      let fill = 0;
      for (let i = 0; i < n; i++) { if (childOrder[i] === -1) { while (taken.has(p2.order[fill])) fill++; childOrder[i] = p2.order[fill++]; } }
      const rot = childOrder.map((_, i) => (rand() < 0.5 ? p1.rot[i % p1.rot.length] : p2.rot[i % p2.rot.length]));
      if (rand() < 0.3) { const i = rndInt(n), j = rndInt(n); [childOrder[i], childOrder[j]] = [childOrder[j], childOrder[i]]; }
      if (rand() < 0.3 && rotations.length > 1) rot[rndInt(n)] = rndInt(rotations.length);
      next.push({ order: childOrder, rot });
    }
    pop = next;
    onProgress?.({ generation: g + 1, generations, bestLengthMm: lenOf(bestScore), efficiency: efficiencyOf(lenOf(bestScore)) });
  }

  const final = evaluate(fromChrom(best), best.rot);
  // lay the bins end-to-end in one continuous marker space (visual gap between sheets) so every
  // downstream consumer (SVG/PDF/HPGL/cut files) keeps working; `bins` records each sheet's band.
  const BIN_GAP = 30;
  const multi = final.binLengths.length > 1;
  const binsMeta: { startYmm: number; usedLengthMm: number }[] = [];
  let y0 = 0;
  for (const len of final.binLengths) {
    binsMeta.push({ startYmm: y0, usedLengthMm: len });
    y0 += len + BIN_GAP;
  }
  const placements = multi
    ? final.placements.map((pl) => {
        const dy = binsMeta[pl.bin ?? 0].startYmm;
        if (dy === 0) return pl;
        return { ...pl, poly: pl.poly.map((p) => ({ x: p.x, y: p.y + dy })), outline: pl.outline.map((p) => ({ x: p.x, y: p.y + dy })) };
      })
    : final.placements;
  const totalLen = final.binLengths.reduce((s, l) => s + l, 0);
  return {
    fabricWidthMm,
    usedLengthMm: multi ? y0 - BIN_GAP : final.binLengths[0],
    gapMm,
    placements,
    efficiency: efficiencyOf(totalLen),
    ...(multi ? { bins: binsMeta } : {})
  };
}
