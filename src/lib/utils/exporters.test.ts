import { describe, expect, it } from 'vitest';
import { createEmptyPattern } from '@seamer/pattern-model';
import { patternToSSP, sspToPattern } from './exporters';

describe('legacy SSP avatar compatibility', () => {
  it('preserves body measurements while marking a settled SeamScape snapshot for its default avatar', async () => {
    const pattern = createEmptyPattern();
    pattern.body.fields = { age: 35, height: 65.2, weight: 182, hipGirth: 46 };
    pattern.pieces = [{
      id: 'piece',
      name: 'Back',
      settings3d: {
        savedMeshSnapshot: { positions: [0, 0, 0] },
        savedPositions: []
      }
    } as never];

    const restored = await sspToPattern(await patternToSSP(pattern));

    expect(restored.body.fields).toEqual(pattern.body.fields);
    expect(restored.body.useLegacyDefaultAvatar).toBe(true);
  });

  it('does not change the avatar mode of a native Seamer SSP', async () => {
    const pattern = createEmptyPattern();
    const restored = await sspToPattern(await patternToSSP(pattern));
    expect(restored.body.useLegacyDefaultAvatar).toBeUndefined();
  });
});
