/// <reference types="node" />

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  parseBaseModel,
  parseCoefficients,
  parseIndices,
  parseSkinIndices,
  parseSkinWeights,
  reconstructVertices,
  SkinnedAvatar,
  solveBodyCoefficients,
  type BaseModel,
  type GenderModel
} from '@seamer/avatar';
import type { Pattern, SeamRef } from '@seamer/pattern-model';
import {
  indexPaths,
  indexPoints,
  piecePathPolyline,
  type Vec2
} from '@seamer/pattern-model/utils/patternGeometry';
import pencilSkirt from '../../../../static/templates/pencil-skirt.json';
import { buildPieceCloth, computeSeamEdgeIntervals, reuseSavedSurface } from './boundary';
import { buildSimData, type ArrangedPiece, type SimData } from '../build';
import { fromArrangement, prepareCloth } from '../simulator';
import { buildCylinders } from './cylinders';
import { arrangeParticles } from './arrangement';

/** Independent oracle for SeamScape's 10 mm, ceil-based composite seam allocation. */
function sourceSeamEdgeIntervals(pattern: Pattern): Map<string, number> {
  const paths = indexPaths(pattern);
  const points = indexPoints(pattern);
  const out = new Map<string, number>();
  const length = (poly: Vec2[]): number => {
    let total = 0;
    for (let index = 1; index < poly.length; index++) {
      total += Math.hypot(poly[index].x - poly[index - 1].x, poly[index].y - poly[index - 1].y);
    }
    return total;
  };
  const info = new Map<string, { len: number; pd: number }>();
  for (const piece of pattern.pieces) {
    const pd = piece.settings3d.particleDistance ?? 10;
    for (const path of [...piece.mainPaths, ...piece.internalPaths]) {
      const poly = piecePathPolyline(path, paths, points, Math.min(4, pd / 2));
      if (poly.length >= 2) info.set(path.id, { len: length(poly), pd });
    }
  }
  const seamCounts = new Map<string, number>();
  const seamSides = new Map<string, { from: ReturnType<typeof side>; to: ReturnType<typeof side> }>();
  function side(refs: { id: string }[]) {
    const items = refs
      .map((ref) => info.get(ref.id))
      .filter((item): item is { len: number; pd: number } => !!item);
    return { items, refs: refs.filter((ref) => info.has(ref.id)) };
  }
  for (const seam of pattern.seams) {
    const from = side(seam.fromPaths);
    const to = side(seam.toPaths);
    if (!from.items.length || !to.items.length) continue;
    seamSides.set(seam.id, { from, to });
    const fromLength = from.items.reduce((sum, item) => sum + item.len, 0);
    const toLength = to.items.reduce((sum, item) => sum + item.len, 0);
    const pd = Math.min(...[...from.items, ...to.items].map((item) => item.pd));
    seamCounts.set(seam.id, Math.ceil(Math.max(fromLength, toLength) / pd));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const piece of pattern.pieces) {
      for (const path of [...piece.mainPaths, ...piece.internalPaths]) {
        const touching = pattern.seams.filter((seam) =>
          [...seam.fromPaths, ...seam.toPaths].some((ref) => ref.id === path.id)
        );
        const maximum = Math.max(0, ...touching.map((seam) => seamCounts.get(seam.id) ?? 0));
        for (const seam of touching) {
          if ((seamCounts.get(seam.id) ?? 0) < maximum) {
            seamCounts.set(seam.id, maximum);
            changed = true;
          }
        }
      }
    }
  }
  for (const seam of pattern.seams) {
    const sides = seamSides.get(seam.id);
    const count = seamCounts.get(seam.id);
    if (!sides || !count) continue;
    const distribute = (value: ReturnType<typeof side>) => {
      const totalLength = value.items.reduce((sum, item) => sum + item.len, 0) || 1;
      const raw = value.items.map((item) => (count * item.len) / totalLength);
      const base = raw.map((item) => Math.max(1, Math.floor(item)));
      let remainder = count - base.reduce((sum, item) => sum + item, 0);
      const order = raw
        .map((item, index) => ({ index, fraction: item - Math.floor(item) }))
        .sort((a, b) => b.fraction - a.fraction);
      for (let index = 0; remainder > 0 && index < order.length; index++, remainder--) {
        base[order[index].index]++;
      }
      value.refs.forEach((ref, index) =>
        out.set(ref.id, Math.max(out.get(ref.id) ?? 0, base[index]))
      );
    };
    distribute(sides.from);
    distribute(sides.to);
  }
  return out;
}

function readArrayBuffer(url: URL): ArrayBuffer {
  return Uint8Array.from(readFileSync(url)).buffer;
}

function buildDefaultAvatar(pattern: Pattern): {
  positions: Float32Array;
  indices: Uint32Array;
  cylinders: ReturnType<typeof buildCylinders>;
} {
  const models = new URL('../../../body-model/models/', import.meta.url);
  const base = parseBaseModel(JSON.parse(readFileSync(new URL('base_model.json', models), 'utf8'))) as BaseModel;
  const gender = JSON.parse(readFileSync(new URL('female_model.json', models), 'utf8')) as GenderModel;
  const indices = parseIndices(readArrayBuffer(new URL('indices.bin', models)));
  const skinIndices = parseSkinIndices(readArrayBuffer(new URL('skin_indices.bin', models)));
  const skinWeights = parseSkinWeights(readArrayBuffer(new URL('skin_weights.bin', models)));
  const coefficients = parseCoefficients(readArrayBuffer(new URL('female_coefficients.bin', models)));
  const { coeff } = solveBodyCoefficients(gender, pattern.body);
  const rest = reconstructVertices(base, coefficients, coeff, skinWeights.length / 4);
  const avatar = new SkinnedAvatar(
    base,
    indices,
    skinIndices,
    skinWeights,
    rest,
    new THREE.MeshBasicMaterial()
  );
  avatar.setPose('T');
  const positions = avatar.positions.slice();
  const cylinders = buildCylinders(
    base.cylinders,
    (name) => avatar.boneWorldPosition(name, new THREE.Vector3()),
    (index) => new THREE.Vector3(
      positions[index * 3],
      positions[index * 3 + 1],
      positions[index * 3 + 2]
    )
  );
  avatar.dispose();
  return { positions, indices, cylinders };
}

function positionBounds(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 4) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[index + axis]);
      max[axis] = Math.max(max[axis], positions[index + axis]);
    }
  }
  return { min, max };
}

function maxCylinderDistance(
  pattern: Pattern,
  prepared: NonNullable<ReturnType<typeof prepareCloth>>,
  cylinders: ReturnType<typeof buildCylinders>
): number {
  const point = new THREE.Vector3();
  const surface = new THREE.Vector3();
  let maximum = 0;
  for (const simPiece of prepared.simData.pieces) {
    const piece = pattern.pieces.find((candidate) => candidate.id === simPiece.pieceId);
    const frame = piece && cylinders.get(piece.settings3d.arrangement.cylinderName);
    if (!frame) continue;
    for (let local = 0; local < simPiece.count; local++) {
      const index = (simPiece.start + local) * 4;
      point.set(
        prepared.simData.positions[index],
        prepared.simData.positions[index + 1],
        prepared.simData.positions[index + 2]
      );
      const uv = frame.worldToUv(point);
      frame.uvToWorld(uv.uDeg, uv.v, 0, surface);
      maximum = Math.max(maximum, point.distanceTo(surface));
    }
  }
  return maximum;
}

function stretchRatios(prepared: NonNullable<ReturnType<typeof prepareCloth>>): {
  minimum: number;
  maximum: number;
  meanAbsoluteError: number;
  collapsed: number;
} {
  let minimum = Infinity;
  let maximum = -Infinity;
  let error = 0;
  let collapsed = 0;
  let count = 0;
  const positions = prepared.simData.positions;
  for (const color of prepared.simData.stretchColors) {
    for (let index = 0; index < color.edges.length; index += 4) {
      const first = color.edges[index] * 4;
      const second = color.edges[index + 1] * 4;
      const rest = color.edges[index + 2];
      const length = Math.hypot(
        positions[first] - positions[second],
        positions[first + 1] - positions[second + 1],
        positions[first + 2] - positions[second + 2]
      );
      const ratio = length / rest;
      minimum = Math.min(minimum, ratio);
      maximum = Math.max(maximum, ratio);
      error += Math.abs(ratio - 1);
      if (ratio < 0.1) collapsed++;
      count++;
    }
  }
  return { minimum, maximum, meanAbsoluteError: error / count, collapsed };
}

function buildArrangedPieces(
  pattern: Pattern,
  cylinders: ReturnType<typeof buildCylinders>,
  intervals: Map<string, number>
): ArrangedPiece[] {
  const arranged: ArrangedPiece[] = [];
  for (const piece of pattern.pieces) {
    const cloth = buildPieceCloth(pattern, piece, undefined, intervals);
    if (!cloth) continue;
    const positions3d = arrangeParticles(
      cloth.mesh.points,
      piece.settings3d.arrangement,
      cylinders.get(piece.settings3d.arrangement.cylinderName) ?? null,
      { flipNormals: piece.settings3d.flipNormals }
    );
    arranged.push({ cloth, positions3d, arranged3d: positions3d, frozen: false, fromSaved: false });
  }
  return arranged;
}

function seamChain(pattern: Pattern, simData: SimData, refs: SeamRef[]): number[] {
  const chain: number[] = [];
  for (const ref of refs) {
    const piece = pattern.pieces.find((candidate) =>
      [...candidate.mainPaths, ...candidate.internalPaths].some((path) => path.id === ref.id)
    );
    const run = piece
      ? simData.edgeRuns.get(`${piece.id}::${ref.id}${ref.mirrored ? '#M' : ''}`)
      : undefined;
    expect(run, `missing edge run for ${ref.id}${ref.mirrored ? '#M' : ''}`).toBeDefined();
    if (!run) continue;
    const oriented = ref.reversed ? run.slice().reverse() : run;
    for (const particle of oriented) {
      if (chain.at(-1) !== particle) chain.push(particle);
    }
  }
  return chain;
}

function orientedRefEndpoints(pattern: Pattern, simData: SimData, refs: SeamRef[]): number[] {
  const endpoints: number[] = [];
  for (const ref of refs) {
    const piece = pattern.pieces.find((candidate) =>
      [...candidate.mainPaths, ...candidate.internalPaths].some((path) => path.id === ref.id)
    );
    const run = piece
      ? simData.edgeRuns.get(`${piece.id}::${ref.id}${ref.mirrored ? '#M' : ''}`)
      : undefined;
    expect(run, `missing edge run for ${ref.id}${ref.mirrored ? '#M' : ''}`).toBeDefined();
    if (!run?.length) continue;
    endpoints.push(ref.reversed ? run.at(-1)! : run[0]);
    endpoints.push(ref.reversed ? run[0] : run.at(-1)!);
  }
  return endpoints;
}

describe('mirrored half-piece seam sampling', () => {
  it('keeps reflected seam runs equal in particle count and rest length', () => {
    const pattern = structuredClone(pencilSkirt) as unknown as Pattern;
    const intervals = computeSeamEdgeIntervals(pattern);
    let compared = 0;

    for (const piece of pattern.pieces) {
      const cloth = buildPieceCloth(pattern, piece, undefined, intervals);
      if (!cloth) continue;
      for (const edge of piece.mainPaths) {
        const original = cloth.edgeParticles.get(edge.id);
        const mirrored = cloth.edgeParticles.get(`${edge.id}#M`);
        if (!original || !mirrored) continue;
        compared++;
        expect(mirrored).toHaveLength(original.length);
        const length = (run: number[]): number => {
          let total = 0;
          for (let index = 1; index < run.length; index++) {
            const from = cloth.mesh.points[run[index - 1]];
            const to = cloth.mesh.points[run[index]];
            total += Math.hypot(to.x - from.x, to.y - from.y);
          }
          return total;
        };
        expect(length(mirrored)).toBeCloseTo(length(original), 6);
      }
    }

    expect(compared).toBeGreaterThan(0);
  });

  it('matches source composite allocation and samples waistband ease without a mismatch fallback', () => {
    const pattern = structuredClone(pencilSkirt) as unknown as Pattern;
    const intervals = computeSeamEdgeIntervals(pattern);
    expect([...intervals]).toEqual([...sourceSeamEdgeIntervals(pattern)]);
    expect(intervals.get('PiecePath_fbyxnjx0s')).toBe(8);
    expect(intervals.get('PiecePath_hnhr6x036')).toBe(8);

    const arranged = buildArrangedPieces(pattern, new Map(), intervals);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const simData = buildSimData(pattern, arranged);
      const mismatches = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => /Seam (?:particle count|length) mismatch/.test(message));
      expect(mismatches).toEqual([]);

      for (const seamId of ['Seam_uzave2eyv', 'Seam_sibuwpf53']) {
        const pairs = simData.seamPairsBySeam.find((candidate) => candidate.seamId === seamId)?.pairs;
        expect(pairs, `missing composite pairs for ${seamId}`).toBeDefined();
        if (!pairs) continue;
        expect(pairs.length / 2).toBeGreaterThan(40);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('reuses the default template drape in placed-plan coordinates', () => {
    const prepared = prepareCloth({
      pattern: structuredClone(pencilSkirt) as unknown as Pattern,
      avatarVertices: new Float32Array(),
      avatarIndices: new Uint32Array(),
      cylinders: new Map()
    });
    expect(prepared).not.toBeNull();
    if (!prepared) return;

    let maxPairDistance = 0;
    let pairCount = 0;
    for (const seam of prepared.simData.seamPairsBySeam) {
      for (let index = 0; index < seam.pairs.length; index += 2) {
        const first = seam.pairs[index] * 4;
        const second = seam.pairs[index + 1] * 4;
        maxPairDistance = Math.max(maxPairDistance, Math.hypot(
          prepared.simData.positions[first] - prepared.simData.positions[second],
          prepared.simData.positions[first + 1] - prepared.simData.positions[second + 1],
          prepared.simData.positions[first + 2] - prepared.simData.positions[second + 2]
        ));
        pairCount++;
      }
    }

    expect(pairCount).toBeGreaterThan(0);
    expect(maxPairDistance).toBeLessThan(0.04);
  });

  it('seeds the default live drape from coherent arrangement topology beside the posed avatar', () => {
    const pattern = structuredClone(pencilSkirt) as unknown as Pattern;
    const avatar = buildDefaultAvatar(pattern);
    const prepared = prepareCloth({
      pattern,
      avatarVertices: avatar.positions,
      avatarIndices: avatar.indices,
      cylinders: avatar.cylinders
    });
    expect(prepared).not.toBeNull();
    if (!prepared) return;
    const live = fromArrangement(prepared);

    expect(live.body.numTriangles).toBe(24_600);
    expect(live.body.positions).toHaveLength(12_302 * 4);
    expect(live.body.triangles).toHaveLength(24_600 * 4);
    const bodyBounds = positionBounds(live.body.positions);
    expect(bodyBounds.min[1]).toBeCloseTo(0.0162, 3);
    expect(bodyBounds.max[1]).toBeCloseTo(1.6530, 3);
    expect(bodyBounds.max[1] - bodyBounds.min[1]).toBeCloseTo(1.6368, 3);

    expect(live.simData.positions).toEqual(prepared.simData.arrangedPositions);
    for (let index = 3; index < live.simData.anchors.length; index += 4) {
      expect(live.simData.anchors[index]).toBe(0);
    }
    const clothBounds = positionBounds(live.simData.positions);
    expect(clothBounds.min[1]).toBeGreaterThan(0.4);
    expect(clothBounds.max[1]).toBeLessThan(1.1);
    expect(maxCylinderDistance(pattern, live, avatar.cylinders)).toBeLessThan(1e-5);

    const stretch = stretchRatios(live);
    expect(stretch.collapsed).toBe(0);
    expect(stretch.minimum).toBeGreaterThan(0.9);
    expect(stretch.maximum).toBeLessThan(1.12);
    expect(stretch.meanAbsoluteError).toBeLessThan(0.03);
  });

  it('keeps every default live-arrangement seam monotone, endpoint-complete, and legacy-paired', () => {
    const pattern = structuredClone(pencilSkirt) as unknown as Pattern;
    const avatar = buildDefaultAvatar(pattern);
    const prepared = prepareCloth({
      pattern,
      avatarVertices: avatar.positions,
      avatarIndices: avatar.indices,
      cylinders: avatar.cylinders
    });
    expect(prepared).not.toBeNull();
    if (!prepared) return;
    const live = fromArrangement(prepared);
    const legacySimData = buildSimData(
      pattern,
      buildArrangedPieces(pattern, avatar.cylinders, sourceSeamEdgeIntervals(pattern))
    );

    expect(live.simData.arrangedPositions).toEqual(legacySimData.arrangedPositions);
    expect(live.simData.seamPairsBySeam.map(({ seamId, pairs }) => ({ seamId, pairs })))
      .toEqual(legacySimData.seamPairsBySeam.map(({ seamId, pairs }) => ({ seamId, pairs })));
    expect(live.simData.seamPairsBySeam).toHaveLength(pattern.seams.length);

    for (const seamPairs of live.simData.seamPairsBySeam) {
      const seam = pattern.seams[seamPairs.index];
      const fromChain = seamChain(pattern, live.simData, seam.fromPaths);
      const toChain = seamChain(pattern, live.simData, seam.toPaths);
      const fromPaired = seamPairs.pairs.filter((_particle, index) => index % 2 === 0);
      const toPaired = seamPairs.pairs.filter((_particle, index) => index % 2 === 1);

      expect(fromPaired[0], `${seam.id} from start`).toBe(fromChain[0]);
      expect(toPaired[0], `${seam.id} to start`).toBe(toChain[0]);
      expect(fromPaired.at(-1), `${seam.id} from end`).toBe(fromChain.at(-1));
      expect(toPaired.at(-1), `${seam.id} to end`).toBe(toChain.at(-1));

      for (const endpoint of orientedRefEndpoints(pattern, live.simData, seam.fromPaths)) {
        expect(fromPaired, `${seam.id} omitted a from run/dart endpoint`).toContain(endpoint);
      }
      for (const endpoint of orientedRefEndpoints(pattern, live.simData, seam.toPaths)) {
        expect(toPaired, `${seam.id} omitted a to run/dart endpoint`).toContain(endpoint);
      }

      const assertMonotone = (chain: number[], paired: number[], label: string) => {
        let previous = -1;
        for (const particle of paired) {
          const ordinal = chain.indexOf(particle, Math.max(0, previous));
          expect(ordinal, `${seam.id} ${label} crossing at particle ${particle}`)
            .toBeGreaterThanOrEqual(previous);
          previous = ordinal;
        }
      };
      assertMonotone(fromChain, fromPaired, 'from');
      assertMonotone(toChain, toPaired, 'to');
    }

    const frontBand = pattern.pieces.find((piece) => piece.name === 'WaistbandFront')!;
    const backBand = pattern.pieces.find((piece) => piece.name === 'WaistbandBack')!;
    expect(frontBand.settings3d.arrangement.cylinderName).toBe('Torso');
    expect(backBand.settings3d.arrangement.cylinderName).toBe('Torso');
    expect(frontBand.settings3d.arrangement.uDegrees).toBe(0);
    expect(backBand.settings3d.arrangement.uDegrees).toBe(180);
    expect(frontBand.settings3d.flipNormals).toBe(false);
    expect(backBand.settings3d.flipNormals).toBe(true);
  });
});

describe('legacy saved-surface restoration', () => {
  it('barycentrically transfers settled XYZ onto freshly triangulated particles', () => {
    const faceBytes = Buffer.alloc(6);
    faceBytes.writeUInt16LE(0, 0);
    faceBytes.writeUInt16LE(1, 2);
    faceBytes.writeUInt16LE(2, 4);
    const savedPositions = [
      0, 0, 0, 0, 0,
      10, 0, 1, 0, 0,
      0, 10, 0, 1, 1
    ];
    const result = reuseSavedSurface(
      [{ x: 2.5, y: 2.5 }, { x: 10, y: 0 }],
      savedPositions,
      {
        version: 2,
        coordinateSpace: 'piece-local',
        vertexCount: 3,
        positions: '',
        faces: faceBytes.toString('base64'),
        faceIndexType: 'u16'
      }
    );

    expect(result).not.toBeNull();
    expect(result?.safeCoverage).toBe(1);
    expect([...result!.positions3d]).toEqual([0.25, 0.25, 0.25, 1, 0, 0]);
    expect(result?.exactCount).toBe(1);
    expect(result?.interpolatedCount).toBe(1);
  });
});
