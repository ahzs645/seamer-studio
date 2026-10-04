import { describe, expect, it } from 'vitest';
import { Ray, Triangle, Vector3 } from 'three';
import { SIM_CONFIG } from '../config';
import { solveExternalSurfaceCollisionWGSL } from './shaders';

type Point = [number, number, number];
const triangle = (...points: Point[]) => new Triangle(...points.map(point => new Vector3(...point)) as [Vector3, Vector3, Vector3]);
const plane = triangle([-.02, -.02, 0], [.02, -.02, 0], [0, .02, 0]);
// Independent finite geometry controls for the vertex eligibility in the generated WGSL.
// They do not emulate its projector, body-side classification, or the GPU f32 arithmetic.
const isNear = (cloth: Triangle, point: Vector3, thickness = .001) =>
  cloth.closestPointToPoint(point, new Vector3()).distanceToSquared(point) <= thickness * thickness;
function edgesCross(source: Triangle, target: Triangle): boolean {
  const points = [source.a, source.b, source.c];
  return points.some((from, index) => {
    const to = points[(index + 1) % 3], direction = to.clone().sub(from), length = direction.length();
    const hit = new Ray(from, direction.multiplyScalar(1 / length)).intersectTriangle(target.a, target.b, target.c, false, new Vector3());
    return hit !== null && hit.distanceTo(from) > 0 && hit.distanceTo(from) < length;
  });
}

// Exact corrected31, interleaved authored-rest shirt176 source trace:
// 493e9bf520c2d4a3aa0d98780911d88bb31e55f9572bcd1cb81e09181b6aad9b.
// Face2456/skin4944 was an 11.9466mm negative-plane response despite no finite contact.
const adjacentCloth = triangle(
  [.5179235935211182, 1.1184521913528442, -.024467304348945618],
  [.5247461199760437, 1.1053162813186646, -.03559302166104317],
  [.5240458250045776, 1.1069146394729614, -.022929204627871513]
);
const adjacentSkin = triangle(
  [.5211700797080994, 1.0967538356781006, -.022401005029678345],
  [.508682370185852, 1.0980584621429443, -.023780127987265587],
  [.5121409296989441, 1.1059412956237793, -.025965994223952293]
);
const crossingCloth = triangle(
  [.5240458250045776, 1.1069146394729614, -.022929204627871513],
  [.5290278792381287, 1.0922825336456299, -.03539842367172241],
  [.5255523920059204, 1.0879957675933838, -.020226143300533295]
);
const crossingSkin = triangle(
  [.5299617052078247, 1.087611198425293, -.019093522801995277],
  [.5174945592880249, 1.0894893407821655, -.02015121467411518],
  [.5211700797080994, 1.0967538356781006, -.022401005029678345]
);
const nearCloth = triangle(
  [.5255523920059204, 1.0879957675933838, -.020226143300533295],
  [.5438339114189148, 1.0820523500442505, -.03492524102330208],
  [.5467042922973633, 1.0842303037643433, -.01809876412153244]
);
const nearSkin = triangle(
  [.5397574305534363, 1.0792977809906006, -.016066057607531548],
  [.5299617052078247, 1.087611198425293, -.019093522801995277],
  [.5329160094261169, 1.0957720279693604, -.018884912133216858]
);

describe('finite body vertex eligibility', () => {
  it('binds vertex proximity to the actual finite face before any signed-plane response, without relaxing edge recovery', () => {
    for (const thickness of [.001, .005]) {
      const shader = solveExternalSurfaceCollisionWGSL({ ...SIM_CONFIG, simulationThickness: thickness, maxSurfaceCorrection: .005 });
      const vertexLoop = shader.slice(shader.indexOf('for (var vertex ='), shader.indexOf('let clothPoints ='));
      expect(vertexLoop).toContain('getClosestPointOnTriangle(a.xyz, b.xyz, c.xyz, point)');
      expect(vertexLoop).toContain('if (dot(finiteOffset, finiteOffset) > thickness * thickness) { continue; }');
      expect(vertexLoop.indexOf('finiteOffset')).toBeLessThan(vertexLoop.indexOf('let signedDistance'));
      expect(vertexLoop).not.toContain('finiteTrianglesCross');
      expect(vertexLoop).not.toContain('maxCorrection');
      expect(shader).toContain('segmentTriangleHit(vertices[edge],vertices[(edge+1u)%3u],a.xyz,b.xyz,c.xyz)');
      expect(shader).toContain('let penetration=length(escape)');
      expect(shader).toContain(`const thickness = ${thickness}f;`);
    }
  });
  it('rejects a skin vertex13mm behind the plane while preserving near points on either side', () => {
    expect(isNear(plane, new Vector3(0, 0, -.013))).toBe(false);
    expect(isNear(plane, new Vector3(0, 0, -.0005))).toBe(true);
    expect(isNear(plane, new Vector3(0, 0, .0005))).toBe(true);
    expect(isNear(plane, new Vector3(0, 0, .00101))).toBe(false);
  });
  it('rejects an exterior point close to the infinite plane but far from the finite face', () => {
    expect(isNear(plane, new Vector3(.03, 0, -.00001))).toBe(false);
  });
  it('does not admit distant vertices merely because another finite feature of their triangle crosses', () => {
    const skin = triangle([0, 0, -.013], [0, 0, .013], [.04, 0, .013]);
    expect(edgesCross(skin, plane)).toBe(true);
    for (const point of [skin.a, skin.b, skin.c]) expect(isNear(plane, point)).toBe(false);
  });
  it('retains a coarse body edge through a cloth interior when all body vertices are distant', () => {
    const large = triangle([-2, -2, 0], [2, -2, 0], [0, 2, 0]);
    const side = triangle([-.2, -.2, -.2], [.2, -.2, .2], [.2, .2, -.2]);
    expect(edgesCross(side, large)).toBe(true);
    for (const point of [side.a, side.b, side.c]) expect(isNear(large, point)).toBe(false);
  });
  it('has the same eligibility for reversed cloth winding', () => {
    const reverse = new Triangle(plane.c, plane.b, plane.a);
    for (const point of [new Vector3(0, 0, .0005), new Vector3(0, 0, -.013), new Vector3(.03, 0, 0)]) {
      expect(isNear(plane, point)).toBe(isNear(reverse, point));
    }
  });
  it('rejects every actualshirt2456/4944 vertex responsible for the false neighboring response', () => {
    expect(edgesCross(adjacentCloth, adjacentSkin) || edgesCross(adjacentSkin, adjacentCloth)).toBe(false);
    for (const point of [adjacentSkin.a, adjacentSkin.b, adjacentSkin.c]) expect(isNear(adjacentCloth, point)).toBe(false);
  });
  it('retains the actualshirt2482/4943 finite body crossing for the edge solver', () => {
    expect(edgesCross(crossingCloth, crossingSkin) || edgesCross(crossingSkin, crossingCloth)).toBe(true);
  });
  it('retains actualshirt2515/19542 finite proximity beside the crossing', () => {
    expect([nearSkin.a, nearSkin.b, nearSkin.c].some(point => isNear(nearCloth, point))).toBe(true);
  });
});
