import { describe, expect, it } from 'vitest';
import { SIM_CONFIG } from '../config';
import { buildSeamGateLayout, packSeamGate, physicalSeamStitchIndices, seamGateWGSL, type SeamGateLayout } from './seamGate';
import { seamWGSL } from './shaders';
import { solveSelfSurfaceCollisionWGSL } from './surfaceSelf';
import { surfaceTopologyExclusions } from './surfaceTopology';

// Independent byte decoding of the uniform consumed by the generated shaders.
const bit = (words: Uint32Array, offset: number, index: number) =>
  (words[offset + Math.floor(index / 32)] & (2 ** (index % 32))) !== 0;
const stitchEnabled = (words: Uint32Array, index: number) => index < words[0] && bit(words, 4, index);
const seamEnabled = (words: Uint32Array, layout: SeamGateLayout, index: number) =>
  bit(words, 4 + layout.stitchVectors * 4, index);
const rows = (packed: Uint32Array, face: number) => {
  const result: number[][] = [];
  for (let at = packed[face]; at < packed[face + 1]; at += 5) result.push(Array.from(packed.slice(at, at + 5)));
  return result;
};
function physicalLinks(count = 10) {
  const seams = new Int32Array(count * 4).fill(-1), orders = new Int32Array(count * 4).fill(-1);
  const join = (a: number, b: number, order: number) => {
    const aSlot = Array.from(seams.slice(a * 4, a * 4 + 4)).indexOf(-1);
    const bSlot = Array.from(seams.slice(b * 4, b * 4 + 4)).indexOf(-1);
    seams[a * 4 + aSlot] = b; orders[a * 4 + aSlot] = order;
    seams[b * 4 + bSlot] = a; orders[b * 4 + bSlot] = order;
  };
  return { seams, orders, join };
}

describe('source sewing uniform', () => {
  it('packs independent stitch and semantic seam bits across word and vec4 boundaries', () => {
    const layout = buildSeamGateLayout(130, 130);
    const active = new Uint32Array(130), mapping = Array.from({ length: 130 }, (_, index) => [index]);
    const selected = new Set([0, 31, 32, 127, 128, 129]);
    selected.forEach(index => { active[index] = 1; });
    const words = packSeamGate(layout, 130, active, mapping);
    expect(words.byteLength).toBe(80);
    expect(Array.from(words.slice(0, 4))).toEqual([130, 1, 0, 0]);
    for (let index = 0; index < 130; index++) {
      expect(stitchEnabled(words, index), `stitch ${index}`).toBe(selected.has(index));
      expect(seamEnabled(words, layout, index), `seam ${index}`).toBe(selected.has(index));
    }
    expect(words[4]).toBe(0x80000001);
    expect(words[7]).toBe(0x80000000);
    expect(words[8]).toBe(3);
  });

  it('uses reciprocal physical first stamps for a partner repeated in different declared seams', () => {
    const links = physicalLinks();
    links.join(0, 4, 31); links.join(1, 5, 128); links.join(2, 6, 129);
    const pairs = [{ pairs: [0, 4, 1, 5] }, { pairs: [4, 0, 2, 6] }];
    const mapping = physicalSeamStitchIndices(links.seams, links.orders, pairs);
    expect(mapping).toEqual([[31, 128], [31, 129]]);
    const layout = buildSeamGateLayout(130, 2);
    const words = packSeamGate(layout, 130, new Uint32Array([0, 1]), mapping);
    expect(stitchEnabled(words, 31)).toBe(true);
    expect(stitchEnabled(words, 128)).toBe(false);
    expect(stitchEnabled(words, 129)).toBe(true);
    expect(seamEnabled(words, layout, 0)).toBe(false);
    expect(seamEnabled(words, layout, 1)).toBe(true);
  });

  it.each(['missing', 'different', 'negative'] as const)('rejects %s reciprocal stitch proof', variant => {
    const links = physicalLinks(); links.join(0, 4, 7);
    if (variant === 'missing') links.seams[16] = -1;
    if (variant === 'different') links.orders[16] = 8;
    if (variant === 'negative') links.orders[0] = links.orders[16] = -1;
    expect(() => physicalSeamStitchIndices(links.seams, links.orders, [{ pairs: [0, 4] }])).toThrow(/reciprocal/);
  });

  it('does not alias the input semantic mask or physical mapping after packing', () => {
    const layout = buildSeamGateLayout(130, 2), mask = new Uint32Array([1, 0]), mapping = [[31, 128], [32, 129]];
    const words = packSeamGate(layout, 129, mask, mapping), before = words.slice();
    mask.set([0, 1]); mapping[0][0] = 32; mapping[1].push(0);
    expect(words).toEqual(before);
    expect(stitchEnabled(words, 31)).toBe(true);
    expect(stitchEnabled(words, 32)).toBe(false);
  });

  it('accepts the exact portable uniform bound and rejects its next vec4', () => {
    const maximum = buildSeamGateLayout(1022 * 128, 0);
    expect(maximum.byteLength).toBe(16384);
    expect(packSeamGate(maximum, maximum.stitchCount, new Uint32Array(), []).byteLength).toBe(16384);
    expect(() => buildSeamGateLayout(1022 * 128 + 1, 0)).toThrow(/portable/);
    expect(() => buildSeamGateLayout(0, 1022 * 128 + 1)).toThrow(/portable/);
  });

  it.each([-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid topology count %s', count => {
    expect(() => buildSeamGateLayout(count, 1)).toThrow();
    expect(() => buildSeamGateLayout(1, count)).toThrow();
  });

  it('rejects malformed active masks, prefixes and out-of-topology physical indices', () => {
    const layout = buildSeamGateLayout(4, 1);
    expect(() => packSeamGate(layout, 4, new Uint32Array([2]), [[0]])).toThrow();
    expect(() => packSeamGate(layout, 4, new Uint32Array(), [[0]])).toThrow();
    for (const prefix of [-1, .5, 5, NaN]) expect(() => packSeamGate(layout, prefix, new Uint32Array([1]), [[0]])).toThrow();
    for (const stitch of [-1, .5, 4, NaN]) expect(() => packSeamGate(layout, 4, new Uint32Array([1]), [[stitch]])).toThrow();
    // Invalid indices are rejected even in a presently inactive group.
    expect(() => packSeamGate(layout, 4, new Uint32Array([0]), [[4]])).toThrow();
  });

  it('retains the native four-scalar 16-byte declaration and unconditional legacy mask helpers', () => {
    const native = seamGateWGSL('SeamGate');
    expect(native).toContain('struct SeamGate { sewnUpTo:i32, p0:i32, p1:i32, p2:i32 }');
    expect(native).not.toContain('stitchBits'); expect(native).not.toContain('seamBits');
    expect(native.match(/return true;/g)).toHaveLength(3);
    const nativeShader = seamWGSL(SIM_CONFIG, .001);
    expect(nativeShader).toContain(native);
    expect(nativeShader).toContain('seamOrder[index * 4u + j] >= gate.sewnUpTo');
  });

  it('shares generated bitset helpers between sewing and finite self-contact shaders', () => {
    const layout = buildSeamGateLayout(130, 130), gate = seamGateWGSL('Gate', layout);
    expect(gate).toContain('stitchBits:array<vec4u,2>, seamBits:array<vec4u,2>');
    expect(gate).toContain('index/128u'); expect(gate).toContain('(index/32u)%4u');
    expect(gate).toContain('seam/128u'); expect(gate).toContain('(seam/32u)%4u');
    expect(gate).toContain('stitch==0xffffffffu');
    expect(gate).toContain('i32(stitch)<gate.sewnUpTo && activeSourceStitch(i32(stitch))');
    const sewing = seamWGSL(SIM_CONFIG, .001, layout);
    const contacts = solveSelfSurfaceCollisionWGSL(SIM_CONFIG, false, layout);
    expect(sewing).toContain(seamGateWGSL('SeamGate', layout));
    expect(sewing).toContain('!activeSourceStitch(seamOrder[index * 4u + j])');
    expect(contacts).toContain(gate);
    expect(contacts).toContain('!activeSourceSeam(seam) || !activeSourceSegment(topology[at+3u])');
  });
});

describe('finite source seam segment activation metadata', () => {
  function segment(first: number, second: number, complete = true) {
    const links = physicalLinks(); links.join(0, 4, first);
    if (complete) links.join(1, 5, second);
    const triangles = new Uint32Array([0, 1, 2, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
    return { links, triangles, pairs: [{ pairs: [0, 4, 1, 5] }] };
  }

  it.each([[7, 2], [2, 7]])('requires BOTH endpoint stamps for prefix activation (%s,%s)', (first, second) => {
    const input = segment(first, second);
    const packed = surfaceTopologyExclusions(input.triangles, input.links.seams, input.links.orders, input.pairs, true);
    const sourceRecords = rows(packed, 0).filter(record => record[0] === 1);
    expect(sourceRecords).toEqual([[1, 2, 2, 7, 0]]);
    expect(rows(packed, 1).filter(record => record[0] === 0)).toEqual([[0, 2, 2, 7, 0]]);
    expect(rows(packed, 2)).toEqual([]); // Unrelated panel receives no topology proof.
    const layout = buildSeamGateLayout(8, 1);
    for (const prefix of [2, 3, 7, 8]) {
      const words = packSeamGate(layout, prefix, new Uint32Array([1]), [[first, second]]);
      const shaderSegmentGate = stitchEnabled(words, sourceRecords[0][3]);
      expect(shaderSegmentGate).toBe(first < prefix && second < prefix);
    }
    const inactive = packSeamGate(layout, 8, new Uint32Array([0]), [[first, second]]);
    expect(seamEnabled(inactive, layout, 0)).toBe(false);
    expect(stitchEnabled(inactive, sourceRecords[0][3])).toBe(false);
  });

  it('marks a missing endpoint as invalid rather than authorizing an available corner', () => {
    const input = segment(2, 7, false);
    const packed = surfaceTopologyExclusions(input.triangles, input.links.seams, input.links.orders, input.pairs, true);
    expect(rows(packed, 0)).toContainEqual([1, 2, 2, 0xffffffff, 0]);
  });

  it('preserves legacy row bytes while adding maximum-endpoint proof only for source masks', () => {
    const input = segment(7, 2);
    const legacy = surfaceTopologyExclusions(input.triangles, input.links.seams, input.links.orders, input.pairs);
    expect(rows(legacy, 0)).toEqual([[1, 2, 2, 0, 0]]);
    const source = surfaceTopologyExclusions(input.triangles, input.links.seams, input.links.orders, input.pairs, true);
    const expected = legacy.slice();
    for (let face = 0; face < 3; face++) for (let at = expected[face]; at < expected[face + 1]; at += 5) expected[at + 3] = 7;
    expect(source).toEqual(expected);
  });
});

describe('identity source stitch timeline', () => {
  const declaration = [{ seamId: 'joined-corner', pairs: [0, 0, 1, 5] }];
  const range = [{ seamId: 'joined-corner', start: 7, end: 9 }];
  function fixture() {
    const links = physicalLinks(); links.join(1, 5, 2);
    return links;
  }
  it('maps only an already shared corner to its declared logical slot without adding a physical link', () => {
    const links = fixture(), beforeSeams = links.seams.slice(), beforeOrders = links.orders.slice();
    expect(physicalSeamStitchIndices(links.seams, links.orders, declaration, range)).toEqual([[7, 2]]);
    expect(links.seams).toEqual(beforeSeams); expect(links.orders).toEqual(beforeOrders);
    expect(Array.from(links.seams.slice(0, 4))).toEqual([-1, -1, -1, -1]);
    // The distinct partner keeps its earlier physical stamp2, not this declaration's logical slot8.
    expect(links.orders[4]).toBe(2);
  });

  it.each([-1, .5, 10, NaN, Infinity])('rejects invalid identity particle %s even with an exact logical range', particle => {
    const links = fixture();
    expect(() => physicalSeamStitchIndices(links.seams, links.orders,
      [{ seamId: 'joined-corner', pairs: [particle, particle, 1, 5] }], range)).toThrow();
  });

  it.each([
    [],
    [{ seamId: 'wrong', start: 7, end: 9 }],
    [{ seamId: 'joined-corner', start: 7, end: 9 }, { seamId: 'joined-corner', start: 7, end: 9 }],
    [{ seamId: 'joined-corner', start: 7, end: 8 }],
    [{ seamId: 'joined-corner', start: -1, end: 1 }],
    [{ seamId: 'joined-corner', start: .5, end: 2.5 }],
    [{ seamId: 'joined-corner', start: 7, end: 9 }, { seamId: 'other', start: 8, end: 10 }],
  ].map(ranges => ({ ranges })))('requires a unique exact valid nonoverlapping logical interval: %j', ({ ranges }) => {
    const links = fixture();
    expect(() => physicalSeamStitchIndices(links.seams, links.orders, declaration, ranges)).toThrow();
  });

  it('requires identity seam ownership and retains strict reciprocal proof for distinct partners', () => {
    const links = fixture();
    expect(() => physicalSeamStitchIndices(links.seams, links.orders, [{ pairs: [0, 0, 1, 5] }], range)).toThrow();
    links.orders[20] = 3;
    expect(() => physicalSeamStitchIndices(links.seams, links.orders, declaration, range)).toThrow(/reciprocal/);
    links.seams[4] = links.seams[20] = -1;
    expect(() => physicalSeamStitchIndices(links.seams, links.orders, declaration, range)).toThrow(/reciprocal/);
  });

  it('requires BOTH logical identity and physical endpoint indices before a local segment can be exempt', () => {
    const links = fixture(), mapping = physicalSeamStitchIndices(links.seams, links.orders, declaration, range);
    const triangles = new Uint32Array([0, 1, 2, 0, 0, 5, 6, 0, 7, 8, 9, 0]);
    const source = surfaceTopologyExclusions(triangles, links.seams, links.orders, declaration, true, mapping);
    expect(rows(source, 0)).toContainEqual([1, 2, 2, 7, 0]);
    const layout = buildSeamGateLayout(9, 1);
    for (const prefix of [2, 3, 7, 8, 9]) {
      const words = packSeamGate(layout, prefix, new Uint32Array([1]), mapping);
      expect(stitchEnabled(words, 7)).toBe(7 < prefix && 2 < prefix);
    }
    const inactive = packSeamGate(layout, 9, new Uint32Array([0]), mapping);
    expect(stitchEnabled(inactive, 7)).toBe(false); expect(seamEnabled(inactive, layout, 0)).toBe(false);
    // No identity metadata changes the native timeline/row semantics.
    const legacy = surfaceTopologyExclusions(triangles, links.seams, links.orders, declaration);
    expect(rows(legacy, 0)).toContainEqual([1, 2, 2, 0, 0]);
  });
});
