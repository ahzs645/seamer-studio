import { describe, expect, it } from 'vitest';
import { validatePreparedGarment } from '@atelier/sim/garment';
import { toPreparedGarment } from './preparedGarment';
import type { SimData } from './build';

// The smallest thing that is still a garment: two particles held a known
// distance apart, seamed to each other, with a body in the way.
function twoParticles(): SimData {
  return {
    particleCount: 2,
    // vec4 per particle: x, y, z, invMass
    positions: new Float32Array([0, 0, 0, 1, 0.1, 0, 0, 1]),
    arrangedPositions: new Float32Array(8),
    positions2d: new Float32Array(8),
    anchors: new Float32Array(8),
    stretchColors: [
      {
        // vec4 per edge: a, b, rest, longRange
        edges: new Float32Array([0, 1, 0.1, 0]),
        // vec4 per edge: compliance, 0, 0, 0
        props: new Float32Array([0, 0, 0, 0]),
        count: 1,
      },
    ],
    bendColors: [],
    seams: Int32Array.from([1, -1, -1, -1, 0, -1, -1, -1]),
    pieces: [
      { pieceId: 'front', materialId: 'm', start: 0, count: 2, triangles: [], uv: new Float32Array() },
    ],
    triangles: new Uint32Array(),
    triangleCount: 0,
    particleLayers: new Uint32Array(2),
    neighborIndices: new Int32Array(16).fill(-1),
    incidentTriangles: new Int32Array(),
    maxIncidentTrianglesPerParticle: 0,
    edgeRuns: new Map(),
    seamPairsBySeam: [],
    seamOrder: new Int32Array(8).fill(-1),
    stitchCount: 0,
    seamStitchRanges: [],
    assemblySteps: [],
    wireRuns: [],
  };
}

describe('a sewn garment in the shared shape', () => {
  it('is a garment Atelier recognises', () => {
    const garment = toPreparedGarment(twoParticles());
    expect(validatePreparedGarment(garment)).toEqual([]);
  });

  it('unpacks the GPU vec4 layout into positions and masses', () => {
    const garment = toPreparedGarment(twoParticles());
    // Float32 throughout, so 0.1 is 0.1 to about seven digits and no further.
    const positions = Array.from(garment.particles.positions);
    expect(positions).toHaveLength(6);
    for (const [index, want] of [0, 0, 0, 0.1, 0, 0].entries()) {
      expect(positions[index]).toBeCloseTo(want, 6);
    }
    expect(Array.from(garment.particles.invMass)).toEqual([1, 1]);
  });

  it('records that seamer works in metres', () => {
    // A garment measured in metres handed to a solver thinking in centimetres
    // falls a hundredth as fast and looks stiff rather than wrong.
    expect(toPreparedGarment(twoParticles()).unit).toBe('m');
  });

  it('carries the stretch edges as fabric and the seams as seams', () => {
    const garment = toPreparedGarment(twoParticles());
    const kinds = Object.fromEntries(
      (garment.ranges ?? []).map((range) => [range.kind, range.count]),
    );
    expect(kinds.fabric).toBe(1);
    expect(kinds['piece-seam']).toBe(1);
    expect(garment.constraints[0]!.a).toBe(0);
    expect(garment.constraints[0]!.b).toBe(1);
    expect(garment.constraints[0]!.rest).toBeCloseTo(0.1, 6);
    expect(garment.constraints[0]!.stiffness).toBe(1);
  });

  it('records a seam once, not once from each end', () => {
    const garment = toPreparedGarment(twoParticles());
    const seams = garment.constraints.filter((constraint) => constraint.rest === 0);
    expect(seams).toHaveLength(1);
  });

  it('leaves bend constraints out unless asked, since they are not fabric', () => {
    const data = twoParticles();
    data.bendColors = [
      { edges: new Float32Array([0, 1, 0.2, 0]), props: new Float32Array([0, 0, 0, 0]), count: 1 },
    ];
    expect(toPreparedGarment(data).constraints).toHaveLength(2);
    expect(toPreparedGarment(data, { includeBend: true }).constraints).toHaveLength(3);
  });

  it('unpacks a body from the engine vec4 layout', () => {
    const garment = toPreparedGarment(twoParticles(), {
      body: {
        positions: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]),
        triangles: Uint32Array.from([0, 1, 2, 0]),
        numTriangles: 1,
      },
    });
    expect(Array.from(garment.collider!.indices)).toEqual([0, 1, 2]);
    expect(garment.collider!.positions).toHaveLength(9);
    expect(validatePreparedGarment(garment)).toEqual([]);
  });
});
