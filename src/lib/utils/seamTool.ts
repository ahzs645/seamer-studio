// Shared seam-tool state machine, driven by BOTH the 2D canvas (edge clicks) and the 3D viewport
// (clicks on the draped garment — the original's handleSeamPointerDown). The state lives in a store
// (stores/pattern.ts: seamTool) so the two views stay in sync mid-selection.

export interface SeamPick {
  id: string; // PiecePath id
  reversed: boolean; // click-position inferred orientation (nearer the path end ⇒ true)
  mirrored: boolean; // the mirrored half was picked
}

export interface SeamToolState {
  from: SeamPick[];
  to: SeamPick[];
  /** multi tool: which side clicks are filling ('from' until Enter/Next) */
  phase: 'from' | 'to';
}

export const EMPTY_SEAM_TOOL: SeamToolState = { from: [], to: [], phase: 'from' };

export const samePick = (a: SeamPick, b: SeamPick) => a.id === b.id && a.mirrored === b.mirrored;

export interface SeamPickResult {
  state: SeamToolState;
  /** set when the pick completes a seam — the caller commits it to the pattern */
  commit?: { from: SeamPick[]; to: SeamPick[] };
  /** user feedback for phase changes */
  message?: string;
}

/** Route one edge pick through the tool. Single-seam: first pick = from, second = commit.
 *  Multi-seam: toggle the pick in the active phase's list. */
export function applySeamPick(kind: 'single' | 'multi', s: SeamToolState, pick: SeamPick): SeamPickResult {
  if (kind === 'single') {
    if (s.from.length === 0) return { state: { ...EMPTY_SEAM_TOOL, from: [pick] } };
    if (samePick(s.from[0], pick)) return { state: EMPTY_SEAM_TOOL }; // click again -> deselect
    return { state: EMPTY_SEAM_TOOL, commit: { from: s.from, to: [pick] } };
  }
  if (s.phase === 'from') {
    const i = s.from.findIndex((r) => samePick(r, pick));
    const from = i >= 0 ? s.from.filter((_, k) => k !== i) : [...s.from, pick];
    return { state: { ...s, from } };
  }
  if (s.from.some((r) => samePick(r, pick))) return { state: s }; // already on the from side
  const i = s.to.findIndex((r) => samePick(r, pick));
  const to = i >= 0 ? s.to.filter((_, k) => k !== i) : [...s.to, pick];
  return { state: { ...s, to } };
}

/** Enter / Next / Finish for the multi tool. */
export function advanceSeamToolPhase(s: SeamToolState): SeamPickResult {
  if (s.phase === 'from') {
    if (s.from.length === 0) return { state: s };
    return {
      state: { ...s, phase: 'to' },
      message: 'Now selecting "to" seam segments. Press Enter or tap Finish when done.'
    };
  }
  if (s.from.length > 0 && s.to.length > 0) return { state: EMPTY_SEAM_TOOL, commit: { from: s.from, to: s.to } };
  return { state: EMPTY_SEAM_TOOL };
}
