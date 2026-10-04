import type { Body } from '@seamer/pattern-model';
/** Body documents are plain serializable records, sometimes wrapped in reactive proxies.
 * Copy enumerable values synchronously without JSON number normalization (including -0). */
export function snapshotAvatarBody(body: Body): Body {
  const seen = new Map<object, unknown>();
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    for (const key of Object.keys(value)) Object.defineProperty(result, key, {
      value: copy((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true
    });
    return result;
  };
  return copy(body) as Body;
}
