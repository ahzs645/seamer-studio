import type { FetchOptions, LoadedBodyModel } from './types';

export function loadBodyModelFromDisk(
  folder?: string | URL,
  options?: Omit<FetchOptions, 'fetchJson' | 'fetchBytes'>
): Promise<LoadedBodyModel>;

export function fetchJson(url: string): Promise<unknown>;
export function fetchBytes(url: string): Promise<ArrayBuffer>;
