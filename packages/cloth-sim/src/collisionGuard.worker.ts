import { createCollisionGuardWorkerHandler } from './collisionGuardWorkerRuntime';
import type { CollisionGuardWorkerRequest, CollisionGuardWorkerResponse } from './collisionGuardWorkerProtocol';

const scope = globalThis as unknown as {
  postMessage(response: CollisionGuardWorkerResponse): void;
  addEventListener(type: 'message', callback: (event: MessageEvent<CollisionGuardWorkerRequest>) => void): void;
};
const handle = createCollisionGuardWorkerHandler(response => scope.postMessage(response));
scope.addEventListener('message', event => { void handle(event.data); });
