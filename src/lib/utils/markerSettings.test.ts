import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKER_SETTINGS,
  readMarkerSettings,
  writeMarkerSettings
} from './markerSettings';

describe('marker settings persistence', () => {
  it('restores the legacy GA defaults for patterns without marker settings', () => {
    expect(readMarkerSettings(null)).toEqual(DEFAULT_MARKER_SETTINGS);
  });

  it('round-trips GA controls without sharing mutable arrays', () => {
    const persisted = writeMarkerSettings({
      algorithm: 'nfp',
      fabricWidthMm: 1520,
      gapMm: 7,
      maxLengthMm: 2400,
      allowedRotations: [0, 90, 180, 270],
      generations: 27,
      gravity: 'right',
      curveToleranceMm: 0.6,
      cutOff: 'concaveHull',
      cutIds: ['piece-a#0']
    });
    const restored = readMarkerSettings(structuredClone(persisted));

    expect(restored).toEqual(persisted);
    expect(restored.allowedRotations).not.toBe(persisted.allowedRotations);
    expect(restored.cutIds).not.toBe(persisted.cutIds);
  });
});
