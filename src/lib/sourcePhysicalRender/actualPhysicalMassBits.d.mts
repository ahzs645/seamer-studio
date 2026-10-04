/** Exact byte-hex decoder. It validates actual SI weights at runtime. */
export interface ActualPhysicalMassSource {
  particleCount: number;
  positions: Float32Array;
  sourcePhysicalMembrane?: {
    policy: {
      physicalInverseMassBitsFloat32: string;
    };
  };
}
export function actualPhysicalInverseMassBits(sim: ActualPhysicalMassSource): Uint32Array;
