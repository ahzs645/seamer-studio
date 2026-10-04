import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertGarmentCodePattern } from '../../../../src/lib/utils/importGarmentCode';
import { indexPaths, indexPoints, piecePathPolyline } from '@seamer/pattern-model/utils/patternGeometry';
import { buildPieceCloth, computeSeamEdgeIntervals } from './boundary';
import type { PieceCloth } from './boundary';

function assertCompleteManifold(cloth: PieceCloth): number {
  const { points, triangles, boundary } = cloth.mesh;
  const key = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  const incidence = new Map<string, number>();
  let area = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.slice(i, i + 3);
    const p = points[a], q = points[b], r = points[c];
    const faceArea = Math.abs((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) / 2;
    expect(faceArea).toBeGreaterThan(0);
    area += faceArea;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) incidence.set(key(u, v), (incidence.get(key(u, v)) ?? 0) + 1);
  }
  expect(boundary.every((index) => index >= 0)).toBe(true);
  const boundaryKeys = new Set(boundary.map((a, i) => key(a, boundary[(i + 1) % boundary.length])));
  for (const segment of boundaryKeys) expect(incidence.get(segment)).toBe(1);
  for (const [segment, count] of incidence) expect(count).toBe(boundaryKeys.has(segment) ? 1 : 2);
  const outline = boundary.map((index) => points[index]);
  const polygonArea = Math.abs(outline.reduce((sum, p, i) => {
    const q = outline[(i + 1) % outline.length];
    return sum + p.x * q.y - q.x * p.y;
  }, 0)) / 2;
  expect(area).toBeCloseTo(polygonArea, 5);
  return area;
}

describe('short authored boundary constraints', () => {
  it('retains a sub-millimetre collinear seam and its forced samples without holes', () => {
    const vertices = [[0, 0], [10, 0], [10, 0.08], [10, 4], [10, 10], [0, 10]];
    const pattern = convertGarmentCodePattern({
      properties: { units_in_meter: 100 },
      pattern: { panels: { front: {
        vertices, edges: vertices.map((_p, i) => ({ endpoints: [i, (i + 1) % vertices.length] }))
      } }, stitches: [] }
    });
    const piece = pattern.pieces[0];
    const tinyEdge = piece.mainPaths[1].id;
    const cloth = buildPieceCloth(pattern, piece, 15, new Map([[tinyEdge, 2]]))!;
    const run = cloth.edgeParticles.get(tinyEdge)!;
    expect(run).toHaveLength(3);
    const p = run.map((index) => cloth.mesh.points[index]);
    expect(p[1].y - p[0].y).toBeCloseTo(0.4, 8);
    expect(p[2].y - p[0].y).toBeCloseTo(0.8, 8);
    expect(assertCompleteManifold(cloth)).toBeCloseTo(10000, 5);
    expect(cloth.mesh.points.length).toBeGreaterThan(cloth.mesh.numBoundary);
  });

  it('renders every real jumpsuit panel with its original seam endpoints and a complete manifold mesh', () => {
    const source = JSON.parse(readFileSync(new URL('../../../../static/examples/garmentcode/js_mean_all_specification.json', import.meta.url), 'utf8'));
    const pattern = convertGarmentCodePattern(source);
    const paths = indexPaths(pattern), points = indexPoints(pattern);
    const intervals = computeSeamEdgeIntervals(pattern);
    for (const piece of pattern.pieces) {
      const cloth = buildPieceCloth(pattern, piece, undefined, intervals)!;
      expect(cloth).not.toBeNull();
      expect(assertCompleteManifold(cloth)).toBeGreaterThan(0);
      for (const pp of piece.mainPaths) {
        const run = cloth.edgeParticles.get(pp.id)!;
        const polyline = piecePathPolyline(pp, paths, points, 4);
        expect(run.length).toBeGreaterThanOrEqual(2);
        expect(cloth.mesh.points[run[0]]).toEqual(polyline[0]);
        expect(cloth.mesh.points[run.at(-1)!]).toEqual(polyline.at(-1));
      }
    }
  });
});
