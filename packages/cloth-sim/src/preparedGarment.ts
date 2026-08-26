// Seamer's cloth, in the shape Atelier says a garment reaches a solver in.
//
// `SimData` is what this package's XPBD engine needs, and it is specific in
// ways that matter to it: constraints sorted into colour groups so a GPU can
// solve them without two threads writing the same particle, seam links gated by
// an assembly order, wire runs, edge runs. None of that is wrong and none of it
// is portable.
//
// `PreparedGarment` is the part that is not specific to any of it: particles,
// the distances the fabric insists on, the seams between pieces, and a body in
// the way. knitterer produces the same shape from a knitting chart -- which has
// nothing whatever in common with a sewing pattern until the question becomes
// how it hangs, and then has everything in common with it.
//
// Converting loses the colouring and the gating on purpose. A solver that wants
// them takes SimData; a solver that only needs to know what a garment *is*
// takes this.

import type {
  GarmentConstraint,
  GarmentConstraintRange,
  GarmentPiece,
  PreparedGarment,
} from '@atelier/sim';
import type { SimData } from './build';
import type { BodyMesh } from './webgpu/engine';

/** Seamer works in metres; the shape records that so nothing has to assume it. */
const seamerUnit = 'm' as const;

function particlesFromSimData(simData: SimData): {
  positions: Float32Array;
  invMass: Float32Array;
} {
  const count = simData.particleCount;
  const positions = new Float32Array(count * 3);
  const invMass = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    // SimData packs position and inverse mass into one vec4 for the GPU.
    positions[index * 3] = simData.positions[index * 4]!;
    positions[index * 3 + 1] = simData.positions[index * 4 + 1]!;
    positions[index * 3 + 2] = simData.positions[index * 4 + 2]!;
    invMass[index] = simData.positions[index * 4 + 3]!;
  }
  return { positions, invMass };
}

function constraintsFromColorGroups(
  groups: readonly { edges: Float32Array; props: Float32Array; count: number }[],
  out: GarmentConstraint[],
): number {
  let added = 0;
  for (const group of groups) {
    for (let edge = 0; edge < group.count; edge++) {
      const a = group.edges[edge * 4]!;
      const b = group.edges[edge * 4 + 1]!;
      const rest = group.edges[edge * 4 + 2]!;
      // Compliance is XPBD's inverse stiffness: zero is rigid, and larger
      // values give. Expressed here as the 0..1 stiffness the shared shape
      // speaks, so a solver that does not do compliance still behaves sensibly.
      const compliance = group.props[edge * 4] ?? 0;
      out.push({
        a,
        b,
        rest,
        stiffness: compliance > 0 ? 1 / (1 + compliance * 1e6) : 1,
      });
      added++;
    }
  }
  return added;
}

function seamConstraints(simData: SimData, out: GarmentConstraint[]): number {
  let added = 0;
  const seen = new Set<number>();
  for (let particle = 0; particle < simData.particleCount; particle++) {
    for (let slot = 0; slot < 4; slot++) {
      const other = simData.seams[particle * 4 + slot]!;
      if (other < 0 || other === particle) {
        continue;
      }
      // Seams are recorded from both ends; one constraint is enough.
      const key = particle < other ? particle * simData.particleCount + other : other * simData.particleCount + particle;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ a: particle, b: other, rest: 0, stiffness: 0.9 });
      added++;
    }
  }
  return added;
}

export interface ToPreparedGarmentOptions {
  body?: BodyMesh;
  /** Include bend constraints as well as stretch. Off by default: a solver
   *  that does not know they are bend constraints will treat them as fabric
   *  that must not stretch, which is not what they are. */
  includeBend?: boolean;
}

/** A sewn garment, in the shape a knitted one also arrives in. */
export function toPreparedGarment(
  simData: SimData,
  { body, includeBend = false }: ToPreparedGarmentOptions = {},
): PreparedGarment {
  const constraints: GarmentConstraint[] = [];
  const ranges: GarmentConstraintRange[] = [];
  const fabric = constraintsFromColorGroups(simData.stretchColors, constraints);
  ranges.push({ kind: 'fabric', start: 0, count: fabric });
  if (includeBend) {
    const bend = constraintsFromColorGroups(simData.bendColors, constraints);
    ranges.push({ kind: 'fabric', start: fabric, count: bend });
  }
  const seamStart = constraints.length;
  const seams = seamConstraints(simData, constraints);
  ranges.push({ kind: 'piece-seam', start: seamStart, count: seams });

  const pieces: GarmentPiece[] = simData.pieces.map((piece) => ({
    name: piece.pieceId,
    kind: 'panel',
    particleStart: piece.start,
    particleCount: piece.count,
  }));

  return {
    particles: particlesFromSimData(simData),
    constraints,
    ranges,
    pieces,
    ...(body
      ? {
          collider: {
            positions: bodyPositionsToXyz(body.positions),
            indices: bodyTrianglesToIndices(body.triangles, body.numTriangles),
          },
        }
      : {}),
    unit: seamerUnit,
  };
}

/** The engine packs the body as vec4s for the GPU; the shared shape is xyz. */
function bodyPositionsToXyz(packed: Float32Array): Float32Array {
  const count = packed.length / 4;
  const out = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    out[index * 3] = packed[index * 4]!;
    out[index * 3 + 1] = packed[index * 4 + 1]!;
    out[index * 3 + 2] = packed[index * 4 + 2]!;
  }
  return out;
}

function bodyTrianglesToIndices(packed: Uint32Array, numTriangles: number): Uint32Array {
  const out = new Uint32Array(numTriangles * 3);
  for (let triangle = 0; triangle < numTriangles; triangle++) {
    out[triangle * 3] = packed[triangle * 4]!;
    out[triangle * 3 + 1] = packed[triangle * 4 + 1]!;
    out[triangle * 3 + 2] = packed[triangle * 4 + 2]!;
  }
  return out;
}
