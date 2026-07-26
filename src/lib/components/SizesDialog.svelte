<script lang="ts">
  import { untrack } from 'svelte';
  import { parseRul, type RulTable } from '$lib/utils/rulImport';

  let { table = null, onapply, oncancel }:
    {
      /** parsed grade rule table; null/undefined opens the dialog in "pick a RUL file" mode */
      table?: RulTable | null;
      onapply: (table: RulTable, size: string) => void;
      oncancel: () => void;
    } = $props();

  let loaded = $state<RulTable | null>(untrack(() => table));
  let chosenSize = $state(untrack(() => table?.sampleSize ?? ''));
  let error = $state('');

  async function onFileChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const t = parseRul(await file.text());
      loaded = t;
      chosenSize = t.sampleSize;
      error = '';
    } catch (err) {
      loaded = null;
      error = (err as Error)?.message || 'Could not parse RUL file';
    }
  }

  function apply() {
    if (loaded && chosenSize) onapply(loaded, chosenSize);
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') oncancel(); }} />

<div class="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
  <div class="bg-base-100 rounded-lg shadow-xl max-w-sm w-full p-5">
    <h3 class="font-bold text-base mb-3">Sizes</h3>

    {#if !table}
      <label class="form-control w-full mb-3">
        <div class="label py-1"><span class="label-text">RUL file (optional)</span></div>
        <input type="file" accept=".rul,.txt" class="file-input file-input-sm file-input-bordered w-full" onchange={onFileChange} />
      </label>
    {/if}

    {#if error}
      <p class="text-sm text-error mb-3">{error}</p>
    {/if}

    {#if loaded}
      <div class="text-sm mb-3">
        <div class="mb-1"><span class="opacity-60">Grade rule table:</span> <span class="font-medium">{loaded.name}</span></div>
        <div class="opacity-60">{loaded.isNumeric ? 'Numeric' : 'Alphanumeric'} sizing · {loaded.sizes.length} sizes · {loaded.rules.size} rules</div>
      </div>
      <label class="form-control w-full mb-4">
        <div class="label py-1"><span class="label-text">Size to load</span></div>
        <select class="select select-sm select-bordered w-full" bind:value={chosenSize}>
          {#each loaded.sizes as sz}
            <option value={sz}>{sz}{sz === loaded.sampleSize ? ' (sample size)' : ''}</option>
          {/each}
        </select>
      </label>
    {:else if !error}
      <p class="text-sm text-base-content/60 mb-4">Choose a RUL grade rule table to list its sizes.</p>
    {/if}

    <div class="flex justify-end gap-2">
      <button class="btn btn-sm btn-ghost" onclick={oncancel}>Cancel</button>
      <button class="btn btn-sm btn-primary" disabled={!loaded || !chosenSize} onclick={apply}>Apply</button>
    </div>
  </div>
</div>
