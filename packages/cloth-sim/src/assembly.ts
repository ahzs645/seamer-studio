import type { Pattern, Piece } from '@seamer/pattern-model';
import { activeGarmentCodeBody } from '@seamer/avatar';
import type { SimData } from './build';
import type { BodyMesh } from './webgpu/engine';
import { buildBodySurfaceBVH, queryBodySurfaceBVH, type SurfaceBVH } from './webgpu/bodySurfaceBroadphase';

export const GARMENT_CODE_ASSEMBLY_REVISION = 5;

export interface AssemblySupportGroup {
  id: string;
  kind: 'shoulder' | 'waist';
  particles: number[];
  seamPairs: number[];
  releaseGapM: number;
  /** Activation prerequisites affect release only; cap placement keeps original seamPairs. */
  releaseSeamIndices?: number[];
  releaseSeamPairs?: number[];
  releaseStitchIndices?: number[];
  /** Original front/back span, retained while sewing endpoints move around the shoulder. */
  sourceZSpan?: [number, number];
  /** Anatomical source neck level; shoulder assembly never follows head/ear geometry above it. */
  skinMaxY?: number;
}

export interface AssemblySupportData {
  revision: number;
  activeOnStart: boolean;
  /** Per-particle vec4: target world Y, support weight, reserved, reserved. X/Z stay free. */
  targets: Float32Array;
  groups: AssemblySupportGroup[];
  activationSeamCount?: number;
  activationStitchCount?: number;
}

/** Upper silhouette of the actual collision mesh at X, restricted to the seam's front/back span.
 * A joint height is insufficient: the skin can sit several centimetres above that joint. */
export function bodyUpperEnvelopeY(body: BodyMesh, x: number, minZ: number, maxZ: number): number {
  let highest = -Infinity;
  for (let t = 0; t < body.triangles.length; t += 4) {
    const section: [number, number][] = [];
    for (let e = 0; e < 3; e++) {
      const a = body.triangles[t + e] * 4;
      const b = body.triangles[t + (e + 1) % 3] * 4;
      const ax = body.positions[a], bx = body.positions[b];
      if (Math.abs(ax - x) < 1e-7) section.push([body.positions[a + 1], body.positions[a + 2]]);
      if ((ax < x && bx > x) || (ax > x && bx < x)) {
        const u = (x - ax) / (bx - ax);
        section.push([body.positions[a + 1] + u * (body.positions[b + 1] - body.positions[a + 1]),
          body.positions[a + 2] + u * (body.positions[b + 2] - body.positions[a + 2])]);
      }
    }
    for (const [y, z] of section) if (z >= minZ && z <= maxZ) highest = Math.max(highest, y);
    if (section.length < 2) continue;
    const [a, b] = section;
    for (const z of [minZ, maxZ]) {
      if ((a[1] < z && b[1] > z) || (a[1] > z && b[1] < z)) {
        highest = Math.max(highest, a[0] + (z - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
    }
  }
  return highest;
}

/** Exact upper envelope over an X/Z rectangle. Clipping actual finite triangles handles peaks
 * between the two moving seam endpoints; endpoint/midpoint samples can miss those peaks. */
export function bodyUpperEnvelopeSpan(body: BodyMesh, minX: number, maxX: number, minZ: number, maxZ: number,
  bvh?: SurfaceBVH, minimumY = -Infinity, maximumY = Infinity): number {
  const ids = bvh ? queryBodySurfaceBVH(bvh, [minX, minimumY, minZ], [maxX, maximumY, maxZ])
    : Array.from({ length: body.numTriangles }, (_, i) => i);
  let highest = -Infinity;
  for (const id of ids) {
    let polygon = [0, 1, 2].map(corner => {
      const offset = body.triangles[id * 4 + corner] * 4;
      return [body.positions[offset], body.positions[offset + 1], body.positions[offset + 2]];
    });
    const planes = [[0, minX, 1], [0, maxX, -1], [2, minZ, 1], [2, maxZ, -1]];
    if (Number.isFinite(maximumY)) planes.push([1, maximumY, -1]);
    for (const [axis, limit, direction] of planes) {
      if (!polygon.length) break;
      const clipped: number[][] = [];
      let previous = polygon[polygon.length - 1];
      let previousInside = direction * (previous[axis] - limit) >= 0;
      for (const point of polygon) {
        const inside = direction * (point[axis] - limit) >= 0;
        if (inside !== previousInside) {
          const fraction = (limit - previous[axis]) / (point[axis] - previous[axis]);
          clipped.push(point.map((value, coordinate) => previous[coordinate] + fraction * (value - previous[coordinate])));
        }
        if (inside) clipped.push(point);
        previous = point; previousInside = inside;
      }
      polygon = clipped;
    }
    for (const point of polygon) if (point[1] >= minimumY) highest = Math.max(highest, point[1]);
  }
  return highest;
}

function shoulderEdge(piece: Piece, pathId: string): boolean {
  const paths = piece.mainPaths;
  const i = paths.findIndex(path => path.id === pathId);
  if (i < 0) return false;
  const adjacent = [paths[(i + paths.length - 1) % paths.length].name, paths[(i + 1) % paths.length].name];
  return adjacent.some(name => /collar|neck/i.test(name)) && adjacent.some(name => /armhole/i.test(name));
}

/** Source placement is kept intact in the document. Only the live assembly seed is lifted so that
 * shoulder seams can travel over the skin rather than trying to sew through it. Supports are
 * independent of saved XYZ anchors and are never enabled for a reused checkpoint. */
export function prepareGarmentCodeAssembly(pattern: Pattern, data: SimData, body: BodyMesh, fresh: boolean): void {
  const source = activeGarmentCodeBody(pattern.body);
  if (!pattern.garmentCodeSource || !source || !(source.height > 0 && source.waist_line > 0 && source.head_l > 0)) return;
  data.sourceArrangedPositions = data.arrangedPositions.slice();
  const owners = new Map(pattern.pieces.flatMap(piece => piece.mainPaths.map(path => [path.id, piece] as const)));
  const groups: AssemblySupportGroup[] = [];
  const liftedPieces = new Set<string>();
  const neckY = (source.height - source.head_l) / 100;
  let shoulderBVH: SurfaceBVH | undefined;
  let lift = 0;
  for (const seam of pattern.seams) {
    const refs = [...seam.fromPaths, ...seam.toPaths];
    if (!refs.some(ref => { const owner = owners.get(ref.id); return owner?.settings3d.arrangement?.sourcePlacement && shoulderEdge(owner, ref.id); })) continue;
    const pairs = data.seamPairsBySeam.find(entry => entry.seamId === seam.id)?.pairs;
    if (!pairs?.length) continue;
    const particles = [...new Set(pairs)];
    shoulderBVH ??= buildBodySurfaceBVH(body);
    let valid = true;
    let seamLift = 0;
    for (let i = 0; i < pairs.length; i += 2) {
      const a = pairs[i] * 4, b = pairs[i + 1] * 4;
      const x = (data.arrangedPositions[a] + data.arrangedPositions[b]) / 2;
      const minZ = Math.min(data.arrangedPositions[a + 2], data.arrangedPositions[b + 2]) - 0.005;
      const maxZ = Math.max(data.arrangedPositions[a + 2], data.arrangedPositions[b + 2]) + 0.005;
      const cap = bodyUpperEnvelopeSpan(body, x, x, minZ, maxZ, shoulderBVH, -Infinity, neckY);
      if (!Number.isFinite(cap)) { valid = false; break; }
      seamLift = Math.max(seamLift, cap + 0.008 - Math.min(data.arrangedPositions[a + 1], data.arrangedPositions[b + 1]));
    }
    if (!valid) continue;
    lift = Math.max(lift, seamLift);
    for (const ref of refs) { const owner = owners.get(ref.id); if (owner) liftedPieces.add(owner.id); }
    const sourceZ = particles.map(i => data.sourceArrangedPositions![i * 4 + 2]);
    groups.push({ id: seam.id, kind: 'shoulder', particles, seamPairs: pairs.slice(), releaseGapM: 0.006,
      sourceZSpan: [Math.min(...sourceZ) - 0.005, Math.max(...sourceZ) + 0.005],
      skinMaxY: neckY });
  }
  // An implausible lift indicates wrong source/body correspondence. Leave that document alone.
  if (lift > 0.10) return;
  lift = Math.max(0, lift);
  for (const piece of data.pieces) {
    if (!liftedPieces.has(piece.pieceId.replace(/#M$/, ''))) continue;
    for (let i = piece.start; i < piece.start + piece.count; i++) {
      data.arrangedPositions[i * 4 + 1] += lift;
      if (fresh) data.positions[i * 4 + 1] += lift;
    }
  }
  const waistParticles = new Set<number>();
  const waistPieces = new Set<string>();
  for (const piece of pattern.pieces) {
    if (!piece.settings3d.arrangement?.sourcePlacement) continue;
    for (const path of piece.mainPaths) {
      if (path.name !== 'lower_interface') continue;
      const run = data.edgeRuns.get(`${piece.id}::${path.id}`);
      if (!run?.length) continue;
      waistPieces.add(piece.id);
      for (const particle of run) waistParticles.add(particle);
    }
  }
  // Translate the whole waistband before simulating, rather than pulling only its upper edge
  // through another panel. Match the connected lower-piece interface to the band's lower edge.
  // Torso panels retain their skin-clear shoulders while their hem maps to the upper interface.
  const waistY = (source.height - source.head_l - source.waist_line) / 100;
  if (waistParticles.size) alignWaistInterfaces(data, waistPieces, waistParticles, liftedPieces, groups, waistY, fresh);
  if (waistParticles.size) {
    const pairs = data.seamPairsBySeam.filter(entry => {
      const seam = pattern.seams.find(item => item.id === entry.seamId);
      return seam && [...seam.fromPaths, ...seam.toPaths].some(ref => waistPieces.has(owners.get(ref.id)?.id ?? ''));
    }).flatMap(entry => entry.pairs);
    if (pairs.length) groups.push({ id: 'source-waist-interface', kind: 'waist', particles: [...waistParticles], seamPairs: pairs, releaseGapM: 0.006 });
  }
  if (!groups.length) return;
  const targets = new Float32Array(data.positions.length);
  // GarmentCode's lower_interface plane attachment uses the body's anatomical waist. A flat
  // panel's initial translation can sit substantially below it and is not a final fit target.
  for (const group of groups) for (const particle of group.particles) {
    targets[particle * 4] = group.kind === 'waist' ? waistY : data.arrangedPositions[particle * 4 + 1];
    targets[particle * 4 + 1] = 1;
  }
  const plan = data.sourceStaging ?? data.arrangementSourceStaging;
  if (plan) {
    for (const group of groups) {
      const shoulder = plan.shoulderPrerequisites.find(entry => entry.shoulderSeamId === group.id);
      if (shoulder) {
        group.releaseSeamIndices = shoulder.seamIndices.slice();
        group.releaseSeamPairs = shoulder.pairs.slice();
        group.releaseStitchIndices = shoulder.stitchIndices.slice();
      } else if (group.kind === 'waist') {
        const keys = new Set<string>();
        for (let at = 0; at < group.seamPairs.length; at += 2) {
          const a = group.seamPairs[at], b = group.seamPairs[at + 1];
          keys.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
        }
        const indices = plan.pairs.flatMap((pairs, index) => {
          for (let at = 0; at < pairs.length; at += 2) {
            const a = pairs[at], b = pairs[at + 1];
            if (keys.has(`${Math.min(a, b)}:${Math.max(a, b)}`)) return [index];
          }
          return [];
        });
        group.releaseSeamIndices = indices;
        group.releaseSeamPairs = indices.flatMap(index => plan.pairs[index]);
        group.releaseStitchIndices = indices.flatMap(index => plan.stitchIndices[index]);
      }
    }
  }
  data.assemblySupport = { revision: GARMENT_CODE_ASSEMBLY_REVISION, activeOnStart: fresh, targets, groups,
    ...(plan ? { activationSeamCount: plan.seamIds.length, activationStitchCount: plan.stitchCount } : {}) };
}

function alignWaistInterfaces(data: SimData, waistPieces: Set<string>, waistParticles: Set<number>,
  upperPieces: Set<string>, groups: AssemblySupportGroup[], waistY: number, fresh: boolean): void {
  const owner = new Array<string>(data.particleCount);
  for (const piece of data.pieces) for (let i = piece.start; i < piece.start + piece.count; i++) owner[i] = piece.pieceId.replace(/#M$/, '');
  const transform = (pieceIds: Set<string>, mapY: (y: number) => number) => {
    for (const piece of data.pieces) {
      if (!pieceIds.has(piece.pieceId.replace(/#M$/, ''))) continue;
      for (let i = piece.start; i < piece.start + piece.count; i++) {
        data.arrangedPositions[i * 4 + 1] = mapY(data.arrangedPositions[i * 4 + 1]);
        if (fresh) data.positions[i * 4 + 1] = data.arrangedPositions[i * 4 + 1];
      }
    }
  };
  for (const pieceId of waistPieces) {
    if (upperPieces.has(pieceId)) continue;
    const particles = [...waistParticles].filter(i => owner[i] === pieceId);
    const meanY = particles.reduce((sum, i) => sum + data.arrangedPositions[i * 4 + 1], 0) / particles.length;
    const shift = waistY - meanY;
    transform(new Set([pieceId]), y => y + shift);
  }
  const connections = new Map<string, Set<string>>();
  const targets = new Map<string, { sumDelta: number; sumCurrentY: number; sumTargetY: number; count: number }>();
  for (const seam of data.seamPairsBySeam) for (let i = 0; i < seam.pairs.length; i += 2) {
    const a = seam.pairs[i], b = seam.pairs[i + 1], pa = owner[a], pb = owner[b];
    if (pa === pb) continue;
    if (!connections.has(pa)) connections.set(pa, new Set());
    if (!connections.has(pb)) connections.set(pb, new Set());
    connections.get(pa)!.add(pb); connections.get(pb)!.add(pa);
    if (waistPieces.has(pa) === waistPieces.has(pb)) continue;
    const w = waistPieces.has(pa) ? a : b, p = w === a ? b : a, pieceId = owner[p];
    const targetY = data.arrangedPositions[w * 4 + 1], currentY = data.arrangedPositions[p * 4 + 1];
    const target = targets.get(pieceId) ?? { sumDelta: 0, sumCurrentY: 0, sumTargetY: 0, count: 0 };
    target.sumDelta += targetY - currentY; target.sumCurrentY += currentY; target.sumTargetY += targetY; target.count++;
    targets.set(pieceId, target);
  }
  for (const pieceId of upperPieces) {
    const target = targets.get(pieceId);
    if (!target) continue;
    const hemY = target.sumCurrentY / target.count, targetY = target.sumTargetY / target.count;
    const shoulderParticles = groups.filter(group => group.kind === 'shoulder').flatMap(group => group.particles).filter(i => owner[i] === pieceId);
    const pivot = Math.min(...shoulderParticles.map(i => data.arrangedPositions[i * 4 + 1]));
    if (!(pivot > hemY + 0.05 && pivot > targetY + 0.05)) continue;
    const slope = (pivot - targetY) / (pivot - hemY);
    if (!(slope >= 0.25 && slope <= 4)) continue;
    transform(new Set([pieceId]), y => y >= pivot ? y : targetY + (y - hemY) * slope);
  }
  const visited = new Set<string>();
  for (const seed of targets.keys()) {
    if (visited.has(seed) || upperPieces.has(seed) || waistPieces.has(seed)) continue;
    const component = new Set<string>(), pending = [seed];
    while (pending.length) {
      const pieceId = pending.pop()!;
      if (visited.has(pieceId) || upperPieces.has(pieceId) || waistPieces.has(pieceId)) continue;
      visited.add(pieceId); component.add(pieceId);
      for (const next of connections.get(pieceId) ?? []) pending.push(next);
    }
    let sum = 0, count = 0;
    for (const pieceId of component) { const target = targets.get(pieceId); if (target) { sum += target.sumDelta; count += target.count; } }
    if (count) { const shift = sum / count; transform(component, y => y + shift); }
  }
}

export interface AssemblySupportState {
  id: string;
  kind: 'shoulder' | 'waist';
  phase: 'assembling' | 'releasing' | 'released';
  scale: number;
  maxSeamGapM: number;
  stableFrames: number;
  releaseSeconds: number;
}

/** Controller history must roll back with GPU particle history after a rejected frame. */
export interface AssemblySupportSnapshot {
  readonly topology: string;
  readonly elapsedSeconds: number;
  readonly states: readonly Readonly<AssemblySupportState>[];
  readonly targets: Float32Array;
  readonly seamActivation?: { readonly activeSeams: Uint32Array; readonly sewnUpTo: number; readonly structuralEnabled?: boolean };
}

/** Release only after the supported seams have actually closed, then fade in simulated time.
 * An unclosed assembly remains explicitly assembling; elapsed time cannot declare a bad fit ready. */
export class AssemblySupportController {
  readonly targets: Float32Array;
  readonly states: AssemblySupportState[];
  private elapsed = 0;
  private body?: BodyMesh;
  private bodyBVH?: SurfaceBVH;
  private readonly snapshotTopology: string;
  private seamActivation?: { activeSeams: Uint32Array; sewnUpTo: number; structuralEnabled: boolean };
  constructor(private readonly data: AssemblySupportData, private readonly timeStepSeconds: number,
    body?: BodyMesh, bvh?: SurfaceBVH) {
    this.snapshotTopology = JSON.stringify({ revision: data.revision, groups: data.groups.map(group => ({
      id: group.id, kind: group.kind, particles: group.particles, seamPairs: group.seamPairs,
      releaseSeamIndices: group.releaseSeamIndices, releaseSeamPairs: group.releaseSeamPairs, releaseStitchIndices: group.releaseStitchIndices
    })) });
    this.targets = data.targets.slice();
    this.states = data.groups.map(group => ({ id: group.id, kind: group.kind,
      phase: data.activeOnStart ? 'assembling' : 'released', scale: data.activeOnStart ? 1 : 0,
      maxSeamGapM: Infinity, stableFrames: 0, releaseSeconds: 0 }));
    this.writeWeights();
    if (body) this.setBody(body, bvh);
  }
  setBody(body: BodyMesh, bvh?: SurfaceBVH): void {
    this.body = body;
    this.bodyBVH = bvh ?? buildBodySurfaceBVH(body);
  }
  captureState(): AssemblySupportSnapshot {
    return { topology: this.snapshotTopology, elapsedSeconds: this.elapsed, states: this.states.map(state => ({ ...state })),
      targets: this.targets.slice(), ...(this.seamActivation ? { seamActivation: { activeSeams: this.seamActivation.activeSeams.slice(), sewnUpTo: this.seamActivation.sewnUpTo, structuralEnabled: this.seamActivation.structuralEnabled } } : {}) };
  }
  restoreState(snapshot: AssemblySupportSnapshot): void {
    if (snapshot.topology !== this.snapshotTopology || snapshot.targets.length !== this.targets.length || snapshot.states.length !== this.states.length
      || snapshot.states.some((state, index) => state.id !== this.states[index].id || state.kind !== this.states[index].kind)) {
      throw new Error('Assembly support snapshot topology changed');
    }
    if (snapshot.seamActivation) this.setSeamActivation(snapshot.seamActivation.activeSeams, snapshot.seamActivation.sewnUpTo, snapshot.seamActivation.structuralEnabled ?? true);
    else this.seamActivation = undefined;
    this.elapsed = snapshot.elapsedSeconds;
    this.targets.set(snapshot.targets);
    snapshot.states.forEach((state, index) => Object.assign(this.states[index], state));
  }
  /** Only activation prerequisites affect release. Original cap targets and X/Z freedom remain. */
  setSeamActivation(activeSeams: Uint32Array, sewnUpTo: number, structuralEnabled = true): void {
    if (!this.data.activationSeamCount || this.data.activationStitchCount === undefined) return;
    if (activeSeams.length !== this.data.activationSeamCount || activeSeams.some(value => value !== 0 && value !== 1)
      || !Number.isInteger(sewnUpTo) || sewnUpTo < 0 || sewnUpTo > this.data.activationStitchCount || typeof structuralEnabled !== 'boolean') {
      throw new Error('Invalid assembly support seam activation');
    }
    this.seamActivation = { activeSeams: activeSeams.slice(), sewnUpTo, structuralEnabled };
  }
  /** Called with the last accepted/readback positions before the following frame. Only assembling
   * shoulder groups follow the skin; release fades their last target, then leaves Y entirely free. */
  refreshTargets(positions: Float32Array): boolean {
    if (!this.body || !this.bodyBVH) return false;
    let changed = false;
    for (let i = 0; i < this.states.length; i++) {
      const state = this.states[i], group = this.data.groups[i];
      if (state.kind !== 'shoulder' || state.phase !== 'assembling' || !group.sourceZSpan) continue;
      for (let at = 0; at < group.seamPairs.length; at += 2) {
        const a = group.seamPairs[at] * 4, b = group.seamPairs[at + 1] * 4;
        const floor = Math.max(this.data.targets[a], this.data.targets[b]);
        const minX = Math.min(positions[a], positions[b]), maxX = Math.max(positions[a], positions[b]);
        const cap = bodyUpperEnvelopeSpan(this.body, minX, maxX, group.sourceZSpan[0], group.sourceZSpan[1], this.bodyBVH, floor - .05, group.skinMaxY);
        const target = Math.fround(Math.max(floor, cap + .008));
        if (this.targets[a] !== target || this.targets[b] !== target) {
          this.targets[a] = target; this.targets[b] = target; changed = true;
        }
      }
    }
    return changed;
  }
  advance(positions: Float32Array): boolean {
    this.elapsed += this.timeStepSeconds;
    let changed = false;
    for (let i = 0; i < this.states.length; i++) {
      const state = this.states[i], group = this.data.groups[i];
      if (state.phase === 'released') continue;
      const prerequisitesEnabled = !!group.releaseSeamIndices && this.seamActivation?.structuralEnabled !== false;
      const active = !prerequisitesEnabled || !!this.seamActivation
        && group.releaseSeamIndices!.every(index => this.seamActivation!.activeSeams[index] === 1)
        && (group.releaseStitchIndices ?? []).every(stitch => stitch < this.seamActivation!.sewnUpTo);
      let max = active ? 0 : Infinity;
      const releasePairs = prerequisitesEnabled ? group.releaseSeamPairs ?? group.seamPairs : group.seamPairs;
      for (let j = 0; j < releasePairs.length; j += 2) {
        const a = releasePairs[j] * 4, b = releasePairs[j + 1] * 4;
        max = Math.max(max, Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]));
      }
      state.maxSeamGapM = max;
      if (state.phase === 'assembling') {
        state.stableFrames = Number.isFinite(max) && max <= group.releaseGapM ? state.stableFrames + 1 : 0;
        if (state.stableFrames >= 3 && this.elapsed >= (group.kind === 'waist' ? 0.5 : 0.25)) state.phase = 'releasing';
      }
      if (state.phase === 'releasing') {
        state.releaseSeconds += this.timeStepSeconds;
        state.scale = Math.max(0, 1 - state.releaseSeconds / 0.5);
        if (!state.scale) state.phase = 'released';
        changed = true;
      }
    }
    if (changed) this.writeWeights();
    return this.refreshTargets(positions) || changed;
  }
  private writeWeights(): void {
    for (let i = 1; i < this.targets.length; i += 4) this.targets[i] = 0;
    this.data.groups.forEach((group, i) => {
      for (const particle of group.particles) this.targets[particle * 4 + 1] = Math.max(this.targets[particle * 4 + 1], this.states[i].scale);
    });
  }
}
