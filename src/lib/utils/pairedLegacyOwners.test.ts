import { describe, expect, it } from 'vitest';
import { artworkDraftPoint, createProductionAutomation, createTechPack, pieceTransform, pieceInverseTransform, pieceArtworkBounds, indexPoints, indexPaths, pieceOutline, saveAppearanceVersion, type Pattern, type PieceArtwork } from '@seamer/pattern-model';
import { convertSimplePattern, convertSimplePatternWithLegacyProject, type SimpleFile } from './importSimplePattern';
import { evaluateSpecMeasurement } from './productionSpec';
import { artworkRepeatTiles } from './artworkSurface';
const rectangle: SimpleFile = { pieces: [{ name: 'Panel', sewLines: [], boundary: [[[0, 0], [100, 0]], [[100, 0], [100, 200]], [[100, 200], [0, 200]], [[0, 200], [0, 0]]] }] };
function project(reflected = false): Pattern {
  const p = convertSimplePattern(rectangle); p.id = 'legacy-project'; const piece = p.pieces[0]; piece.id = 'old-piece'; piece.position = { x: 300, y: -40 }; piece.rotation = 37; piece.mirrorX = reflected;
  p.artwork = [{ id: 'logo', pieceId: piece.id, name: 'Asymmetric logo', dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', pixelWidth: 2, pixelHeight: 1, x: 30, y: 40, widthMm: 20, heightMm: 10, rotation: 23, opacity: 1, zone: [{ x: 10, y: 10 }, { x: 80, y: 10 }, { x: 80, y: 120 }] }];
  p.colorways = { activeId: 'red', variants: [{ id: 'red', name: 'Red', pieces: { [piece.id]: { materialId: piece.materialId, frontColor: '#ff0000' } } }], generatedMaterialSources: {} };
  p.techPack = createTechPack(); p.techPack.construction = [{ id: 'sew', title: 'Sew panel', pieceId: piece.id, instruction: 'Sew' }];
  p.productionAutomation = createProductionAutomation(); p.productionAutomation.surfaceMeasurements = [{ id: 'surface', name: 'Path', pomId: null, pieceId: piece.id, from: { x: 20, y: 20 }, to: { x: 80, y: 20 }, method: 'chord', captured: { valueMm: 60, capturedAt: '2026-10-11', source: 'Cloth', geometryFingerprint: 'old-geometry' } }];
  const edge = piece.mainPaths[0]; p.measurements = [{ id: 'annotation', name: 'Width', fromPointId: edge.from, toPointId: edge.to, targetMm: 100 }];
  p.productionSpec = { measurements: [{ id: 'width', name: 'Width', annotationId: 'annotation', unit: 'mm', manualValue: null, target: 100, tolMinus: 0, tolPlus: 0, notes: '' }], procurement: [] };
  return saveAppearanceVersion(p, 'v1', 'Original', '2026-10-11T00:00:00.000Z');
}
function rawProject(p: Pattern): SimpleFile {
  const points = indexPoints(p), paths = indexPaths(p);
  return { pieces: p.pieces.map(piece => { const outline = pieceOutline(p, piece, paths, points, 1).map(pieceTransform(piece, points)); return { name: piece.name, sewLines: [], boundary: outline.map((point, i) => [[point.x, point.y], [outline[(i + 1) % outline.length].x, outline[(i + 1) % outline.length].y]]) }; }) };
}
function corners(p: Pattern, art: PieceArtwork) { const transform = pieceTransform(p.pieces.find(piece => piece.id === art.pieceId)!, indexPoints(p)); return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => transform(artworkDraftPoint(art, u, v))); }
describe('coordinate-proven paired legacy owner remapping', () => {
  it.each([false, true])('preserves asymmetric world UV corners for rotated/reflected frame=%s while repairing owners/history', reflected => {
    const source = project(reflected), raw = rawProject(source), original = structuredClone(source);
    const restored = convertSimplePatternWithLegacyProject(raw, source); const owner = restored.pieces[0];
    expect(owner.id).not.toBe(source.pieces[0].id); expect(restored.artwork![0].pieceId).toBe(owner.id);
    corners(restored, restored.artwork![0]).forEach((point, i) => { expect(point.x).toBeCloseTo(corners(source, source.artwork![0])[i].x, 7); expect(point.y).toBeCloseTo(corners(source, source.artwork![0])[i].y, 7); });
    expect(Boolean(restored.artwork![0].flipX)).toBe(reflected);
    expect(Object.keys(restored.colorways!.variants[0].pieces)).toEqual([owner.id]);
    expect(restored.techPack!.construction[0].pieceId).toBe(owner.id);
    expect(restored.appearanceHistory!.versions[0].pieces[0].id).toBe(owner.id);
    expect(restored.appearanceHistory!.versions[0].artwork![0]).toEqual(restored.artwork![0]);
    const from = pieceTransform(source.pieces[0], indexPoints(source))(source.productionAutomation!.surfaceMeasurements[0].from);
    expect(restored.productionAutomation!.surfaceMeasurements[0].from.x).toBeCloseTo(from.x, 7);
    expect(restored.productionAutomation!.surfaceMeasurements[0].pieceId).toBe(owner.id);
    expect(restored.productionAutomation!.surfaceMeasurements[0].captured!.geometryFingerprint).toContain('recapture');
    const measured = evaluateSpecMeasurement(restored, restored.productionSpec!.measurements[0]); expect(measured.actual).toBeCloseTo(100, 7); expect(measured.status).toBe('within');
    expect(source).toEqual(original);
  });
  it('refuses duplicate names, multi-cut ownership and opt-in scaling without silently reattaching artwork', () => {
    for (const modify of [(p: Pattern) => p.pieces.push({ ...structuredClone(p.pieces[0]), id: 'duplicate' }), (p: Pattern) => p.pieces[0].rightPieces = 2, (p: Pattern) => p.pieces[0].useMaterialScaling = true]) {
      const source = project(); const raw = rawProject(source); modify(source);
      const restored = convertSimplePatternWithLegacyProject(raw, source);
      expect(restored.artwork![0].pieceId).toBe('old-piece'); expect(restored.techPack!.construction[0].pieceId).toBe('old-piece'); expect(restored.measurements ?? []).toHaveLength(0);
    }
  });
  it('quarantines accidental rebuilt ID collisions when matching outlines cannot be proven', () => {
    const source = project(); source.pieces[0].id = 'Piece_0'; source.artwork![0].pieceId = 'Piece_0';
    const restored = convertSimplePatternWithLegacyProject(rectangle, source);
    expect(restored.artwork![0].pieceId).toBe('UnresolvedLegacyPiece:Piece_0'); expect(restored.pieces[0].id).toBe('Piece_0');
    expect(restored.pieces.some(piece => piece.id === restored.artwork![0].pieceId)).toBe(false);
  });
  it('updates only a range style linked to the source document and retains unresolved chart sources', () => {
    const source = project(); source.rangePlan = { id: 'collection', name: 'Plan', season: '', currency: 'USD', notes: '', styles: ['legacy-project', 'another-document'].map((id, i) => ({ id: `style-${i}`, patternId: id, name: 'Style', category: '', status: 'draft', colorwayNames: [], sizes: [], plannedUnits: null, targetUnitCost: null, notes: '' })) };
    source.productionSpec!.measurements[0].annotationId = 'deleted-annotation';
    const restored = convertSimplePatternWithLegacyProject(rawProject(source), source);
    expect(restored.rangePlan!.styles.map(style => style.patternId)).toEqual([restored.id, 'another-document']);
    expect(evaluateSpecMeasurement(restored, restored.productionSpec!.measurements[0]).label).toBe('Missing annotation');
  });
  it.each(['grid', 'brick', 'half-drop'] as const)('verifies reflected %s repeat lattice before remapping its asymmetric motif', mode => {
    const source = project(true); source.artwork![0].repeat = { mode, gapXmm: 7, gapYmm: 3 };
    const restored = convertSimplePatternWithLegacyProject(rawProject(source), source);
    expect(restored.artwork![0].pieceId).toBe(restored.pieces[0].id); expect(restored.artwork![0].flipX).toBe(true);
    expect(restored.artwork![0].repeat).toEqual(source.artwork![0].repeat);
    const oldTransform = pieceTransform(source.pieces[0], indexPoints(source)), inverse = pieceInverseTransform(source.pieces[0], indexPoints(source));
    const newTransform = pieceTransform(restored.pieces[0], indexPoints(restored));
    const oldTiles = artworkRepeatTiles(source.artwork![0], pieceArtworkBounds(source, source.pieces[0].id)!);
    const newTiles = artworkRepeatTiles(restored.artwork![0], pieceArtworkBounds(restored, restored.pieces[0].id)!);
    const insideOld = oldTiles.filter(tile => tile.x > 10 && tile.x < 90 && tile.y > 10 && tile.y < 190);
    expect(insideOld.length).toBeGreaterThan(10);
    // Enumeration bounds can add different off-piece border tiles; compare the common actual
    // piece interior, where the renderers clip both families to the same placed garment polygon.
    for (const oldTile of insideOld) {
      const center = oldTransform(oldTile);
      const matched = newTiles.find(tile => { const point = newTransform(tile); return Math.hypot(point.x - center.x, point.y - center.y) < 1e-7; });
      expect(matched).toBeDefined();
      const rawPoint = inverse(newTransform(matched!)); expect(rawPoint.x).toBeCloseTo(oldTile.x, 7); expect(rawPoint.y).toBeCloseTo(oldTile.y, 7);
      corners(restored, matched!).forEach((point, i) => { const old = corners(source, oldTile)[i]; expect(point.x).toBeCloseTo(old.x, 7); expect(point.y).toBeCloseTo(old.y, 7); });
    }
  });
});
