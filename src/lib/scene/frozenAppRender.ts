import {prepareFrozenPhysicalMaterial,type FrozenPhysicalMaterialEvidence} from './frozenPhysicalPreparation';
import type { Pattern } from '@seamer/pattern-model';
import type { PreparedCloth, CollisionSeamActivation, CollisionGuardReport } from '@seamer/cloth-sim';
import { sourceCollisionPreparation } from '../utils/sourceCollisionPreparation';
import { canonicalSha256, sourceCutSha256 } from '../utils/sourceGatherEvidence';

export interface FrozenAppRenderRequest { snapshotJson: string; snapshotSha256: string }
export interface FrozenAppRenderReceipt {
  snapshotSha256: string; frame: number; sceneGeneration: number;
  diagnostic: true; garmentAccepted: false; cacheResumeEligible: false; deviceAcquired: false;
  bodyPositionErrorM: number; clothPositionErrorM: number; staticSafetyReport: CollisionGuardReport;
  bodyIndexSha256: string; clothTriangleSha256: string; sourceCutSha256: string;
  sourceBodyFitRevision: number; sourceAssemblyRevision: number; seamActivationSha256: string;
  sourceApprovalOrigins?:{numerical:string|null;rendering:string|null};
  visibleNotice: string;
}
export interface FrozenRenderEvidence extends FrozenPhysicalMaterialEvidence {
  frame: number; inputSha256: string; pattern: Pattern;
  renderPreparationFingerprints?:Record<string,string>;
  bodyPositions: number[]; bodyIndices: number[]; clothPositions: number[]; clothTriangles: number[]; seams: number[];
  sourceFitRevision: number; sourceAssemblyRevision: number;
  sourceFingerprints: Record<string, string>; bodySourceFingerprints: Record<string, string>;
  sourceFitFingerprint: string; sourceStretchPolicy: unknown;
  sourceGatherRefinement?: unknown; sourceGatherCollisionGeometry?: unknown;
  collisionSeamDictionary: unknown;
  collisionSeamActivation: { revision: number; activeSeams: number[]; sewnUpTo: number };
  safetyReport: CollisionGuardReport;
}
export interface FrozenPreparedBinding {
  pattern: Pattern; prepared: PreparedCloth; bodyPositions: Float32Array; bodyIndices: Uint32Array;
  sourceFitRevision: number; sourceAssemblyRevision: number;
}
export const FROZEN_SOURCE_PIN_REQUIREMENTS = [
  'packages/cloth-sim/src/assembly.ts', 'packages/cloth-sim/src/build.ts', 'packages/cloth-sim/src/collisionGuard.ts',
  'packages/cloth-sim/src/finalizeSourceGatherGeometry.ts', 'packages/cloth-sim/src/sourceGatherRefinement.ts',
  'packages/cloth-sim/src/sourceAssemblyTopology.ts', 'packages/cloth-sim/src/sourceStaging.ts',
  'packages/cloth-sim/src/webgpu/seamGate.ts', 'src/lib/utils/sourceCollisionPreparation.ts',
  'src/lib/utils/sourceGatherEvidence.ts', 'src/lib/utils/sourceGatherPreparation.ts', 'src/lib/utils/pinnedGatherPrograms.ts',
  'src/lib/scene/sourceBodyCheckpoint.ts'
] as const;
export const FROZEN_BODY_PIN_REQUIREMENTS = ['packages/avatar/src/avatarController.ts',
  'packages/avatar/src/garmentCodeFit.ts', 'packages/avatar/src/skinnedAvatar.ts', 'packages/avatar/src/matrix.ts',
  'src/lib/utils/importGarmentCode.ts', 'packages/avatar/src/sourceSurfaceDimensions.ts',
  'packages/avatar/src/surfaceGeodesic.ts', 'packages/avatar/src/bodySnapshot.ts',
  'packages/avatar/src/sourceFitWorkerRuntime.ts', 'packages/avatar/src/sourceFitWorker.ts',
  'packages/avatar/src/sourceFit.worker.ts'] as const;
const shaPattern = /^[a-f0-9]{64}$/;
export async function frozenSha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)),
    value => value.toString(16).padStart(2, '0')).join('');
}
function pack(values: ArrayLike<number>, integer = false): Uint8Array {
  const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw Error('Nonfinite frozen coordinates');
    if (integer) view.setUint32(i * 4, values[i], true); else view.setFloat32(i * 4, values[i], true);
  }
  return bytes;
}
function exact(a: ArrayLike<number>, b: ArrayLike<number>, label: string, stride: number, integer = false) {
  if (!a?.length || a.length !== b?.length || a.length % stride) throw Error(`Frozen ${label} count differs`);
  if (integer && Array.from(a).some(value => !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)) throw Error(`Invalid frozen ${label}`);
  const x = pack(a, integer), y = pack(b, integer);
  if (x.some((value, i) => value !== y[i])) throw Error(`Frozen ${label} differs from actual scene`);
  return x;
}
function policyTree(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map(policyTree);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, policyTree(item)]));
  return value;
}
async function equalPolicy(a: unknown, b: unknown, label: string) {
  if (await canonicalSha256(policyTree(a ?? null)) !== await canonicalSha256(policyTree(b ?? null))) throw Error(`Frozen ${label} differs`);
}
export async function decodeFrozenRenderRequest(request: FrozenAppRenderRequest): Promise<FrozenRenderEvidence> {
  const { snapshotJson, snapshotSha256 } = request;
  if (typeof snapshotJson !== 'string' || typeof snapshotSha256 !== 'string' || !shaPattern.test(snapshotSha256)
    || await frozenSha256(new TextEncoder().encode(snapshotJson)) !== snapshotSha256) throw Error('Frozen snapshot file digest differs');
  const value = JSON.parse(snapshotJson) as FrozenRenderEvidence;
  if (!Number.isSafeInteger(value.frame) || value.frame < 0 || !shaPattern.test(value.inputSha256)
    || !value.pattern?.garmentCodeSource || !value.safetyReport) throw Error('Missing frozen source checkpoint metadata');
  return value;
}
/** Module paths are controlled data, never executable document instructions. DEV raw imports
 * return the actual deployment source bytes; they do not approve the source document. */
export async function verifyFrozenModulePins(evidence: FrozenRenderEvidence, readSource: (path: string) => Promise<string>) {
  const physical=evidence.sourcePhysicalMaterialPolicySha256!==undefined;
  const sourcePins=physical?evidence.renderPreparationFingerprints:evidence.sourceFingerprints;
  if(physical){
    // Execution pins remain separate and unchanged. Only actual render preparation
    // modules are checked against this deployment, which has no SI solver installed.
    if(!sourcePins||FROZEN_SOURCE_PIN_REQUIREMENTS.filter(path=>path.startsWith('packages/cloth-sim/')).some(path=>!evidence.sourceFingerprints?.[path]))throw Error('Missing sealed numerical/render source pins');
    for(const name of ['sourcePhysicalMembrane.ts','sourceMaterialIntegrity.ts','sourceMembraneReference.ts']){
      const original=evidence.sourceFingerprints['packages/cloth-sim/src/'+name],rendered=sourcePins['src/lib/sourcePhysicalRender/'+name];
      if(!original||original!==rendered)throw Error('Frozen numerical SI preparation code differs from render preparation');
    }
    for(const path of ['src/lib/scene/frozenPhysicalPreparation.ts','src/lib/scene/frozenAppRender.ts','src/lib/sourcePhysicalRender/actualPhysicalMassBits.mjs','src/lib/utils/explicitSourceGatherImport.ts'])if(!sourcePins[path])throw Error('Missing actual SI render binding pin');
    for(const [path,hash]of Object.entries(evidence.sourceFingerprints))if(!shaPattern.test(hash)||path.split('/').includes('..'))throw Error('Invalid original numerical execution pin');
  }
  for (const [pins, required] of [[sourcePins, FROZEN_SOURCE_PIN_REQUIREMENTS],
    [evidence.bodySourceFingerprints, FROZEN_BODY_PIN_REQUIREMENTS]] as const) {
    if (required.some(path => !pins?.[path])) throw Error('Missing required frozen source/body pins');
    if (!pins || !Object.keys(pins).length) throw Error('Missing frozen source/body pins');
    for (const [path, sha] of Object.entries(pins)) {
      const attribution = path === 'packages/avatar/src/surfaceGeodesic.LICENSE' || path === 'packages/avatar/src/surfaceGeodesic.NOTICE';
      if ((!attribution && !/^(packages\/(avatar|cloth-sim|pattern-model)\/src\/|src\/lib\/(scene|utils|sourcePhysicalRender)\/|scripts\/)[A-Za-z0-9/_.-]+\.(ts|mjs)$/.test(path))
        || path.split('/').includes('..') || !shaPattern.test(sha)) throw Error('Invalid frozen module pin');
      if (await frozenSha256(new TextEncoder().encode(await readSource(path))) !== sha) throw Error(`Frozen module pin differs: ${path}`);
    }
  }
  if (evidence.bodySourceFingerprints['packages/avatar/src/garmentCodeFit.ts'] !== evidence.sourceFitFingerprint) throw Error('Frozen body-fit fingerprint differs');
}
/** Bind one sealed observation. All runtime guard/publication work stays in PatternRenderer. */
export async function bindFrozenPrepared(evidence: FrozenRenderEvidence, actual: FrozenPreparedBinding) {
  const {pattern}=actual;
  const prepared=await prepareFrozenPhysicalMaterial(evidence,pattern,actual.prepared),data=prepared.simData;
  if (!prepared.collisionSafety || !pattern.garmentCodeSource) throw Error('Frozen rendering requires an actual active source preparation');
  for (const [label, old, current] of [['body-fit', evidence.sourceFitRevision, actual.sourceFitRevision],
    ['assembly', evidence.sourceAssemblyRevision, actual.sourceAssemblyRevision]] as const) {
    if (!Number.isSafeInteger(old) || old !== current) throw Error(`Stale frozen ${label} revision`);
  }
  const cut = await sourceCutSha256(pattern);
  if (await sourceCutSha256(evidence.pattern) !== cut) throw Error('Frozen source cut identity differs');
  const frozenSource = evidence.pattern.garmentCodeSource, actualSource = pattern.garmentCodeSource;
  if (!frozenSource) throw Error('Missing frozen original source');
  const refined = !!(data.sourceGatherRefinement || evidence.sourceGatherRefinement);
  if (refined && (!frozenSource.gatherProvenance || !actualSource.gatherProvenance
    || !frozenSource.gatherSourceDocument || !actualSource.gatherSourceDocument)) throw Error('Refined frozen geometry requires its existing approved lossless source document');
  for (const source of [frozenSource, actualSource]) if (source.gatherProvenance && source.gatherProvenance.sourceCutSha256 !== cut) throw Error('Frozen source cut identity differs');
  // Unrefined source data has no gathering approval. Bind its original source fields directly;
  // never synthesize provenance or treat a missing ledger/document as approved refinement.
  for (const key of ['format', 'unitsInMeter', 'properties', 'parameters', 'parameterOrder',
    'constraints', 'constraintOrder', 'panelNames'] as const) await equalPolicy(frozenSource[key], actualSource[key], `original source ${key}`);
  await equalPolicy(evidence.pattern.body, pattern.body, 'body inputs');
  await equalPolicy(evidence.pattern.materials, pattern.materials, 'materials');
  await equalPolicy(frozenSource.generation, actualSource.generation, 'generation request');
  await equalPolicy(frozenSource.gatherSourceDocument, actualSource.gatherSourceDocument, 'lossless source document');
  const sourceApprovalOrigins={numerical:frozenSource.gatherProvenance?.origin??null,rendering:actualSource.gatherProvenance?.origin??null};
  if(evidence.sourcePhysicalMaterialPolicySha256&&refined&&sourceApprovalOrigins.numerical!==sourceApprovalOrigins.rendering){
    if(sourceApprovalOrigins.numerical!=='trusted-generator-response'||sourceApprovalOrigins.rendering!=='explicit-authored-import')throw Error('Frozen source approval origin differs from its actual import');
    // A deliberate original import is a distinct genuine approval. Preserve both
    // origins, while every numerical provenance field stays exactly bound.
    const {origin:oldOrigin,...numerical}=frozenSource.gatherProvenance!,{origin:newOrigin,...rendering}=actualSource.gatherProvenance!;
    await equalPolicy(numerical,rendering,'source provenance');
  }else await equalPolicy(frozenSource.gatherProvenance, actualSource.gatherProvenance, 'source provenance');
  const bodyBytes = exact(evidence.bodyPositions, actual.bodyPositions, 'body XYZ', 3);
  const bodyIndexBytes = exact(evidence.bodyIndices, actual.bodyIndices, 'body topology', 3, true);
  const triangles = exact(evidence.clothTriangles, data.triangles, 'cloth topology', 4, true);
  // Packed seam links are signed integer IDs, not positions.
  if (!evidence.seams?.length || evidence.seams.length !== data.seams.length
    || evidence.seams.some((value, i) => !Number.isInteger(value) || value !== data.seams[i])) throw Error('Frozen seam links differ');
  for (const [label, frozen, baked] of [['stretch policy', evidence.sourceStretchPolicy, data.sourceStretchPolicy],
    ['gather refinement', evidence.sourceGatherRefinement, data.sourceGatherRefinement],
    ['material collision geometry', evidence.sourceGatherCollisionGeometry, data.sourceGatherCollisionGeometry]] as const) await equalPolicy(frozen, baked, label);
  const context = sourceCollisionPreparation(prepared);
  await equalPolicy(evidence.collisionSeamDictionary, context.dictionary, 'physical seam dictionary');
  const used = evidence.collisionSeamActivation;
  if (!used || !Number.isSafeInteger(used.revision) || used.revision < 0 || !Number.isInteger(used.sewnUpTo)
    || used.sewnUpTo < 0 || used.sewnUpTo > data.stitchCount || used.activeSeams?.length !== context.dictionary.seamPairsBySeam.length
    || used.activeSeams.some(value => value !== 0 && value !== 1)) throw Error('Invalid frozen proof-used activation');
  await equalPolicy(used, evidence.safetyReport.seamActivation, 'proof-used activation');
  if (evidence.safetyReport.safe !== true) throw Error('Unsafe frozen checkpoint cannot enter the app scene');
  if (!evidence.clothPositions?.length || evidence.clothPositions.length !== data.positions.length
    || evidence.clothPositions.some(value => !Number.isFinite(value))) throw Error('Frozen particle topology differs');
  const positions = Float32Array.from(evidence.clothPositions);
  if (positions.some(value => !Number.isFinite(value))) throw Error('Nonfinite frozen Float32 coordinates');
  for (let i = 3; i < positions.length; i += 4) if (!Object.is(positions[i], data.positions[i])) throw Error('Frozen mass or hold substitution');
  const activation: CollisionSeamActivation = { ...used, activeSeams: Uint32Array.from(used.activeSeams) };
  return { positions, activation, sourceApprovalOrigins, dictionary: context.dictionary, sourceCutSha256: cut,
    bodyIndexSha256: await frozenSha256(bodyIndexBytes), bodyPositionSha256: await frozenSha256(bodyBytes),
    clothTriangleSha256: await frozenSha256(triangles), seamActivationSha256: await canonicalSha256(policyTree(used)) };
}

/** DEV automation readers remain available, but commands/transactions cannot edit the scene's document. */
export function frozenReadOnlyAutomation<T extends object>(api: T): T {
  const mutators = new Set(['execute', 'preview', 'beginTransaction', 'undo', 'redo']);
  // Editor readers return live document objects. Copy without JSON number normalization or
  // structuredClone's rejection of reactive proxies; returned snapshots cannot alter caches.
  function snapshot(value: unknown, seen = new Map<object, unknown>()): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return structuredClone(value);
    if (value instanceof Map) { const out = new Map(); seen.set(value, out); for (const [key, item] of value) out.set(snapshot(key, seen), snapshot(item, seen)); return out; }
    if (value instanceof Set) { const out = new Set(); seen.set(value, out); for (const item of value) out.add(snapshot(item, seen)); return out; }
    const out: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    seen.set(value, out);
    for (const key of Object.keys(value)) Object.defineProperty(out, key, { value: snapshot((value as Record<string, unknown>)[key], seen), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return new Proxy(api, { get(target, key, receiver) {
    if (typeof key === 'string' && mutators.has(key)) return () => { throw Error('Exit the read-only frozen checkpoint before editing.'); };
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? (...args: unknown[]) => snapshot(Reflect.apply(value, target, args)) : snapshot(value);
  } });
}
