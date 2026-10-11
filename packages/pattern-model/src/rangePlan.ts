/** A collection/range plan travels with the pattern and references other locally saved styles. */
export type RangeStyleStatus = 'idea' | 'draft' | 'sampling' | 'approved' | 'production';
export interface RangeStyle {
  id: string;
  patternId: string | null;
  name: string;
  category: string;
  status: RangeStyleStatus;
  colorwayNames: string[];
  sizes: string[];
  plannedUnits: number | null;
  targetUnitCost: number | null;
  notes: string;
}
export interface RangePlan {
  id: string;
  name: string;
  season: string;
  currency: string;
  notes: string;
  styles: RangeStyle[];
}
export function createRangePlan(id: string = crypto.randomUUID()): RangePlan {
  return { id, name: 'New collection', season: '', currency: 'USD', notes: '', styles: [] };
}
export function validateRangePlan(value: unknown): asserts value is RangePlan {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!record(value) || !['id', 'name', 'season', 'currency', 'notes'].every(key => typeof value[key] === 'string') || !/^[A-Z]{3}$/.test(String(value.currency)) || !Array.isArray(value.styles) || value.styles.length > 500) throw new Error('Invalid range plan.');
  const ids = new Set<string>();
  for (const style of value.styles) {
    if (!record(style) || typeof style.id !== 'string' || !style.id || ids.has(style.id) || !['name', 'category', 'notes'].every(key => typeof style[key] === 'string') || !(style.patternId === null || typeof style.patternId === 'string') || !['idea', 'draft', 'sampling', 'approved', 'production'].includes(String(style.status)) || ['colorwayNames', 'sizes'].some(key => !Array.isArray(style[key]) || (style[key] as unknown[]).length > 100 || !(style[key] as unknown[]).every(value => typeof value === 'string')) || ['plannedUnits', 'targetUnitCost'].some(key => !(style[key] === null || typeof style[key] === 'number' && Number.isFinite(style[key]) && Number(style[key]) >= 0)) || style.plannedUnits !== null && !Number.isInteger(style.plannedUnits)) throw new Error('Invalid range style.');
    ids.add(style.id);
  }
}
