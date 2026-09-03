import type { FetchOptions, LoadedBodyModel } from './types';


/** This package's own `models/` folder, as a URL with a trailing slash. */
export const modelFolder: string;

export const modelFiles: {
  baseModel: string;
  indices: string;
  skinIndices: string;
  skinWeights: string;
  coefficients: (gender: string) => string;
  statistics: (gender: string) => string;
};

export function parseIndices(buffer: ArrayBuffer): Uint32Array;
export function parseSkinIndices(buffer: ArrayBuffer): Uint16Array;
export function parseSkinWeights(buffer: ArrayBuffer): Float32Array;
export function parseCoefficients(buffer: ArrayBuffer): Float32Array;

export function loadBodyModel(folder?: string, options?: FetchOptions): Promise<LoadedBodyModel>;
