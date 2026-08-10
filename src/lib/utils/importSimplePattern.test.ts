/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPieceCloth, computeSeamEdgeIntervals } from '@seamer/cloth-sim';
import { assertPatternBuildable3d, convertSimplePattern, convertSimplePatternWithLegacyProject, type SimpleFile } from './importSimplePattern';

const LEGACY_PENCIL_SKIRT = new URL('../../../e2e/fixtures/pencil-skirt-legacy.json', import.meta.url);
const CANONICAL_PENCIL_SKIRT = new URL('../../../static/templates/pencil-skirt.json', import.meta.url);

describe('convertSimplePattern legacy pencil skirt', () => {
  const source = JSON.parse(readFileSync(LEGACY_PENCIL_SKIRT, 'utf8')) as SimpleFile;
  const canonical = JSON.parse(readFileSync(CANONICAL_PENCIL_SKIRT, 'utf8'));

  it('restores the canonical editable draft, seam topology, arrangement, and saved drape', () => {
    expect(source.pieces).toHaveLength(4);
    expect(source.pieces.reduce((count, piece) => count + piece.boundary.length, 0)).toBe(82);
    expect(source.pieces.reduce((count, piece) => count + piece.sewLines.length, 0)).toBe(48);
    const pattern = convertSimplePattern(source, canonical);
    const intervals = computeSeamEdgeIntervals(pattern);

    expect(pattern.name).toBe(source.name);
    expect(pattern.description).toBe(source.description);
    expect(pattern.points).toHaveLength(35);
    expect(pattern.paths).toHaveLength(36);
    expect(pattern.points.map((point) => point.name)).toEqual(Array.from({ length: 35 }, (_, index) => `A${index}`));
    expect(pattern.pieces).toHaveLength(4);
    expect(pattern.pieces.map((piece) => piece.name)).toEqual(['Front', 'Back', 'WaistbandFront', 'WaistbandBack']);
    expect(pattern.seams).toHaveLength(12);
    expect(pattern.seams.map((seam) => [seam.fromPaths.length, seam.toPaths.length])).toEqual([
      [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1],
      [4, 6], [4, 6], [1, 1], [1, 1]
    ]);
    expect(pattern.pieces.reduce((count, piece) => count + piece.settings3d.savedPositions.length, 0)).toBe(32985);
    expect(() => assertPatternBuildable3d(pattern)).not.toThrow();
    for (const piece of pattern.pieces) {
      expect(piece.originPoint, `${piece.name} origin point`).not.toBe('');
      expect(() => buildPieceCloth(pattern, piece, undefined, intervals), piece.name).not.toThrow();
      expect(buildPieceCloth(pattern, piece, undefined, intervals), piece.name).not.toBeNull();
    }
    expect(pattern.pieces.map((piece) => piece.settings3d.arrangement.uDegrees)).toEqual([0, 180, 0, 180]);
    expect(pattern.pieces.map((piece) => piece.settings3d.flipNormals)).toEqual([false, true, false, true]);
  });

  it('does not substitute the sample for a merely similar skirt', () => {
    const changed = structuredClone(source);
    changed.pieces[0].origin![0] += 1;
    const pattern = convertSimplePattern(changed, canonical);

    expect(pattern.points).not.toHaveLength(35);
    expect(pattern.pieces.every((piece) => piece.settings3d.savedPositions.length === 0)).toBe(true);
  });

  it('uses the paired project as the authority for canonical runtime state and cached drape', () => {
    const legacyProject = structuredClone(canonical);
    legacyProject.settings3d.showSeams = false;
    for (const piece of legacyProject.pieces) piece.settings3d.savedPositions = [];
    legacyProject.pieces[2].settings3d.frozen = true;

    const restored = convertSimplePatternWithLegacyProject(source, legacyProject, canonical);

    // The bundled canonical scaffold has 6,597 settled vertices. A paired source project with no
    // cache must still start from its arrangement, not silently inherit that unrelated equilibrium.
    expect(restored.pieces.reduce(
      (count, piece) => count + piece.settings3d.savedPositions.length,
      0
    )).toBe(0);
    expect(restored.pieces[2].settings3d.frozen).toBe(true);
    expect(restored.settings3d.showSeams).toBe(false);
    expect(restored.seams).toHaveLength(12);
    expect(() => assertPatternBuildable3d(restored)).not.toThrow();
  });
});

describe('convertSimplePattern SeamScape raw JSON compatibility', () => {
  const loop = (x: number, width = 120, height = 900): [number, number][][] => [
    [[x, 0], [x + width, 0]],
    [[x + width, 0], [x + width, height]],
    [[x + width, height], [x, height]],
    [[x, height], [x, 0]]
  ];

  it('preserves the source cut data while promoting stitch lines and markings', () => {
    const boundary = loop(-10, 140, 920);
    const sewLines = loop(0, 120, 900);
    const source: SimpleFile = {
      name: 'Source interchange',
      description: 'lossless import',
      itemId: 'source-item-42',
      pieces: [{
        name: 'CF', origin: [60, 450], grain: [0, 1], materialId: null,
        boundary, sewLines,
        cutBoundary: [[-10, 0], [130, 0], [130, 920], [-10, 920], [-10, 0]],
        cutPaths: [[[25, 200], [95, 200]]],
        internalLines: [[[60, 100], [60, 800]]],
        notches: [[[0, 300], [-8, 300]]],
        drillHoles: [[60, 250]],
        text: 'Centre front', description: 'Front panel', rotation: 3,
        rightPieces: 2, leftPieces: 1, mirrorLeftPiecesAxis: 'Y'
      }]
    };

    const pattern = convertSimplePattern(source);
    const piece = pattern.pieces[0];

    expect(pattern.sourceItemId).toBe('source-item-42');
    expect(pattern.showConstruction).toBe(false);
    expect(pattern.points.every((point) => point.name === '')).toBe(true);
    expect(piece.mainPaths).toHaveLength(4);
    expect(piece.internalPaths).toHaveLength(2);
    expect(piece.markers).toEqual([{ id: 'LegacyDrill_0_0', type: 'drill', x: 60, y: 250 }]);
    expect(piece.legacyGeometry?.boundary).toEqual(boundary);
    expect(piece.legacyGeometry?.sewLines).toEqual(sewLines);
    expect(piece.legacyGeometry?.notches).toEqual(source.pieces[0].notches);
    expect(piece.hideEditorPoints).toBe(true);
    expect(piece.text).toBe('Centre front');
    expect(piece.rotation).toBe(3);
    expect(piece.rightPieces).toBe(2);
    expect(piece.leftPieces).toBe(1);
    expect(piece.mirrorLeftPiecesAxis).toBe('Y');
    expect(pattern.seams).toHaveLength(0);
    expect(() => assertPatternBuildable3d(pattern)).not.toThrow();
  });

  it('uses source panel names to distribute mirrored trouser panels around the correct legs', () => {
    const names = ['CB left', 'B', 'SB left', 'F', 'CF', 'Piece', 'CB right', 'SB right', 'Copy of Piece', 'Copy of CF'];
    const source: SimpleFile = {
      name: 'Named trousers',
      pieces: names.map((name, index) => {
        const band = name === 'B' || name === 'F';
        const geometry = loop(index * 180, band ? 450 : 120, band ? 120 : 900);
        return { name, origin: [index * 180 + 60, 450], grain: [0, 1], materialId: null, boundary: geometry, sewLines: geometry };
      })
    };

    const pattern = convertSimplePattern(source);
    const arrangements = Object.fromEntries(pattern.pieces.map((piece) => [piece.name, piece.settings3d.arrangement]));
    expect(arrangements['CB left'].cylinderName).toBe('LeftUpperLeg');
    expect(arrangements['CB right'].cylinderName).toBe('RightUpperLeg');
    expect(arrangements['CF'].uDegrees).toBe(15);
    expect(arrangements['Copy of CF'].uDegrees).toBe(-15);
    expect(arrangements['SB left'].uDegrees).toBe(115);
    expect(arrangements['SB right'].uDegrees).toBe(-115);
    expect(arrangements['F']).toMatchObject({ cylinderName: 'Torso', uDegrees: 0 });
    expect(arrangements['B']).toMatchObject({ cylinderName: 'Torso', uDegrees: 180 });
  });

  it('maps legacy seam references by edge geometry when sampled perimeter order differs', () => {
    const source: SimpleFile = {
      name: 'Reordered seam edges',
      pieces: [
        { name: 'Left', origin: [50, 50], boundary: loop(0, 100, 100), sewLines: loop(0, 100, 100) },
        { name: 'Right', origin: [150, 50], boundary: loop(100, 100, 100), sewLines: loop(100, 100, 100) }
      ]
    };
    const legacy = convertSimplePattern(source);
    const leftEdge = legacy.pieces[0].mainPaths[1];
    const rightEdge = legacy.pieces[1].mainPaths[3];
    legacy.pieces[1].mainPaths.reverse();
    legacy.seams = [{
      id: 'LegacyJoin', name: '',
      fromPaths: [{ id: leftEdge.id, mirrored: false, reversed: false }],
      toPaths: [{ id: rightEdge.id, mirrored: false, reversed: false }]
    }];

    const converted = convertSimplePatternWithLegacyProject(source, legacy);
    expect(converted.seams).toHaveLength(1);
    expect(converted.seams[0].fromPaths[0].id).toBe('PP_0_1');
    expect(converted.seams[0].toPaths[0].id).toBe('PP_1_3');
  });

  it('preserves a legacy project that intentionally has 3D disabled', () => {
    const geometry = loop(0, 100, 100);
    const source: SimpleFile = {
      name: '2D-only source',
      pieces: [{ name: 'Panel', origin: [50, 50], boundary: geometry, sewLines: geometry }]
    };
    const legacy = convertSimplePattern(source);
    legacy.enable3d = false;
    legacy.viewMode = '2d';

    const converted = convertSimplePatternWithLegacyProject(source, legacy);
    expect(converted.enable3d).toBe(false);
    expect(converted.viewMode).toBe('2d');
  });

  it('maps a normalized legacy piece name onto an expanded left/right Raw JSON piece', () => {
    const source: SimpleFile = {
      name: 'Expanded back panels',
      pieces: [
        { name: 'back (R1)', origin: [50, 50], boundary: loop(0, 100, 100), sewLines: loop(0, 100, 100) },
        { name: 'back (L1)', origin: [150, 50], boundary: loop(100, 100, 100), sewLines: loop(100, 100, 100) },
        { name: 'Front', origin: [250, 50], boundary: loop(200, 100, 100), sewLines: loop(200, 100, 100) }
      ]
    };
    const legacy = convertSimplePattern({
      name: source.name,
      pieces: [
        { name: 'back', origin: [50, 50], boundary: loop(0, 100, 100), sewLines: loop(0, 100, 100) },
        source.pieces[2]
      ]
    });
    legacy.seams = [{
      id: 'ExpandedBackJoin', name: '',
      fromPaths: [{ id: legacy.pieces[0].mainPaths[1].id, mirrored: false, reversed: false }],
      toPaths: [{ id: legacy.pieces[1].mainPaths[3].id, mirrored: false, reversed: false }]
    }];

    const converted = convertSimplePatternWithLegacyProject(source, legacy);
    expect(converted.seams).toHaveLength(1);
    expect(converted.seams[0].fromPaths[0].id).toBe('PP_0_1');
    expect(converted.seams[0].toPaths[0].id).toBe('PP_2_3');
  });

  it('materializes a legacy internal attachment path that Raw JSON did not export', () => {
    const source: SimpleFile = {
      name: 'Pocket attachment',
      pieces: [
        { name: 'Front', origin: [50, 50], boundary: loop(0, 100, 100), sewLines: loop(0, 100, 100) },
        { name: 'Pocket', origin: [150, 50], boundary: loop(100, 100, 100), sewLines: loop(100, 100, 100) }
      ]
    };
    const legacy = convertSimplePattern(source);
    legacy.points.push(
      { id: 'PocketAttachA', name: '', x: 25, y: 30 },
      { id: 'PocketAttachB', name: '', x: 75, y: 30 }
    );
    legacy.paths.push({
      id: 'PocketAttachPath', name: '', pathType: 'line',
      pathPoints: [{ id: 'PocketAttachA' }, { id: 'PocketAttachB' }],
      basePoint: 'PocketAttachA', version: 1
    });
    legacy.pieces[0].internalPaths.push({
      id: 'PocketAttachPiecePath', name: 'Pocket placement', path: 'PocketAttachPath',
      from: 'PocketAttachA', to: 'PocketAttachB', reversed: false, notches: [], showIn3d: true
    });
    legacy.seams = [{
      id: 'PocketAttachment', name: '',
      fromPaths: [{ id: 'PocketAttachPiecePath', mirrored: false, reversed: false }],
      toPaths: [{ id: legacy.pieces[1].mainPaths[0].id, mirrored: false, reversed: false }]
    }];

    const converted = convertSimplePatternWithLegacyProject(source, legacy);
    expect(converted.seams).toHaveLength(1);
    expect(converted.seams[0].fromPaths[0].id).toMatch(/^LegacySourceInternalPP_/);
    expect(converted.pieces[0].internalPaths.some((path) =>
      path.id === converted.seams[0].fromPaths[0].id
    )).toBe(true);
  });
});
