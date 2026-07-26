// Command bus types — a unified, schema-described operation layer over the Pattern model.
//
// This mirrors the original studio's command registry (each op carries type/category/summary/inputs/
// example) so the same surface can drive the UI, keyboard shortcuts, a command palette, and external
// automation/agents — without coupling every edit to a Svelte component. Every command is a pure
// reducer (Pattern, params, ctx) => Pattern; the dispatcher wraps it with labeled undo.

import type { Pattern } from '@seamer/pattern-model';
import type { Selection } from './selection';

export interface CommandContext {
  /** The current editor selection, for commands that act on "the selection". */
  selection: Selection;
  /** Stable id generator matching the app convention `${prefix}_${rand}`. */
  uid: (prefix: string) => string;
}

export interface CommandDef {
  /** Dotted command id, e.g. "selection.rotate". */
  type: string;
  /** Grouping for the palette / docs, e.g. "selection". */
  category: string;
  /** One-line human description (shown in the palette and agent schema). */
  summary: string;
  /** Ordered parameter descriptors, e.g. ["degrees", "about?"]. `?` marks optional. */
  inputs: string[];
  /** A minimal example params object for docs / agents. */
  example?: Record<string, unknown>;
  /** False for read-only/no-op-safe commands; true (default) records undo. */
  mutating?: boolean;
  /** Human label used for the undo entry (falls back to summary). */
  label?: string;
  /** Pure reducer. Return the input unchanged to signal "nothing happened" (no undo recorded). */
  run: (pattern: Pattern, params: Record<string, unknown>, ctx: CommandContext) => Pattern;
}

export interface CommandResult {
  ok: boolean;
  changed: boolean;
  error?: string;
}

/** Default uid generator (matches `uid()` used across the studio components). */
export const makeUid = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
