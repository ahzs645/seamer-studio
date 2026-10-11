<script module lang="ts">
  export interface WorkspaceAction {
    id: string;
    label: string;
    keywords?: string[];
    run: () => void;
  }
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { COMMAND_LIST, type CommandDef } from '@seamer/pattern-model';

  let { onclose, actions = [] }: { onclose: () => void; actions?: WorkspaceAction[] } = $props();
  type Result = { kind: 'workspace'; action: WorkspaceAction } | { kind: 'command'; command: CommandDef };

  const paletteId = $props.id();
  let dialog: HTMLDialogElement;
  let inputEl: HTMLInputElement;
  let paramsEl = $state<HTMLTextAreaElement | null>(null);
  let launcher: HTMLElement | null = null;
  let query = $state('');
  let activeIndex = $state(0);
  let selectedType = $state<string | null>(null);
  let paramText = $state('{}');
  let paramError = $state<string | null>(null);
  let runMsg = $state<string | null>(null);

  const filteredActions = $derived(actions.filter((action) => {
    const q = query.trim().toLowerCase();
    return !q || [action.label, ...(action.keywords ?? [])].some((value) => value.toLowerCase().includes(q));
  }));
  const filteredCommands = $derived(COMMAND_LIST.filter((command) => {
    const q = query.trim().toLowerCase();
    return !q || [command.type, command.label ?? command.summary, command.summary, command.category].some((value) => value.toLowerCase().includes(q));
  }));
  const results: Result[] = $derived([
    ...filteredActions.map((action): Result => ({ kind: 'workspace', action })),
    ...filteredCommands.map((command): Result => ({ kind: 'command', command }))
  ]);

  $effect(() => { query; activeIndex = 0; selectedType = null; paramError = null; runMsg = null; });

  onMount(() => {
    launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    inputEl.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (launcher?.isConnected) launcher.focus({ preventScroll: true });
    };
  });

  function closePalette() {
    if (dialog.open) dialog.close();
    if (launcher?.isConnected) launcher.focus({ preventScroll: true });
    onclose();
  }

  async function select(command: CommandDef) {
    selectedType = command.type;
    paramText = command.example ? JSON.stringify(command.example, null, 2) : '{}';
    paramError = null;
    runMsg = null;
    await tick();
    paramsEl?.focus();
  }

  function run(command: CommandDef) {
    paramError = null;
    runMsg = null;
    let params: Record<string, unknown> = {};
    if (command.inputs.length) {
      try {
        const parsed: unknown = paramText.trim() ? JSON.parse(paramText) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          paramError = 'Parameters must be a JSON object';
          return;
        }
        params = parsed as Record<string, unknown>;
      } catch {
        paramError = 'Invalid JSON';
        return;
      }
    }
    const response = window.seamer?.execute(command.type, params);
    if (!response) { paramError = 'Command API unavailable'; return; }
    if (!response.ok) { paramError = response.error ?? 'Failed'; return; }
    runMsg = response.changed ? `Ran ${command.label ?? command.summary}` : `${command.label ?? command.summary}: no change`;
    if (response.changed) closePalette();
  }

  function activate(result: Result) {
    if (result.kind === 'workspace') {
      // Restore the launcher before opening another dialog or panel through this action.
      closePalette();
      result.action.run();
    } else if (!result.command.inputs.length) run(result.command);
    else if (selectedType === result.command.type) run(result.command);
    else void select(result.command);
  }

  function handleKey(event: KeyboardEvent) {
    // Modal shortcuts never reach canvas or global selection handlers.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
      return;
    }
    if (event.key === 'Tab') {
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, [tabindex="0"]'))
        .filter((element) => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
      return;
    }
    const target = event.target;
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
      (target !== inputEl && !(target instanceof HTMLElement && target.hasAttribute('data-palette-result')))) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!results.length) return;
      activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      const button = dialog.querySelector<HTMLButtonElement>(`[data-palette-result="${activeIndex}"]`);
      button?.scrollIntoView({ block: 'nearest' });
      if (target !== inputEl) button?.focus();
    } else if (event.key === 'Enter' && results[activeIndex]) {
      event.preventDefault();
      activate(results[activeIndex]);
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="bg-base-100 text-base-content w-[min(640px,92vw)] max-h-[min(70vh,calc(100dvh-2rem))] rounded-lg shadow-2xl p-0 overflow-hidden backdrop:bg-black/40"
  aria-labelledby={`${paletteId}-title`}
  onkeydown={handleKey}
  oncancel={(event) => { event.preventDefault(); closePalette(); }}
  onclick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closePalette();
  }}
>
  <div class="flex flex-col max-h-[min(70vh,calc(100dvh-2rem))]">
    <div class="p-3 border-b border-base-300 space-y-2 shrink-0">
      <div class="flex items-center justify-between">
        <h2 id={`${paletteId}-title`} class="font-semibold text-sm">Command palette</h2>
        <button class="btn btn-ghost btn-xs" aria-label="Close command palette" onclick={closePalette}>✕</button>
      </div>
      <input bind:this={inputEl} bind:value={query} type="search"
        class="input input-sm input-bordered w-full" placeholder="Search views, panels and pattern commands…"
        aria-label="Search commands" aria-controls={`${paletteId}-results`}
        aria-describedby={`${paletteId}-help`} />
    </div>

    <div id={`${paletteId}-results`} class="overflow-y-auto flex-1 min-h-0">
      {#if filteredActions.length}
        <h3 class="px-3 pt-3 pb-1 text-xs font-semibold text-base-content/60">Workspace</h3>
        {#each filteredActions as action, index (action.id)}
          <button class="w-full text-left px-3 py-2 hover:bg-base-200 text-sm"
            class:bg-base-200={activeIndex === index} data-palette-result={index}
            aria-current={activeIndex === index ? 'true' : undefined}
            onfocus={() => activeIndex = index} onclick={() => activate({ kind: 'workspace', action })}>
            {action.label}
          </button>
        {/each}
      {/if}
      {#if filteredCommands.length}
        <h3 class="px-3 pt-3 pb-1 text-xs font-semibold text-base-content/60">Advanced pattern commands</h3>
        {#each filteredCommands as command, index (command.type)}
          {@const resultIndex = filteredActions.length + index}
          <div class="border-b border-base-200">
            <button class="w-full text-left px-3 py-2 hover:bg-base-200"
              class:bg-base-200={activeIndex === resultIndex} data-palette-result={resultIndex}
              aria-current={activeIndex === resultIndex ? 'true' : undefined}
              aria-expanded={selectedType === command.type && command.inputs.length > 0}
              onfocus={() => activeIndex = resultIndex} onclick={() => activate({ kind: 'command', command })}>
              <span class="block text-sm">{command.label ?? command.summary}</span>
              <span class="font-mono text-[11px] text-base-content/60">{command.type}</span>
            </button>
            {#if selectedType === command.type}
              <div class="px-3 pb-3 bg-base-200/50">
                <label class="block text-[11px] text-base-content/60 mb-1" for={`${paletteId}-params`}>Advanced parameters (JSON): {command.inputs.join(', ')}</label>
                <textarea id={`${paletteId}-params`} bind:this={paramsEl} bind:value={paramText}
                  class="textarea textarea-bordered textarea-xs w-full font-mono" rows="3"
                  aria-describedby={paramError ? `${paletteId}-error` : undefined}></textarea>
                {#if paramError}<div id={`${paletteId}-error`} class="text-error text-xs mt-1" role="alert">{paramError}</div>{/if}
                {#if runMsg}<div class="text-success text-xs mt-1" role="status">{runMsg}</div>{/if}
                <button class="btn btn-primary btn-xs mt-2" onclick={() => run(command)}>Run {command.label ?? command.summary}</button>
              </div>
            {/if}
          </div>
        {/each}
      {/if}
      {#if results.length === 0}<div class="p-4 text-center text-sm text-base-content/50" role="status">No matching command</div>{/if}
      {#if runMsg && !selectedType}<div class="px-3 py-2 text-success text-xs" role="status">{runMsg}</div>{/if}
      {#if paramError && !selectedType}<div class="px-3 py-2 text-error text-xs" role="alert">{paramError}</div>{/if}
    </div>
    <div id={`${paletteId}-help`} class="px-3 py-2 text-[11px] text-base-content/60 border-t border-base-300 shrink-0">
      ↑ ↓ choose · Enter run · Esc close
    </div>
  </div>
</dialog>
