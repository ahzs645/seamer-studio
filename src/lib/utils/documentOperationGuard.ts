interface DocumentAdmission {
  identity: object;
  fingerprint: string;
  context: string;
  blocked: boolean;
}
/** An asynchronous local open may commit only to the unchanged document that requested it. */
export function createDocumentOperationGuard(read: () => DocumentAdmission) {
  let generation = 0;
  return {
    invalidate() { ++generation; },
    begin() {
      const ticket = ++generation;
      const captureCurrent = () => {
        const captured = { ...read() };
        return () => {
          const current = read();
          return ticket === generation && !current.blocked && current.identity === captured.identity
            && current.fingerprint === captured.fingerprint && current.context === captured.context;
        };
      };
      return { isCurrent: captureCurrent(), captureCurrent };
    }
  };
}
