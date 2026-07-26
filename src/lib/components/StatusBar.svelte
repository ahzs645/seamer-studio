<script lang="ts">
  // Bottom status bar: live cursor position (mm), current tool, selection counts and a saved/unsaved
  // indicator — mirroring the original studio's readout strip. The coordinate readout (cursor +
  // single-selection position) is gated by the persisted "Show coordinates" setting.
  import { cursorMm, selectedTool, selectedPointIds, selectedPathIds, selectedPieceIds, showCoordinates } from '$lib/stores/pattern';
  import type { Pattern } from '@seamer/pattern-model';

  let { currentPattern, saved }: { currentPattern: Pattern; saved: boolean } = $props();

  const selCount = $derived($selectedPointIds.size + $selectedPathIds.size + $selectedPieceIds.size);
  const unit = $derived(currentPattern.lengthUnit ?? 'mm');
  const toUnit = (mm: number) => (unit === 'cm' ? mm / 10 : unit === 'inch' ? mm / 25.4 : mm);
  const fmt = (mm: number) => toUnit(mm).toFixed(unit === 'inch' ? 2 : 1);

  // Position of the active selection (a single point's drafting coords, or a single piece's placement).
  const selPos = $derived.by<{ label: string; x: number; y: number } | null>(() => {
    if ($selectedPointIds.size === 1) {
      const p = currentPattern.points.find((q) => q.id === [...$selectedPointIds][0]);
      return p ? { label: p.name, x: p.x, y: p.y } : null;
    }
    if ($selectedPieceIds.size === 1) {
      const pc = currentPattern.pieces.find((q) => q.id === [...$selectedPieceIds][0]);
      return pc ? { label: pc.name, x: pc.position.x, y: pc.position.y } : null;
    }
    return null;
  });
</script>

<div class="h-6 px-3 flex items-center gap-4 text-[11px] bg-base-300 border-t border-base-200 text-base-content/70 shrink-0 select-none">
  {#if $showCoordinates}
    <span class="font-mono w-40">
      {#if $cursorMm}
        x {fmt($cursorMm.x)} · y {fmt($cursorMm.y)} {unit}
      {:else}
        —
      {/if}
    </span>
    {#if selPos}
      <span class="font-mono">{selPos.label}: x {fmt(selPos.x)} · y {fmt(selPos.y)} {unit}</span>
    {/if}
  {/if}
  <span>tool: <b class="text-base-content/90">{$selectedTool}</b></span>
  <span>selection: <b class="text-base-content/90">{selCount}</b></span>
  <span class="ml-auto flex items-center gap-1">
    <span class="w-2 h-2 rounded-full {saved ? 'bg-success' : 'bg-warning'}"></span>
    {saved ? 'Saved' : 'Unsaved changes'}
  </span>
</div>
