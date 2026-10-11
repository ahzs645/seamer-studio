import { describe, expect, it } from 'vitest';
import { measureProductionSurface, type ProductionSurfaceMesh } from './surfaceMeasurement';
const folded: ProductionSurfaceMesh = { pieceId: 'cloth', positions: [0, 0, 0, 100, 0, 0, 0, 100, 0, 100, 100, 100], uv: [0, 0, 100, 0, 0, 100, 100, 100], indices: [0, 1, 2, 1, 3, 2] };
describe('actual cloth surface measurements', () => {
  it('interpolates UV endpoints on displayed triangles for millimeter chords', () => { expect(measureProductionSurface(folded, { x: 10, y: 10 }, { x: 60, y: 20 }, 'chord')).toBeCloseTo(Math.hypot(50, 10)); });
  it('measures a folded surface path longer than its spatial chord without crossing empty space', () => {
    const a = { x: 0, y: 0 }, b = { x: 100, y: 100 };
    const chord = measureProductionSurface(folded, a, b, 'chord'); const path = measureProductionSurface(folded, a, b, 'surface-path');
    expect(chord).toBeCloseTo(Math.sqrt(30000)); expect(path).toBeCloseTo(100 + Math.sqrt(20000)); expect(path).toBeGreaterThan(chord);
  });
  it('uses direct on-triangle distance and rejects outside endpoints or invalid meshes', () => {
    expect(measureProductionSurface(folded, { x: 10, y: 10 }, { x: 20, y: 20 }, 'surface-path')).toBeCloseTo(Math.sqrt(200));
    expect(() => measureProductionSurface(folded, { x: -1, y: 10 }, { x: 20, y: 20 }, 'chord')).toThrow('outside');
    expect(() => measureProductionSurface({ ...folded, indices: [99, 1, 2] }, { x: 0, y: 0 }, { x: 10, y: 10 }, 'chord')).toThrow('Invalid');
  });
  it('rejects disconnected mesh paths instead of substituting a straight distance', () => {
    const separated = { pieceId: 'x', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0], uv: [0, 0, 1, 0, 0, 1, 10, 0, 11, 0, 10, 1], indices: [0, 1, 2, 3, 4, 5] };
    expect(() => measureProductionSurface(separated, { x: .1, y: .1 }, { x: 10.1, y: .1 }, 'surface-path')).toThrow('disconnected');
  });
});
