import type { Pattern } from '@seamer/pattern-model';
import type { RangePlan, RangeStyle } from '../../../packages/pattern-model/src/rangePlan';

export function rangeStyleFromPattern(pattern: Pattern, id: string): RangeStyle {
  return { id, patternId: pattern.id, name: pattern.name, category: '', status: 'draft', colorwayNames: pattern.colorways?.variants.map(variant => variant.name) ?? [], sizes: pattern.techPack?.sizes.map(size => size.name) ?? [], plannedUnits: null, targetUnitCost: null, notes: '' };
}
/** Unknown quantities/costs remain unknown; totals are explicitly known subtotals. */
export function rangePlanSummary(plan: RangePlan) {
  let knownUnits = 0, knownBudget = 0, incompleteStyles = 0;
  for (const style of plan.styles) {
    if (style.plannedUnits !== null) knownUnits += style.plannedUnits;
    if (style.plannedUnits !== null && style.targetUnitCost !== null) knownBudget += style.plannedUnits * style.targetUnitCost;
    else incompleteStyles++;
  }
  return { knownUnits: Number.isFinite(knownUnits) ? knownUnits : null, knownBudget: Number.isFinite(knownBudget) ? knownBudget : null, incompleteStyles };
}
