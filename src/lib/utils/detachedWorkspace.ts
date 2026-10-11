import type { Pattern } from '@seamer/pattern-model';
import { validateDocumentExtensions } from '@seamer/pattern-model';
export type DetachedPane = '2d' | '3d' | 'specs';
export type DetachedMessage =
  | { type: 'hello' | 'heartbeat' }
  | { type: 'state'; pattern: Pattern; revision: number; readonly: boolean }
  | { type: 'edit'; pattern: Pattern; revision: number; label?: string }
  | { type: 'undo' | 'redo'; revision: number }
  | { type: 'error'; message: string }
  | { type: 'closed' };
export function detachedEditProblem(current: Pattern, message: { pattern: Pattern; revision: number }, revision: number, readonly: boolean): string | null {
  if (readonly) return 'This document is read-only.';
  if (message.revision !== revision) return 'The main document changed. Retry after receiving the current state.';
  if (!message.pattern || message.pattern.id !== current.id) return 'Detached document identity cannot change.';
  if (!Array.isArray(message.pattern.pieces) || !Array.isArray(message.pattern.points) || !Array.isArray(message.pattern.paths)) return 'Invalid detached document.';
  try { validateDocumentExtensions(message.pattern); } catch { return 'Invalid detached document extension.'; }
  return null;
}
export function createDetachedWorkspace(options: {
  base?: string; pattern: () => Pattern; readonly: () => boolean;
  onchange: (pattern: Pattern, label?: string, pane?: DetachedPane) => void; onundo?: () => void; onredo?: () => void;
  onerror?: (message: string) => void; onwindowschange?: (count: number) => void;
}) {
  let revision = 0, signature = '';
  const windows = new Map<string, { window: Window; channel: BroadcastChannel }>();
  function state(channel: BroadcastChannel) { channel.postMessage({ type: 'state', pattern: options.pattern(), revision, readonly: options.readonly() } satisfies DetachedMessage); }
  function update() {
    const next = JSON.stringify({ pattern: options.pattern(), readonly: options.readonly() });
    if (next !== signature) { signature = next; ++revision; for (const item of windows.values()) state(item.channel); }
  }
  function open(pane: DetachedPane): boolean {
    if (typeof BroadcastChannel === 'undefined') { options.onerror?.('This browser does not support detached workspace windows.'); return false; }
    update();
    const room = crypto.randomUUID();
    const child = window.open(`${options.base ?? ''}/detached#${pane}/${room}`, `seamer-${room}`, 'popup,width=1100,height=800');
    if (!child) { options.onerror?.('The browser blocked the detached window. Allow popups for Seamer and try again.'); return false; }
    const channel = new BroadcastChannel(`seamer-detached-${room}`);
    windows.set(room, { window: child, channel }); options.onwindowschange?.(windows.size);
    channel.onmessage = (event: MessageEvent<DetachedMessage>) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      update();
      if (message.type === 'hello' || message.type === 'heartbeat') state(channel);
      if (message.type === 'edit') {
        const problem = detachedEditProblem(options.pattern(), message, revision, options.readonly());
        if (problem) channel.postMessage({ type: 'error', message: problem } satisfies DetachedMessage);
        else { try { options.onchange(message.pattern, message.label ?? 'Edit detached pane', pane); update(); } catch { channel.postMessage({ type: 'error', message: 'The main window rejected this edit.' } satisfies DetachedMessage); } }
        state(channel);
      }
      if (message.type === 'undo' || message.type === 'redo') {
        if (!options.readonly() && message.revision === revision) { if (message.type === 'undo') options.onundo?.(); else options.onredo?.(); update(); }
        state(channel);
      }
      if (message.type === 'closed') close(room);
    };
    return true;
  }
  function close(room: string) { windows.get(room)?.channel.close(); windows.delete(room); options.onwindowschange?.(windows.size); }
  const timer = setInterval(() => { for (const [room, item] of windows) if (item.window.closed) close(room); }, 1000);
  return { open, update, dispose() { clearInterval(timer); for (const item of windows.values()) { item.channel.postMessage({ type: 'closed' } satisfies DetachedMessage); item.channel.close(); } windows.clear(); } };
}
