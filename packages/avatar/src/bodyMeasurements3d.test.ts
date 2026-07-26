// On-mesh measurement segments: girth slicing on a square tube has a known perimeter.

import { describe, it, expect } from 'vitest';
import { measurementSegment } from './bodyMeasurements3d';

/** A square tube (side 1) from y=0 to y=2: 8 vertices, 8 side triangles. */
function squareTube() {
  const s = 0.5;
  const ring = (y: number) => [
    [-s, y, -s], [s, y, -s], [s, y, s], [-s, y, s]
  ] as [number, number, number][];
  const verts = [...ring(0), ...ring(2)];
  const vertices = new Float32Array(verts.flat());
  const idx: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = i, b = (i + 1) % 4, c = i + 4, d = ((i + 1) % 4) + 4;
    idx.push(a, b, c, b, d, c);
  }
  return { vertices, indices: new Uint32Array(idx) };
}

describe('measurementSegment', () => {
  const { vertices, indices } = squareTube();
  // barycentric anchor at the centroid of face 0 (one of the side triangles) → height ≈ 2/3
  const anchor = { faceIndex: 0, u: 1 / 3, v: 1 / 3, w: 1 / 3 };

  it('girth slices the tube into a closed loop with the square perimeter', () => {
    const seg = measurementSegment(
      { name: 'g', type: 'girth', coordinates: [anchor] },
      vertices,
      indices
    );
    expect(seg).not.toBeNull();
    expect(seg!.closed).toBe(true);
    expect(seg!.lengthM).toBeCloseTo(4, 1); // 4 × side 1
    for (const p of seg!.points) expect(p[1]).toBeCloseTo(2 / 3, 6); // all on the slice plane
  });

  it('straight measures the anchor-to-anchor distance', () => {
    const a2 = { faceIndex: 6, u: 1 / 3, v: 1 / 3, w: 1 / 3 };
    const seg = measurementSegment({ name: 's', type: 'straight', coordinates: [anchor, a2] }, vertices, indices);
    expect(seg).not.toBeNull();
    expect(seg!.closed).toBe(false);
    expect(seg!.lengthM).toBeGreaterThan(0);
  });

  it('floor drops from the anchor to y=0', () => {
    const seg = measurementSegment({ name: 'f', type: 'floor', coordinates: [anchor] }, vertices, indices);
    expect(seg!.lengthM).toBeCloseTo(2 / 3, 6);
    expect(seg!.points[1][1]).toBe(0);
  });
});
