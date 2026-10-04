import { describe, expect, it, vi } from 'vitest';
import { createDocumentSaver } from './documentSave';

interface Document {
  id: string;
  content: { text: string };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const document = (id = 'a', text = 'initial'): Document => ({ id, content: { text } });

describe('document saving', () => {
  it('writes immutable snapshots in request order when manual save overlaps autosave', async () => {
    const firstWrite = deferred();
    const writes: Document[] = [];
    const saver = createDocumentSaver<Document>(async (snapshot) => {
      writes.push(snapshot);
      if (writes.length === 1) await firstWrite.promise;
    });
    const source = document();
    const autosave = saver.save(source, 1);
    source.content.text = 'new edit';
    const manualSave = saver.save(source, 2);
    source.content.text = 'unsaved edit';
    await Promise.resolve();
    expect(writes).toEqual([document()]);
    firstWrite.resolve();
    const oldReceipt = await autosave;
    const newReceipt = await manualSave;
    expect(writes).toEqual([document(), document('a', 'new edit')]);
    expect(oldReceipt.isCurrent('a', 2)).toBe(false);
    expect(newReceipt.isCurrent('a', 2)).toBe(true);
    expect(newReceipt.isCurrent('a', 3)).toBe(false);
  });

  it('does not mark edits during an in-flight write as saved', async () => {
    const inFlight = deferred();
    const saver = createDocumentSaver<Document>(() => inFlight.promise);
    let revision = 4;
    const save = saver.save(document(), revision);
    revision += 1;
    inFlight.resolve();
    expect((await save).isCurrent('a', revision)).toBe(false);
  });

  it('keeps document queues independent and receipts bound to the active document session', async () => {
    const inFlight = deferred();
    const saver = createDocumentSaver<Document>((snapshot) =>
      snapshot.id === 'a' ? inFlight.promise : Promise.resolve());
    const oldDocumentSave = saver.save(document('a'), 1);
    const otherReceipt = await saver.save(document('b'), 2);
    expect(otherReceipt.isCurrent('b', 2)).toBe(true);
    inFlight.resolve();
    const oldReceipt = await oldDocumentSave;
    expect(oldReceipt.isCurrent('b', 2)).toBe(false);
    // Switching back to the same document must advance the caller's revision too.
    expect(oldReceipt.isCurrent('a', 3)).toBe(false);
  });

  it('surfaces write failures and still attempts queued newer edits', async () => {
    const firstWrite = deferred();
    const write = vi.fn<(snapshot: Document) => Promise<void>>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(undefined);
    const saver = createDocumentSaver(write);
    const failedSave = saver.save(document(), 1);
    const failure = expect(failedSave).rejects.toThrow('disk full');
    const retry = saver.save(document('a', 'new edit'), 2);
    firstWrite.reject(new Error('disk full'));
    await failure;
    expect((await retry).isCurrent('a', 2)).toBe(true);
    expect(write.mock.calls.map(([snapshot]) => snapshot.content.text))
      .toEqual(['initial', 'new edit']);
  });

  it('rejects snapshot failures without blocking future saves', async () => {
    const write = vi.fn<(snapshot: Document) => Promise<void>>().mockResolvedValue(undefined);
    const saver = createDocumentSaver(write);
    const proxy = new Proxy(document(), {});
    await expect(saver.save(proxy, 1)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect((await saver.save(document(), 2)).isCurrent('a', 2)).toBe(true);
  });

  it('recovers when a writer throws before returning a promise', async () => {
    const write = vi.fn<(snapshot: Document) => Promise<void>>()
      .mockImplementationOnce(() => { throw new Error('storage unavailable'); })
      .mockResolvedValue(undefined);
    const saver = createDocumentSaver(write);
    const first = saver.save(document(), 1);
    const failure = expect(first).rejects.toThrow('storage unavailable');
    const second = saver.save(document('a', 'retry'), 2);
    await failure;
    expect((await second).isCurrent('a', 2)).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
