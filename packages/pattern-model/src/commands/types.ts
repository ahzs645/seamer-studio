// Command bus types — a unified, schema-described operation layer over the Pattern model.
//
// This mirrors the original studio's command registry (each op carries type/category/summary/inputs/
// example) so the same surface can drive the UI, keyboard shortcuts, a command palette, and external
// automation/agents — without coupling every edit to a Svelte component. Every command is a pure
// reducer (Pattern, params, ctx) => Pattern; the dispatcher wraps it with labeled undo.

import type {
  CommandContext as AtelierCommandContext,
  CommandDef as AtelierCommandDef,
  CommandResult
} from '@atelier/core';
import type { Pattern } from '../pattern';

/** Pattern-specific aliases keep command declarations terse while using Atelier's real bus types. */
export type CommandContext = AtelierCommandContext<Pattern>;
/**
 * Seamer exposes replay safety in its public command catalog. Atelier deliberately keeps its
 * generic command contract smaller, so this app-specific metadata remains on the pattern model.
 */
export type SeamerCommandDef = AtelierCommandDef<Pattern, Record<string, unknown>> & {
  replayable?: boolean;
};
export type CommandDef = SeamerCommandDef;
export type { CommandResult };
