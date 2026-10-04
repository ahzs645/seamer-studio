import { computeSourceFit, type SourceFitInput } from './sourceFitWorkerRuntime';
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; input: SourceFitInput }>) => void) | null;
  postMessage(value: unknown, transfers?: Transferable[]): void;
};
scope.onmessage = event => {
  const { id, input } = event.data;
  try { const vertices = computeSourceFit(input); scope.postMessage({ id, vertices }, [vertices.buffer]); }
  catch (error) { scope.postMessage({ id, error: error instanceof Error ? error.message : 'Source fitting failed.' }); }
};
