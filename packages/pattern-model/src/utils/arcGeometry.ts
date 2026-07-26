// Arc/circle geometry shared by the 2D arc tools, the command bus (path.create*Arc/Ellipse) and the
// parametric-arc editor: anchors along an arc as cubic Bézier segments (≤90° per segment), plus the
// 3-point circumcircle.

export interface Vec2 { x: number; y: number }
export interface ArcAnchor { pos: Vec2; v1: Vec2; v2: Vec2 }

/**
 * Bézier anchors approximating the arc of radius `r` about `c` from angle `a0` to `a1` (radians;
 * a1 < a0 sweeps clockwise). One anchor every ≤90°, with standard 4/3·tan(Δ/4) tangent handles.
 */
export function arcAnchors(c: Vec2, r: number, a0: number, a1: number): ArcAnchor[] {
  return ellipseAnchors(c, r, r, 0, a0, a1);
}

/**
 * Bézier anchors for a (rotated) ELLIPTICAL arc: parametric point c + R(rot)·(rx·cos t, ry·sin t)
 * from t = a0 to a1. Handles follow the parametric derivative scaled by 4/3·tan(Δ/4) — the standard
 * cubic approximation, exact for circles and excellent for ≤90° elliptical segments.
 */
export function ellipseAnchors(c: Vec2, rx: number, ry: number, rotation: number, a0: number, a1: number): ArcAnchor[] {
  const span = a1 - a0;
  const nSeg = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2)));
  const dA = span / nSeg;
  const k = (4 / 3) * Math.tan(dA / 4);
  const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
  const rot = (x: number, y: number): Vec2 => ({ x: x * cosR - y * sinR, y: x * sinR + y * cosR });
  const out: ArcAnchor[] = [];
  for (let i = 0; i <= nSeg; i++) {
    const t = a0 + dA * i;
    const p = rot(rx * Math.cos(t), ry * Math.sin(t));
    const d = rot(-rx * Math.sin(t), ry * Math.cos(t));
    out.push({
      pos: { x: c.x + p.x, y: c.y + p.y },
      v1: { x: -d.x * k, y: -d.y * k },
      v2: { x: d.x * k, y: d.y * k }
    });
  }
  return out;
}

/** Circumcircle through three points, or null when collinear. */
export function circumcircle(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return null;
  const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
  const center = { x: ux, y: uy };
  return { c: center, r: Math.hypot(a.x - ux, a.y - uy) };
}

/** Angles for a CCW center-arc defined by clicks: center, radius/start point, end point. */
export function centerArcAngles(center: Vec2, start: Vec2, end: Vec2): { r: number; a0: number; a1: number } {
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  let a1 = Math.atan2(end.y - center.y, end.x - center.x);
  if (a1 <= a0) a1 += Math.PI * 2;
  return { r, a0, a1 };
}

/** Angles for a 3-point arc: through p1→p2→p3 (direction chosen so the arc passes p2). */
export function threePointArcAngles(p1: Vec2, p2: Vec2, p3: Vec2): { c: Vec2; r: number; a0: number; a1: number } | null {
  const cc = circumcircle(p1, p2, p3);
  if (!cc) return null;
  const ang = (pt: Vec2) => Math.atan2(pt.y - cc.c.y, pt.x - cc.c.x);
  const a0 = ang(p1), am = ang(p2), a1 = ang(p3);
  const norm = (x: number) => { let t = x; while (t < 0) t += Math.PI * 2; while (t >= Math.PI * 2) t -= Math.PI * 2; return t; };
  const dm = norm(am - a0), d1 = norm(a1 - a0);
  return { c: cc.c, r: cc.r, a0, a1: dm <= d1 ? a0 + d1 : a0 + d1 - Math.PI * 2 };
}
