import { describe, expect, it } from 'vitest';
import { Selection } from '@atelier/core';
import { EMPTY_PATTERN, type Pattern } from '@seamer/pattern-model';
import { contextualSelection } from './contextualSelection';

function fixture(): Pattern {
  return {
    ...structuredClone(EMPTY_PATTERN),
    points: [{ id: 'a', name: 'A', x: 0, y: 0 }, { id: 'b', name: 'B', x: 20, y: 0 }],
    seams: [{ id: 'seam', name: '', fromPaths: [], toPaths: [] }]
  };
}

describe('contextual selection eligibility', () => {
  it('does not offer mutation when selection combines supported and unsupported kinds', () => {
    const pattern = fixture();
    for (const selection of [
      Selection.of([['point', ['a']], ['seam', ['seam']]]),
      Selection.of([['point', ['a']], ['text', ['label']]])
    ]) {
      expect(contextualSelection(pattern, selection)).toMatchObject({ kind: 'mixed', count: 2, canMutate: false });
    }
    expect(contextualSelection(pattern, Selection.of([['text', ['label']]]))).toMatchObject({ kind: 'unsupported', canMutate: false });
  });

  it('rejects the entire stale selection instead of mutating only its surviving records', () => {
    const pattern = fixture();
    const selection = Selection.of([['point', ['a', 'missing']]]);
    expect(contextualSelection(pattern, selection)).toMatchObject({ kind: 'point', count: 2, canMutate: false });
    expect(contextualSelection(pattern, selection.remove('point', 'missing'))).toMatchObject({ canMutate: true });
    expect(contextualSelection(pattern, Selection.of([['seam', ['seam']]]))).toMatchObject({ kind: 'seam', ids: ['seam'], canMutate: true });
    expect(contextualSelection(pattern, Selection.empty())).toBeNull();
  });
});
