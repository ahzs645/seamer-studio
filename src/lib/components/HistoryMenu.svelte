<script lang="ts">
  // Undo-history dropdown: the labeled edit stack (newest first) with click-to-jump. The history was
  // already labeled + persisted; this surfaces it visually (the original showed a history list).
  import { historyLabels, redoLabel, undoLabel, resetHistory } from '$lib/stores/pattern';

  let { onundo, onredo }: { onundo: (steps: number) => void; onredo: () => void } = $props();
  let open = $state(false);

  // historyLabels is oldest→newest; show newest first. Clicking row r (0 = most recent) undoes r+1 steps.
  const rows = $derived([...$historyLabels].reverse());
</script>

<div class="relative">
  <button class="btn btn-ghost btn-xs" title="Edit history" aria-label="Edit history" onclick={() => (open = !open)}>
    <span class="material-symbols-rounded notranslate align-middle" style="font-size:18px">manage_history</span>
  </button>
  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-40" onclick={() => (open = false)} onkeydown={() => {}} role="button" tabindex="-1"></div>
    <div class="absolute right-0 mt-1 w-60 max-h-80 overflow-y-auto bg-base-100 border border-base-300 rounded-box shadow-lg z-50 text-sm">
      {#if $redoLabel}
        <button class="w-full text-left px-3 py-1.5 hover:bg-base-200 flex items-center gap-2 text-primary" onclick={() => { onredo(); open = false; }}>
          <span class="material-symbols-rounded text-base">redo</span> Redo {$redoLabel}
        </button>
        <div class="border-b border-base-200"></div>
      {/if}
      {#if rows.length === 0}
        <div class="px-3 py-2 text-base-content/50">No history yet.</div>
      {:else}
        {#each rows as label, i (i)}
          <button class="w-full text-left px-3 py-1.5 hover:bg-base-200 flex items-center gap-2" class:font-semibold={i === 0}
            title={i === 0 ? 'Most recent edit' : `Undo ${i + 1} steps`}
            onclick={() => { onundo(i + 1); open = false; }}>
            <span class="material-symbols-rounded text-base opacity-50">{i === 0 ? 'undo' : 'history'}</span>
            <span class="truncate flex-1">{label}</span>
            {#if i === 0 && $undoLabel}<span class="badge badge-ghost badge-xs">latest</span>{/if}
          </button>
        {/each}
        <div class="border-t border-base-200"></div>
        <button class="w-full text-left px-3 py-1.5 hover:bg-base-200 flex items-center gap-2 text-error/80" onclick={() => { resetHistory(); open = false; }}>
          <span class="material-symbols-rounded text-base">delete_history</span> Clear undo history
        </button>
      {/if}
    </div>
  {/if}
</div>
