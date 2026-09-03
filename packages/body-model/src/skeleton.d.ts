import type { BaseModel, Bone, PoseData, Skeleton, Skin } from './types';

/** The 52-bone skeleton for one rest shape, derived from the mesh. */
export function createSkeleton(baseModel: BaseModel, restVertices: Float32Array): Skeleton;

/** One column-major 4x4 world matrix per bone, in `skeleton.bones` order. */
export function poseWorldMatrices(skeleton: Skeleton, pose?: PoseData): Float64Array[];

/** Where every joint ends up in a pose, by bone name: [x, y, z] in metres. */
export function jointWorldPositions(skeleton: Skeleton, pose?: PoseData): Map<string, number[]>;

/** Linear-blend skinning, four bones per vertex. Writes into `out` when given. */
export function poseVertices(
  skeleton: Skeleton,
  restVertices: Float32Array,
  skin: Skin,
  pose?: PoseData,
  out?: Float32Array
): Float32Array;

/** The T pose with both upper arms lifted `lift` radians above horizontal. */
export function armsUpPose(baseModel: BaseModel, lift?: number): PoseData;

export function jointWorldPosition(restVertices: Float32Array, bone: Pick<Bone, 'indices' | 'weights'>): number[];
export function rigid(position: ArrayLike<number>, euler: ArrayLike<number>, out?: Float64Array): Float64Array;
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>, out?: Float64Array): Float64Array;
export function invertRigid(m: ArrayLike<number>, out?: Float64Array): Float64Array;
export function transformPoint(m: ArrayLike<number>, point: ArrayLike<number>, out?: number[]): number[];
