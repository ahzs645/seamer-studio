<script lang="ts">
  import type { Pattern } from '@seamer/pattern-model';
  import {
    DEFAULT_GLOBE_LANTERN,
    generateGlobeLantern,
    globeLanternNotes,
    type GlobeLanternParams,
    type GlobeLanternStats
  } from '$lib/generators/globeLantern';
  import { downloadText } from '$lib/utils/exporters';
  import { toastError } from '$lib/stores/toast';

  interface Props {
    open: boolean;
    ongenerate: (pattern: Pattern) => void;
    onclose: () => void;
  }

  let { open = false, ongenerate, onclose }: Props = $props();

  let params = $state<GlobeLanternParams>({ ...DEFAULT_GLOBE_LANTERN });

  // Regenerating on every keystroke keeps the numbers honest — they come from the pattern that
  // would actually be created, not from a formula that could drift away from the generator.
  const preview = $derived.by((): { stats: GlobeLanternStats; warnings: string[]; error: string | null } => {
    try {
      const { stats, warnings } = generateGlobeLantern($state.snapshot(params));
      return { stats, warnings, error: null };
    } catch (error) {
      return {
        stats: null as unknown as GlobeLanternStats,
        warnings: [],
        error: error instanceof Error ? error.message : 'These parameters do not make a globe.'
      };
    }
  });

  const mm = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} m` : `${Math.round(v)} mm`);

  function create(): void {
    try {
      const { pattern } = generateGlobeLantern($state.snapshot(params));
      ongenerate(pattern);
      onclose();
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not generate the lantern.');
    }
  }

  function saveNotes(): void {
    if (!preview.stats) return;
    downloadText('globe-lantern-notes.txt', globeLanternNotes($state.snapshot(params), preview.stats));
  }

  const fields: { key: keyof GlobeLanternParams; label: string; unit: string; step?: number; min?: number }[] = [
    { key: 'width', label: 'Width (diameter)', unit: 'mm', step: 5, min: 40 },
    { key: 'height', label: 'Height', unit: 'mm', step: 5, min: 40 },
    { key: 'topOpen', label: 'Top hole ⌀', unit: 'mm', step: 2, min: 4 },
    { key: 'botOpen', label: 'Bottom hole ⌀', unit: 'mm', step: 2, min: 4 },
    { key: 'strip', label: 'Finished strip width', unit: 'mm', step: 1, min: 4 },
    { key: 'seamAllowance', label: 'Seam allowance', unit: 'mm', step: 1, min: 0 },
    { key: 'channelWidth', label: 'Wire channel', unit: 'mm', step: 1, min: 0 },
    { key: 'wireDiameter', label: 'Wire diameter', unit: 'mm', step: 0.1, min: 0.2 },
    { key: 'wireStiffness', label: 'Wire stiffness', unit: '0–100', step: 5, min: 0 },
    { key: 'wireLinearMass', label: 'Wire weight', unit: 'g/m', step: 0.1, min: 0 },
    { key: 'matWidth', label: 'Mat width', unit: 'mm', step: 1, min: 80 },
    { key: 'matLength', label: 'Mat length', unit: 'mm', step: 1, min: 80 }
  ];
</script>

{#if open}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      <h3 class="font-bold text-lg mb-1">Globe lantern</h3>
      <p class="text-xs opacity-70 mb-3">
        A strip of cloth with wire sewn into its seam, coiled into a sphere. The top and bottom holes
        are set below — the coiling starts and stops at them, and each is finished with a closed wire
        hoop of the length shown.
      </p>

      <div class="mb-4">
        <div class="join">
          <button
            class="join-item btn btn-sm"
            class:btn-active={params.mode === 'rings'}
            onclick={() => (params.mode = 'rings')}
          >Stacked rings</button>
          <button
            class="join-item btn btn-sm"
            class:btn-active={params.mode === 'helix'}
            onclick={() => (params.mode = 'helix')}
          >Helix</button>
        </div>
        {#if params.mode === 'helix'}
          <label class="flex items-center gap-2 mt-3 text-xs cursor-pointer">
            <input
              type="checkbox"
              class="checkbox checkbox-xs"
              checked={params.layout === 'spiral'}
              onchange={(e) => (params.layout = e.currentTarget.checked ? 'spiral' : 'sheets')}
            />
            <span>Lay the pieces out on the spiral</span>
            <span class="opacity-60">— shows the continuous ribbon; untick to pack them into rows for cutting</span>
          </label>
        {/if}
        <p class="text-xs opacity-70 mt-2">
          {#if params.mode === 'rings'}
            Separate closed bands, each an annular sector, joined ring to ring. Much less fiddly to
            sew, and every seam is a closed circle.
          {:else}
            One continuous ribbon whose flat shape is a double spiral — it curves one way above the
            equator, straightens, and curves back below it. One long spiral seam.
          {/if}
        </p>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 mb-4">
        {#each fields as field (field.key)}
          <label class="form-control">
            <span class="label-text text-xs">{field.label}</span>
            <div class="join">
              <input
                class="join-item input input-bordered input-xs w-full tabular-nums text-right"
                type="number"
                step={field.step ?? 1}
                min={field.min ?? 0}
                bind:value={params[field.key] as number}
              />
              <span class="join-item btn btn-xs btn-disabled no-animation">{field.unit}</span>
            </div>
          </label>
        {/each}
      </div>

      {#if preview.error}
        <div class="alert alert-error text-xs py-2 mb-3">{preview.error}</div>
      {:else}
        <div class="stats stats-horizontal shadow w-full text-xs mb-2 overflow-x-auto">
          <div class="stat py-2 px-3">
            <div class="stat-title text-xs">Coils</div>
            <div class="stat-value text-base tabular-nums">{preview.stats.coils.toFixed(1)}</div>
          </div>
          <div class="stat py-2 px-3">
            <div class="stat-title text-xs">Wire</div>
            <div class="stat-value text-base tabular-nums">{mm(preview.stats.wireLength)}</div>
            <div class="stat-desc text-xs">+ hoops {mm(preview.stats.hoopLengths[0])} / {mm(preview.stats.hoopLengths[1])}</div>
          </div>
          <div class="stat py-2 px-3">
            <div class="stat-title text-xs">Fabric</div>
            <div class="stat-value text-base tabular-nums">{preview.stats.fabricArea.toFixed(2)} m²</div>
          </div>
          <div class="stat py-2 px-3">
            <div class="stat-title text-xs">Pieces</div>
            <div class="stat-value text-base tabular-nums">{preview.stats.pieceCount}</div>
            <div class="stat-desc text-xs">{preview.stats.seamCount} seams</div>
          </div>
          {#if preview.stats.ease > 0}
            <div class="stat py-2 px-3">
              <div class="stat-title text-xs">Seam ease</div>
              <div class="stat-value text-base tabular-nums">{(preview.stats.ease * 100).toFixed(2)}%</div>
              <div class="stat-desc text-xs">per coil, taken up by the cloth</div>
            </div>
            <div class="stat py-2 px-3">
              <div class="stat-title text-xs">Coil clearance</div>
              <div
                class="stat-value text-base tabular-nums"
                class:text-warning={preview.stats.coilClearance < 0}
              >{preview.stats.coilClearance >= 0 ? '+' : ''}{preview.stats.coilClearance.toFixed(0)} mm</div>
              <div class="stat-desc text-xs">
                {preview.stats.coilClearance < 0 ? 'cut outlines overlap near the poles' : 'between coils on the page'}
              </div>
            </div>
          {/if}
        </div>

        {#each preview.warnings as warning}
          <div class="alert alert-warning text-xs py-2 mb-2">{warning}</div>
        {/each}
      {/if}

      <div class="modal-action">
        <button class="btn btn-sm btn-ghost" onclick={saveNotes} disabled={!!preview.error}>
          Save cutting notes
        </button>
        <button class="btn btn-sm" onclick={onclose}>Cancel</button>
        <button class="btn btn-sm btn-primary" onclick={create} disabled={!!preview.error}>
          Create pattern
        </button>
      </div>
    </div>
    <button type="button" class="modal-backdrop" onclick={onclose} aria-label="Close"></button>
  </div>
{/if}
