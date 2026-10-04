import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { fitSourceCamera, sourceCameraSafeRect, type CameraFitPoint, type CameraFitRect } from './sourceCameraFit';

const points: CameraFitPoint[] = [];
for (const x of [-.685, .685]) for (const y of [0, 1.76]) for (const z of [-.164, .131]) points.push([x, y, z]);
// Authored skirt and sleeves can extend beyond the avatar. Those points must fit as well.
points.push([-.79, 1.15, .21], [.79, 1.15, -.21], [0, -.06, .25]);
const direction: CameraFitPoint = [.18, .08, Math.sqrt(1 - .18 ** 2 - .08 ** 2)];

function projected(width: number, height: number, fit: NonNullable<ReturnType<typeof fitSourceCamera>>) {
  const camera = new PerspectiveCamera(fit.fov, width / height, .01, 100);
  camera.position.fromArray(fit.position); camera.lookAt(new Vector3(...fit.target)); camera.updateMatrixWorld();
  return points.map(p => {
    const v = new Vector3(...p).project(camera);
    return { x: (v.x + 1) * width / 2, y: (1 - v.y) * height / 2, z: v.z };
  });
}

describe('source camera fits actual geometry to usable viewport', () => {
  const scenarios: { name: string; width: number; height: number; obstacles: CameraFitRect[] }[] = [
    { name: '390 portrait', width: 390, height: 671, obstacles: [{ left: 75, right: 382, top: 611, bottom: 663 }] },
    { name: '360 portrait', width: 360, height: 627, obstacles: [{ left: 45, right: 352, top: 567, bottom: 619 }] },
    { name: 'short landscape', width: 667, height: 202, obstacles: [{ left: 490, right: 659, top: 8, bottom: 52 }, { left: 615, right: 659, top: 56, bottom: 158 }] },
    { name: 'tablet', width: 768, height: 820, obstacles: [{ left: 600, right: 760, top: 8, bottom: 64 }, { left: 716, right: 760, top: 108, bottom: 580 }] },
    { name: 'desktop', width: 1280, height: 623, obstacles: [{ left: 1050, right: 1272, top: 8, bottom: 40 },
      { left: 1107, right: 1272, top: 108, bottom: 485 }, { left: 520, right: 760, top: 547, bottom: 615 }, { left: 8, right: 130, top: 8, bottom: 34 }] },
    { name: 'desktop split', width: 520, height: 623, obstacles: [{ left: 285, right: 512, top: 8, bottom: 40 },
      { left: 468, right: 512, top: 108, bottom: 485 }, { left: 140, right: 380, top: 547, bottom: 615 }] }
  ];
  for (const s of scenarios) it(`projects every cloth/body point inside measured controls for ${s.name}`, () => {
    const rect = sourceCameraSafeRect(s.width, s.height, s.obstacles)!;
    expect(rect).not.toBeNull();
    const fit = fitSourceCamera(points, { ...s, rect }, direction, 54.43)!;
    for (const p of projected(s.width, s.height, fit)) {
      expect(p.x).toBeGreaterThanOrEqual(rect.left); expect(p.x).toBeLessThanOrEqual(rect.right);
      expect(p.y).toBeGreaterThanOrEqual(rect.top); expect(p.y).toBeLessThanOrEqual(rect.bottom);
      expect(p.z).toBeGreaterThan(-1); expect(p.z).toBeLessThan(1);
    }
    expect(fit.fov).toBe(54.43);
    expect(new Vector3(...fit.position).sub(new Vector3(...fit.target)).normalize().distanceTo(new Vector3(...direction))).toBeLessThan(1e-12);
  });

  it('keeps the previous framing while a nearly full-screen drawer is open', () => {
    expect(sourceCameraSafeRect(390, 671, [{ left: 30, right: 382, top: 8, bottom: 603 }])).toBeNull();
    expect(sourceCameraSafeRect(390, 671, [{ left: 75, right: 382, top: 611, bottom: 663 }])).not.toBeNull();
  });
  it('matches the actual Three camera projection for a top-facing camera', () => {
    const rect = { left: 12, right: 648, top: 24, bottom: 400 };
    const fit = fitSourceCamera(points, { width: 660, height: 440, rect }, [0, 1, 0], 54.43)!;
    for (const p of projected(660, 440, fit)) {
      expect(p.x).toBeGreaterThanOrEqual(rect.left); expect(p.x).toBeLessThanOrEqual(rect.right);
      expect(p.y).toBeGreaterThanOrEqual(rect.top); expect(p.y).toBeLessThanOrEqual(rect.bottom);
    }
  });
  it('rejects unavailable and malformed geometry instead of inventing a camera', () => {
    const viewport = { width: 390, height: 671, rect: { left: 12, right: 378, top: 12, bottom: 600 } };
    expect(fitSourceCamera([], viewport, direction, 54.43)).toBeNull();
    expect(fitSourceCamera([[NaN, 1, 0]], viewport, direction, 54.43)).toBeNull();
    expect(fitSourceCamera(points, viewport, [0, 0, 0], 54.43)).toBeNull();
    expect(sourceCameraSafeRect(0, 0, [])).toBeNull();
  });
});
