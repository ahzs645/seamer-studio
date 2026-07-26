// Command dispatcher + external automation API.
//
// executeCommand() runs a registered command against a supplied pattern and commits the result
// through an `apply(next, label)` callback (the studio wires this to its undo-aware update path, so
// the command bus never bypasses history or duplicates editor state). installCommandApi() exposes a
// stable `window.seamer` surface so external scripts / agents can drive the editor locally — no
// login, no network: the whole command registry runs in-page.

import type { Pattern } from '@seamer/pattern-model';
import type { Selection } from './selection';
import { COMMANDS, COMMAND_LIST } from './registry';
import { makeUid, type CommandResult, type CommandContext } from './types';

export interface ExecuteHost {
  /** Snapshot of the current pattern. */
  getPattern: () => Pattern;
  /** The current editor selection. */
  getSelection: () => Selection;
  /** Commit a new pattern with an undo label. No-op expected when next === current. */
  apply: (next: Pattern, label: string) => void;
}

export interface ExecuteOptions {
  /** evaluate the command without committing (the original's preview/dryRun) */
  dryRun?: boolean;
}

/** Run a command by type. Returns {ok, changed, error}; commits via host.apply when it changes
 *  (unless dryRun). */
export function executeCommand(host: ExecuteHost, type: string, params: Record<string, unknown> = {}, opts: ExecuteOptions = {}): CommandResult {
  const def = COMMANDS.get(type);
  if (!def) return { ok: false, changed: false, error: `Unknown command: ${type}` };
  const pattern = host.getPattern();
  const ctx: CommandContext = { selection: host.getSelection(), uid: makeUid };
  let next: Pattern;
  try {
    next = def.run(pattern, params, ctx);
  } catch (e) {
    return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) };
  }
  const changed = next !== pattern && JSON.stringify(next) !== JSON.stringify(pattern);
  if (changed && !opts.dryRun) host.apply(next, def.label ?? def.summary);
  return { ok: true, changed };
}

/**
 * Batch several commands into ONE undo entry (the original's PatternTransaction / dragTransaction /
 * pasteTransaction): commands run against a working copy; commit() applies the final pattern once.
 */
export class PatternTransaction {
  private host: ExecuteHost;
  private working: Pattern;
  private label: string;
  private dirty = false;
  private done = false;

  constructor(host: ExecuteHost, label = 'Transaction') {
    this.host = host;
    this.label = label;
    this.working = host.getPattern();
  }

  /** Run a command against the transaction's working pattern. Nothing is committed yet. */
  execute(type: string, params: Record<string, unknown> = {}): CommandResult {
    if (this.done) return { ok: false, changed: false, error: 'Transaction already finished' };
    const def = COMMANDS.get(type);
    if (!def) return { ok: false, changed: false, error: `Unknown command: ${type}` };
    const ctx: CommandContext = { selection: this.host.getSelection(), uid: makeUid };
    let next: Pattern;
    try {
      next = def.run(this.working, params, ctx);
    } catch (e) {
      return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) };
    }
    const changed = next !== this.working && JSON.stringify(next) !== JSON.stringify(this.working);
    if (changed) { this.working = next; this.dirty = true; }
    return { ok: true, changed };
  }

  /** Evaluate a command against the working pattern without keeping its result. */
  preview(type: string, params: Record<string, unknown> = {}): CommandResult {
    if (this.done) return { ok: false, changed: false, error: 'Transaction already finished' };
    const def = COMMANDS.get(type);
    if (!def) return { ok: false, changed: false, error: `Unknown command: ${type}` };
    const ctx: CommandContext = { selection: this.host.getSelection(), uid: makeUid };
    try {
      const next = def.run(this.working, params, ctx);
      return { ok: true, changed: next !== this.working && JSON.stringify(next) !== JSON.stringify(this.working) };
    } catch (e) {
      return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Apply everything as a single undo entry. Returns whether anything changed. */
  commit(): boolean {
    if (this.done) return false;
    this.done = true;
    if (!this.dirty) return false;
    this.host.apply(this.working, this.label);
    return true;
  }

  /** Discard the working copy (nothing was committed). */
  rollback(): void {
    this.done = true;
  }
}

export function beginTransaction(host: ExecuteHost, label?: string): PatternTransaction {
  return new PatternTransaction(host, label);
}

/** A serialisable description of the whole command surface (for docs / agent tool schemas). */
export function commandSchema() {
  return COMMAND_LIST.map((d) => ({
    type: d.type,
    category: d.category,
    summary: d.summary,
    inputs: d.inputs,
    example: d.example ?? null
  }));
}

declare global {
  interface Window {
    seamer?: {
      commands: () => ReturnType<typeof commandSchema>;
      execute: (type: string, params?: Record<string, unknown>) => CommandResult;
      /** evaluate a command without committing it */
      preview: (type: string, params?: Record<string, unknown>) => CommandResult;
      /** batch commands into one undo entry: execute/preview then commit (or rollback) */
      beginTransaction: (label?: string) => PatternTransaction;
      getPattern: () => Pattern;
      getSelection: () => Selection;
    };
  }
}

/** Install the `window.seamer` automation API. Returns a disposer. Safe to call only in browser. */
export function installCommandApi(host: ExecuteHost): () => void {
  if (typeof window === 'undefined') return () => {};
  window.seamer = {
    commands: commandSchema,
    execute: (type, params) => executeCommand(host, type, params),
    preview: (type, params) => executeCommand(host, type, params, { dryRun: true }),
    beginTransaction: (label) => beginTransaction(host, label),
    getPattern: host.getPattern,
    getSelection: host.getSelection
  };
  return () => {
    if (window.seamer) delete window.seamer;
  };
}
