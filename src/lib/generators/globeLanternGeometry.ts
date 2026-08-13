// The shape question, on its own: what flat piece becomes a globe when you coil it up?
//
// A surface of revolution is covered by a band of finished width w that advances w of MERIDIAN arc
// per turn, so consecutive coils meet edge to edge. Flattening a strip preserves geodesic curvature,
// and for a latitude circle on a surface of revolution that is
//
//        kappa_g(m) = -r'(m) / r(m)
//
// so the flat centreline is the plane curve carrying that curvature. Parametrised by strip arc
// length s:
//
//        dm/ds     = w / (2*pi*r)     advance down the meridian
//        dtheta/ds = -r'(m) / r(m)    heading in the plane
//        dpsi/ds   = 1 / r(m)         azimuth on the 3D form
//
// On a sphere this is kappa = cot(phi)/R: a spiral that opens out to a straight line at the equator,
// inflects, and spirals back the other way. Near the equator kappa is linear in s, so the pattern
// really is a clothoid there. Do not mirror one half onto the other.
//
// Stacked rings need none of that. Each ring is a cone frustum between two latitudes, and a frustum
// develops exactly into an annular sector — closed form, no integration. Same globe, easier sew, and
// the reason the mode is worth offering rather than inferring.

export const TAU = Math.PI * 2;

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

export interface Meridian {
  N: number;
  r: Float64Array;
  z: Float64Array;
  m: Float64Array;
  drdm: Float64Array;
  total: number;
}

/** Half-meridian of an ellipsoid of revolution, arc-length indexed from the top pole. */
export function meridian(a: number, b: number, N = 4000): Meridian {
  const r = new Float64Array(N + 1);
  const z = new Float64Array(N + 1);
  const m = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const t = (Math.PI * i) / N;
    r[i] = a * Math.sin(t);
    z[i] = b * Math.cos(t);
  }
  for (let i = 1; i <= N; i++) m[i] = m[i - 1] + Math.hypot(r[i] - r[i - 1], z[i] - z[i - 1]);
  const drdm = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(N, i + 1);
    const dm = m[i1] - m[i0] || 1e-9;
    drdm[i] = (r[i1] - r[i0]) / dm;
  }
  return { N, r, z, m, drdm, total: m[N] };
}

export interface MeridianSample { r: number; z: number; drdm: number }

export function sampleMeridian(M: Meridian, mv: number): MeridianSample {
  const m = M.m;
  if (mv <= m[0]) return { r: M.r[0], z: M.z[0], drdm: M.drdm[0] };
  if (mv >= m[M.N]) return { r: M.r[M.N], z: M.z[M.N], drdm: M.drdm[M.N] };
  let lo = 0;
  let hi = M.N;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (m[mid] <= mv) lo = mid; else hi = mid;
  }
  const f = (mv - m[lo]) / (m[hi] - m[lo] || 1e-9);
  const L = (A: Float64Array) => A[lo] + (A[hi] - A[lo]) * f;
  return { r: L(M.r), z: L(M.z), drdm: L(M.drdm) };
}

/** Meridian arc positions of the two ring openings, as a fraction of the full half-meridian. */
export function openingSpan(M: Meridian, a: number, topOpen: number, botOpen: number): { mS: number; mE: number } {
  const rTop = Math.min(topOpen / 2, a * 0.98);
  const rBot = Math.min(botOpen / 2, a * 0.98);
  let mS = 0;
  let mE = M.total;
  for (let i = 0; i <= M.N; i++) if (M.r[i] >= rTop) { mS = M.m[i]; break; }
  for (let i = M.N; i >= 0; i--) if (M.r[i] >= rBot) { mE = M.m[i]; break; }
  return { mS, mE };
}

/** 3D point on the form at meridian arc `m` and azimuth `psi`. Y is up, matching the sim's gravity. */
export function surfacePoint(M: Meridian, m: number, psi: number): Vec3 {
  const q = sampleMeridian(M, Math.min(Math.max(m, 0), M.total));
  return { x: q.r * Math.cos(psi), y: q.z, z: q.r * Math.sin(psi) };
}

/* ------------------------------------------------------------------ *
 *  HELIX
 * ------------------------------------------------------------------ */

export interface HelixStation {
  s: number;      // arc length along the strip (mm)
  m: number;      // meridian arc position (mm)
  x: number;      // flat centreline (mm)
  y: number;
  th: number;     // flat heading (rad)
  psi: number;    // azimuth on the form (rad)
  coil: number;   // (m - mS) / w — the coil coordinate the split logic works in
}

export interface HelixCurve {
  stations: HelixStation[];
  length: number;
  turns: number;
  /** Worst relative mismatch between one coil's outer edge and the next coil's inner edge. */
  ease: number;
}

/**
 * Integrate the strip. RK4 on (m, theta, x, y, psi) against arc length, which keeps the double
 * spiral's inflection at the equator clean — the place a cruder integrator visibly drifts.
 */
export function integrateHelix(
  M: Meridian,
  w: number,
  mS: number,
  mE: number,
  steps = 3000
): HelixCurve | null {
  if (mE - mS < w * 2) return null;

  let estimate = 0;
  for (let i = 0; i < M.N; i++) {
    const mm = M.m[i];
    if (mm >= mS && mm < mE) estimate += (TAU * M.r[i] * (M.m[i + 1] - mm)) / w;
  }
  if (!(estimate > 0)) return null;

  const ds = estimate / steps;
  const derivative = (m: number, th: number) => {
    const q = sampleMeridian(M, m);
    const r = Math.max(q.r, 1e-6);
    return { dm: w / (TAU * r), dth: -q.drdm / r, dx: Math.cos(th), dy: Math.sin(th), dpsi: 1 / r };
  };

  const stations: HelixStation[] = [];
  let m = mS, th = 0, x = 0, y = 0, psi = 0, s = 0;
  for (let i = 0; i <= steps; i++) {
    stations.push({ s, m, x, y, th, psi, coil: (m - mS) / w });
    if (m >= mE) break;
    const k1 = derivative(m, th);
    const k2 = derivative(m + (ds / 2) * k1.dm, th + (ds / 2) * k1.dth);
    const k3 = derivative(m + (ds / 2) * k2.dm, th + (ds / 2) * k2.dth);
    const k4 = derivative(m + ds * k3.dm, th + ds * k3.dth);
    const avg = (f: 'dm' | 'dth' | 'dx' | 'dy' | 'dpsi') => (k1[f] + 2 * k2[f] + 2 * k3[f] + k4[f]) / 6;
    m += ds * avg('dm');
    th += ds * avg('dth');
    x += ds * avg('dx');
    y += ds * avg('dy');
    psi += ds * avg('dpsi');
    s += ds;
  }
  if (stations.length < 8) return null;

  const turns = (mE - mS) / w;
  return { stations, length: stations[stations.length - 1].s, turns, ease: seamEase(stations, w, ds) };
}

/**
 * The fabric has to take up the difference between the outer edge of one coil and the inner edge of
 * the next. It is small — a fraction of a percent — and disappears into the weave, but it is the
 * number that decides whether the wire fights the form, so it is worth reporting rather than hiding.
 */
function seamEase(stations: HelixStation[], w: number, ds: number): number {
  const at = (coil: number) => {
    let i = 0;
    while (i < stations.length - 1 && stations[i].coil < coil) i++;
    return i;
  };
  const curvature = (i: number) => {
    const a = stations[Math.max(0, i - 1)];
    const b = stations[Math.min(stations.length - 1, i + 1)];
    const dth = b.th - a.th;
    const dsp = b.s - a.s;
    return dsp > 1e-9 ? dth / dsp : 0;
  };
  const edgeLength = (i0: number, i1: number, u: number) => {
    let total = 0;
    for (let i = i0; i < i1; i++) total += (1 - u * curvature(i)) * ds;
    return total;
  };
  const coils = Math.floor(stations[stations.length - 1].coil);
  let worst = 0;
  for (let k = 0; k + 2 <= coils; k++) {
    const i0 = at(k), i1 = at(k + 1), i2 = at(k + 2);
    if (i2 <= i1 || i1 <= i0) continue;
    const outer = edgeLength(i0, i1, w / 2);
    const inner = edgeLength(i1, i2, -w / 2);
    const rel = Math.abs(outer - inner) / Math.max(outer, inner, 1e-9);
    if (rel > worst) worst = rel;
  }
  return worst;
}

/** Flat point offset `u` across the strip from the centreline at a station. */
export function helixOffset(st: HelixStation, u: number): Vec2 {
  return { x: st.x - u * Math.sin(st.th), y: st.y + u * Math.cos(st.th) };
}

/** Interpolate a station at an arbitrary coil coordinate. */
export function helixAtCoil(curve: HelixCurve, coil: number): HelixStation {
  const st = curve.stations;
  if (coil <= st[0].coil) return st[0];
  const last = st[st.length - 1];
  if (coil >= last.coil) return last;
  let lo = 0, hi = st.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (st[mid].coil <= coil) lo = mid; else hi = mid;
  }
  const span = st[hi].coil - st[lo].coil || 1e-9;
  const f = (coil - st[lo].coil) / span;
  const lerp = (p: number, q: number) => p + (q - p) * f;
  return {
    s: lerp(st[lo].s, st[hi].s),
    m: lerp(st[lo].m, st[hi].m),
    x: lerp(st[lo].x, st[hi].x),
    y: lerp(st[lo].y, st[hi].y),
    th: lerp(st[lo].th, st[hi].th),
    psi: lerp(st[lo].psi, st[hi].psi),
    coil
  };
}

/* ------------------------------------------------------------------ *
 *  RINGS
 * ------------------------------------------------------------------ */

export interface RingDevelopment {
  /** true when the band is close enough to a cylinder that its development is a rectangle. */
  cylindrical: boolean;
  /** Developed radius at the upper (m0) and lower (m1) edge. Unused when cylindrical. */
  rho0: number;
  rho1: number;
  /** Angular span of the sector (rad), or the rectangle's width (mm) when cylindrical. */
  sweep: number;
  m0: number;
  m1: number;
  r0: number;
  r1: number;
}

/**
 * Develop one cone frustum. Radius grows linearly with distance from the apex, so the developed
 * radius at true radius r is r * L / |dr| and the sector sweep is 2*pi*|dr| / L. Both stay positive
 * whichever way the band tapers, which is what keeps the equator crossing well behaved.
 */
export function developRing(M: Meridian, m0: number, m1: number): RingDevelopment {
  const q0 = sampleMeridian(M, m0);
  const q1 = sampleMeridian(M, m1);
  const L = m1 - m0;
  const dr = q1.r - q0.r;
  if (Math.abs(dr) < L * 1e-3) {
    return { cylindrical: true, rho0: 0, rho1: 0, sweep: TAU * ((q0.r + q1.r) / 2), m0, m1, r0: q0.r, r1: q1.r };
  }
  const scale = L / Math.abs(dr);
  return {
    cylindrical: false,
    rho0: q0.r * scale,
    rho1: q1.r * scale,
    sweep: (TAU * Math.abs(dr)) / L,
    m0, m1, r0: q0.r, r1: q1.r
  };
}

/**
 * Flat point of a ring at meridian arc `m` and azimuth `psi`, in the ring's own local frame:
 * the sector is centred on the +Y axis for a cone, or laid out left-to-right for a cylinder.
 */
export function ringFlatPoint(dev: RingDevelopment, m: number, psi: number): Vec2 {
  const t = (m - dev.m0) / (dev.m1 - dev.m0 || 1e-9);
  if (dev.cylindrical) {
    return { x: (psi / TAU) * dev.sweep, y: -(dev.m1 - dev.m0) * t };
  }
  const rho = dev.rho0 + (dev.rho1 - dev.rho0) * t;
  const phi = (psi / TAU) * dev.sweep - dev.sweep / 2 + Math.PI / 2;
  return { x: rho * Math.cos(phi), y: rho * Math.sin(phi) };
}

/* ------------------------------------------------------------------ *
 *  COIL CLEARANCE
 * ------------------------------------------------------------------ */

/**
 * How close neighbouring coils sit in the FLAT layout.
 *
 * The developed radius is rho(m) = r / |r'|, so consecutive coils lie |rho(m+w) - rho(m)| apart. On
 * a sphere that is w*sec^2(phi): never less than the finished width, but near the poles barely more
 * than it — so the CUT outlines, which are wider than the finished strip by their allowances,
 * overlap each other on the page. Those coils cannot be nested; they have to be cut as separate
 * pieces. Reporting the number is the difference between "the layout looks wrong" and "the layout is
 * telling you something true about the geometry".
 *
 * Returns clearance in mm: cut width subtracted, so negative means the outlines overlap.
 */
export function coilClearance(M: Meridian, curve: HelixCurve, w: number, cutWidth: number): number {
  const BIG = 1e6;
  const rho = (mv: number) => {
    const q = sampleMeridian(M, Math.min(Math.max(mv, 0), M.total));
    // |r'| -> 0 at the equator: the coil is locally a cylinder and the developed radius is unbounded
    return Math.abs(q.drdm) < 1e-3
      ? { v: BIG, s: 0 }
      : { v: q.r / Math.abs(q.drdm), s: Math.sign(q.drdm) };
  };
  let minGap = Infinity;
  for (const station of curve.stations) {
    const here = rho(station.m);
    const pairGap = (other: { v: number; s: number }) =>
      // unbounded radius, or a sign flip across the equator: those coils cannot crowd each other
      here.v >= BIG || other.v >= BIG || here.s * other.s < 0 ? BIG : Math.abs(other.v - here.v);
    const gap = Math.min(pairGap(rho(station.m + w)), pairGap(rho(station.m - w)));
    if (Number.isFinite(gap) && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap)) minGap = BIG;
  return minGap - cutWidth;
}
