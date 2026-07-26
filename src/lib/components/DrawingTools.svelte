<script lang="ts">
  import { get } from 'svelte/store';
  import { selectedTool, selectedPointIds, selectedPathIds, selectedPieceIds } from '$lib/stores/pattern';

  // Right-hand drawing toolbar matching the original 2D editor. Some entries are
  // GROUPS that reveal sub-tools in a flyout (Arc/circle, Seam) — like the source.
  interface Item {
    id: string;
    label: string;
    hotkey?: string;
    icon?: string;  // Material Symbols ligature
    svg?: string;   // inline SVG glyph
  }
  interface Entry extends Partial<Item> {
    group?: string;     // group header label (with sub-tools)
    sub?: Item[];
    gap?: boolean;
  }

  const SEAM_SINGLE = '<svg viewBox="0 0 512 512" class="w-5 h-5" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M153.9 51.5c-34.6 0-65.87 4.45-87.79 11.3C55.15 66.23 46.56 70.31 41.35 74.17 36.13 78.02 34.94 80.87 34.94 82.5s1.19 4.48 6.41 8.33c5.21 3.86 13.8 7.94 24.76 11.37 21.92 6.8 53.19 11.3 87.79 11.3 34.6 0 65.9-4.5 87.8-11.3 11-3.43 19.6-7.51 24.8-11.37 5.2-3.85 6.4-6.7 6.4-8.33s-1.2-4.48-6.4-8.33c-5.2-3.86-13.8-7.94-24.8-11.37-21.9-6.85-53.2-11.3-87.8-11.3zM240.9 348.6c-59.9 12.8-117.3 14-173.99 13.8 0 0 .41.9 3.71 2.8 3.91 2.2 10.75 4.6 19.24 6.5 16.94 3.8 40.54 5.8 64.04 5.8 23.5 0 47.1-2 64-5.8 8.5-1.9 15.4-4.3 19.3-6.5 3.4-2 3.7-3 3.7-2.8z"/></svg>';
  const SEAM_MULTI = '<svg viewBox="0 -0.5 17 17" class="w-5 h-5" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M16.875,2.125 L15.547,2.125 C14.93,1.461 13.747,1 12.958,1 L12.958,0.042 L12,0.042 L12,1 L4.042,1 C2.938,1 2.042,1 2.042,2 L2.042,3.875 C2.042,4.979 2.933,5.875 4.031,5.875 L4.031,5.875 L4.031,7 L3,7 L3,8 L5,8 L5,10 L5.958,10 L5.958,5.875 L6.011,5.875 C6.511,5.875 6.737,5.46 6.848,4.918 L6.987,4.05 C7.006,3.676 6.968,4.305 6.987,4 L11,4 L11,11.042 L3.042,11.042 C1.938,11.042 1.042,11.938 1.042,13.042 L1.042,13.958 C1.042,15.062 1.938,14.958 3.042,14.958 L13.958,14.958 C15.062,14.958 15.958,15.062 15.958,13.958 L15.958,13.917 L15.958,5.875 L16.875,5.875 L16.875,2.125 Z"/></svg>';

  const entries: Entry[] = [
    { id: 'select', label: 'Modify & select', hotkey: 'V', icon: 'arrow_selector_tool' },
    { id: 'pen', label: 'Pen tool (lines and curves)', hotkey: 'P', icon: 'ink_pen', gap: true },
    { group: 'Arc/circle tools', icon: 'circle', sub: [
      { id: 'circle', label: 'New circle/ellipse', hotkey: 'C', icon: 'circle' },
      { id: 'arc-center', label: 'New center arc', hotkey: 'A', icon: 'progress_activity' },
      { id: 'arc-3pt', label: 'New three-point-arc', hotkey: 'Q', icon: 'line_curve' }
    ] },
    { id: 'point', label: 'New point', hotkey: 'N', icon: 'radio_button_checked' },
    { id: 'piece', label: 'Create pattern piece', hotkey: 'T', icon: 'extension', gap: true },
    { id: 'internal', label: 'Add internal path (dart / fold) to the selected piece', hotkey: 'D', icon: 'conversion_path' },
    { id: 'piece-point', label: 'Add piece point (construction point on a dynamic piece)', icon: 'adjust' },
    { group: 'Seam tools', svg: SEAM_MULTI, gap: true, sub: [
      { id: 'seam-single', label: 'Create single seam', hotkey: 'S', svg: SEAM_SINGLE },
      { id: 'seam-multi', label: 'Create multi seam', hotkey: 'Shift+S', svg: SEAM_MULTI }
    ] },
    { id: 'text', label: 'Insert text', hotkey: 'I', icon: 'text_fields', gap: true },
    { id: 'image', label: 'Insert image (reference / logo)', hotkey: 'G', icon: 'image' },
    { id: 'trace', label: 'Trace piece', hotkey: 'R', icon: 'polyline' },
    { id: 'measure', label: 'Measure (point to point)', hotkey: 'M', icon: 'straighten', gap: true }
  ];

  const groupActive = (e: Entry) => !!e.sub?.some((s) => s.id === $selectedTool);

  function handleKeydown(ev: KeyboardEvent) {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // Shift+S (multi seam) before plain S
    if (ev.shiftKey && ev.key.toLowerCase() === 's') { ev.preventDefault(); selectedTool.set('seam-multi'); return; }
    // Other shifted keys belong to app-level bindings (Shift+V variables, Shift+M mirror-Y).
    if (ev.shiftKey) return;
    // M doubles as "mirror selection" (studio page handler) — an active selection wins over the tool.
    if (ev.key.toLowerCase() === 'm' &&
        (get(selectedPointIds).size || get(selectedPathIds).size || get(selectedPieceIds).size)) return;
    const all: Item[] = [];
    for (const e of entries) { if (e.id) all.push(e as Item); if (e.sub) all.push(...e.sub); }
    const t = all.find((x) => x.hotkey && !x.hotkey.includes('+') && x.hotkey.toLowerCase() === ev.key.toLowerCase());
    if (t) { ev.preventDefault(); selectedTool.set(t.id); }
  }

  $effect(() => {
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });
</script>

{#snippet toolBtn(item: Item, active: boolean)}
  <button
    type="button"
    title="{item.label}{item.hotkey ? ` (${item.hotkey})` : ''}"
    aria-label={item.label}
    class="group/btn relative flex items-center h-9 justify-center btn btn-primary p-0 my-0.5 overflow-hidden transition-all self-end hover:aspect-auto aspect-square shadow"
    class:!btn-accent={active}
    onclick={() => selectedTool.set(item.id)}
  >
    <span class="min-w-0 hidden group-hover/btn:inline">
      <span class="text-xs pl-2 pr-1 whitespace-nowrap inline-flex items-center gap-1">
        {item.label}{#if item.hotkey}<span class="kbd kbd-xs">{item.hotkey}</span>{/if}
      </span>
    </span>
    <span class="block aspect-square h-full flex items-center justify-center">
      {#if item.icon}<span class="material-symbols-rounded" aria-hidden="true">{item.icon}</span>
      {:else if item.svg}{@html item.svg}{/if}
    </span>
  </button>
{/snippet}

<div class="flex flex-col m-2 absolute right-0 top-0 z-10 items-end" data-tour-id="tour-drawing-tools">
  {#each entries as e}
    {#if e.gap}<div class="h-4"></div>{/if}
    {#if e.sub}
      <!-- group with a hover flyout of sub-tools -->
      <div class="group/grp relative flex items-center self-end">
        <div class="absolute right-full mr-1 top-0 hidden group-hover/grp:flex flex-col items-end bg-base-200/95 rounded-box p-1 shadow-lg">
          {#each e.sub as s}{@render toolBtn(s, $selectedTool === s.id)}{/each}
        </div>
        <button
          type="button"
          title={e.group}
          aria-label={e.group}
          class="flex items-center h-9 justify-center btn btn-primary p-0 my-0.5 aspect-square shadow"
          class:!btn-accent={groupActive(e)}
          onclick={() => e.sub && selectedTool.set(e.sub[0].id)}
        >
          <span class="block aspect-square h-full flex items-center justify-center">
            {#if e.icon}<span class="material-symbols-rounded" aria-hidden="true">{e.icon}</span>
            {:else if e.svg}{@html e.svg}{/if}
          </span>
        </button>
      </div>
    {:else}
      {@render toolBtn(e as Item, $selectedTool === e.id)}
    {/if}
  {/each}
</div>
