<script lang="ts">
  // Undo-history dropdown: the labeled edit stack (newest first) with click-to-jump. The history was
  // already labeled + persisted; this surfaces it visually (the original showed a history list).
  import { tick } from 'svelte';
  import { navigateMenu } from '$lib/utils/focus';
  import { historyLabels, redoLabel, undoLabel, resetHistory } from '$lib/stores/pattern';

  let { onundo, onredo }: { onundo: (steps: number) => void; onredo: () => void } = $props();
  let open = $state(false);
  const instanceId = $props.id();
  let trigger: HTMLButtonElement;
  let container: HTMLDivElement;
  let menu = $state<HTMLDivElement>();

  $effect(() => {
    if (!open) return;
    void tick().then(() => {
      if (open && menu) (menu.querySelector<HTMLElement>('[role="menuitem"]') ?? menu).focus({ preventScroll: true });
    });
  });

  function close(restoreFocus = true) {
    open = false;
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function handleKey(event: KeyboardEvent) {
    // History navigation must not nudge selected pattern entities underneath it.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close(false);
    else if (menu) navigateMenu(event, menu);
  }

  // historyLabels is oldest→newest; show newest first. Clicking row r (0 = most recent) undoes r+1 steps.
  const rows = $derived([...$historyLabels].reverse());
</script>

<svelte:window onkeydown={(event) => {
  if (open && event.key === 'Escape') { event.preventDefault(); close(); }
}} />

<div bind:this={container} class="relative"
  onfocusout={(event) => { if (open && event.relatedTarget instanceof Node && !container.contains(event.relatedTarget)) close(false); }}
>
  <button bind:this={trigger} aria-expanded={open} aria-controls={`${instanceId}-menu`} aria-haspopup="menu" class="btn btn-ghost btn-xs" title="Edit history" aria-label="Edit history" onclick={() => (open = !open)}
    onkeydown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); open = true; }
    }}>
    <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">manage_history</span>
  </button>
  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-40" onclick={() => close(false)} onkeydown={() => {}} role="button" tabindex="-1"></div>
    <div bind:this={menu} id={`${instanceId}-menu`} role="menu" aria-label="Edit history" tabindex="-1" onkeydown={handleKey} class="absolute right-0 mt-1 w-60 max-h-80 overflow-y-auto bg-base-100 border border-base-300 rounded-box shadow-lg z-50 text-sm">
      {#if $redoLabel}
        <button role="menuitem" tabindex="-1" class="w-full text-left px-3 py-1.5 hover:bg-base-200 flex items-center gap-2 text-primary" onclick={() => { close(); onredo(); }}>
          <span class="material-symbols-rounded text-base" aria-hidden="true">redo</span> Redo {$redoLabel}
        </button>
        <div class="border-b border-base-200"></div>
      {/if}
      {#if rows.length === 0}
        <div class="px-3 py-2 text-base-content/50">No history yet.</div>
      {:else}
        {#each rows as label, i (i)}
          <button role="menuitem" tabindex="-1" class="w-full text-left px-3 py-1.5 hover:bg-base-200 flex items-center gap-2" class:font-semibold={i === 0}
            title={i === 0 ? 'Most recent edit' : `Undo ${i + 1} steps`}
            onclick={() => { close(); onundo(i + 1); }}>
            <span class="material-symbols-rounded text-base opacity-50" aria-hidden="true">{i === 0 ? 'undo' : 'history'}</span>
            <span class="truncate flex-1">{label}</span>
            {#if i === 0 && $undoLabel}<span class="badge badge-ghost badge-xs">latest</span>{/if}
          </button>
        {/each}
        <div class="border-t border-base-200"></div>
        <button role="menuitem" tabindex="-1" class="w-full text-left px-3 py-1.5 hover:bg-base-200 flex items-center gap-2 text-error/80" onclick={() => { close(); resetHistory(); }}>
          <span class="material-symbols-rounded text-base" aria-hidden="true">delete_history</span> Clear undo history
        </button>
      {/if}
    </div>
  {/if}
</div>
