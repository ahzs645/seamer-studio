import type { NestGravity } from './nestingProtocol';
import type { CutOffType } from './markerLayout';

export interface MarkerSettings {
  algorithm: 'fast' | 'trueShape' | 'nfp';
  fabricWidthMm: number;
  gapMm: number;
  allowedRotations: number[];
  generations: number;
  gravity: NestGravity;
  curveToleranceMm: number;
  cutOff: CutOffType;
  cutIds: string[];
  maxLengthMm?: number;
}

export const DEFAULT_MARKER_SETTINGS: Readonly<MarkerSettings> = {
  algorithm: 'nfp',
  fabricWidthMm: 1400,
  gapMm: 10,
  maxLengthMm: 0,
  allowedRotations: [0, 180],
  generations: 12,
  gravity: 'bottom',
  curveToleranceMm: 1,
  cutOff: 'none',
  cutIds: []
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Normalizes persisted settings from older patterns while retaining legacy defaults. */
export function readMarkerSettings(value: unknown): MarkerSettings {
  if (!isRecord(value)) return structuredClone(DEFAULT_MARKER_SETTINGS);
  const algorithm =
    value.algorithm === 'fast' || value.algorithm === 'trueShape' || value.algorithm === 'nfp'
      ? value.algorithm
      : DEFAULT_MARKER_SETTINGS.algorithm;
  const gravity =
    value.gravity === 'bottom' || value.gravity === 'left' ||
    value.gravity === 'right' || value.gravity === 'top'
      ? value.gravity
      : DEFAULT_MARKER_SETTINGS.gravity;
  const cutOff =
    value.cutOff === 'none' || value.cutOff === 'boundingBox' ||
    value.cutOff === 'convexHull' || value.cutOff === 'concaveHull'
      ? value.cutOff
      : DEFAULT_MARKER_SETTINGS.cutOff;
  const finite = (candidate: unknown, fallback: number): number =>
    typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
  return {
    algorithm,
    fabricWidthMm: finite(value.fabricWidthMm, DEFAULT_MARKER_SETTINGS.fabricWidthMm),
    gapMm: finite(value.gapMm, DEFAULT_MARKER_SETTINGS.gapMm),
    maxLengthMm: finite(value.maxLengthMm, DEFAULT_MARKER_SETTINGS.maxLengthMm ?? 0),
    allowedRotations:
      Array.isArray(value.allowedRotations) &&
      value.allowedRotations.length > 0 &&
      value.allowedRotations.every((rotation) => typeof rotation === 'number' && Number.isFinite(rotation))
        ? [...value.allowedRotations]
        : [...DEFAULT_MARKER_SETTINGS.allowedRotations],
    generations: finite(value.generations, DEFAULT_MARKER_SETTINGS.generations),
    gravity,
    curveToleranceMm: finite(value.curveToleranceMm, DEFAULT_MARKER_SETTINGS.curveToleranceMm),
    cutOff,
    cutIds: Array.isArray(value.cutIds)
      ? value.cutIds.filter((id): id is string => typeof id === 'string')
      : []
  };
}

export function writeMarkerSettings(settings: MarkerSettings): MarkerSettings {
  return {
    ...settings,
    allowedRotations: [...settings.allowedRotations],
    cutIds: [...settings.cutIds]
  };
}
