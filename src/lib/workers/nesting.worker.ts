// Nesting Web Worker: runs the true-shape / NFP genetic nest off the main thread, streaming
// per-generation progress. Terminated by the client to cancel.

import { nestCore, type CoreItem, type CoreOptions } from '../utils/nestCore';

export interface NestWorkerRequest {
  items: CoreItem[];
  options: CoreOptions;
}

self.onmessage = (e: MessageEvent<NestWorkerRequest>) => {
  const { items, options } = e.data;
  try {
    const layout = nestCore(items, options, (p) => self.postMessage({ type: 'progress', ...p }));
    self.postMessage({ type: 'done', layout });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
