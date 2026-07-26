// Cloth simulation constants and material -> XPBD compliance mappings, matching the original
// Seamer solver. Compliance is mapped log-linearly from the UI 0..100 scale.

export interface SimConfig {
  timeStep: number;
  subSteps: number;
  deltaT: number;
  gravity: [number, number, number];
  globalDamping: number; // shader uses (1 - globalDamping)
  localDamping: number; // rigid-body damping (original default 0 -> pass skipped)
  nearDamping: number; // 8-neighbour local rigid-body damping (original default 0.1)
  simulationThickness: number; // m
  edgeThickness: number; // m (self-collision edge contact)
  maxVelocity: number;
  minVelocity: number;
  seamStrength: number;
  selfCollisionFriction: number;
  externalCollisionFriction: number;
  handleSelfCollisions: boolean;
  handleExternalCollisions: boolean;
  useBending: boolean; // original "Use bending": dispatch the bending-constraint passes
  staticCollisionRadius: number; // m (cloth self-collision search radius)
  externalStaticCollisionRadius: number; // m (body)
  minDistance2d: number; // m (skip self-collision tris closer than this in 2D)
  clothSpacing: number; // m (internal spatial-hash cell size)
  externalHashSpacing: number; // m (body spatial-hash cell size; original getHashSpacingMeters = particleDistance/1000)
  numInternalCollisionConstraintsPerParticle: number;
  numExternalCollisionConstraintsPerParticle: number; // body tris gathered per particle (original 32)
  internalHashTableMultiplier: number;
  externalHashTableMultiplier: number; // body hash table size = mult * numBodyTris + 1 (original 5)
  // Substeps between self-collision near-triangle re-gathers. Original = subSteps (once/frame);
  // smaller re-gathers more often against current positions (stable when the cloth is moving).
  selfCollisionGatherInterval: number;
  // Seam constraint Gauss-Seidel iterations per substep. Original = 1; more closes weakly-linked
  // seams (e.g. the short waistband-centre join) faster so panels don't pull apart under a drag.
  seamIterations: number;
}

const timeStep = 0.016;
const subSteps = 40;

// Original ClothConfig.designParticleDistance = 10 (mm) -> these derived radii.
const designParticleDistance = 10; // mm

export const SIM_CONFIG: SimConfig = {
  timeStep,
  subSteps,
  deltaT: timeStep / subSteps, // 4e-4
  gravity: [0, -9.8, 0],
  globalDamping: 0,
  localDamping: 0, // original default: local (rigid-body) damping disabled
  nearDamping: 0.1, // original default: near-neighbour damping on
  simulationThickness: 0.005,
  edgeThickness: 0.005,
  maxVelocity: 1,
  minVelocity: 0.01,
  seamStrength: 1,
  selfCollisionFriction: 0.1,
  externalCollisionFriction: 0.3,
  // Self-collision is the original's GPU triangle-hash + edge/face contact port. It stays quiescent
  // at the cached drape (≈0 contacts there) and prevents panels passing through each other; the
  // waistband-curl artifact came not from self-collision itself but from the garment drifting off
  // the cached (source) equilibrium once the anchor was FULLY released. We now release the anchor
  // only locally around a grab (see the integrate shader), so non-grabbed regions stay on the good
  // drape and self-collision never curls them. Re-gathering contacts more often than once/frame was
  // measured to NOT reduce the curl and to cost ~9x, so we keep the original's once-per-frame gather.
  handleSelfCollisions: true,
  handleExternalCollisions: true,
  useBending: true,
  staticCollisionRadius: designParticleDistance / 1000, // 0.01 m
  externalStaticCollisionRadius: (designParticleDistance / 1000) * 2.5, // 0.025 m
  minDistance2d: (3 * designParticleDistance) / 1000, // 0.03 m
  clothSpacing: 0.02, // ClothConfig.spacing
  externalHashSpacing: designParticleDistance / 1000, // 0.01 m (original getHashSpacingMeters)
  numInternalCollisionConstraintsPerParticle: 16,
  numExternalCollisionConstraintsPerParticle: 32,
  internalHashTableMultiplier: 5,
  externalHashTableMultiplier: 5,
  selfCollisionGatherInterval: subSteps, // once per frame (matches original; re-gathering more was no better and ~9x slower)
  seamIterations: 1 // matches original (one seam Gauss-Seidel pass per substep); dense pairing makes the extra pass unnecessary
};

export const DISABLED_COMPLIANCE = 10; // seam-edge stretch override

/** seam correction clamp: (maxVelocity * deltaT)^2 * 4 */
export function seamMaxDisplacementSq(cfg: SimConfig): number {
  const d = cfg.maxVelocity * cfg.deltaT;
  return d * d * 4;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function interpolateLog(e: number, lo: number, hi: number): number {
  const t = clamp(e, 0, 1);
  return Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * t);
}

/** UI stretch value (0..100) -> XPBD compliance alpha in [0.01, 100]. */
export function stretchScaleToCompliance(scale: number): number {
  return interpolateLog(clamp(scale, 0, 100) / 100, 0.01, 100);
}

/** UI bend value (0..100) -> XPBD compliance alpha in [0.001, 10]. */
export function bendScaleToCompliance(value: number): number {
  return interpolateLog(clamp(value, 0, 100) / 100, 0.001, 10);
}

export function clampStretchAlpha(a: number): number {
  return clamp(a, 0.01, 100);
}

export function clampBendAlpha(a: number): number {
  return clamp(a, 0.001, 10);
}
