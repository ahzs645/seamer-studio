import type { BaseModel } from '@seamer/body-model';
import type { Body } from '@seamer/pattern-model';
import { activeGarmentCodeBody, fitGarmentCodeAvatar } from './garmentCodeFit';
import { fitSourceSurfaceDimensions } from './sourceSurfaceDimensions';

export interface SourceFitInput {
  vertices: Float32Array; indices: Uint32Array; skinIndices: Uint16Array; skinWeights: Float32Array;
  model: BaseModel; body: Body;
}
/** Pure numerical source calibration, shared by the browser isolate and explicit CPU tests. */
export function computeSourceFit(input: SourceFitInput): Float32Array {
  const { vertices, indices, skinIndices, skinWeights, model, body } = input;
  const source = activeGarmentCodeBody(body);
  if (!source) throw new Error('Source worker requires verified active body measurements.');
  if (!(vertices instanceof Float32Array) || vertices.length % 3 || !vertices.length
    || !(indices instanceof Uint32Array) || indices.length % 3
    || !(skinIndices instanceof Uint16Array) || !(skinWeights instanceof Float32Array)
    || skinIndices.length !== vertices.length / 3 * 4 || skinWeights.length !== skinIndices.length
    || !vertices.every(Number.isFinite) || !skinWeights.every(Number.isFinite)
    || !indices.every(i => i < vertices.length / 3)) throw new Error('Invalid source fit numerical inputs.');
  const initial = fitGarmentCodeAvatar(vertices, indices, model, body);
  return fitSourceSurfaceDimensions(initial, indices, skinIndices, skinWeights, model, source);
}
