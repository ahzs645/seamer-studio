import { createEmptyPattern, type Pattern } from '@seamer/pattern-model';
import { packBodyMesh, type PreparedCloth } from '@seamer/cloth-sim';
import { sourceCutSha256 } from '../utils/sourceGatherEvidence';
import { sourceCollisionPreparation } from '../utils/sourceCollisionPreparation';
import type { FrozenRenderEvidence } from './frozenAppRender';
// Small binding fixture, not a garment fit or source approval. Renderer tests separately use
// the authoritative finite guard against a genuinely closed body and actual Three buffers.
export async function bindingFixture() {
  const pattern = createEmptyPattern();
  pattern.garmentCodeSource = { format: 'garmentcode-json', properties: {}, unitsInMeter: 100, panelNames: ['panel'],
    gatherSourceDocument: { encoding: 'lossless-ieee754-json-tree-v1', value: ['z'] },
    gatherProvenance: { sourceCutSha256: await sourceCutSha256(pattern) } } as unknown as Pattern['garmentCodeSource'];
  pattern.garmentCodeSource!.gatherProvenance!.sourceCutSha256 = await sourceCutSha256(pattern);
  const bodyPositions = Float32Array.from([-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1]);
  const bodyIndices = Uint32Array.from([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]);
  const positions = Float32Array.from([2,0,0,1, 2,.3,0,1, 2,0,.3,1]);
  const prepared = { collisionSafety: true, body: packBodyMesh(bodyPositions, bodyIndices),
    simData: { particleCount: 3, positions, triangles: Uint32Array.from([0,1,2,0]),
      seams: new Int32Array(12).fill(-1), seamOrder: new Int32Array(12).fill(-1),
      seamPairsBySeam: [], stitchCount: 0 } } as unknown as PreparedCloth;
  const dictionary = sourceCollisionPreparation(prepared).dictionary;
  const activation = { revision: 0, activeSeams: [], sewnUpTo: 0 };
  const evidence = { frame: 2, inputSha256: 'a'.repeat(64), pattern: structuredClone(pattern),
    bodyPositions: Array.from(bodyPositions), bodyIndices: Array.from(bodyIndices),
    clothPositions: Array.from(positions), clothTriangles: Array.from(prepared.simData.triangles),
    seams: Array.from(prepared.simData.seams), sourceFitRevision: 4, sourceAssemblyRevision: 5,
    sourceStretchPolicy: null, collisionSeamDictionary: dictionary, collisionSeamActivation: activation,
    safetyReport: { safe: true, seamActivation: activation } } as unknown as FrozenRenderEvidence;
  return { pattern, prepared, bodyPositions, bodyIndices, evidence,
    actual: { pattern, prepared, bodyPositions, bodyIndices, sourceFitRevision: 4, sourceAssemblyRevision: 5 } };
}
