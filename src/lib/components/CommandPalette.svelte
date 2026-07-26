<script lang="ts">
  // Command palette — the human face of the unified command bus (Ctrl/Cmd+K). Lists every
  // registered command (the same surface exposed to automation via window.seamer), lets you
  // filter, fill parameters, and run. Selection-based commands act on the current editor selection.
  import { COMMAND_LIST } from '$lib/commands/registry';
  import { executeCommand, type ExecuteHost } from '$lib/commands/execute';
  import type { CommandDef } from '$lib/commands/types';

  let { host, onclose }: { host: ExecuteHost; onclose: () => void } = $props();

  let query = $state('');
  let selectedType = $state<string | null>(null);
  let paramText = $state('{}');
  let paramError = $state<string | null>(null);
  let runMsg = $state<string | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);

  const filtered = $derived(
    COMMAND_LIST.filter((c) => {
      const q = query.trim().toLowerCase();
      return !q || c.type.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q) || c.category.includes(q);
    })
  );

  $effect(() => { inputEl?.focus(); });

  function select(cmd: CommandDef) {
    selectedType = cmd.type;
    paramText = cmd.example ? JSON.stringify(cmd.example, null, 2) : '{}';
    paramError = null;
    runMsg = null;
  }

  function run(cmd: CommandDef) {
    let params: Record<string, unknown> = {};
    if (cmd.inputs.length) {
      try {
        params = paramText.trim() ? JSON.parse(paramText) : {};
      } catch {
        paramError = 'Invalid JSON';
        return;
      }
    }
    const res = executeCommand(host, cmd.type, params);
    if (!res.ok) { paramError = res.error ?? 'Failed'; return; }
    runMsg = res.changed ? `Ran ${cmd.type}` : `${cmd.type}: no change`;
    if (res.changed) onclose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onclose(); }
    if (e.key === 'Enter' && filtered.length === 1) { e.preventDefault(); const c = filtered[0]; if (!c.inputs.length) run(c); else select(c); }
  }
</script>

<div
  class="fixed inset-0 z-[200] flex items-start justify-center bg-black/40 pt-24"
  role="button" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}
  onkeydown={(e) => e.key === 'Escape' && onclose()}
>
  <div class="bg-base-100 w-[min(640px,92vw)] max-h-[70vh] rounded-lg shadow-2xl flex flex-col overflow-hidden" role="dialog" aria-label="Command palette">
    <div class="p-2 border-b border-base-300">
      <input
        bind:this={inputEl}
        bind:value={query}
        onkeydown={onKey}
        class="input input-sm input-bordered w-full"
        placeholder="Run a command… (e.g. selection.rotate, layer.rename)"
      />
    </div>

    <div class="overflow-y-auto flex-1">
      {#each filtered as cmd (cmd.type)}
        <div class="border-b border-base-200 first:border-t-0">
          <button
            class="w-full text-left px-3 py-1.5 hover:bg-base-200 flex items-baseline gap-2"
            class:bg-base-200={selectedType === cmd.type}
            onclick={() => (selectedType === cmd.type ? run(cmd) : select(cmd))}
          >
            <span class="badge badge-ghost badge-xs">{cmd.category}</span>
            <span class="font-mono text-xs">{cmd.type}</span>
            <span class="text-xs text-base-content/60 truncate">{cmd.summary}</span>
          </button>

          {#if selectedType === cmd.type}
            <div class="px-3 pb-2 bg-base-200/50">
              {#if cmd.inputs.length}
                <div class="text-[11px] text-base-content/60 mb-1">params: {cmd.inputs.join(', ')}</div>
                <textarea
                  bind:value={paramText}
                  class="textarea textarea-bordered textarea-xs w-full font-mono"
                  rows="3"
                ></textarea>
              {:else}
                <div class="text-[11px] text-base-content/60 mb-1">No parameters — acts on the current selection.</div>
              {/if}
              {#if paramError}<div class="text-error text-xs mt-1">{paramError}</div>{/if}
              {#if runMsg}<div class="text-success text-xs mt-1">{runMsg}</div>{/if}
              <button class="btn btn-primary btn-xs mt-2" onclick={() => run(cmd)}>Run {cmd.type}</button>
            </div>
          {/if}
        </div>
      {/each}
      {#if filtered.length === 0}
        <div class="p-4 text-center text-sm text-base-content/50">No matching command</div>
      {/if}
    </div>
    <div class="px-3 py-1.5 text-[11px] text-base-content/50 border-t border-base-300">
      {COMMAND_LIST.length} commands · also available to scripts via <span class="font-mono">window.seamer</span>
    </div>
  </div>
</div>
