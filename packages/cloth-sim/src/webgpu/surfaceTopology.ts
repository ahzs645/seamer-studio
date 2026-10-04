import type { SourceGatherCollisionGeometry } from '../collisionGuard';

/** Sparse seam-contact neighborhoods. Records are [otherFace, stitchThreshold, pairedSegmentLink, 0, seamIndex].
 * A face pair is never exempt merely because its panels are sewn elsewhere: the shader also
 * requires the actual contact to be within thickness of BOTH locally closed seam sides. */
export function surfaceTopologyExclusions(
  triangles: Uint32Array, seams: Int32Array, seamOrder: Int32Array,
  seamPairs: readonly { pairs: readonly number[] }[] = [], sourceStitchProof = false,
  sourceStitchIndices?: readonly (readonly number[])[],
  sourceGatherGeometry?: Pick<SourceGatherCollisionGeometry, 'intervals'>
): Uint32Array {
  const count = triangles.length / 4;
  const incident = new Map<number, Set<number>>();
  const neighbors = new Map<number, Set<number>>();
  for (let face = 0; face < count; face++) {
    const vertices = Array.from(triangles.subarray(face * 4, face * 4 + 3));
    for (const vertex of vertices) {
      const faces = incident.get(vertex) ?? new Set<number>();
      faces.add(face); incident.set(vertex, faces);
      const near = neighbors.get(vertex) ?? new Set<number>();
      for (const other of vertices) near.add(other);
      neighbors.set(vertex, near);
    }
  }
  const neighborhood = (vertex: number) => {
    const faces = new Set(incident.get(vertex));
    for (const neighbor of neighbors.get(vertex) ?? []) {
      for (const face of incident.get(neighbor) ?? []) faces.add(face);
    }
    return faces;
  };
  const segmentsByPair = new Map<string, { seam: number; link: number }[]>();
  const stitchByPair = new Map<string, number>();
  if (sourceStitchProof) for(let vertex=0;vertex<seams.length/4;vertex++) for(let slot=0;slot<4;slot++) {
    const partner=seams[vertex*4+slot], order=seamOrder[vertex*4+slot];
    if(partner>=0 && order>=0) stitchByPair.set(`${vertex}:${partner}`,order);
  }
  const segmentThreshold = new Map<number, number>();
  const refined = refinedSurfaceSeamRecords(seamPairs, sourceGatherGeometry);
  let seamOffset=seamPairs.length+1;
  for(let seam=0;seam<seamPairs.length;seam++) {
    const pairs=seamPairs[seam].pairs;

    for(let at=0;at+1<pairs.length;at+=2) {
      const segments=[];
      if(at>=2) segments.push({seam,link:seamOffset+at-2});
      if(at+3<pairs.length) segments.push({seam,link:seamOffset+at});
      if(sourceStitchProof && at+3<pairs.length) {
        const first=sourceStitchIndices?.[seam]?.[at/2] ?? stitchByPair.get(`${pairs[at]}:${pairs[at+1]}`);
        const second=sourceStitchIndices?.[seam]?.[at/2+1] ?? stitchByPair.get(`${pairs[at+2]}:${pairs[at+3]}`);
        segmentThreshold.set(seamOffset+at,first===undefined || second===undefined ? 0xffffffff : Math.max(first,second));
      }
      segmentsByPair.set(`${pairs[at]}:${pairs[at+1]}`,segments);
      segmentsByPair.set(`${pairs[at+1]}:${pairs[at]}`,segments);
    }
    seamOffset+=pairs.length;
  }
  const rows = Array.from({ length: count }, () => new Map<string, [number, number, number, number, number]>());
  for (let vertex = 0; vertex < seams.length / 4; vertex++) {
    for (let slot = 0; slot < 4; slot++) {
      const partner = seams[vertex * 4 + slot];
      if (partner < 0) continue;
      const order = seamOrder[vertex * 4 + slot];
      const threshold = order < 0 ? 0xffffffff : order;
      // Segment pointers already prove that an actual endpoint pair links both face one-rings.
      // Deduplicating identical segments avoids rescanning an entire seam for every contact.
      for (const a of neighborhood(vertex)) for (const b of neighborhood(partner)) {
        for(const segment of segmentsByPair.get(`${vertex}:${partner}`) ?? []) {
          const key=`${b}:${segment.seam}:${segment.link}`;
          const old=rows[a].get(key);
          if(!old || threshold===0xffffffff || (old[1]!==0xffffffff && threshold<old[1])) {
            rows[a].set(key,[b,threshold,refined.pointers.get(segment.link) ?? segment.link,sourceStitchProof ? (segmentThreshold.get(segment.link) ?? 0xffffffff) : 0,segment.seam]);
          }
        }
      }
    }
  }
  const entries = rows.reduce((sum, row) => sum + row.size, 0);
  const packed = new Uint32Array(count + 1 + entries * 5);
  let offset = count + 1;
  for (let face = 0; face < count; face++) {
    packed[face] = offset;
    for (const record of [...rows[face].values()].sort(([a], [b]) => a - b)) {
      packed.set(record, offset); offset += 5;
    }
  }
  packed[count] = offset;
  return packed;
}

/** Original seam headers/pairs stay byte-identical. Tagged links address ten-u32 child records
 * appended in the EXISTING seamLinks storage buffer, without changing stitch identity. */
export function surfaceSeamLinks(seams: readonly { pairs: readonly number[] }[],
  geometry?: Pick<SourceGatherCollisionGeometry, 'intervals'>): Uint32Array {
  const refined = refinedSurfaceSeamRecords(seams, geometry);
  const packed = new Uint32Array(seams.length + 1 + seams.reduce((sum, seam) => sum + seam.pairs.length, 0) + refined.words.length);
  let offset = seams.length + 1;
  for (let index = 0; index < seams.length; index++) {
    packed[index] = offset; packed.set(seams[index].pairs, offset); offset += seams[index].pairs.length;
  }
  packed[seams.length] = offset;
  packed.set(refined.words, offset);
  return packed;
}

/** Exact tagged record map shared by topology and seamLinks packing. */
function refinedSurfaceSeamRecords(seams: readonly { pairs: readonly number[] }[],
  geometry?: Pick<SourceGatherCollisionGeometry, 'intervals'>): { pointers: Map<number, number>; words: number[] } {
  const pointers = new Map<number, number>(), words: number[] = [];
  const offsets: number[] = []; let end = seams.length + 1;
  for (const seam of seams) { offsets.push(end); end += seam.pairs.length; }
  for (const record of geometry?.intervals ?? []) {
    const pairs = seams[record.seamIndex]?.pairs, k = record.originalInterval;
    if (!pairs || !Number.isSafeInteger(k) || k < 0 || (k+1)*2+1 >= pairs.length
      || record.sides.length !== 2 || end+words.length+10 >= 0x80000000) throw new Error('Invalid refined GPU seam interval');
    const oldLink = offsets[record.seamIndex]+k*2;
    if (pointers.has(oldLink)) throw new Error('Duplicate refined GPU seam interval');
    const data: number[] = [], faces: number[] = [];
    for (let sideIndex=0;sideIndex<2;sideIndex++) {
      const side = record.sides[sideIndex], ids = side.particles;
      if ((ids.length !== 2 && ids.length !== 3) || side.children.length !== ids.length-1
        || ids[0] !== pairs[k*2+sideIndex] || ids.at(-1) !== pairs[(k+1)*2+sideIndex]) throw new Error('Refined GPU path does not match original stitch interval');
      data.push(ids[0],ids.length===3 ? ids[1] : 0xffffffff,ids.at(-1)!);
      faces.push(side.children[0].boundaryFace,side.children.at(-1)!.boundaryFace);
    }
    pointers.set(oldLink, (end+words.length+0x80000000) >>> 0);
    words.push(...data,...faces);
  }
  return { pointers, words };
}
