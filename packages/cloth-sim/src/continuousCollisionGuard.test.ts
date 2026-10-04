import { describe, expect, it } from 'vitest';
import { ClothCollisionGuard, type CollisionGuardInput } from './collisionGuard';
import { ContinuousClothCollisionGuard } from './continuousCollisionGuard';

const cubePositions = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
const cubeIndices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
const packed = (points: number[][]) => Float32Array.from(points.flatMap(p => [...p, 1]));
function input(points: number[][], triangles = [0, 1, 2, 0], extra: Partial<CollisionGuardInput> = {}): CollisionGuardInput {
  return { bodyPositions: cubePositions, bodyIndices: cubeIndices, particleCount: points.length, clothTriangles: triangles, ...extra };
}
const farBody = { bodyPositions: cubePositions.map((v, i) => i % 3 === 0 ? v + 100 : v) };

describe('optional linear-feature continuous garment collision screen', () => {
  it('accepts clear linear movement without mutating either boundary', () => {
    const before = packed([[2, -.3, -.3], [2, .3, -.3], [2, 0, .3]]), after = before.slice();
    for (let k = 0; k < after.length; k += 4) after[k] += .1;
    const firstCopy = before.slice(), lastCopy = after.slice(), guard = new ContinuousClothCollisionGuard(input([[2, 0, 0], [2, 1, 0], [2, 0, 1]]));
    expect(guard.inspect(before, after)).toMatchObject({ safe: true, bodyContactCount: 0, selfContactCount: 0, earliestTimeOfImpact: null });
    expect(before).toEqual(firstCopy); expect(after).toEqual(lastCopy);
  });

  it('catches a broad moving cloth face traversing the body although every vertex path stays outside', () => {
    const start = [[-4, -3, -2], [4, -3, -2], [0, 5, -2]], end = start.map(p => [p[0], p[1], 2]);
    const topology = input(start), discrete = new ClothCollisionGuard(topology);
    expect(discrete.inspect(packed(start), packed(end)).safe).toBe(true);
    expect(discrete.inspect(packed(end), packed(start)).safe).toBe(true);
    const report = new ContinuousClothCollisionGuard(topology).inspect(packed(start), packed(end));
    expect(report.safe).toBe(false);
    expect(report.bodyContactCount).toBeGreaterThan(0);
    expect(report.earliestTimeOfImpact).toBeCloseTo(.25, 8);
    expect(report.events.some(event => event.feature === 'vertex-face')).toBe(true);
  });

  it('catches a static body edge entering a moving face while every vertex chord remains outside', () => {
    const start = [[.5, 1.1, 0], [1.1, 1.2, 0], [1.2, 1.2, 0]], end = [[1.2, 1.1, 0], [1.1, .5, 0], [1.2, 1.2, 0]], topology = input(start);
    const discrete = new ClothCollisionGuard(topology);
    expect(discrete.inspect(packed(start), packed(end)).safe).toBe(true);
    expect(discrete.inspect(packed(end), packed(start)).safe).toBe(true);
    const report = new ContinuousClothCollisionGuard(topology).inspect(packed(start), packed(end));
    expect(report.bodyContactCount).toBeGreaterThan(0);
    expect(report.events[0].feature).toBe('edge-edge');
    expect(report.earliestTimeOfImpact).toBeCloseTo((.49 - Math.sqrt(.49 ** 2 - 4 * .49 * .11)) / (.98), 5);
  });

  it('isolates repeated coplanarity roots when a moving vertex only grazes a moving face', () => {
    const start = [[-1, -1, -.5], [1, -1, -.5], [0, 1, 0], [0, -.5, -.25], [3, -.5, .75], [3, .5, .75]];
    const end = [[-1, -1, .5], [1, -1, .5], [0, 1, 0], [0, .5, .25], [3, .5, 1.25], [3, 1.5, 1.25]];
    const topology = input(start, [0, 1, 2, 0, 3, 4, 5, 0], farBody), discrete = new ClothCollisionGuard(topology);
    expect(discrete.inspect(packed(start)).safe).toBe(true); expect(discrete.inspect(packed(end)).safe).toBe(true);
    const report = new ContinuousClothCollisionGuard(topology).inspect(packed(start), packed(end));
    expect(report.selfContactCount).toBe(1);
    expect(report.earliestTimeOfImpact).toBeCloseTo(.5, 8);
    expect(report.events[0].feature).toBe('vertex-face');
  });

  it('catches pure moving edge/edge contacts when no vertex lies in the opposite face', () => {
    const start = [[-2, 0, 0], [2, 0, 0], [-2, -1, 0], [0, -2, -1], [0, 2, -1], [1, 2, -1]];
    const end = start.map((p, i) => i < 3 ? p : [p[0], p[1], 1]);
    const topology = input(start, [0, 1, 2, 0, 3, 4, 5, 0], farBody), discrete = new ClothCollisionGuard(topology);
    expect(discrete.inspect(packed(start)).safe).toBe(true);
    expect(discrete.inspect(packed(end)).safe).toBe(true);
    const report = new ContinuousClothCollisionGuard(topology).inspect(packed(start), packed(end));
    expect(report.selfContactCount).toBe(1);
    expect(report.earliestTimeOfImpact).toBeCloseTo(.5, 8);
    expect(report.events[0].feature).toBe('edge-edge');
  });

  it('catches coplanar crossings between clear endpoints using analytical event partitions', () => {
    const start = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [2, .1, 0], [3, .1, 0], [2, 1.1, 0]];
    const end = start.map((p, i) => i < 3 ? p : [p[0] - 4, p[1], p[2]]), topology = input(start, [0, 1, 2, 0, 3, 4, 5, 0], farBody);
    const discrete = new ClothCollisionGuard(topology);
    expect(discrete.inspect(packed(start)).safe).toBe(true); expect(discrete.inspect(packed(end)).safe).toBe(true);
    const report = new ContinuousClothCollisionGuard(topology).inspect(packed(start), packed(end));
    expect(report.selfContactCount).toBe(1);
    expect(report.earliestTimeOfImpact).toBeCloseTo(.275, 6);
  });

  it('finds a very brief coplanar collision without a fixed temporal sample grid', () => {
    const start = [[0, 0, 0], [.0001, 0, 0], [0, .0001, 0], [1.234567, 0, 0], [1.234667, 0, 0], [1.234567, .0001, 0]];
    const end = start.map((p, i) => i < 3 ? p : [p[0] - 4, p[1], p[2]]), topology = input(start, [0, 1, 2, 0, 3, 4, 5, 0], farBody);
    const report = new ContinuousClothCollisionGuard(topology).inspect(packed(start), packed(end));
    expect(report.selfContactCount).toBe(1);
    expect(report.earliestTimeOfImpact).toBeCloseTo((1.234567 - .0001) / 4, 6);
  });

  it('accepts stationary and translating exact paired seam edges', () => {
    const start = [[3, 0, 0], [4, 0, 0], [3, .2, 0], [3, 0, 0], [4, 0, 0], [3, -.2, 0]];
    const topology = input(start, [0, 1, 2, 0, 3, 4, 5, 0], { seamPairsBySeam: [{ pairs: [0, 3, 1, 4] }] });
    const checker = new ContinuousClothCollisionGuard(topology);
    expect(checker.inspect(packed(start), packed(start)).safe).toBe(true);
    expect(checker.inspect(packed(start), packed(start.map(p => [p[0] + .1, p[1], p[2]]))).safe).toBe(true);
  });

  it('accepts local welded contacts while other stitches remain open', () => {
    const start = [[3, 0, 0], [4, 0, 0], [3, .2, 0], [3, 0, 0], [4, 0, 0], [3, -.2, 0], [4.5, 0, 0], [4.5, 0, .01]];
    const topology = input(start, [0, 1, 2, 0, 3, 4, 5, 0], { seamPairsBySeam: [{ pairs: [0, 3, 1, 4, 6, 7] }] });
    const checker = new ContinuousClothCollisionGuard(topology);
    expect(checker.inspect(packed(start), packed(start)).safe).toBe(true);
    expect(checker.inspect(packed(start), packed(start.map(p => [p[0] + .1, p[1], p[2]]))).safe).toBe(true);
  });

  it('accepts valid shared mesh edges while checking remote features of corner-sharing faces', () => {
    const valid = [[3, 0, 0], [4, 0, 0], [3, .2, 0], [3, -.2, 0]], topology = input(valid, [0, 1, 2, 0, 1, 0, 3, 0]);
    const checker = new ContinuousClothCollisionGuard(topology);
    expect(checker.inspect(packed(valid), packed(valid)).safe).toBe(true);
    const folded = [[3, 0, 0], [4, 0, 0], [3, 1, 0], [3.4, .2, -1], [3.4, .2, 1]];
    const collision = new ContinuousClothCollisionGuard(input(folded, [0, 1, 2, 0, 0, 3, 4, 0]));
    expect(collision.inspect(packed(folded), packed(folded)).safe).toBe(false);
  });

  it('does not excuse a remote contact merely because the panels share a seam', () => {
    const start = [[-2, 0, 0], [2, 0, 0], [-2, -1, 0], [0, -2, -1], [0, 2, -1], [1, 2, -1]], end = start.map((p, i) => i < 3 ? p : [p[0], p[1], 1]);
    const topology = input(start, [0, 1, 2, 0, 3, 4, 5, 0], { ...farBody, seamPairsBySeam: [{ pairs: [0, 3, 1, 4] }] });
    expect(new ContinuousClothCollisionGuard(topology).inspect(packed(start), packed(end)).safe).toBe(false);
  });

  it('distinguishes actual supplied substeps from a frame chord that cuts through the body', () => {
    const start = [[-2, -.3, -.3], [-2, .3, -.3], [-2, 0, .3]], raised = start.map(p => [p[0], p[1], p[2] + 3]), across = raised.map(p => [2, p[1], p[2]]), end = start.map(p => [2, p[1], p[2]]);
    const checker = new ContinuousClothCollisionGuard(input(start));
    expect(checker.inspect(packed(start), packed(end)).safe).toBe(false);
    expect(checker.inspectTrajectory([packed(start), packed(raised), packed(across), packed(end)])).toMatchObject({ safe: true, segmentCount: 3, interpolation: 'piecewise-linear' });
  });

  it('fails conservatively on overlapping degenerate geometry and invalid inputs', () => {
    const vertices = [[-1, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 1, 0], [1, 0, 0]];
    const checker = new ContinuousClothCollisionGuard(input(vertices, [0, 1, 2, 0, 3, 4, 5, 0], farBody)), positions = packed(vertices), report = checker.inspect(positions, positions);
    expect(report.safe).toBe(false); expect(report.indeterminateContactCount).toBeGreaterThan(0);
    positions[0] = NaN;
    expect(checker.inspect(positions, positions)).toMatchObject({ safe: false, finite: false });
    expect(() => checker.inspectTrajectory([positions])).toThrow();
  });

  it('keeps full pair counts when recorded events are capped', () => {
    const start = [[-4, -3, -2], [4, -3, -2], [0, 5, -2]], end = start.map(p => [p[0], p[1], 2]);
    const report = new ContinuousClothCollisionGuard(input(start), { maxRecordedEvents: 1 }).inspect(packed(start), packed(end));
    expect(report.bodyContactCount).toBeGreaterThan(1); expect(report.events).toHaveLength(1);
    expect(report.events[0].timeOfImpact).toBeCloseTo(.25, 8);
    expect(report.earliestTimeOfImpact).toBeCloseTo(.25, 8);
  });
});
