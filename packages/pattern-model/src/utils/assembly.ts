// Resolving a pattern's sewing order.
//
// A pattern need not define an assembly: most don't, and the ones that do rarely name every seam.
// Both cases have to produce a complete, deterministic order, because the assembly timeline records
// against it and a seam left out of the order would simply never close.

import type { Assembly, AssemblyStep, Pattern, Seam } from '../pattern';

export interface ResolvedAssemblyStep {
  id: string;
  label: string;
  /** Seam ids in stitching order. Every id resolves to a seam in the pattern. */
  seamIds: string[];
  /** Frames to hold after this step's stitches close. */
  settleFrames: number;
  /** True when this step was synthesised for seams the assembly never named. */
  implicit: boolean;
}

export const DEFAULT_SETTLE_FRAMES = 12;

/**
 * The full sewing order: the assembly's own steps first (dropping ids that no longer resolve, so a
 * deleted seam can't strand the timeline), then one implicit step carrying every seam the assembly
 * didn't mention, in `pattern.seams` order.
 *
 * A pattern with no assembly at all therefore yields exactly one step containing every seam — which
 * is what makes "record the timeline" meaningful on patterns nobody has ordered by hand.
 */
export function resolveAssembly(pattern: Pattern): ResolvedAssemblyStep[] {
  const bySeamId = new Map<string, Seam>(pattern.seams.map((seam) => [seam.id, seam]));
  const assembly: Assembly | undefined = pattern.assembly;
  const fallbackSettle = assembly?.settleFrames ?? DEFAULT_SETTLE_FRAMES;
  const claimed = new Set<string>();
  const steps: ResolvedAssemblyStep[] = [];

  for (const step of assembly?.steps ?? []) {
    const seamIds = step.seamIds.filter((id) => bySeamId.has(id) && !claimed.has(id));
    for (const id of seamIds) claimed.add(id);
    if (seamIds.length === 0) continue;
    steps.push({
      id: step.id,
      label: step.label || describeStep(step, bySeamId),
      seamIds,
      settleFrames: step.settleFrames ?? fallbackSettle,
      implicit: false
    });
  }

  const remaining = pattern.seams.filter((seam) => !claimed.has(seam.id)).map((seam) => seam.id);
  if (remaining.length > 0) {
    steps.push({
      id: 'assembly-remaining',
      label: steps.length === 0 ? 'Sew the garment' : 'Remaining seams',
      seamIds: remaining,
      settleFrames: fallbackSettle,
      implicit: true
    });
  }
  return steps;
}

function describeStep(step: AssemblyStep, bySeamId: Map<string, Seam>): string {
  const names = step.seamIds.map((id) => bySeamId.get(id)?.name).filter(Boolean);
  if (names.length === 0) return 'Sew';
  if (names.length === 1) return `Sew ${names[0]}`;
  return `Sew ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Build an assembly that sews `seamIds` one seam per step, in the order given. */
export function assemblyFromSeamOrder(
  seams: { id: string; name: string }[],
  options: { settleFrames?: number; stitchesPerFrame?: number } = {}
): Assembly {
  return {
    steps: seams.map((seam, index) => ({
      id: `step-${index + 1}-${seam.id}`,
      label: seam.name || `Seam ${index + 1}`,
      seamIds: [seam.id]
    })),
    settleFrames: options.settleFrames,
    stitchesPerFrame: options.stitchesPerFrame
  };
}
