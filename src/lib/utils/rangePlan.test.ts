import { describe, expect, it } from 'vitest';
import { createEmptyPattern } from '@seamer/pattern-model';
import { createRangePlan, validateRangePlan } from '../../../packages/pattern-model/src/rangePlan';
import { rangePlanSummary, rangeStyleFromPattern } from './rangePlan';

describe('collection range planning', () => {
  it('captures actual saved pattern, size and colorway associations without inventing production quantities', () => {
    const pattern = { ...createEmptyPattern(), id: 'saved', name: 'Dress', colorways: { activeId: null, variants: [{ id: 'blue', name: 'Blue', pieces: {} }], generatedMaterialSources: {} } };
    const style = rangeStyleFromPattern(pattern, 'style');
    expect(style).toMatchObject({ patternId: 'saved', name: 'Dress', colorwayNames: ['Blue'], plannedUnits: null, targetUnitCost: null });
    const plan = { ...createRangePlan('range'), styles: [style, { ...style, id: 'complete', plannedUnits: 100, targetUnitCost: 12.5 }, { ...style, id: 'units-only', plannedUnits: 20 }] };
    validateRangePlan(plan);
    expect(rangePlanSummary(plan)).toEqual({ knownUnits: 120, knownBudget: 1250, incompleteStyles: 2 });
  });
  it('rejects duplicate IDs, fractional units, invalid currency and nonfinite/negative costs on import', () => {
    const style = rangeStyleFromPattern(createEmptyPattern(), 'style');
    const plan = { ...createRangePlan('range'), styles: [style] };
    expect(() => validateRangePlan({ ...plan, styles: [style, style] })).toThrow();
    expect(() => validateRangePlan({ ...plan, currency: 'dollars' })).toThrow();
    for (const patch of [{ plannedUnits: 1.5 }, { plannedUnits: -1 }, { targetUnitCost: Infinity }, { targetUnitCost: -2 }, { sizes: [1] }, { status: 'invented' }]) expect(() => validateRangePlan({ ...plan, styles: [{ ...style, ...patch }] })).toThrow();
  });
});
