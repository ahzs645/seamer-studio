import { writable } from 'svelte/store';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

export const toasts = writable<Toast[]>([]);

let nextId = 1;

/** Show a transient toast (auto-dismisses). */
export function toast(message: string, kind: Toast['kind'] = 'info', ms = 2600) {
  const id = nextId++;
  toasts.update((list) => [...list, { id, message, kind }]);
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}
export const toastSuccess = (m: string, ms?: number) => toast(m, 'success', ms);
export const toastError = (m: string, ms?: number) => toast(m, 'error', ms ?? 4000);

export function dismissToast(id: number) {
  toasts.update((list) => list.filter((t) => t.id !== id));
}
