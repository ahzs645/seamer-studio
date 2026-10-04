/** Optional source masks share the existing sewing uniform; native gates retain 16 bytes. */
export interface SeamGateLayout {
  stitchCount: number;
  seamCount: number;
  stitchVectors: number;
  seamVectors: number;
  byteLength: number;
}

export function buildSeamGateLayout(stitchCount: number, seamCount: number): SeamGateLayout {
  if (![stitchCount, seamCount].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Invalid sewing gate topology');
  }
  const stitchVectors = Math.max(1, Math.ceil(stitchCount / 128));
  const seamVectors = Math.max(1, Math.ceil(seamCount / 128));
  const byteLength = 16 + (stitchVectors + seamVectors) * 16;
  if (byteLength > 16384) throw new Error('Source sewing gate exceeds the portable uniform limit');
  return { stitchCount, seamCount, stitchVectors, seamVectors, byteLength };
}

/** A physical repeated partner keeps its first-stamped GPU stitch index. Identity pairs
 * have no GPU link; their declared logical timeline ordinal gates only seam proof. */
export function packSeamGate(layout: SeamGateLayout, prefix: number, activeSeams: Uint32Array,
  stitchIndices: readonly (readonly number[])[]): Uint32Array {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > layout.stitchCount
    || activeSeams.length !== layout.seamCount || stitchIndices.length !== layout.seamCount
    || activeSeams.some(value => value !== 0 && value !== 1)) throw new Error('Invalid source sewing activation');
  const words = new Uint32Array(layout.byteLength / 4);
  words[0] = prefix; words[1] = 1;
  const seamOffset = 4 + layout.stitchVectors * 4;
  for (let seam = 0; seam < layout.seamCount; seam++) {
    for (const stitch of stitchIndices[seam]) {
      if (!Number.isInteger(stitch) || stitch < 0 || stitch >= layout.stitchCount) {
        throw new Error('Source sewing activation has an invalid physical stitch');
      }
      if (activeSeams[seam]) words[4 + (stitch >>> 5)] |= 1 << (stitch & 31);
    }
    if (activeSeams[seam]) words[seamOffset + (seam >>> 5)] |= 1 << (seam & 31);
  }
  return words;
}

export function seamGateWGSL(name: string, layout?: SeamGateLayout): string {
  if (!layout) return `struct ${name} { sewnUpTo:i32, p0:i32, p1:i32, p2:i32 };\n`
    + 'fn activeSourceStitch(stitch:i32)->bool { return true; }\n'
    + 'fn activeSourceSeam(seam:u32)->bool { return true; }\n'
    + 'fn activeSourceSegment(stitch:u32)->bool { return true; }';
  return `struct ${name} {
    sewnUpTo:i32, masked:u32, p1:u32, p2:u32,
    stitchBits:array<vec4u,${layout.stitchVectors}>, seamBits:array<vec4u,${layout.seamVectors}>
  };
  fn activeSourceStitch(stitch:i32)->bool {
    if(gate.masked==0u || stitch<0) { return true; }
    let index=u32(stitch); if(index>=${layout.stitchCount}u) { return false; }
    return (gate.stitchBits[index/128u][(index/32u)%4u] & (1u<<(index%32u)))!=0u;
  }
  fn activeSourceSeam(seam:u32)->bool {
    if(gate.masked==0u) { return true; }
    if(seam>=${layout.seamCount}u) { return false; }
    return (gate.seamBits[seam/128u][(seam/32u)%4u] & (1u<<(seam%32u)))!=0u;
  }
  fn activeSourceSegment(stitch:u32)->bool {
    if(gate.masked==0u) { return true; }
    if(stitch==0xffffffffu) { return false; }
    return i32(stitch)<gate.sewnUpTo && activeSourceStitch(i32(stitch));
  }`;
}

export function physicalSeamStitchIndices(seams: Int32Array, orders: Int32Array,
  paired: readonly { seamId?: string; pairs: readonly number[] }[],
  ranges: readonly { seamId: string; start: number; end: number }[] = []): number[][] {
  if (seams.length % 4 || orders.length !== seams.length) throw new Error('Source sewing link arrays have incompatible topology');
  return paired.map(({ seamId, pairs }) => {
    if (pairs.length % 2 || pairs.some(vertex => !Number.isSafeInteger(vertex) || vertex < 0 || vertex >= seams.length / 4)) {
      throw new Error('Source paired seam has an invalid particle');
    }
    const result: number[] = [];
    for (let at = 0; at < pairs.length; at += 2) {
      const a = pairs[at], b = pairs[at + 1];
      if (a === b) {
        const owned = ranges.filter(range => range.seamId === seamId);
        const range = owned[0];
        if (typeof seamId !== 'string' || !seamId || owned.length !== 1 || !Number.isSafeInteger(range.start) || range.start < 0
          || !Number.isSafeInteger(range.end) || range.end - range.start !== pairs.length / 2
          || ranges.some(other => !Number.isSafeInteger(other.start) || other.start < 0
            || !Number.isSafeInteger(other.end) || other.end < other.start
            || other !== range && other.start < range.end && other.end > range.start)) {
          throw new Error('Source identity seam has no exact logical stitch range');
        }
        result.push(range.start + at / 2);
        continue;
      }
      let order = -1, reverse = -1;
      for (let slot = 0; slot < 4; slot++) {
        if (seams[a * 4 + slot] === b) order = orders[a * 4 + slot];
        if (seams[b * 4 + slot] === a) reverse = orders[b * 4 + slot];
      }
      if(order<0 || order!==reverse || !Number.isInteger(order)) throw new Error('Source paired seam has no reciprocal physical stitch');
      result.push(order);
    }
    return result;
  });
}
