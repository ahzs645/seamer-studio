export interface SaveReceipt {
  documentId: string;
  revision: number;
  /** The caller must advance its revision on edits and document switches. */
  isCurrent(documentId: string, revision: number): boolean;
}

/**
 * Capture each requested write immediately, then write revisions of one document in order.
 * Documents have independent queues so a slow save cannot block another open document.
 * Pass a plain snapshot (e.g. $state.snapshot in Svelte), rather than a reactive proxy.
 */
export function createDocumentSaver<T extends { id: string }>(
  write: (document: T) => Promise<void>
): { save(document: T, revision: number): Promise<SaveReceipt> } {
  const pending = new Map<string, Promise<void>>();

  return {
    async save(document, revision) {
      // Clone before waiting for an earlier write; later edits cannot mutate queued data.
      const snapshot = structuredClone(document);
      const documentId = snapshot.id;
      const previous = pending.get(documentId) ?? Promise.resolve();
      const operation = previous.then(() => write(snapshot));
      // Keep rejection recovery on the queue, while returning the real failure to the caller.
      const tail = operation.then(() => {}, () => {});
      pending.set(documentId, tail);
      void tail.then(() => {
        if (pending.get(documentId) === tail) pending.delete(documentId);
      });

      await operation;
      return {
        documentId,
        revision,
        isCurrent: (activeId, activeRevision) =>
          activeId === documentId && activeRevision === revision
      };
    }
  };
}
