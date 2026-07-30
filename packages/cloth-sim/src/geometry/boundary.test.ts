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
import type { Pattern } from '@seamer/pattern-model';
import pencilSkirt from '../../../../static/templates/pencil-skirt.json';
import { buildPieceCloth, computeSeamEdgeIntervals } from './boundary';
import { buildSimData, type ArrangedPiece } from '../build';
import { fromArrangement, prepareCloth } from '../simulator';
import { buildCylinders } from './cylinders';

function readArrayBuffer(url: URL): ArrayBuffer {
  return Uint8Array.from(readFileSync(url)).buffer;
}

function buildDefaultAvatar(pattern: Pattern): {
  positions: Float32Array;
  indices: Uint32Array;
  cylinders: ReturnType<typeof buildCylinders>;
} {
  const models = new URL('../../../../static/models/', import.meta.url);
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

  it('builds the default template without seam count or length mismatch warnings', () => {
    const pattern = structuredClone(pencilSkirt) as unknown as Pattern;
    const intervals = computeSeamEdgeIntervals(pattern);
    const arranged: ArrangedPiece[] = [];
    for (const piece of pattern.pieces) {
      const cloth = buildPieceCloth(pattern, piece, undefined, intervals);
      if (!cloth) continue;
      const positions3d = new Float32Array(cloth.mesh.points.length * 3);
      cloth.mesh.points.forEach((point, index) => {
        positions3d[index * 3] = point.x / 1000;
        positions3d[index * 3 + 1] = point.y / 1000;
      });
      arranged.push({
        cloth,
        positions3d,
        frozen: false,
        fromSaved: false
      });
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      buildSimData(pattern, arranged);
      const mismatches = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => /Seam (?:particle count|length) mismatch/.test(message));
      expect(mismatches).toEqual([]);
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
});
