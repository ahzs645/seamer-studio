// Worker endpoint for Atelier's steady-solver protocol. The main thread uses terminate-mode
// cancellation because nestSearch is intentionally synchronous inside this isolated worker.

import {
  serveSteadySolverPlugin,
  type SolveWorkerScope,
  type SteadySolverPlugin
} from '@atelier/sim';
import {
  solveNestQuery,
  type NestProgress,
  type NestSolveQuery
} from '../utils/nestingProtocol';
import type { MarkerLayout } from '../utils/markerLayout';

const plugin: SteadySolverPlugin<void, NestSolveQuery, MarkerLayout, NestProgress> = {
  id: 'seamer.ga-nesting',
  backend: 'cpu',
  prepare: async () => ({
    solve: async (query, options = {}) => {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      }
      const layout = solveNestQuery(query, options.onProgress);
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      }
      return layout;
    },
    dispose: () => undefined
  })
};

serveSteadySolverPlugin(
  self as unknown as SolveWorkerScope,
  plugin
);
