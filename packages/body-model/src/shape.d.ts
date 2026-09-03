import type { BaseModel, GenderModel } from './types';

export const coefficientCount: 17;

/**
 * The rest-pose vertex positions in metres, +Y up, mirrored across x = 0.
 * `values` is the seventeen coefficients in `baseModel.coefficientNames` order.
 */
export function reconstructVertices(
  baseModel: BaseModel,
  coefficients: Float32Array,
  values: ArrayLike<number>,
  numVertices?: number
): Float32Array;

/** The seventeen coefficients for one row of the statistics' 69 columns. */
export function coefficientsFrom(baseModel: BaseModel, statistics: GenderModel, row: ArrayLike<number>): number[];

/** The seventeen coefficients of the mean body for a gender. */
export function meanCoefficients(baseModel: BaseModel, statistics: GenderModel): number[];
