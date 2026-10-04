import type { SurfaceBVH } from './bodySurfaceBroadphase';

export interface SurfaceRefitLevel { depth: number; first: number; count: number; uniformOffset: number }
export interface SurfaceRefitPlan {
  parentNodeIds: Uint32Array;
  levels: SurfaceRefitLevel[];
  uniforms: Uint32Array;
  leafCount: number;
  maxLeafTriangles: number;
  maxDepth: number;
}
const INTERNAL = 0xffffffff, START_MASK = 0x0fffffff;

/** Immutable preorder topology: left=node+1, right=left.escape. Parents run deepest first. */
export function buildSurfaceRefitPlan(bvh: SurfaceBVH, uniformAlignment = 256): SurfaceRefitPlan {
  if (!Number.isInteger(uniformAlignment) || uniformAlignment < 16 || uniformAlignment % 16) throw new Error('Invalid refit uniform alignment');
  if (bvh.nodes.length !== bvh.nodeCount * 8 || bvh.ranges.length !== bvh.nodeCount * 4) throw new Error('Invalid refit topology sizes');
  const words = new Uint32Array(bvh.nodes.buffer, bvh.nodes.byteOffset, bvh.nodes.length);
  const byDepth: number[][] = [], seen = new Set<number>();
  let leafCount = 0, maxLeafTriangles = 0, maxDepth = 0;
  const visit = (index: number, depth: number): void => {
    if (index < 0 || index >= bvh.nodeCount || seen.has(index)) throw new Error('Invalid or repeated refit node');
    seen.add(index); maxDepth = Math.max(maxDepth, depth);
    const escape = words[index * 8 + 3], leaf = words[index * 8 + 7];
    if (escape <= index || escape > bvh.nodeCount) throw new Error('Invalid refit escape');
    if (leaf !== INTERNAL) {
      const first = leaf & START_MASK, count = leaf >>> 28;
      if (escape !== index + 1 || count < 1 || count > 8 || first + count > bvh.triangleIds.length
        || bvh.ranges[index * 4] !== first || bvh.ranges[index * 4 + 1] !== count) throw new Error('Invalid refit leaf');
      leafCount++; maxLeafTriangles = Math.max(maxLeafTriangles, count); return;
    }
    const left = index + 1;
    if (left >= escape) throw new Error('Missing refit child');
    const right = words[left * 8 + 3];
    if (right <= left || right >= escape || words[right * 8 + 3] !== escape) throw new Error('Invalid refit child escape');
    if (bvh.ranges[index * 4 + 1] !== bvh.ranges[left * 4 + 1] + bvh.ranges[right * 4 + 1]) throw new Error('Invalid refit subtree range');
    (byDepth[depth] ??= []).push(index);
    visit(left, depth + 1); visit(right, depth + 1);
  };
  if (bvh.nodeCount) visit(0, 1);
  if (seen.size !== bvh.nodeCount || maxDepth !== bvh.maxDepth) throw new Error('Unreachable refit node or incorrect depth');
  const parentNodeIds = new Uint32Array(bvh.nodeCount - leafCount), levels: SurfaceRefitLevel[] = [];
  let first = 0;
  for (let depth = maxDepth - 1; depth >= 1; depth--) {
    const ids = byDepth[depth]; if (!ids?.length) continue;
    parentNodeIds.set(ids, first);
    levels.push({ depth, first, count: ids.length, uniformOffset: levels.length * uniformAlignment });
    first += ids.length;
  }
  const uniforms = new Uint32Array(levels.length * uniformAlignment / 4);
  for (const level of levels) uniforms.set([level.first, level.count, 0, 0], level.uniformOffset / 4);
  return { parentNodeIds, levels, uniforms, leafCount, maxLeafTriangles, maxDepth };
}

