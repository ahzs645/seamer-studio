/** Unwrap reactive document proxies before returning an isolated public snapshot. */
export function automationSnapshot<T>(value: T): T {
  return structuredClone($state.snapshot(value)) as T;
}
