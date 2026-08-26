/// <reference types="@webgpu/types" />

import {
  requestDevice,
  type SolverHandle,
  type SolverPlugin
} from '@atelier/sim';
import { ClothSimulation, type PreparedCloth } from './simulator';

export * from './config';
export * from './build';
export * from './simulator';
export * from './refit';
export * from './cylinderRefit';
export * from './geometry/boundary';
export * from './geometry/arrangement';
export * from './geometry/cylinders';
export * from './preparedGarment';

export interface ClothSolverState {
  readonly positions: Float32Array;
}

class ClothSolverHandle implements SolverHandle<ClothSolverState> {
  readonly #simulation: ClothSimulation;

  constructor(simulation: ClothSimulation) {
    this.#simulation = simulation;
  }

  async step(_dt: number): Promise<void> {
    // XPBD owns its fixed substep count and timestep in SIM_CONFIG. SolverRunner's
    // frame dt is intentionally not threaded into the WGSL uniforms.
    await this.#simulation.step();
  }

  read(out?: Float32Array): Float32Array {
    const positions = this.#simulation.positions;
    if (!out || out.length !== positions.length) return positions.slice();
    out.set(positions);
    return out;
  }

  state(): ClothSolverState {
    return { positions: this.#simulation.positions };
  }

  reset(): void {
    this.#simulation.resetToSaved();
  }

  dispose(): void {
    this.#simulation.dispose();
  }
}

/** WebGPU XPBD plugin for Atelier's lifecycle/loop host. */
export const clothSolverPlugin: SolverPlugin<PreparedCloth, ClothSolverState> = {
  id: 'seamer.xpbd-cloth',
  backend: 'webgpu',
  async build(input, context) {
    const device = context.device ?? await requestDevice();
    if (!device) throw new Error('WebGPU is unavailable');
    return new ClothSolverHandle(new ClothSimulation(device, input));
  }
};
