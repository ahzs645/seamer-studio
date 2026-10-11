import { describe, expect, it } from 'vitest';
import { createEmptyPattern } from '@seamer/pattern-model';
import { detachedEditProblem } from './detachedWorkspace';
const createPattern = (name: string) => ({ ...createEmptyPattern(), name });
describe('detached canonical document guard', () => {
  it('rejects stale edits, read-only roles, changed identities and malformed artwork without mutation', () => {
    const pattern = createPattern('Canonical'); const initial = JSON.stringify(pattern);
    expect(detachedEditProblem(pattern, { pattern, revision: 4 }, 4, false)).toBeNull();
    expect(detachedEditProblem(pattern, { pattern, revision: 3 }, 4, false)).toContain('changed');
    expect(detachedEditProblem(pattern, { pattern, revision: 4 }, 4, true)).toContain('read-only');
    expect(detachedEditProblem(pattern, { pattern: { ...pattern, id: 'different' }, revision: 4 }, 4, false)).toContain('identity');
    expect(detachedEditProblem(pattern, { pattern: { ...pattern, artwork: [{ id: 'invalid' }] } as never, revision: 4 }, 4, false)).toContain('extension');
    expect(JSON.stringify(pattern)).toBe(initial);
  });
});
