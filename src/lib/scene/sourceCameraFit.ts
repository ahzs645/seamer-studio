import { Box3, Vector3 } from 'three';

export interface CameraFitRect { left: number; top: number; right: number; bottom: number }
export interface CameraFitViewport { width: number; height: number; rect: CameraFitRect }
export type CameraFitPoint = readonly [number, number, number];

/** Largest unobscured rectangle, using measured controls rather than a device breakpoint.
 * A full-screen drawer is temporary: keep the previous camera until it closes. */
export function sourceCameraSafeRect(width: number, height: number, obstacles: readonly CameraFitRect[]): CameraFitRect | null {
  if (!(width > 32 && height > 32)) return null;
  const margin = 12, gap = 8;
  const bounds = { left: margin, top: margin, right: width - margin, bottom: height - margin };
  const visible = obstacles.map(r => ({ left: Math.max(0, r.left), top: Math.max(0, r.top),
    right: Math.min(width, r.right), bottom: Math.min(height, r.bottom) }))
    .filter(r => r.right > r.left && r.bottom > r.top);
  if (visible.some(r => (r.right - r.left) * (r.bottom - r.top) > width * height * .55)) return null;
  const xs = [...new Set([bounds.left, bounds.right, ...visible.flatMap(r => [r.left - gap, r.right + gap])])]
    .filter(x => x >= bounds.left && x <= bounds.right).sort((a, b) => a - b);
  const ys = [...new Set([bounds.top, bounds.bottom, ...visible.flatMap(r => [r.top - gap, r.bottom + gap])])]
    .filter(y => y >= bounds.top && y <= bounds.bottom).sort((a, b) => a - b);
  let best: CameraFitRect | null = null, area = 0;
  for (const left of xs) for (const right of xs) for (const top of ys) for (const bottom of ys) {
    const size = (right - left) * (bottom - top);
    if (right - left < 32 || bottom - top < 32 || size <= area) continue;
    if (visible.some(r => left < r.right + gap && right > r.left - gap && top < r.bottom + gap && bottom > r.top - gap)) continue;
    best = { left, right, top, bottom }; area = size;
  }
  return best;
}

/** Perspective fit of actual cloth/body points. Retains direction and FOV, shifts the orbit
 * target into the usable screen rectangle, and leaves 3% breathing room. */
export function fitSourceCamera(points: readonly CameraFitPoint[], viewport: CameraFitViewport,
  direction: CameraFitPoint, fov: number): { position: [number, number, number]; target: [number, number, number]; fov: number } | null {
  const { width, height, rect } = viewport;
  if (!points.length || !points.every(p => p.every(Number.isFinite)) || !(fov > 0 && fov < 179)
    || !(width > 0 && height > 0 && rect.right > rect.left && rect.bottom > rect.top)) return null;
  const backward = new Vector3(...direction);
  if (!Number.isFinite(backward.lengthSq()) || backward.lengthSq() < 1e-12) return null;
  backward.normalize();
  // Match Three's default-Y lookAt convention without leaving its exactly vertical
  // degeneracy for Matrix4 to resolve differently from the fitting basis.
  if (Math.abs(backward.y) > 1 - 1e-8) { backward.z += .0001; backward.normalize(); }
  const up = new Vector3(0, 1, 0).addScaledVector(backward, -backward.y);
  up.normalize();
  const right = new Vector3().crossVectors(up, backward).normalize();
  const box = new Box3();
  for (const p of points) box.expandByPoint(new Vector3(...p));
  const center = box.getCenter(new Vector3());
  const coordinates = points.map(p => {
    const v = new Vector3(...p).sub(center);
    return [v.dot(right), v.dot(up), v.dot(backward)];
  });
  const tan = Math.tan(fov * Math.PI / 360), horizontalTan = tan * width / height;
  const cx = (rect.left + rect.right) / width - 1;
  const cy = 1 - (rect.top + rect.bottom) / height;
  const limits = [2 * rect.left / width - 1, 2 * rect.right / width - 1,
    1 - 2 * rect.bottom / height, 1 - 2 * rect.top / height];
  function fits(distance: number): boolean {
    return coordinates.every(([x, y, z]) => {
      const depth = distance - z;
      if (depth <= .01) return false;
      const nx = (x + cx * distance * horizontalTan) / (depth * horizontalTan);
      const ny = (y + cy * distance * tan) / (depth * tan);
      return nx >= limits[0] && nx <= limits[1] && ny >= limits[2] && ny <= limits[3];
    });
  }
  let low = .01, high = Math.max(1, box.getSize(new Vector3()).length());
  for (let i = 0; i < 24 && !fits(high); i++) high *= 2;
  if (!fits(high)) return null;
  for (let i = 0; i < 48; i++) { const mid = (low + high) / 2; if (fits(mid)) high = mid; else low = mid; }
  const distance = high * 1.03;
  const target = center.clone().addScaledVector(right, -cx * distance * horizontalTan).addScaledVector(up, -cy * distance * tan);
  const position = target.clone().addScaledVector(backward, distance);
  return { position: position.toArray(), target: target.toArray(), fov };
}
