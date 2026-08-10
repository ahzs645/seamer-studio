const PLANAR_EPSILON = 1e-6;
const MINIMUM_HEIGHT = 0.001;
const TILT_RADIANS = 0.001;

interface PieceBounds {
  indices: number[];
  hasFixedParticle: boolean;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

function createBounds(): PieceBounds {
  return {
    indices: [],
    hasFixedParticle: false,
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY
  };
}

/**
 * Match SeamScape's solver initialization for exactly vertical panels.
 *
 * An infinitesimal alternating tilt keeps a flat vertical piece from beginning in a perfectly
 * symmetric/degenerate plane. `positions2d.w` stores the particle's piece index in our packed
 * simulation data, equivalent to the source engine's `particlePieceIndices` array.
 */
export function applyInitialVerticalTilt(positions: Float32Array, positions2d: Float32Array): void {
  const particleCount = positions.length / 4;
  if (!Number.isInteger(particleCount) || positions2d.length !== positions.length) {
    throw new Error('Initial tilt requires matching packed vec4 position arrays.');
  }

  const pieces = new Map<number, PieceBounds>();
  for (let index = 0; index < particleCount; index++) {
    const offset = index * 4;
    const pieceIndex = positions2d[offset + 3];
    const bounds = pieces.get(pieceIndex) ?? createBounds();
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];

    bounds.indices.push(index);
    if (!bounds.hasFixedParticle) bounds.hasFixedParticle = positions[offset + 3] <= 0;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxZ = Math.max(bounds.maxZ, z);
    pieces.set(pieceIndex, bounds);
  }

  for (const [pieceIndex, bounds] of pieces) {
    const height = bounds.maxY - bounds.minY;
    if (bounds.hasFixedParticle || height < MINIMUM_HEIGHT) continue;

    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;
    const isXYPlane = depth <= PLANAR_EPSILON && width > PLANAR_EPSILON;
    const isYZPlane = width <= PLANAR_EPSILON && depth > PLANAR_EPSILON;
    if (!isXYPlane && !isYZPlane) continue;

    const angle = (pieceIndex % 2 === 0 ? 1 : -1) * TILT_RADIANS;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    if (isXYPlane) {
      const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
      for (const index of bounds.indices) {
        const offset = index * 4;
        const y = positions[offset + 1] - bounds.minY;
        const z = positions[offset + 2] - centerZ;
        positions[offset + 1] = bounds.minY + y * cosine - z * sine;
        positions[offset + 2] = centerZ + y * sine + z * cosine;
      }
    } else {
      const centerX = (bounds.minX + bounds.maxX) * 0.5;
      for (const index of bounds.indices) {
        const offset = index * 4;
        const x = positions[offset] - centerX;
        const y = positions[offset + 1] - bounds.minY;
        positions[offset] = centerX + x * cosine - y * sine;
        positions[offset + 1] = bounds.minY + x * sine + y * cosine;
      }
    }
  }
}
