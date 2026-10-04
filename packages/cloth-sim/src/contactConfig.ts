import type { Pattern } from '@seamer/pattern-model';
import { activeGarmentCodeBody } from '@seamer/avatar';
import { SIM_CONFIG, type SimConfig } from './config';

/** Original general-purpose padding. Keep this immutable if SIM_CONFIG is edited by a user. */
const ORIGINAL_PADDING_METERS = .005;
const SOURCE_MARGIN_METERS = .0005;
/** Source shoulder joins need additional Jacobi convergence before supports release. */
const SOURCE_SEAM_ITERATIONS = 8;
/** Two passes reduced 535 body-facet occurrences to one; four is the controlled next target. */
const SOURCE_SUBSTEP_CONTACT_ITERATIONS = 4;
export type ContactPaddingField = 'simulationThickness' | 'edgeThickness';
export type SourceStretchSewingMode = 'sequential' | 'interleaved';
export interface SourceContactConfigOptions {
  /** Optional numerical experiment; production keeps the original sequential dispatch order. */
  sourceStretchSewingMode?: SourceStretchSewingMode;
  /** Preserve deliberate settings even when they happen to equal the original default. */
  explicitPadding?: Partial<Record<ContactPaddingField, boolean>>;
  /** Preserve an intentional single finishing pass rather than selecting source thin-cloth defaults. */
  explicitFinalContactIterations?: boolean;
  /** Preserve deliberate every-substep convergence, including an intentional single pass. */
  explicitSubstepContactIterations?: boolean;
  /** Preserve a deliberately selected single source sewing iteration. */
  explicitSeamIterations?: boolean;
}
export interface SourceContactPolicy {
  policy: 'source-material-thickness-v1' | 'unchanged';
  reason: 'material-aware' | 'not-active-source' | 'invalid-thickness' | 'no-active-cloth';
  materialIds: string[];
  maximumMaterialThicknessMm?: number;
  automaticPaddingMeters?: number;
  /** Recomputed from the actual resolved body clearance when current options are applied. */
  automaticFinalContactIterations?: number;
  automaticSubstepContactIterations?: number;
  preservedExplicitSubstepContactIterations?: boolean;
  preservedExplicitFinalContactIterations?: boolean;
  /** Source assembly target; independent of material thickness and contact padding. */
  automaticSeamIterations?: number;
  preservedExplicitSeamIterations?: boolean;
  /** Explicit overrides are preserved; they do not imply the automatic envelope is satisfied. */
  preservedExplicitPadding: ContactPaddingField[];
}
export interface SourceContactConfigResolution { config: SimConfig; contactPolicy: SourceContactPolicy }

/** Validated source/body provenance; independent of any material/contact envelope. */
export function isActiveMeasuredGarmentCodeSource(pattern: Pattern): boolean {
  const source = pattern.garmentCodeSource;
  if (!source || source.format !== 'garmentcode-json' || !Number.isFinite(source.unitsInMeter) || source.unitsInMeter <= 0
    || !source.properties || typeof source.properties !== 'object' || Array.isArray(source.properties)
    || !Array.isArray(source.panelNames) || !source.panelNames.length || !source.panelNames.every(name => typeof name === 'string' && name.length > 0)) return false;
  try { return !!activeGarmentCodeBody(pattern.body); } catch { return false; }
}

/**
 * Automatic contact envelopes for measured source garments only. General-purpose native
 * padding and deliberate solver overrides retain their exact values. Used physical material
 * thickness and an enabled visual shell both count; unrelated library materials do not.
 * A missing/invalid thickness leaves the original config intact rather than guessing zero.
 */
export function inferSourceContactPolicy(pattern: Pattern): SourceContactPolicy {
  const unchanged = (reason: SourceContactPolicy['reason'], materialIds: string[] = []): SourceContactPolicy => ({
    policy: 'unchanged', reason, materialIds, preservedExplicitPadding: []
  });
  if (!isActiveMeasuredGarmentCodeSource(pattern)) return unchanged('not-active-source');
  // Match prepareCloth's actual eligible pieces. Hidden pieces still participate in
  // physics and can become visible again, so their physical envelope remains valid.
  const materialIds = [...new Set(pattern.pieces.filter(piece => piece.type === 'dynamic' && piece.settings3d?.enable3d !== false).map(piece => piece.materialId))];
  if (!materialIds.length) return unchanged('no-active-cloth');
  const materials = new Map(pattern.materials.map(material => [material.id, material]));
  let maximumMaterialThicknessMm = 0;
  for (const id of materialIds) {
    const material = materials.get(id);
    if (!material || typeof material.thickness !== 'number' || !Number.isFinite(material.thickness) || material.thickness < 0) return unchanged('invalid-thickness', materialIds);
    const visual = material.visualizationThickness;
    if (visual !== undefined && (typeof visual !== 'number' || !Number.isFinite(visual) || visual < 0)) return unchanged('invalid-thickness', materialIds);
    maximumMaterialThicknessMm = Math.max(maximumMaterialThicknessMm, material.thickness, visual ?? 0);
  }
  const automaticPaddingMeters = Math.max(SOURCE_MARGIN_METERS, (maximumMaterialThicknessMm + SOURCE_MARGIN_METERS * 1000) / 1000);
  return { policy: 'source-material-thickness-v1', reason: 'material-aware', materialIds, maximumMaterialThicknessMm,
    automaticPaddingMeters, automaticFinalContactIterations: automaticPaddingMeters < ORIGINAL_PADDING_METERS ? 4 : 1, preservedExplicitPadding: [], preservedExplicitFinalContactIterations: false, automaticSeamIterations: SOURCE_SEAM_ITERATIONS, preservedExplicitSeamIterations: false, automaticSubstepContactIterations: SOURCE_SUBSTEP_CONTACT_ITERATIONS, preservedExplicitSubstepContactIterations: false };
}

/**
 * Apply a prepared material target to the CURRENT solver config. Preparing geometry
 * must not freeze user collision flags, timestep, gravity or other live options.
 */
export function applySourceContactPolicy(config: SimConfig, policy: SourceContactPolicy, options: SourceContactConfigOptions = {}): SourceContactConfigResolution {
  if (policy.policy === 'unchanged') return { config, contactPolicy: { ...policy, preservedExplicitPadding: [] } };
  const target = policy.automaticPaddingMeters;
  if (typeof target !== 'number' || !Number.isFinite(target) || target < SOURCE_MARGIN_METERS) return {
    config, contactPolicy: { policy: 'unchanged', reason: 'invalid-thickness', materialIds: [...policy.materialIds], preservedExplicitPadding: [] }
  };
  const effective = { ...config }, preservedExplicitPadding: ContactPaddingField[] = [];
  for (const field of ['simulationThickness', 'edgeThickness'] as const) {
    if (options.explicitPadding?.[field] || config[field] !== ORIGINAL_PADDING_METERS) preservedExplicitPadding.push(field);
    else effective[field] = target;
  }
  const automaticFinalContactIterations = effective.simulationThickness < ORIGINAL_PADDING_METERS ? 4 : 1;
  const preservedExplicitFinalContactIterations = !!options.explicitFinalContactIterations || (config.finalContactIterations ?? 1) !== 1;
  if (automaticFinalContactIterations === 4 && !preservedExplicitFinalContactIterations) effective.finalContactIterations = 4;
  const automaticSubstepContactIterations = SOURCE_SUBSTEP_CONTACT_ITERATIONS;
  const preservedExplicitSubstepContactIterations = !!options.explicitSubstepContactIterations || (config.substepContactIterations ?? 1) !== 1;
  if (!preservedExplicitSubstepContactIterations) effective.substepContactIterations = automaticSubstepContactIterations;
  // Source sewing uses correctly weighted Jacobi iterations. Its convergence
  // target is independent of fabric thickness, body clearance and finishing passes.
  const automaticSeamIterations = SOURCE_SEAM_ITERATIONS;
  const preservedExplicitSeamIterations = !!options.explicitSeamIterations || config.seamIterations !== 1;
  if (!preservedExplicitSeamIterations) effective.seamIterations = automaticSeamIterations;
  // maxSurfaceCorrection is an independent recovery bound. Material clearance must
  // never lower that bound, nor does this policy modify the base solver timestep.
  return {
    config: effective.simulationThickness === config.simulationThickness && effective.edgeThickness === config.edgeThickness && effective.finalContactIterations === config.finalContactIterations && effective.seamIterations === config.seamIterations && effective.substepContactIterations === config.substepContactIterations ? config : effective,
    contactPolicy: { ...policy, materialIds: [...policy.materialIds], preservedExplicitPadding, automaticFinalContactIterations, preservedExplicitFinalContactIterations, automaticSeamIterations, preservedExplicitSeamIterations, automaticSubstepContactIterations, preservedExplicitSubstepContactIterations }
  };
}

/** Resolve immediately when Pattern and current config are both available. */
export function resolveSourceContactConfig(pattern: Pattern, config: SimConfig = SIM_CONFIG, options: SourceContactConfigOptions = {}): SourceContactConfigResolution {
  return applySourceContactPolicy(config, inferSourceContactPolicy(pattern), options);
}

/** Convenience for callers that do not need benchmark/configuration provenance. */
export function sourceContactConfig(pattern: Pattern, config: SimConfig = SIM_CONFIG, options: SourceContactConfigOptions = {}): SimConfig {
  return resolveSourceContactConfig(pattern, config, options).config;
}
