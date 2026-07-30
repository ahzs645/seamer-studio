import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  SolveWorkerClientMessage,
  SolveWorkerServerMessage
} from '@atelier/sim';
import type { MarkerLayout, NestItem } from './markerLayout';
import type { NestProgress, NestSolveQuery } from './nestingProtocol';

const originalWorker = globalThis.Worker;

const layout: MarkerLayout = {
  fabricWidthMm: 100,
  usedLengthMm: 42,
  gapMm: 2,
  placements: [],
  efficiency: 0
};

class FakeNestingWorker {
  static instances: FakeNestingWorker[] = [];

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor() {
    FakeNestingWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    const typed = message as SolveWorkerClientMessage<void, NestSolveQuery>;
    if (typed.type === 'prepare') {
      queueMicrotask(() => this.send({ type: 'ready' }));
      return;
    }
    if (typed.type !== 'solve') return;
    const progress: NestProgress = {
      generation: 0,
      generations: typed.query.options.generations,
      bestLengthMm: 42,
      efficiency: 0.5
    };
    queueMicrotask(() => this.send({
      type: 'progress',
      requestId: typed.requestId,
      progress
    }));
    setTimeout(() => this.send({
      type: 'result',
      requestId: typed.requestId,
      result: layout
    }), 5);
  }

  terminate(): void {
    this.terminated = true;
  }

  private send(message: SolveWorkerServerMessage<MarkerLayout, NestProgress>): void {
    if (this.terminated) return;
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

const items: NestItem[] = [{
  pieceId: 'piece',
  name: 'Piece',
  cut: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  instanceId: 'piece#0',
  area: 100
}];

beforeAll(() => {
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: FakeNestingWorker
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: originalWorker
  });
});

describe('nesting solve-host client', () => {
  it('rejects an older request when a newer solve supersedes it', async () => {
    const { nestItemsInWorker } = await import('./nestingClient');
    const first = nestItemsInWorker(items, { generations: 2, seed: 1 });
    const second = nestItemsInWorker(items, { generations: 2, seed: 2 });

    await expect(first.promise).rejects.toThrow('cancelled');
    await expect(second.promise).resolves.toEqual(layout);
  });

  it('aborts and terminates an active worker after streamed progress', async () => {
    const { nestItemsInWorker } = await import('./nestingClient');
    let cancel = (): void => undefined;
    const job = nestItemsInWorker(items, { generations: 2 }, () => cancel());
    cancel = job.cancel;

    await expect(job.promise).rejects.toThrow('cancelled');
    expect(FakeNestingWorker.instances.some((worker) => worker.terminated)).toBe(true);
  });
});
