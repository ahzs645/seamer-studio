import { materialContextJSON, sha256UTF8, snapshotMaterialInput } from './sourceMaterialIntegrity.ts';
/** Isolated opt-in candidate. No garment default and no production caller. */
import { prepareMembrane, type Mat3, type PreparedMembrane, type TriangleMaterial, type Vec2 } from './sourceMembraneReference.ts';

export interface BenchmarkSheet {
  densityKgPerM2: number;
  sheetTensorNPerM: Mat3;
  bendingRigidityNm: 0;
  iterationsPerMaterialStage: number;
  parameterOrigin: 'explicit-illustrative-benchmark';
  benchmarkId: string;
  parameterProvenance: string;
}
export interface CandidatePiece { pieceId: string; start: number; count: number; triangles: number[] }
export interface CandidateColor { edges: Float32Array; props: Float32Array; count: number }
export interface CandidateSim {
  particleCount: number;
  positions: Float32Array;
  arrangedPositions: Float32Array;
  sourceArrangedPositions?: Float32Array;
  positions2d: Float32Array;
  anchors: Float32Array;
  pieces: CandidatePiece[];
  stretchColors: CandidateColor[];
  bendColors: CandidateColor[];
  wireRuns: { pieceId: string }[];
  sourceStretchPolicy?: { sourcePieceIds: string[] };
  sourcePhysicalMembrane?: PreparedSourceMembrane;
}
export interface SourceSheetAssignment {
  pieceId: string;
  grainDirection: Vec2;
  parameters: BenchmarkSheet;
}
export interface PreparedSourceMembrane {
  revision: 'source-objective-SI-membrane-benchmark-v3';
  policySha256: string;
  iterationsPerMaterialStage: number;
  policy: Readonly<Record<string, unknown>>;
  triangles: readonly TriangleMaterial[];
  colors: readonly Uint32Array[];
  records: Float32Array;
  physicalMassesKg: Float64Array;
  sourceParticles: Uint8Array;
}
export interface ExecutedMaterialPolicy {
  revision: PreparedSourceMembrane['revision'];
  policySha256: string;
  parameterOrigin: 'explicit-illustrative-benchmark';
  iterationsPerMaterialStage: number;
  bendingRigidityNm: 0;
  measuredGarmentParameters: false;
  correctionLedger: 'direct-pre-world-add-metres-v1';
}
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const exactFloatBits = (values: Float32Array | Float64Array) => hex(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
const immutable = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); } return value; };
const copyColor = (color: CandidateColor): CandidateColor => ({ count: color.count, edges: color.edges.slice(), props: color.props.slice() });

/** A color contains no shared read/write vertex, including all three material participants. */
export function colorMembraneTriangles(triangles: readonly TriangleMaterial[]): Uint32Array[] {
  const used = new Map<number, Set<number>>(), colors: number[][] = [];
  triangles.forEach((tri, t) => {
    let c = 0;
    while (tri.ids.some(id => used.get(id)?.has(c))) c++;
    (colors[c] ??= []).push(t);
    for (const id of tri.ids) { const v = used.get(id) ?? new Set<number>(); v.add(c); used.set(id, v); }
  });
  return colors.map(ids => Uint32Array.from(ids));
}

/** Original cut-coordinate rest matrices, global IDs, immutable Float32-compatible material ABI. */
export function packMembraneRecords(triangles: readonly TriangleMaterial[]): Float32Array {
  const out = new Float32Array(triangles.length * 44), ids = new Uint32Array(out.buffer);
  triangles.forEach((tr, t) => {
    const offset = t * 44;
    tr.ids.forEach((id, i) => { ids[offset + i] = id; });
    tr.shapeGradientsPerM.forEach((g, i) => out.set(g, offset + 4 + i * 4));
    tr.compliancePerJoule.forEach((a, i) => out.set(a, offset + 16 + i * 4));
    tr.sheetTensorNPerM.forEach((a, i) => out.set(a, offset + 28 + i * 4));
    out[offset + 40] = tr.areaM2;
  });
  if (out.some((x, i) => i % 44 >= 4 && !Number.isFinite(x))) throw Error('Unrepresentable Float32 material');
  return out;
}

function filterConstraints(colors: CandidateColor[], source: Uint8Array, bending: boolean): { colors: CandidateColor[]; removed: number } {
  let removed = 0;
  return { colors: colors.map(color => {
    if (color.edges.length !== color.count * 4 || color.props.length !== color.count * 4) throw Error('Exact constraint rows required');
    const edges: number[] = [], props: number[] = [];
    for (let i = 0; i < color.count; i++) {
      const row = Array.from(color.edges.subarray(i * 4, i * 4 + 4));
      const ends = row.slice(0, bending ? 4 : 2);
      if (ends.some(id => !Number.isInteger(id) || id < 0 || id >= source.length)) throw Error('Constraint topology invalid');
      const isSource = ends.every(id => source[id] === 1);
      if (ends.some(id => source[id]) && !isSource) throw Error('Mixed source/native mechanical row unsupported');
      // Wire constraints are a separate axial law. Do not silently replace their mass/physics.
      if (isSource && !bending && row[3] !== 0) throw Error('Source wire mechanics needs an explicit SI policy');
      if (isSource) { removed++; continue; }
      edges.push(...row); props.push(...color.props.subarray(i * 4, i * 4 + 4));
    }
    return { count: edges.length / 4, edges: Float32Array.from(edges), props: Float32Array.from(props) };
  }), removed };
}

/** Every source panel requires an explicit assignment. Native geometry is never inferred as source. */
export async function prepareSourcePhysicalMembrane<T extends CandidateSim>(sim: T, assignments: readonly SourceSheetAssignment[]): Promise<T> {
  if (!assignments.length) return sim; // Identity/native path: no copying or material hooks.
  if (sim.sourcePhysicalMembrane) throw Error('Material policy already prepared');
  sim = snapshotMaterialInput(sim);
  assignments = snapshotMaterialInput(assignments);
  if (!sim.sourceStretchPolicy?.sourcePieceIds.length) throw Error('Authentic source-rest marker required');
  const sourceIds = sim.sourceStretchPolicy.sourcePieceIds, supplied = new Map(assignments.map(a => [a.pieceId, a]));
  if (supplied.size !== assignments.length || supplied.size !== sourceIds.length || sourceIds.some(id => !supplied.has(id))) throw Error('Explicit policy required for every and only source instance');
  if (sim.wireRuns.some(run => supplied.has(run.pieceId))) throw Error('Source wires require a separate physical mass and axial law');
  const iterations = assignments[0].parameters.iterationsPerMaterialStage;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 512 || assignments.some(a => a.parameters.iterationsPerMaterialStage !== iterations)) throw Error('One explicit bounded iteration policy required for the complete source material stage');
  const n = sim.particleCount;
  for (const array of [sim.positions, sim.arrangedPositions, sim.positions2d, sim.anchors, ...(sim.sourceArrangedPositions ? [sim.sourceArrangedPositions] : [])])
    if (array.length !== n * 4) throw Error('Exact particle array required');
  const source = new Uint8Array(n), masses = new Float64Array(n), triangles: TriangleMaterial[] = [], piecePolicies: unknown[] = [];
  for (const id of sourceIds) {
    const piece = sim.pieces.find(p => p.pieceId === id), assignment = supplied.get(id)!;
    if (!piece || !Number.isInteger(piece.start) || !Number.isInteger(piece.count) || piece.count < 1 || piece.start < 0 || piece.start + piece.count > n || piece.triangles.length % 3) throw Error('Source piece topology invalid');
    const p = assignment.parameters;
    if (p.parameterOrigin !== 'explicit-illustrative-benchmark' || p.bendingRigidityNm !== 0) throw Error('Only explicit membrane-only benchmark policy supported');
    for (let i = piece.start; i < piece.start + piece.count; i++) { if (source[i]) throw Error('Overlapping source pieces'); source[i] = 1; }
    const rest: Vec2[] = Array.from({ length: piece.count }, (_, i) => [sim.positions2d[(piece.start + i) * 4], sim.positions2d[(piece.start + i) * 4 + 1]]);
    const localTriangles: [number, number, number][] = [];
    for (let i = 0; i < piece.triangles.length; i += 3) localTriangles.push(piece.triangles.slice(i, i + 3).map(v => v - piece.start) as [number, number, number]);
    const weights = Array.from({ length: piece.count }, (_, i) => sim.positions[(piece.start + i) * 4 + 3]);
    const prepared: PreparedMembrane = prepareMembrane({ restPointsM: rest, triangles: localTriangles, grainDirections: localTriangles.map(() => assignment.grainDirection), densityKgPerM2: p.densityKgPerM2, sheetTensorNPerM: p.sheetTensorNPerM, capturedInverseMass: weights, benchmarkId: p.benchmarkId, parameterProvenance: p.parameterProvenance });
    prepared.physicalMassesKg.forEach((m, i) => { masses[piece.start + i] = m; });
    triangles.push(...prepared.triangles.map(tr => ({ ...tr, ids: tr.ids.map(v => v + piece.start) as [number, number, number] })));
    piecePolicies.push({ pieceId: id, grainDirection: Array.from(assignment.grainDirection), parameters: { ...p, sheetTensorNPerM: p.sheetTensorNPerM.map(r => Array.from(r)) }, totalPhysicalMassKg: prepared.totalMassKg });
  }
  const positions = sim.positions.slice(), arranged = sim.arrangedPositions.slice(), originalSource = sim.sourceArrangedPositions?.slice();
  for (let i = 0; i < n; i++) if (source[i]) {
    const captured = sim.positions[i * 4 + 3];
    if (sim.anchors[i * 4 + 3] !== 0) throw Error('Old source held checkpoints cannot enter a new material policy');
    for (let k = 0; k < 3; k++) if (!Object.is(sim.positions[i * 4 + k], sim.arrangedPositions[i * 4 + k])) throw Error('New physical policy requires a fresh arranged source seed; old drape/material cache cannot resume');
    if (sim.arrangedPositions[i * 4 + 3] !== captured || originalSource && originalSource[i * 4 + 3] !== captured) throw Error('Mobility differs across restart seeds');
    const w = captured === 0 ? captured : Math.fround(1 / masses[i]); // Exact +0/-0 captured fixed mask.
    if (!Number.isFinite(w) || captured > 0 && w <= 0) throw Error('Unrepresentable physical inverse mass');
    positions[i * 4 + 3] = w; arranged[i * 4 + 3] = w; if (originalSource) originalSource[i * 4 + 3] = w;
  }
  const stretch = filterConstraints(sim.stretchColors, source, false), bending = filterConstraints(sim.bendColors, source, true);
  const records = packMembraneRecords(triangles), colors = colorMembraneTriangles(triangles);
  const executedSim = { ...sim, positions, arrangedPositions: arranged, ...(originalSource ? { sourceArrangedPositions: originalSource } : {}), stretchColors: stretch.colors, bendColors: bending.colors };
  const policy = immutable({ preparedContextJSON: materialContextJSON(executedSim), iterationsPerMaterialStage: iterations, revision: 'source-objective-SI-membrane-benchmark-v3', cacheRevisionRequired: true, garmentParametersMeasured: false, integrationStatus: 'isolated-copy-only', pieces: piecePolicies, removedSourceStretchRows: stretch.removed, removedSourceDistanceOrFoldBendRows: bending.removed, sourceBendingRigidityNm: 0, sourceBendingStatus: 'membrane-only benchmark; no authored fold or bending response asserted', sourceRestBitsFloat32: exactFloatBits(sim.positions2d), physicalMassBitsFloat64: exactFloatBits(masses), physicalInverseMassBitsFloat32: exactFloatBits(positions.filter((_, i) => i % 4 === 3)), materialRecordBitsFloat32: exactFloatBits(records), sourceParticleMask: Array.from(source), colors: colors.map(ids => Array.from(ids)), correctionLedger: 'direct-pre-world-add-metres-v1', correctionLifetime: 'reset once before physical prediction by owning engine or standalone material; add direct material corrections across colors; rollback with whole frame; velocity reconciliation requires all source constraint increments', lambdaLifetime: 'zero at each actual physical prediction; accumulate across colors/material iterations; restore parent frame on material failure', response: 'objective coupled Green strain; finite SPD SI tensor; not a calibrated large-compression cloth law' });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(policy)));
  if (sha256UTF8(JSON.stringify(policy)) !== hex(new Uint8Array(digest))) throw Error('Independent preparation digest mismatch');
  const material: PreparedSourceMembrane = { iterationsPerMaterialStage: iterations, revision: 'source-objective-SI-membrane-benchmark-v3', policySha256: hex(new Uint8Array(digest)), policy, triangles: immutable(triangles), colors, records, physicalMassesKg: masses, sourceParticles: source };
  return { ...executedSim, sourcePhysicalMembrane: material };
}

/** Review control for identity/native bit parity; no implicit assignment or new allocation. */
export function copyUnchangedNativeColors(colors: CandidateColor[]): CandidateColor[] { return colors.map(copyColor); }

/** Recompute the actual SHA and validate every executed payload, not a truthy digest label. */
export function validateSourcePhysicalMembrane(sim: CandidateSim): ExecutedMaterialPolicy | null {
  const m = sim.sourcePhysicalMembrane;
  if (!m) return null;
  if (m.policy.correctionLedger !== 'direct-pre-world-add-metres-v1') throw Error('Source correction ledger policy missing');
  if (m.revision !== 'source-objective-SI-membrane-benchmark-v3' || m.policy.revision !== m.revision
    || !/^[0-9a-f]{64}$/.test(m.policySha256) || sha256UTF8(JSON.stringify(m.policy)) !== m.policySha256) throw Error('Actual source material policy digest mismatch');
  const iterations = m.iterationsPerMaterialStage, pieces = m.policy.pieces as { pieceId:string; parameters:BenchmarkSheet }[];
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 512 || m.policy.iterationsPerMaterialStage !== iterations
    || !Array.isArray(pieces) || pieces.length !== sim.sourceStretchPolicy?.sourcePieceIds.length
    || pieces.some(p => p.parameters.iterationsPerMaterialStage !== iterations || p.parameters.parameterOrigin !== 'explicit-illustrative-benchmark'
      || p.parameters.bendingRigidityNm !== 0 || !sim.sourceStretchPolicy?.sourcePieceIds.includes(p.pieceId))) throw Error('Material iterations/instance law differ from hashed policy');
  if (m.policy.preparedContextJSON !== materialContextJSON(sim)) throw Error('Executed preparation geometry/support/topology differs from sealed material policy');
  if (m.policy.physicalInverseMassBitsFloat32 !== exactFloatBits(sim.positions.filter((_,i) => i % 4 === 3))) throw Error('Executed inverse masses differ from material policy');
  if (m.policy.physicalMassBitsFloat64 !== exactFloatBits(m.physicalMassesKg)
    || JSON.stringify(m.policy.sourceParticleMask) !== JSON.stringify(Array.from(m.sourceParticles))) throw Error('Material mass/particle ownership differs from policy');
  const expected = packMembraneRecords(m.triangles);
  if (exactFloatBits(m.records) !== exactFloatBits(expected) || m.policy.materialRecordBitsFloat32 !== exactFloatBits(m.records)
    || JSON.stringify(m.policy.colors) !== JSON.stringify(m.colors.map(c => Array.from(c)))) throw Error('Material constants/color order differs from hashed policy');
  return Object.freeze({ revision:m.revision,policySha256:m.policySha256,parameterOrigin:'explicit-illustrative-benchmark',iterationsPerMaterialStage:iterations,bendingRigidityNm:0,measuredGarmentParameters:false,correctionLedger:'direct-pre-world-add-metres-v1' });
}

/** Private snapshot for a simulation/engine constructor; source validation precedes allocation. */
export function sealSourceMaterialSimulation<T extends CandidateSim>(sim: T): T {
  if (!sim.sourcePhysicalMembrane) return sim;
  const copy = snapshotMaterialInput(sim);
  validateSourcePhysicalMembrane(copy);
  copy.sourcePhysicalMembrane!.policy = immutable(copy.sourcePhysicalMembrane!.policy);
  copy.sourcePhysicalMembrane!.triangles = immutable(copy.sourcePhysicalMembrane!.triangles);
  return copy;
}
