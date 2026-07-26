<script lang="ts">
  import type { SvgImportOptions } from '$lib/utils/patternImport';

  let { filename = '', onapply, oncancel }:
    {
      filename?: string;
      onapply: (options: SvgImportOptions) => void;
      oncancel: () => void;
    } = $props();

  let unitsOverride = $state<'auto' | 'mm' | 'px'>('auto');
  let dpi = $state(96);
  let importSeam = $state(true);
  let importCut = $state(true);
  let importInternal = $state(true);
  let importText = $state(true);

  function apply() {
    onapply({
      unitsOverride,
      dpi: Number.isFinite(dpi) && dpi > 0 ? dpi : 96,
      importText,
      classify: { importSeam, importCut, importInternal }
    });
  }
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') oncancel(); }} />

<div class="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
  <div class="bg-base-100 rounded-lg shadow-xl max-w-md w-full p-5">
    <h3 class="font-bold text-base mb-1">Import SVG</h3>
    {#if filename}<p class="text-xs opacity-60 mb-3 truncate">{filename}</p>{/if}

    <label class="form-control w-full mb-3">
      <div class="label py-1"><span class="label-text">SVG units</span></div>
      <select class="select select-sm select-bordered w-full" bind:value={unitsOverride}>
        <option value="auto">Auto from width, height, and viewBox</option>
        <option value="mm">Treat drawing units as mm</option>
        <option value="px">Treat drawing units as pixels</option>
      </select>
    </label>

    <label class="form-control w-full mb-3">
      <div class="label py-1"><span class="label-text">Pixel density</span></div>
      <div class="flex items-center gap-2">
        <input type="number" min="1" step="1" class="input input-sm input-bordered flex-1" bind:value={dpi} />
        <span class="text-xs opacity-60">DPI</span>
      </div>
      <div class="label py-1">
        <span class="label-text-alt opacity-60">Used for px dimensions; SVG defaults to 96 DPI.</span>
      </div>
    </label>

    <div class="mb-4 space-y-1">
      <label class="label cursor-pointer justify-start gap-2 py-1">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={importCut} />
        <span class="label-text">Import cut lines</span>
      </label>
      <label class="label cursor-pointer justify-start gap-2 py-1">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={importSeam} />
        <span class="label-text">Import seam lines</span>
      </label>
      <label class="label cursor-pointer justify-start gap-2 py-1">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={importInternal} />
        <span class="label-text">Import internal lines</span>
      </label>
      <label class="label cursor-pointer justify-start gap-2 py-1">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={importText} />
        <span class="label-text">Import text labels</span>
      </label>
    </div>

    <p class="text-xs opacity-50 mb-4">
      Lines are classified by their data-layer or id: cut/boundary/outline, seam/stitch, or internal/fold/dart. Closed shapes default to cut lines.
    </p>

    <div class="flex justify-end gap-2">
      <button class="btn btn-sm btn-ghost" onclick={oncancel}>Cancel</button>
      <button class="btn btn-sm btn-primary" onclick={apply}>Import</button>
    </div>
  </div>
</div>
