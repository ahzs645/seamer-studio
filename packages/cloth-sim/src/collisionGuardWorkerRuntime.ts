import { ClothCollisionGuard } from './collisionGuard';
import { collisionGuardActivationBinding, collisionGuardWorkerBinding, type CollisionGuardWorkerRequest, type CollisionGuardWorkerResponse } from './collisionGuardWorkerProtocol';

/** One immutable body/topology per isolate, with one persistent static body BVH. */
export function createCollisionGuardWorkerHandler(post: (response: CollisionGuardWorkerResponse) => void) {
  let guard: ClothCollisionGuard | null = null, token = '', binding = '', initializing = false;
  return async (request: CollisionGuardWorkerRequest): Promise<void> => {
    try {
      if (request.kind === 'init') {
        if (guard || initializing) throw new Error('Collision verification worker was initialized twice.');
        initializing = true;
        const actual = await collisionGuardWorkerBinding(request.input, request.options);
        if (actual !== request.binding) throw new Error('Collision verification body/topology binding mismatch.');
        guard = new ClothCollisionGuard(request.input, request.options);
        token = request.token; binding = actual;
        post({ kind: 'ready', token, binding, requestId: request.requestId });
        return;
      }
      if (!guard || request.token !== token || request.binding !== binding) {
        throw new Error('Collision verification worker received a stale body/topology request.');
      }
      const activation = request.activation && { ...request.activation, activeSeams: request.activation.activeSeams.slice() };
      const activationBinding = activation ? await collisionGuardActivationBinding(activation) : undefined;
      if (activationBinding !== request.activationBinding || request.activationRevision !== request.activation?.revision) {
        throw new Error('Collision verification sewing activation binding mismatch.');
      }
      const report = guard.inspectTrajectory(request.final, request.previous, request.trajectory, request.expectedSubSteps, activation);
      post({ kind: 'report', token, binding, requestId: request.requestId, report,
        activationBinding, activationRevision: request.activation?.revision });
    } catch (error) {
      post({ kind: 'error', token: request.token, binding: request.binding, requestId: request.requestId,
        message: error instanceof Error ? error.message : 'Collision verification worker failed.' });
    }
  };
}
