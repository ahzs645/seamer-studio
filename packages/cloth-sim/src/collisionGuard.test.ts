import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ClothCollisionGuard, isLocallyClosedPairedSeamContact, type CollisionGuardInput } from './collisionGuard';

const bodyPositions = new Float32Array([
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
  -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1
]);
const bodyIndices = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7
]);
const packed = (vertices: number[][]) => new Float32Array(vertices.flatMap(p => [...p, 1]));
function guard(vertices: number[][], triangles = [0, 1, 2, 0], extra: Partial<CollisionGuardInput> = {}) {
  return new ClothCollisionGuard({ bodyPositions, bodyIndices, clothTriangles: new Uint32Array(triangles), particleCount: vertices.length, ...extra });
}

describe('source garment collision acceptance guard', () => {
  it('accepts a clear garment and does not mutate positions', () => {
    const vertices = [[2, -1, -1], [2, 1, -1], [2, 0, 1]], positions = packed(vertices), copy = positions.slice();
    const checker = guard(vertices), report = checker.inspect(positions);
    expect(report.safe).toBe(true);
    expect(report.bodyClosed).toBe(true);
    expect(positions).toEqual(copy);
    expect(checker.inspect(positions, positions).safe).toBe(true);
  });

  it('accepts contact on the body surface and outward motion from contact', () => {
    const vertices = [[1, -.3, -.3], [1, .3, -.3], [1, 0, .3]];
    const checker = guard(vertices), contact = packed(vertices), outside = packed(vertices.map(p => [1.01, p[1], p[2]]));
    expect(checker.inspect(contact).safe).toBe(true);
    expect(checker.inspect(outside, contact).safe).toBe(true);
  });

  it('accepts GPU-packed body positions and triangle metadata strides', () => {
    const vertices = [[2, -1, -1], [2, 1, -1], [2, 0, 1]];
    const body = [];
    for (let k = 0; k < bodyPositions.length; k += 3) body.push(bodyPositions[k], bodyPositions[k + 1], bodyPositions[k + 2], 0);
    const indices = [];
    for (let k = 0; k < bodyIndices.length; k += 3) indices.push(bodyIndices[k], bodyIndices[k + 1], bodyIndices[k + 2], 9999);
    expect(guard(vertices, undefined, { bodyPositions: body, bodyIndices: indices, bodyPositionStride: 4, bodyTriangleStride: 4 }).inspect(packed(vertices)).safe).toBe(true);
  });

  it('retains distinct submicron entry/exit hits instead of merging their ray distances', () => {
    const vertices = [[0, 0, 0], [0, .1, 0], [0, 0, .1]];
    // The first oblique ray traverses this closed slab in <1um. Both crossings
    // lie in triangle interiors; distance-only deduplication falsely made it odd.
    const thinBody = Float32Array.from(bodyPositions, (value, index) => index % 3 === 0 ? (value < 0 ? 1 : 1 + 4e-7) : value);
    const report = guard(vertices, undefined, { bodyPositions: thinBody }).inspect(packed(vertices));
    expect(report).toMatchObject({ safe: true, bodyClosed: true, insideParticleCount: 0, rayDisagreementCount: 0 });
  });

  it('coalesces true shared-edge ray duplicates without discarding interior hits', () => {
    const vertices = [[0, 0, 0], [0, -.1, 0], [0, 0, -.1]];
    // The first ray passes through the centre/shared diagonal of the front face.
    const shiftedBody = Array.from(bodyPositions, (value, index) => value + [2, .173, .291][index % 3]);
    const report = guard(vertices, undefined, { bodyPositions: shiftedBody }).inspect(packed(vertices));
    expect(report).toMatchObject({ safe: true, insideParticleCount: 0, rayDisagreementCount: 0 });
  });

  it('detects an inside particle independently of a surface crossing', () => {
    const vertices = [[0, 0, 0], [.1, 0, 0], [0, .1, 0]];
    const report = guard(vertices).inspect(packed(vertices));
    expect(report.safe).toBe(false);
    expect(report.insideParticleCount).toBe(3);
    expect(report.bodyCrossingTriangleCount).toBe(0);
  });

  it('rejects a body edge passing through a broad cloth face with every cloth vertex outside', () => {
    const vertices = [[-4, -3, 0], [4, -3, 0], [0, 5, 0]];
    const report = guard(vertices).inspect(packed(vertices));
    expect(report.insideParticleCount).toBe(0);
    expect(report.bodyCrossingTriangleCount).toBe(1);
    expect(report.safe).toBe(false);
  });

  it('detects a narrow wrist-sized body crossing between outside sleeve vertices', () => {
    const wristBody = Float32Array.from(bodyPositions, x => x * .025);
    const vertices = [[-.08, 0, 0], [.08, 0, 0], [0, .08, 0]];
    const report = guard(vertices, undefined, { bodyPositions: wristBody }).inspect(packed(vertices));
    expect(report.insideParticleCount).toBe(0);
    expect(report.bodyCrossingTriangleCount).toBe(1);
    expect(report.safe).toBe(false);
  });

  it('rejects tunnelling through a body even when both endpoint states are clear', () => {
    const before = [[-2, -.3, -.3], [-2, .3, -.3], [-2, 0, .3]];
    const after = before.map(p => [2, p[1], p[2]]);
    const checker = guard(before);
    expect(checker.inspect(packed(before)).safe).toBe(true);
    expect(checker.inspect(packed(after)).safe).toBe(true);
    const report = checker.inspect(packed(after), packed(before));
    expect(report.sweptBodyCrossingParticleCount).toBe(3);
    expect(report.safe).toBe(false);
  });

  it('rejects finite cloth edge/face crossings with no inside body particles', () => {
    const vertices = [[2, 0, 0], [4, 0, 0], [3, 2, 0], [3, .5, -1], [3, .5, 1], [5, .5, 0]];
    const report = guard(vertices, [0, 1, 2, 0, 3, 4, 5, 0]).inspect(packed(vertices));
    expect(report.bodyCrossingTriangleCount).toBe(0);
    expect(report.insideParticleCount).toBe(0);
    expect(report.selfCrossingPairs).toEqual([[0, 1]]);
    expect(report.safe).toBe(false);
  });

  it('exempts only locally closed sewing contacts and shared mesh particles', () => {
    const vertices = [[2, 0, 0], [2, .1, 0], [2.1, 0, 0], [2, 0, .001], [2, .1, -.001], [2.1, .05, .02]];
    const seams = new Int32Array(24).fill(-1); seams[0] = 3; seams[12] = 0; seams[4] = 4; seams[16] = 1;
    const topology = { seams, seamPairsBySeam: [{ pairs: [0, 3, 1, 4] }] };
    const report = guard(vertices, [0, 1, 2, 0, 3, 4, 5, 0], topology).inspect(packed(vertices));
    expect(report.selfCrossingPairCount).toBe(0);
    // The exact same sewing corner references do not excuse a crossing far from its seam.
    const far = [[2, 0, 0], [4, 0, 0], [3, 2, 0], [3, .5, -1], [3, .5, 1], [5, .5, 0]];
    expect(guard(far, [0, 1, 2, 0, 3, 4, 5, 0], topology).inspect(packed(far)).selfCrossingPairCount).toBe(1);
    const shared = guard(vertices, [0, 1, 2, 0, 0, 4, 5, 0]).inspect(packed(vertices));
    expect(shared.selfCrossingPairCount).toBe(0);
  });

  it('accepts a locally welded sewing contact while other stitches of the same seam remain open', () => {
    const vertices = [[2, 0, 0], [2, .1, 0], [2.1, 0, 0], [2, 0, .001], [2, .1, -.001], [2.1, .05, .02],
      [2, .2, 0], [2, .2, .004]];
    const report = guard(vertices, [0, 1, 2, 0, 3, 4, 5, 0], { seamPairsBySeam: [{ pairs: [0, 3, 1, 4, 6, 7] }] }).inspect(packed(vertices));
    expect(report.selfCrossingPairCount).toBe(0);
    expect(report.safe).toBe(true);
  });

  it('rejects locally unclosed contacts even when the two independent seam sides are nearby', () => {
    const vertices = [[2, 0, 0], [2, .1, 0], [2.1, 0, 0], [2, 0, .004], [2, .1, .004], [2.1, .05, -.02]];
    const report = guard(vertices, [0, 1, 2, 0, 3, 4, 5, 0], { seamPairsBySeam: [{ pairs: [0, 3, 1, 4] }] }).inspect(packed(vertices));
    expect(report.selfCrossingPairCount).toBe(1);
    expect(report.safe).toBe(false);
  });

  it('requires corresponding locations on the same actual paired segment', () => {
    const p = new Vector3(0, .01, 0), a0 = new Vector3(0, 0, 0), a1 = new Vector3(0, .1, 0), b0 = new Vector3(0, .03, 0), b1 = new Vector3(0, -.07, 0);
    // The independent polylines overlap, but the matched midpoint projects to
    // opposite source locations 30mm apart; nearest-side tests would falsely pass.
    expect(isLocallyClosedPairedSeamContact(p, a0, a1, b0, b1)).toBe(false);
    expect(isLocallyClosedPairedSeamContact(new Vector3(0, .05, .001), a0, a1, new Vector3(0, 0, .002), new Vector3(0, .1, .002))).toBe(true);
    expect(isLocallyClosedPairedSeamContact(new Vector3(0, .05, .002), a0, a1, new Vector3(0, 0, .004), new Vector3(0, .1, .004))).toBe(false);
  });

  it('rejects a contact near an unrelated folded segment of the same source seam', () => {
    const vertices = [[2, 0, 0], [4, 0, 0], [3, 2, 0], [3, .5, -1], [3, .5, 1], [5, .5, 0],
      [3, .5, 0], [4, .5, 0], [3, .5, 0], [4, .5, 0]];
    const topology = { seamPairsBySeam: [{ pairs: [0, 3, 6, 8, 7, 9] }] };
    // This distant segment lies directly on the intersection, but its actual
    // particle pairs are disconnected from both intersecting face one-rings.
    expect(isLocallyClosedPairedSeamContact(new Vector3(3.5, .5, 0), new Vector3(...vertices[6]), new Vector3(...vertices[7]), new Vector3(...vertices[8]), new Vector3(...vertices[9]))).toBe(true);
    const report = guard(vertices, [0, 1, 2, 0, 3, 4, 5, 0], topology).inspect(packed(vertices));
    expect(report.selfCrossingPairCount).toBe(1);
    expect(report.safe).toBe(false);
  });

  it('keeps distant faces on sewn panels eligible for collision checks', () => {
    // Sew two tiny faces, leaving the actual crossing pair disconnected from that seam.
    const vertices = [[2, 0, 0], [4, 0, 0], [3, 2, 0], [3, .5, -1], [3, .5, 1], [5, .5, 0],
      [10, 0, 0], [10, 1, 0], [11, 0, 0], [10, 0, .01], [10, 1, .01], [11, 0, .01]];
    const seams = new Int32Array(vertices.length * 4).fill(-1); seams[6 * 4] = 9; seams[9 * 4] = 6;
    const report = guard(vertices, [0, 1, 2, 0, 3, 4, 5, 0, 6, 7, 8, 0, 9, 10, 11, 0], { seams }).inspect(packed(vertices));
    expect(report.selfCrossingPairs).toEqual([[0, 1]]);
    expect(report.safe).toBe(false);
  });

  it('fails closed for nonfinite steps and unsupported open body topology', () => {
    const vertices = [[2, -1, -1], [2, 1, -1], [2, 0, 1]], positions = packed(vertices);
    positions[0] = NaN;
    expect(guard(vertices).inspect(positions)).toMatchObject({ safe: false, finite: false });
    expect(guard(vertices, undefined, { bodyIndices: bodyIndices.slice(3) }).inspect(packed(vertices)))
      .toMatchObject({ safe: false, bodyClosed: false });
  });

  it('accepts duplicate body vertices at a closed UV seam', () => {
    const positions = [...bodyPositions], indices: number[] = [];
    for (const index of bodyIndices) { indices.push(positions.length / 3); positions.push(...bodyPositions.slice(index * 3, index * 3 + 3)); }
    const vertices = [[2, -1, -1], [2, 1, -1], [2, 0, 1]];
    expect(guard(vertices, undefined, { bodyPositions: positions, bodyIndices: indices }).inspect(packed(vertices)).safe).toBe(true);
  });

  it('limits reported samples without suppressing complete collision counts', () => {
    const vertices = [[0, 0, 0], [.1, 0, 0], [0, .1, 0]];
    const checker = new ClothCollisionGuard({ bodyPositions, bodyIndices, particleCount: 3, clothTriangles: [0, 1, 2, 0] }, { maxRecordedIssues: 1 });
    const report = checker.inspect(packed(vertices));
    expect(report.insideParticleCount).toBe(3);
    expect(report.insideParticles).toHaveLength(1);
  });
});

describe('strict actual corrected substep trajectories', () => {
  const startVertices = [[-2, -.3, -.3], [-2, .3, -.3], [-2, 0, .3]];
  const start = packed(startVertices), end = packed(startVertices.map(point => [2, point[1], point[2]]));
  const around = [start, packed(startVertices.map(point => [-2, point[1], point[2] + 2.5])),
    packed(startVertices.map(point => [2, point[1], point[2] + 2.5])), end];

  it('accepts an exactly bound curved path around skin whose whole-frame chord crosses it', () => {
    const checker = guard(startVertices);
    expect(checker.inspect(end, start)).toMatchObject({ safe: false, sweptBodyCrossingParticleCount: 3 });
    const before = around.map(sample => sample.slice());
    expect(checker.inspectTrajectory(end, start, around, 3)).toMatchObject({
      safe: true, finite: true, insideParticleCount: 0, bodyCrossingTriangleCount: 0,
      selfCrossingPairCount: 0, sweptBodyCrossingParticleCount: 0,
      trajectory: { valid: true, expectedSubSteps: 3, inspectedSubsteps: 3 }
    });
    expect(around).toEqual(before);
  });

  it('rejects an actual consecutive tunnel despite clear initial and final states', () => {
    const report = guard(startVertices).inspectTrajectory(end, start, [start, end], 1);
    expect(report).toMatchObject({ safe: false, insideParticleCount: 0, bodyCrossingTriangleCount: 0,
      sweptBodyCrossingParticleCount: 3, trajectory: { valid: true, firstUnsafeSubstep: 1 } });
    expect(report.sweptBodyCrossingParticles).toEqual([0, 1, 2]);
  });

  it('rejects intermediate deep inside particles even when every published endpoint is clear', () => {
    const middle = packed(startVertices.map(point => [0, point[1], point[2]]));
    const checker = new ClothCollisionGuard({ bodyPositions, bodyIndices, particleCount: 3, clothTriangles: [0, 1, 2, 0] }, { maxRecordedIssues: 1 });
    const report = checker.inspectTrajectory(end, start, [start, middle, middle, end], 3);
    expect(report).toMatchObject({ safe: false, insideParticleCount: 6, sweptBodyCrossingParticleCount: 6,
      trajectory: { valid: true, inspectedSubsteps: 3, firstUnsafeSubstep: 1, counts: 'feature-occurrences-across-substeps' } });
    expect(report.insideParticles).toHaveLength(1);
    expect(report.sweptBodyCrossingParticles).toHaveLength(1);
  });

  it('rejects intermediate finite cloth interiors cut by body edges with all cloth vertices outside', () => {
    const initialVertices = [[2, -.3, -.3], [2, .3, -.3], [2, 0, .3]], initial = packed(initialVertices);
    const crossing = packed([[-4, -3, 0], [4, -3, 0], [0, 5, 0]]);
    const report = guard(initialVertices).inspectTrajectory(initial, initial, [initial, crossing, initial], 2);
    expect(report).toMatchObject({ safe: false, insideParticleCount: 0, bodyCrossingTriangleCount: 1,
      trajectory: { valid: true, firstUnsafeSubstep: 1 } });
  });

  it('rejects intermediate actual cloth self-crossings away from the body', () => {
    const clearVertices = [[2, 0, 0], [4, 0, 0], [3, 2, 0], [3, .5, 1], [3, .5, 2], [5, .5, 1]];
    const initial = packed(clearVertices), crossed = packed([[2, 0, 0], [4, 0, 0], [3, 2, 0], [3, .5, -1], [3, .5, 1], [5, .5, 0]]);
    const report = guard(clearVertices, [0, 1, 2, 0, 3, 4, 5, 0]).inspectTrajectory(initial, initial, [initial, crossed, initial], 2);
    expect(report).toMatchObject({ safe: false, insideParticleCount: 0, bodyCrossingTriangleCount: 0,
      selfCrossingPairCount: 1, trajectory: { valid: true, firstUnsafeSubstep: 1 } });
    expect(report.selfCrossingPairs).toEqual([[0, 1]]);
  });

  it.each([
    ['missing', undefined, 3, 'sample-count'], ['empty', [], 3, 'sample-count'],
    ['skipped substep', [start, around[1], end], 3, 'sample-count'],
    ['wrong expected steps', around, 40, 'sample-count'],
    ['invalid expected steps', around, 0, 'invalid-substeps']
  ] as const)('fails closed for %s without inspecting an invented trajectory', (_, path, steps, reason) => {
    const report = guard(startVertices).inspectTrajectory(end, start, path, steps);
    expect(report).toMatchObject({ safe: false, finite: false,
      trajectory: { valid: false, inspectedSubsteps: 0, invalidReason: reason } });
  });

  it.each(['start', 'end', 'NaN', 'wrong topology', 'mass'])('rejects exact trace binding corruption: %s', corruption => {
    const path = around.map(sample => sample.slice());
    let reason = 'invalid-sample';
    if (corruption === 'start') { path[0][0] += .000001; reason = 'start-mismatch'; }
    if (corruption === 'end') { path[3][0] += .000001; reason = 'end-mismatch'; }
    if (corruption === 'NaN') path[1][0] = NaN;
    if (corruption === 'wrong topology') path[1] = path[1].slice(0, 8);
    if (corruption === 'mass') { path[1][3] = 0; reason = 'mass-mismatch'; }
    const report = guard(startVertices).inspectTrajectory(end, start, path, 3);
    expect(report).toMatchObject({ safe: false, finite: false,
      trajectory: { valid: false, inspectedSubsteps: 0, invalidReason: reason } });
  });

  it('checks the initial static geometry instead of trusting an unsafe claimed published start', () => {
    const insideVertices = [[0, 0, 0], [.1, 0, 0], [0, .1, 0]], inside = packed(insideVertices);
    expect(guard(insideVertices).inspectTrajectory(inside, inside, [inside, inside], 1)).toMatchObject({
      safe: false, insideParticleCount: 6, trajectory: { valid: true, firstUnsafeSubstep: 0 }
    });
  });
});

describe('exact active seam and authoritative stitch-prefix proof', () => {
  const vertices = [[2, 0, 0], [2, .1, 0], [2.1, 0, 0], [2, 0, .001], [2, .1, -.001], [2.1, .05, .02]];
  const positions = packed(vertices), triangles = [0, 1, 2, 0, 3, 4, 5, 0];
  const topology = { stitchCount: 4, seamPairsBySeam: [{ seamId: 'actual-source-join', index: 0,
    pairs: [0, 3, 1, 4], stitchIndices: [3, 1] }] };
  const activation = (mask = 1, prefix = 4) => ({ revision: 7, activeSeams: new Uint32Array([mask]), sewnUpTo: prefix });

  it('rejects an inactive joining seam even when every finite endpoint is a locally closed actual pair', () => {
    const checker = guard(vertices, triangles, topology);
    expect(checker.inspect(positions, undefined, activation()).safe).toBe(true);
    expect(checker.inspect(positions, undefined, activation(0))).toMatchObject({ safe: false,
      finite: true, selfCrossingPairCount: 1, selfCrossingPairs: [[0, 1]] });
  });
  it('requires both actual segment endpoint stitches rather than group any-active or local pair ordinal', () => {
    const checker = guard(vertices, triangles, topology);
    expect(checker.inspect(positions, undefined, activation(1, 2)).selfCrossingPairCount).toBe(1);
    expect(checker.inspect(positions, undefined, activation(1, 3)).selfCrossingPairCount).toBe(1);
    expect(checker.inspect(positions, undefined, activation(1, 4)).selfCrossingPairCount).toBe(0);
  });
  it('uses the same activation for all41 samples and reports the request stage rather than a future stage', () => {
    const checker = guard(vertices, triangles, topology), trajectory = Array.from({ length: 41 }, () => positions.slice());
    const inactive = checker.inspectTrajectory(positions, positions, trajectory, 40, activation(0));
    expect(inactive).toMatchObject({ safe: false, selfCrossingPairCount: 41,
      seamActivation: { revision: 7, activeSeams: [0], sewnUpTo: 4 },
      trajectory: { valid: true, inspectedSubsteps: 40, firstUnsafeSubstep: 0 } });
    expect(checker.inspectTrajectory(positions, positions, trajectory, 40, activation()).safe).toBe(true);
  });
  it('fails closed when stitch-aware source input has no activation', () => {
    const checker = guard(vertices, triangles, topology);
    expect(checker.inspect(positions)).toMatchObject({ safe: false, finite: false });
    expect(checker.inspectTrajectory(positions, positions, [positions, positions], 1)).toMatchObject({
      safe: false, finite: false, trajectory: { valid: false, inspectedSubsteps: 0, invalidReason: 'activation-missing' }
    });
  });
  it.each([
    { revision: -1, activeSeams: new Uint32Array([1]), sewnUpTo: 4 },
    { revision: 1, activeSeams: new Uint32Array([2]), sewnUpTo: 4 },
    { revision: 1, activeSeams: new Uint32Array([]), sewnUpTo: 4 },
    { revision: 1, activeSeams: new Uint32Array([1]), sewnUpTo: 5 },
    { revision: 1, activeSeams: new Uint32Array([1]), sewnUpTo: .5 }
  ])('rejects malformed activation without inventing a valid geometric trace', context => {
    const report = guard(vertices, triangles, topology).inspectTrajectory(positions, positions, [positions, positions], 1, context);
    expect(report).toMatchObject({ safe: false, finite: false,
      trajectory: { valid: false, inspectedSubsteps: 0, invalidReason: 'invalid-seam-activation' } });
  });
  it('requires immutable source IDs, numeric dictionary order and complete in-range pair-stitch indices', () => {
    for (const patch of [
      { stitchIndices: [0] }, { stitchIndices: [0, 4] }, { stitchIndices: [0, -1] },
      { seamId: '' }, { index: 1 }
    ]) {
      expect(() => guard(vertices, triangles, { ...topology,
        seamPairsBySeam: [{ ...topology.seamPairsBySeam[0], ...patch }] })).toThrow(/authoritative seam stitch/);
    }
  });
  it('snapshots authoritative indices instead of accepting a later topology edit', () => {
    const indices = new Int32Array([3, 1]), checker = guard(vertices, triangles, {
      ...topology, seamPairsBySeam: [{ ...topology.seamPairsBySeam[0], stitchIndices: indices }]
    });
    indices.fill(0);
    expect(checker.inspect(positions, undefined, activation(1, 1)).selfCrossingPairCount).toBe(1);
  });
  it('keeps full legacy native joining behavior when no stitch-aware input is supplied', () => {
    const checker = guard(vertices, triangles, { seamPairsBySeam: [{ pairs: [0, 3, 1, 4] }] });
    expect(checker.inspect(positions).safe).toBe(true);
    expect(checker.inspectTrajectory(positions, positions, [positions, positions], 1).safe).toBe(true);
  });
  it('validates honest identity-logical versus reciprocal provenance without inventing a physical partner', () => {
    const kinds = ['identity-logical', 'reciprocal-first-stamp'] as const;
    const dictionary = { ...topology, seamPairsBySeam: [{ ...topology.seamPairsBySeam[0],
      pairs: [0, 0, 1, 4], stitchIndexKinds: kinds }] };
    expect(() => guard(vertices, triangles, dictionary)).not.toThrow();
    for (const wrong of [[], ['reciprocal-first-stamp', 'reciprocal-first-stamp'], ['identity-logical', 'identity-logical']] as const) {
      expect(() => guard(vertices, triangles, { ...dictionary, seamPairsBySeam: [{
        ...dictionary.seamPairsBySeam[0], stitchIndexKinds: wrong }] })).toThrow(/provenance/);
    }
    expect(() => guard(vertices, triangles, { ...topology, seamPairsBySeam: [{ ...topology.seamPairsBySeam[0],
      stitchIndexKinds: ['identity-logical', 'reciprocal-first-stamp'] }] })).toThrow(/provenance/);
  });
});
