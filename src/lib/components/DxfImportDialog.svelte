<script lang="ts">
  import type { DxfImportOptions, DxfLineClass } from '$lib/utils/patternImport';

  let { filename = '', onapply, oncancel }:
    {
      /** name of the chosen .dxf file (shown in the header) */
      filename?: string;
      onapply: (options: DxfImportOptions) => void;
      oncancel: () => void;
    } = $props();

  let unitsOverride = $state<'auto' | 'mm' | 'cm' | 'inch'>('auto');
  let importSeam = $state(true);
  let importCut = $state(true);
  let importInternal = $state(true);
  /** DXF color index → line class rows for the colorMap */
  let colorRows = $state<{ index: number; cls: DxfLineClass }[]>([]);

  function addRow() {
    const used = new Set(colorRows.map((r) => r.index));
    let idx = 1;
    while (used.has(idx)) idx++;
    colorRows = [...colorRows, { index: idx, cls: 'cut' }];
  }

  function apply() {
    const colorMap: Record<number, DxfLineClass> = {};
    for (const r of colorRows) if (Number.isFinite(r.index)) colorMap[r.index] = r.cls;
    onapply({
      unitsOverride,
      classify: { importSeam, importCut, importInternal, ...(colorRows.length ? { colorMap } : {}) }
    });
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') oncancel(); }} />

<div class="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
  <div class="bg-base-100 rounded-lg shadow-xl max-w-md w-full p-5">
    <h3 class="font-bold text-base mb-1">Import DXF</h3>
    {#if filename}<p class="text-xs opacity-60 mb-3 truncate">{filename}</p>{/if}

    <label class="form-control w-full mb-3">
      <div class="label py-1"><span class="label-text">DXF INSUNITS override</span></div>
      <select class="select select-sm select-bordered w-full" bind:value={unitsOverride}>
        <option value="auto">Auto</option>
        <option value="mm">mm</option>
        <option value="cm">cm</option>
        <option value="inch">inch</option>
      </select>
    </label>

    <div class="mb-3 space-y-1">
      <label class="label cursor-pointer justify-start gap-2 py-1">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={importSeam} />
        <span class="label-text">Import seam lines</span>
      </label>
      <label class="label cursor-pointer justify-start gap-2 py-1">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={importCut} />
        <span class="label-text">Import cut lines</span>
      </label>
      <label class="label cursor-pointer justify-start gap-2 py-1">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={importInternal} />
        <span class="label-text">Import internal lines</span>
      </label>
    </div>

    <div class="mb-4">
      <div class="flex items-center justify-between mb-1">
        <span class="text-sm">Color index</span>
        <button class="btn btn-xs btn-ghost" onclick={addRow}>+ Add mapping</button>
      </div>
      {#if colorRows.length}
        <div class="space-y-1">
          {#each colorRows as row, i}
            <div class="flex items-center gap-2">
              <input type="number" min="0" max="256" class="input input-sm input-bordered w-20" bind:value={row.index} aria-label="DXF color index" />
              <span class="opacity-50 text-sm">→</span>
              <select class="select select-sm select-bordered flex-1" bind:value={row.cls}>
                <option value="seam">Seam</option>
                <option value="cut">Cut</option>
                <option value="internal">Internal</option>
              </select>
              <button class="btn btn-xs btn-ghost btn-circle" aria-label="Remove mapping" onclick={() => (colorRows = colorRows.filter((_, j) => j !== i))}>✕</button>
            </div>
          {/each}
        </div>
      {:else}
        <p class="text-xs opacity-50">No color mappings — lines are classified by layer name, then by topology (closed → cut, open → internal).</p>
      {/if}
    </div>

    <div class="flex justify-end gap-2">
      <button class="btn btn-sm btn-ghost" onclick={oncancel}>Cancel</button>
      <button class="btn btn-sm btn-primary" onclick={apply}>Import</button>
    </div>
  </div>
</div>
