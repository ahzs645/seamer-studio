import { describe, it, expect } from 'vitest';
import { mirrorHalfOutline, type Vec2 } from './patternGeometry';

const bbox = (pts: Vec2[]) => ({
  minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
  minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y))
});

describe('mirrorHalfOutline (first-edge symmetry)', () => {
  it('mirrors a half-rectangle across a vertical fold into a full rectangle', () => {
    // fold = the segment a=(0,0)→b=(0,10) on x=0; half lives at x>=0
    const a = { x: 0, y: 0 }, b = { x: 0, y: 10 };
    const half: Vec2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }
    ];
    const full = mirrorHalfOutline(half, a, b);
    const bb = bbox(full);
    expect(bb.minX).toBeCloseTo(-10, 6); // mirrored across x=0
    expect(bb.maxX).toBeCloseTo(10, 6);
    expect(bb.minY).toBeCloseTo(0, 6);
    expect(bb.maxY).toBeCloseTo(10, 6);
  });

  it('drops interior fold points and stays symmetric about the fold', () => {
    const a = { x: 0, y: 0 }, b = { x: 0, y: 10 };
    const half: Vec2[] = [
      { x: 0, y: 0 }, { x: 0, y: 5 } /* interior fold point — should be dropped */,
      { x: 0, y: 10 }, { x: 8, y: 8 }, { x: 8, y: 2 }
    ];
    const full = mirrorHalfOutline(half, a, b);
    // every x>0 vertex must have a mirrored x<0 partner
    const xs = full.map((p) => p.x);
    expect(xs.some((x) => x > 0)).toBe(true);
    expect(xs.some((x) => x < 0)).toBe(true);
    expect(bbox(full).minX).toBeCloseTo(-8, 6);
    expect(bbox(full).maxX).toBeCloseTo(8, 6);
  });

  it('mirrors across an arbitrary (diagonal) fold line', () => {
    const a = { x: 0, y: 0 }, b = { x: 10, y: 10 }; // y = x
    const full = mirrorHalfOutline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], a, b);
    // (10,0) reflected across y=x → (0,10)
    expect(full.some((p) => Math.abs(p.x - 0) < 1e-6 && Math.abs(p.y - 10) < 1e-6)).toBe(true);
  });
});
