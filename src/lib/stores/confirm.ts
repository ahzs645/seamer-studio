import { writable } from 'svelte/store';

export interface ConfirmOpts {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
interface ConfirmState extends ConfirmOpts {
  resolve: (value: boolean) => void;
}

export const confirmState = writable<ConfirmState | null>(null);

/** Show a confirmation dialog; resolves true if confirmed, false if cancelled. */
export function confirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => confirmState.set({ ...opts, resolve }));
}

export function resolveConfirm(value: boolean) {
  confirmState.update((s) => { s?.resolve(value); return null; });
}
