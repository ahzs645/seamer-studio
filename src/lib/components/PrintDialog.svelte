<script lang="ts">
  import type { Pattern } from '@seamer/pattern-model';
  import { patternBoundsMm, printPatternTiled, patternToPDF, downloadBlob, TILE_OVERLAP_MM } from '$lib/utils/exporters';
  import { PAGE_SIZES_MM, tilePageCount } from '@atelier/io';
  import { nestPatternForPaper } from '$lib/utils/markerLayout';
  import { toastSuccess, toastError } from '$lib/stores/toast';

  let { pattern, patternName = 'Pattern', onclose }:
    {
      pattern: Pattern;
      patternName?: string;
      onclose: () => void;
    } = $props();

  type PageKey = keyof typeof PAGE_SIZES_MM;
  const PAGE_KEYS: PageKey[] = ['A4', 'A3', 'A2', 'A1', 'A0', 'Letter'];
  let paperSize = $state<PageKey>('A4');
  let marginMm = $state<number | null>(10); // null while the field is cleared
  let orientation = $state<'portrait' | 'landscape'>('portrait');
  let scalePct = $state<number | null>(100); // 100% = true scale; null while cleared
  let renest = $state(false); // re-nest pieces onto the paper strip to minimize pages

  // a cleared number input binds null — compute with the defaults and gate Print/Export until valid
  const marginVal = $derived(marginMm ?? 10);
  const scaleVal = $derived(scalePct ?? 100);
  const inputsValid = $derived(
    marginMm != null && Number.isFinite(marginMm) && marginMm >= 0 &&
    scalePct != null && Number.isFinite(scalePct) && scalePct > 0
  );

  const pageDims = $derived.by(() => {
    const [w, h] = PAGE_SIZES_MM[paperSize] ?? PAGE_SIZES_MM.A4;
    return orientation === 'landscape' ? { w: h, h: w } : { w, h };
  });
  // the pattern actually printed: re-nested onto the printable width when requested
  const printedPattern = $derived.by(() => {
    if (!renest) return pattern;
    const usable = (pageDims.w - 2 * marginVal) / (scaleVal / 100);
    return nestPatternForPaper(pattern, usable);
  });
  const contentBounds = $derived(patternBoundsMm(printedPattern));
  const pageCount = $derived(tilePageCount(
    contentBounds.width * (scaleVal / 100),
    contentBounds.height * (scaleVal / 100),
    { pageWmm: pageDims.w, pageHmm: pageDims.h, marginMm: marginVal, overlapMm: TILE_OVERLAP_MM }
  ));

  function doPrint() {
    printPatternTiled(printedPattern, {
      pageWmm: pageDims.w, pageHmm: pageDims.h, marginMm: marginVal,
      scale: scaleVal / 100, title: patternName
    });
    onclose();
  }

  async function doExportPDF() {
    const base = patternName.replace(/\s+/g, '_') || 'pattern';
    try {
      const blob = await patternToPDF(printedPattern, {
        page: paperSize, landscape: orientation === 'landscape',
        marginMm: marginVal, overlapMm: TILE_OVERLAP_MM, scale: scaleVal / 100,
        tile: true, title: patternName
      });
      downloadBlob(`${base}.pdf`, blob);
      toastSuccess(`Exported PDF (${paperSize}, ${pageCount.total} page${pageCount.total === 1 ? '' : 's'})`);
      onclose();
    } catch {
      toastError('PDF export failed');
    }
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onclose(); }} />

<div class="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
  <div class="bg-base-100 rounded-lg shadow-xl max-w-sm w-full p-5">
    <h3 class="font-bold text-base mb-3">Print / Export PDF</h3>

    <label class="form-control w-full mb-2">
      <div class="label py-1"><span class="label-text">Paper size</span></div>
      <select class="select select-sm select-bordered w-full" bind:value={paperSize}>
        {#each PAGE_KEYS as sz}
          <option value={sz}>{sz} ({PAGE_SIZES_MM[sz][0]} × {PAGE_SIZES_MM[sz][1]} mm)</option>
        {/each}
      </select>
    </label>

    <label class="form-control w-full mb-2">
      <div class="label py-1"><span class="label-text">Margins (mm)</span></div>
      <input type="number" min="0" max="50" step="1" class="input input-sm input-bordered w-full" bind:value={marginMm} />
    </label>

    <div class="form-control w-full mb-2">
      <div class="label py-1"><span class="label-text">Orientation</span></div>
      <div class="join join-horizontal">
        <button class="join-item btn btn-sm" class:btn-active={orientation === 'portrait'} onclick={() => (orientation = 'portrait')}>Portrait</button>
        <button class="join-item btn btn-sm" class:btn-active={orientation === 'landscape'} onclick={() => (orientation = 'landscape')}>Landscape</button>
      </div>
    </div>

    <label class="form-control w-full mb-3">
      <div class="label py-1"><span class="label-text">Scale (%)</span><span class="label-text-alt opacity-60">100 = true scale</span></div>
      <input type="number" min="1" max="400" step="1" class="input input-sm input-bordered w-full" bind:value={scalePct} />
    </label>

    <label class="flex items-center gap-2 mb-3 text-sm" title="Pack the pieces onto the printable paper width before tiling (fewer pages)">
      <input type="checkbox" class="checkbox checkbox-sm" bind:checked={renest} />
      Re-nest pieces to minimize pages
    </label>

    <div class="text-sm bg-base-200 rounded p-2 mb-4">
      <div><span class="opacity-60">Pattern:</span> {contentBounds.width.toFixed(0)} × {contentBounds.height.toFixed(0)} mm</div>
      <div><span class="opacity-60">Total number of pages:</span> <span class="font-medium">{pageCount.total}</span> ({pageCount.cols} × {pageCount.rows})</div>
    </div>

    <div class="flex justify-end gap-2">
      <button class="btn btn-sm btn-ghost" onclick={onclose}>Cancel</button>
      <button class="btn btn-sm" onclick={doExportPDF} disabled={!inputsValid}>Export PDF</button>
      <button class="btn btn-sm btn-primary" onclick={doPrint} disabled={!inputsValid}>Print</button>
    </div>
  </div>
</div>
