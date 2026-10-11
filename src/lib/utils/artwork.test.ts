import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addPieceArtwork, artworkDraftPoint, artworkPlacementProblem, artworkSourceProblem, artworkSourceUV,
  indexPoints, MAX_ARTWORK_SOURCE_BYTES, pieceArtworkBounds, pieceTransform, removePieceArtwork, updatePieceArtwork,
  type ArtworkSource, type Pattern
} from '@seamer/pattern-model';

function fixture(): Pattern {
  return JSON.parse(readFileSync(new URL('../../../static/templates/pencil-skirt.json', import.meta.url), 'utf8')) as Pattern;
}
// Pure source validation checks embedding/limits; browser tests exercise actual raster decoding.
const source: ArtworkSource = { dataUrl: 'data:image/png;base64,iVBORw==', mimeType: 'image/png', pixelWidth: 200, pixelHeight: 100 };

describe('piece-bound artwork', () => {
  it('reads tuple-based legacy boundary segments when editable main paths are missing', () => {
    const pattern = fixture(), piece = pattern.pieces[0];
    const legacy = { ...pattern, pieces: [{ ...piece, mainPaths: [], legacyGeometry: {
      format: 'seamscape-json' as const, sewLines: [],
      boundary: [[[10, 20], [110, 20]], [[110, 20], [110, 70]], [[110, 70], [10, 70]], [[10, 70], [10, 20]]] as [number, number][][]
    } }] };
    expect(pieceArtworkBounds(legacy, piece.id)).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
    const artwork = addPieceArtwork(legacy, piece.id, source, 'legacy-print', 'Print').artwork![0];
    expect(artwork).toMatchObject({ x: 60, y: 45 });
    const degenerate = { ...legacy, pieces: legacy.pieces.map(item => ({ ...item, legacyGeometry: {
      ...item.legacyGeometry, boundary: [[[0, 0], [10, 10], [20, 20]]] as [number, number][][]
    } })) };
    expect(pieceArtworkBounds(degenerate, piece.id)).toBeNull();
  });
  it('adds an aspect-preserving print in the owner draft frame without changing geometry or another piece', () => {
    const pattern = fixture(), before = structuredClone(pattern), piece = pattern.pieces[0];
    const bounds = pieceArtworkBounds(pattern, piece.id)!;
    const next = addPieceArtwork(pattern, piece.id, source, 'print-1', ' Logo ');
    expect(next.artwork).toHaveLength(1);
    const artwork = next.artwork![0];
    expect(artwork).toMatchObject({ id: 'print-1', pieceId: piece.id, name: 'Logo', opacity: 1, rotation: 0,
      x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 });
    expect(artwork.widthMm / artwork.heightMm).toBe(2);
    expect(next.pieces).toBe(pattern.pieces);
    expect(next.points).toBe(pattern.points);
    expect(next.paths).toBe(pattern.paths);
    expect(pattern).toEqual(before);
    expect(() => addPieceArtwork(pattern, 'missing', source, 'print-2', 'Missing')).toThrow(/valid closed boundary/);
  });

  it('uses inverse raster UV mappings after rotation and follows mirrored, translated, scaled pieces', () => {
    const pattern = fixture();
    const piece = { ...pattern.pieces[0], position: { x: 700, y: -120 }, rotation: 37, mirrorX: true, mirrorY: false };
    const transform = pieceTransform(piece, indexPoints(pattern), { x: 1.08, y: .92 });
    const placement = { x: 60, y: 90, widthMm: 40, heightMm: 20, rotation: 90 };
    expect(artworkDraftPoint(placement, 1, .5)).toEqual({ x: 60, y: 110 });
    for (const [u, v] of [[0, 0], [.2, .8], [1, 1], [1.4, -.2]]) {
      const draft = artworkDraftPoint(placement, u, v), uv = artworkSourceUV(placement, draft);
      expect(uv.x).toBeCloseTo(u, 10); expect(uv.y).toBeCloseTo(v, 10);
    }
    // Rigid placement translation moves every print corner equally without changing print size.
    const moved = pieceTransform({ ...piece, position: { x: 750, y: -140 } }, indexPoints(pattern), { x: 1.08, y: .92 });
    for (const [u, v] of [[0, 0], [1, 0], [0, 1]]) {
      const corner = artworkDraftPoint(placement, u, v), first = transform(corner), second = moved(corner);
      expect(second.x - first.x).toBeCloseTo(50); expect(second.y - first.y).toBeCloseTo(-20);
    }
    const origin = transform(artworkDraftPoint(placement, 0, 0));
    const right = transform(artworkDraftPoint(placement, 1, 0));
    // 90° print rotation makes its width follow the piece's local y scaling.
    expect(Math.hypot(right.x - origin.x, right.y - origin.y)).toBeCloseTo(40 * .92);
  });

  it('rejects remote/active sources, invalid base64, oversized files and unreasonable dimensions', () => {
    expect(artworkSourceProblem(source)).toBeNull();
    for (const dataUrl of ['', 'https://example.com/logo.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,!!!', 'data:image/png;base64,YQ=']) {
      expect(artworkSourceProblem({ ...source, dataUrl })).not.toBeNull();
    }
    expect(artworkSourceProblem({ ...source, mimeType: 'image/jpeg' })).not.toBeNull();
    expect(artworkSourceProblem({ ...source, pixelWidth: 8193 })).not.toBeNull();
    expect(artworkSourceProblem({ ...source, pixelWidth: 8192, pixelHeight: 8192 })).not.toBeNull();
    const large = `data:image/png;base64,${Buffer.alloc(MAX_ARTWORK_SOURCE_BYTES + 1).toString('base64')}`;
    expect(artworkSourceProblem({ ...source, dataUrl: large })).toMatch(/2 MiB/);
    expect(artworkPlacementProblem({ x: 0, y: 0, widthMm: 0, heightMm: 20, rotation: 0, opacity: 1 })).not.toBeNull();
    expect(artworkPlacementProblem({ x: NaN, y: 0, widthMm: 20, heightMm: 20, rotation: 0, opacity: 1 })).not.toBeNull();
  });

  it('enforces the whole-project source budget and allows replacement to reuse its own budget', () => {
    let pattern = fixture();
    const bigSource = { ...source, dataUrl: `data:image/png;base64,${Buffer.alloc(MAX_ARTWORK_SOURCE_BYTES).toString('base64')}` };
    for (let index = 0; index < 4; index++) pattern = addPieceArtwork(pattern, pattern.pieces[0].id, bigSource, `print-${index}`, 'Print');
    expect(() => addPieceArtwork(pattern, pattern.pieces[0].id, source, 'overflow', 'Print')).toThrow(/8 MiB/);
    const replacement = updatePieceArtwork(pattern, 'print-0', { ...bigSource, pixelWidth: 100, pixelHeight: 200 });
    expect(replacement.artwork![0].pixelWidth).toBe(100);
    expect(replacement.artwork).toHaveLength(4);
  });

  it('edits/removes without mutating geometry and exposes stale owner/source records for repair', () => {
    const original = fixture();
    const pattern = addPieceArtwork(original, original.pieces[0].id, source, 'print-1', 'Print');
    const next = updatePieceArtwork(pattern, 'print-1', { x: 123, y: 456, rotation: -35, widthMm: 42, opacity: .4 });
    expect(next.artwork![0]).toMatchObject({ x: 123, y: 456, rotation: -35, widthMm: 42, opacity: .4 });
    expect(next.points).toBe(pattern.points); expect(next.paths).toBe(pattern.paths); expect(next.pieces).toBe(pattern.pieces);
    expect(updatePieceArtwork(next, 'print-1', { x: 123 })).toBe(next);
    expect(() => updatePieceArtwork(next, 'print-1', { widthMm: -2 })).toThrow(/greater than zero/);
    expect(() => updatePieceArtwork(next, 'print-1', { opacity: 2 })).toThrow(/between 0 and 1/);
    const orphan = { ...next, pieces: next.pieces.filter(piece => piece.id !== next.artwork![0].pieceId),
      artwork: next.artwork!.map(artwork => ({ ...artwork, dataUrl: '' })) };
    expect(pieceArtworkBounds(orphan, orphan.artwork[0].pieceId)).toBeNull();
    expect(artworkSourceProblem(orphan.artwork[0])).toMatch(/Missing image/);
    const repaired = updatePieceArtwork(orphan, 'print-1', { pieceId: orphan.pieces[0].id, ...source });
    expect(repaired.artwork![0].pieceId).toBe(orphan.pieces[0].id);
    expect(artworkSourceProblem(repaired.artwork![0])).toBeNull();
    const removed = removePieceArtwork(repaired, 'print-1');
    expect(removed.artwork).toEqual([]); expect(removed.pieces).toBe(repaired.pieces);
    expect(removePieceArtwork(removed, 'missing')).toBe(removed);
  });
});
