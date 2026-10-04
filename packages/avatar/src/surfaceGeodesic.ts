/** Triangle fast marching with unfolded virtual edges, following the actual
 * GarmentMeasurements dependency pmp::geodesics (Kimmel/Sethian 1998).
 * Copyright 2011–2020 Polygon Mesh Processing Library developers;
 * 2001–2005 Computer Graphics Group, RWTH Aachen. MIT, see surfaceGeodesic.LICENSE.
 * This uses JS double arithmetic on the same Float32 geometry; it does not
 * recreate the original SMPL landmark assignment. */
export function triangleSurfaceGeodesic(v: Float32Array, t: Uint32Array, start: number, end: number): number {
  const n = v.length / 3;
  if (!Number.isInteger(n) || start < 0 || end < 0 || start >= n || end >= n || t.length % 3) throw new Error('Invalid geodesic topology or anchors.');
  const at = (i: number) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
  const add = (a: number[], b: number[]) => a.map((x, i) => x + b[i]);
  const scale = (a: number[], s: number) => a.map(x => x * s);
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  const norm = (a: number[]) => Math.hypot(...a);
  const unit = (a: number[]) => scale(a, 1 / norm(a));
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const next = (h: number) => h - h % 3 + (h + 1) % 3;
  const from = (h: number) => t[h], to = (h: number) => t[next(h)];
  const outgoing: number[][] = Array.from({ length: n }, () => []), neighbors: Set<number>[] = Array.from({ length: n }, () => new Set());
  const directed = new Map<string, number>();
  for (let h = 0; h < t.length; h++) { const a = from(h), b = to(h); if (a >= n || b >= n || a === b || directed.has(`${a}_${b}`)) throw new Error('Non-manifold or degenerate geodesic topology.'); directed.set(`${a}_${b}`, h); outgoing[a].push(h); neighbors[a].add(b); neighbors[b].add(a); }
  const opposite = (h: number) => directed.get(`${to(h)}_${from(h)}`);
  const virtual = new Map<number, { vertex: number; length: number }>();
  for (let h = 0; h < t.length; h++) {
    const p = at(from(h)); let a = to(h), hh = next(h), b = to(hh), pa = at(a), pb = at(b);
    const da = unit(sub(pa, p)), db = unit(sub(pb, p)), cosine = dot(da, db);
    if (cosine >= Math.fround(Math.cos(Math.fround(Math.PI / 2)))) continue;
    const alpha = .5 * Math.acos(Math.max(-1, Math.min(1, cosine))), tolerance = Math.tan(Math.PI / 2 - alpha), x = unit(add(da, db)), y = unit(cross(cross(da, db), x));
    let va = [dot(sub(pa, p), x), dot(sub(pa, p), y)], vb = [dot(sub(pb, p), x), dot(sub(pb, p), y)];
    const firstA = a, firstB = b; let across = opposite(hh), visits = 0;
    while ((a === firstA || b === firstB) && across !== undefined) {
      if (++visits > t.length) throw new Error('Unfolded geodesic traversal did not terminate.');
      const c = to(next(across)), pc = at(c), ab = sub(pb, pa), ac = sub(pc, pa), edge = sub(vb, va), fraction = dot(ab, ac) / dot(ab, ab), projected = add(pa, scale(ab, fraction)), unfolded = add(va, scale(edge, fraction));
      const vn = add(unfolded, scale(unit([edge[1], -edge[0]]), norm(sub(projected, pc))));
      if (Math.abs(vn[1]) / Math.abs(vn[0]) < tolerance) { virtual.set(h, { vertex: c, length: norm(vn) }); break; }
      const back = opposite(hh); if (back === undefined) break;
      if (vn[1] > 0) { hh = next(back); b = c; pb = pc; vb = vn; }
      else { hh = next(next(back)); a = c; pa = pc; va = vn; }
      across = opposite(hh);
    }
  }
  const d = new Float64Array(n).fill(Infinity), done = new Uint8Array(n), heap: [number, number][] = [];
  const less = (a: [number, number], b: [number, number]) => a[0] < b[0] || a[0] === b[0] && a[1] < b[1];
  const push = (value: [number, number]) => { let i = heap.length; heap.push(value); while (i > 0) { const p = (i - 1) >> 1; if (!less(value, heap[p])) break; heap[i] = heap[p]; i = p; } heap[i] = value; };
  const pop = () => { const first = heap[0], last = heap.pop()!; if (heap.length) { let i = 0; while (true) { const l = i * 2 + 1; if (l >= heap.length) break; const r = l + 1, c = r < heap.length && less(heap[r], heap[l]) ? r : l; if (!less(heap[c], last)) break; heap[i] = heap[c]; i = c; } heap[i] = last; } return first; };
  const triangleDistance = (a0: number, b0: number, c: number, r0?: number, r1?: number) => {
    let a = a0, b = b0, ar = r1, br = r0;
    if (d[a0] >= d[b0]) { a = b0; b = a0; ar = r0; br = r1; }
    const ca = sub(at(a), at(c)), cb = sub(at(b), at(c)), al = ar ?? norm(cb), bl = br ?? norm(ca), cosine = dot(unit(ca), unit(cb)), fallback = Math.min(d[a] + bl, d[b] + al);
    if (cosine < 0) return fallback;
    const u = d[b] - d[a], aa = al * al + bl * bl - 2 * al * bl * cosine, bb = 2 * bl * u * (al * cosine - bl), cc = bl * bl * (u * u - al * al * (1 - cosine * cosine)), disc = bb * bb - 4 * aa * cc;
    if (disc > 0) { const time = Math.max((-bb + Math.sqrt(disc)) / (2 * aa), (-bb - Math.sqrt(disc)) / (2 * aa)), q = bl * (time - u) / time; if (u < time && al * cosine < q && q < al / cosine) return d[a] + time; }
    return fallback;
  };
  const update = (c: number) => {
    let best = Infinity;
    for (const h of outgoing[c]) {
      const a = to(h), b = to(next(h)), ve = virtual.get(h);
      if (!ve) { if (done[a] && done[b]) best = Math.min(best, triangleDistance(a, b, c)); }
      else { if (done[a] && done[ve.vertex]) best = Math.min(best, triangleDistance(a, ve.vertex, c, undefined, ve.length)); if (done[b] && done[ve.vertex]) best = Math.min(best, triangleDistance(ve.vertex, b, c, ve.length)); }
    }
    if (best !== d[c]) { d[c] = best; if (Number.isFinite(best)) push([best, c]); }
  };
  d[start] = 0; done[start] = 1;
  for (const b of neighbors[start]) { d[b] = norm(sub(at(start), at(b))); done[b] = 1; }
  for (const b of neighbors[start]) for (const c of neighbors[b]) if (!done[c]) update(c);
  while (heap.length) { const [distance, a] = pop(); if (done[a] || distance !== d[a]) continue; done[a] = 1; if (a === end) return d[a]; for (const b of neighbors[a]) if (!done[b]) update(b); }
  if (Number.isFinite(d[end])) return d[end];
  throw new Error('Surface geodesic anchors are disconnected.');
}
