import type { Selection } from '@atelier/core';
import type { Pattern } from '@seamer/pattern-model';

export type ContextualSelectionKind = 'piece' | 'path' | 'point' | 'seam' | 'mixed' | 'unsupported';
export interface ContextualSelection {
  kind: ContextualSelectionKind;
  count: number;
  ids: string[];
  label: string;
  canMutate: boolean;
}

/** Context actions require one supported kind and every selected ID to still exist. */
export function contextualSelection(pattern: Pattern, selection: Selection): ContextualSelection | null {
  if (!selection.size) return null;
  const kinds = selection.kinds();
  if (kinds.length !== 1) {
    return { kind: 'mixed', count: selection.size, ids: [], label: `${selection.size} items selected`, canMutate: false };
  }
  const kind = kinds[0];
  if (kind !== 'piece' && kind !== 'path' && kind !== 'point' && kind !== 'seam') {
    return { kind: 'unsupported', count: selection.size, ids: [], label: `${selection.size} items selected`, canMutate: false };
  }
  const ids = [...selection.get(kind)];
  const records = kind === 'piece' ? pattern.pieces : kind === 'path' ? pattern.paths : kind === 'point' ? pattern.points : pattern.seams;
  const existing = new Set(records.map(record => record.id));
  return {
    kind, count: ids.length, ids,
    label: `${ids.length} ${kind}${ids.length === 1 ? '' : 's'} selected`,
    canMutate: ids.every(id => existing.has(id))
  };
}
