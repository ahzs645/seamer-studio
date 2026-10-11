import { describe, expect, it } from 'vitest';
import { CollaborationPause } from './collaborationPause';
describe('collaboration admission while observing a frozen document', () => {
  it('holds multiple successful in-flight responses until thaw, without acknowledging a revision', async () => {
    const gate = new CollaborationPause(); gate.setPaused(true);
    let revision = 1;
    const pending = Promise.resolve(2).then(async (value) => { await gate.wait(); revision = value; });
    const other = gate.wait();
    await Promise.resolve(); await Promise.resolve(); expect(revision).toBe(1);
    gate.setPaused(false); await Promise.all([pending, other]); expect(revision).toBe(2);
  });
  it('rejects held results on disposal rather than leaking a pending request', async () => {
    const gate = new CollaborationPause(); gate.setPaused(true);
    const pending = gate.wait(); const rejected = expect(pending).rejects.toThrow('closed');
    gate.dispose(); await rejected;
  });
});
