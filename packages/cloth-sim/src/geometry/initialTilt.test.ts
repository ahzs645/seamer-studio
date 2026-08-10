import { describe, expect, it } from 'vitest';
import { applyInitialVerticalTilt } from './initialTilt';

function packedParticle(x: number, y: number, z: number, inverseMass = 1): number[] {
  return [x, y, z, inverseMass];
}

function packed2d(pieceIndex: number): number[] {
  return [0, 0, 0, pieceIndex];
}

describe('applyInitialVerticalTilt', () => {
  it('alternates the source 0.001 radian tilt for vertical XY panels', () => {
    const positions = new Float32Array([
      ...packedParticle(-1, 0, 0),
      ...packedParticle(1, 2, 0),
      ...packedParticle(-1, 0, 4),
      ...packedParticle(1, 2, 4)
    ]);
    const positions2d = new Float32Array([
      ...packed2d(0), ...packed2d(0), ...packed2d(1), ...packed2d(1)
    ]);

    applyInitialVerticalTilt(positions, positions2d);

    expect(positions[6]).toBeCloseTo(2 * Math.sin(0.001), 6);
    expect(positions[14]).toBeCloseTo(4 - 2 * Math.sin(0.001), 6);
    expect(positions[1]).toBe(0);
    expect(positions[9]).toBe(0);
  });

  it('tilts vertical YZ panels around their bottom edge', () => {
    const positions = new Float32Array([
      ...packedParticle(3, 0, -1),
      ...packedParticle(3, 2, 1)
    ]);
    const positions2d = new Float32Array([...packed2d(2), ...packed2d(2)]);

    applyInitialVerticalTilt(positions, positions2d);

    expect(positions[0]).toBe(3);
    expect(positions[4]).toBeCloseTo(3 - 2 * Math.sin(0.001), 6);
    expect(positions[5]).toBeCloseTo(2 * Math.cos(0.001), 6);
  });

  it('leaves non-planar and fixed-particle pieces unchanged', () => {
    const positions = new Float32Array([
      ...packedParticle(0, 0, 0),
      ...packedParticle(1, 2, 1),
      ...packedParticle(4, 0, 0, 0),
      ...packedParticle(5, 2, 0)
    ]);
    const positions2d = new Float32Array([
      ...packed2d(0), ...packed2d(0), ...packed2d(1), ...packed2d(1)
    ]);
    const before = positions.slice();

    applyInitialVerticalTilt(positions, positions2d);

    expect(positions).toEqual(before);
  });
});
