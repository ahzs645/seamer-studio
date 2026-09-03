// The shapes the model's own files are in. base_model.json and
// <gender>_model.json are read as-is, so these describe the data rather than
// wrap it.

export interface BoneData {
  /** Four vertex indices whose weighted sum is the joint's world position. */
  indices: number[];
  /** Four weights; they may be negative and sum to about one. */
  weights: number[];
  parent: string | null;
  /** Rest euler [x, y, z, 'XYZ']. */
  rotation: [number, number, number, string];
}

/** Bone name -> absolute XYZ euler rotation. Bones left out keep their rest rotation. */
export type PoseData = Record<string, { x: number; y: number; z: number }>;

export interface Cylinder {
  id: string;
  name: string;
  startBone: string;
  endBone: string;
  vertexIndices: number[];
  padding: number;
  uOffsetDegrees: number;
  tapered: boolean;
  elliptical: boolean;
  axisReversed: boolean;
  enabled: boolean;
}

export interface ArrangementPointDef {
  id: string;
  name: string;
  cylinderName: string;
  uDegrees: number;
  v: number;
  enabled: boolean;
}

export interface Landmark {
  id: number;
  vertexIndex: number;
  name: string;
  x: number;
  y: number;
  z: number;
  enabled: boolean;
}

export interface BaseModel {
  bodyParts: Record<string, number[]>;
  symmetry: { centeredIndices: number[]; pairs: [number, number][] };
  measurements: unknown[];
  coefficientNames: string[];
  landmarks: Landmark[];
  bones: [string, BoneData][];
  poses: Record<string, PoseData>;
  cylinders: Cylinder[];
  arrangementPoints: ArrangementPointDef[];
}

/** The statistics one gender's sliders start from: 69 columns of measurements. */
export interface GenderModel {
  covariances: number[][];
  means: number[];
  min: number[];
  max: number[];
  columnNames: string[];
  numSamples: number;
}

/** Four bones per vertex: indices into the skeleton, and weights summing to one. */
export interface Skin {
  indices: Uint16Array;
  weights: Float32Array;
}

export interface LoadedBodyModel {
  baseModel: BaseModel;
  /** Triangle indices, numTriangles * 3. */
  indices: Uint32Array;
  skin: Skin;
  /** Present only when a gender was asked for. */
  coefficients?: Float32Array;
  statistics?: GenderModel;
}

export interface Bone {
  name: string;
  /** Index of the parent bone, or -1 for the root. */
  parent: number;
  rotation: number[];
  indices: number[];
  weights: number[];
  position: number[];
  /** Rest world matrix, column-major 4x4. */
  world: Float64Array;
  /** Inverse of `world`: takes a rest vertex into the bone's frame. */
  bindInverse: Float64Array;
}

export interface Skeleton {
  bones: Bone[];
  indexOf: Map<string, number>;
  poses: Record<string, PoseData>;
}

export interface FetchOptions {
  fetchJson?: (url: string) => Promise<unknown>;
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  gender?: 'male' | 'female' | null;
}
