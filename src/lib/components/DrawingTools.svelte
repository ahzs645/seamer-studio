<script lang="ts">
  import { DRAWING_SHORTCUTS, drawingShortcutTool } from '$lib/utils/shortcuts';
  import { tick } from 'svelte';
  import type { Editor } from '@atelier/core';
  import { editorState } from '@atelier/svelte';
  import type { Pattern } from '@seamer/pattern-model';
  import { selectedTool } from '$lib/stores/pattern';
  import { canUseDrawingShortcut, isDialogKeyboardTarget } from '$lib/utils/keyboard';

  let { editor }: { editor: Editor<Pattern> } = $props();
  // svelte-ignore state_referenced_locally -- PatternCanvas2D is keyed by Editor identity
  const editorView = editorState(editor);

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
    { id: 'select', label: 'Modify & select', hotkey: DRAWING_SHORTCUTS['select'], icon: 'arrow_selector_tool' },
    { id: 'pen', label: 'Pen tool (lines and curves)', hotkey: DRAWING_SHORTCUTS['pen'], icon: 'ink_pen', gap: true },
    { group: 'Arc/circle tools', icon: 'circle', sub: [
      { id: 'circle', label: 'New circle/ellipse', hotkey: DRAWING_SHORTCUTS['circle'], icon: 'circle' },
      { id: 'arc-center', label: 'New center arc', hotkey: DRAWING_SHORTCUTS['arc-center'], icon: 'progress_activity' },
      { id: 'arc-3pt', label: 'New three-point-arc', hotkey: DRAWING_SHORTCUTS['arc-3pt'], icon: 'line_curve' }
    ] },
    { id: 'point', label: 'New point', hotkey: DRAWING_SHORTCUTS['point'], icon: 'radio_button_checked' },
    { id: 'piece', label: 'Create pattern piece', hotkey: DRAWING_SHORTCUTS['piece'], icon: 'extension', gap: true },
    { id: 'internal', label: 'Add internal path (dart / fold) to the selected piece', hotkey: DRAWING_SHORTCUTS['internal'], icon: 'conversion_path' },
    { id: 'piece-point', label: 'Add piece point (construction point on a dynamic piece)', icon: 'adjust' },
    { group: 'Seam tools', svg: SEAM_MULTI, gap: true, sub: [
      { id: 'seam-single', label: 'Create single seam', hotkey: DRAWING_SHORTCUTS['seam-single'], svg: SEAM_SINGLE },
      { id: 'seam-multi', label: 'Create multi seam', hotkey: DRAWING_SHORTCUTS['seam-multi'], svg: SEAM_MULTI }
    ] },
    { id: 'text', label: 'Insert text', hotkey: DRAWING_SHORTCUTS['text'], icon: 'text_fields', gap: true },
    { id: 'image', label: 'Insert image (reference / logo)', hotkey: DRAWING_SHORTCUTS['image'], icon: 'image' },
    { id: 'trace', label: 'Trace piece', hotkey: DRAWING_SHORTCUTS['trace'], icon: 'polyline' },
    { id: 'measure', label: 'Measure (point to point)', hotkey: DRAWING_SHORTCUTS['measure'], icon: 'straighten', gap: true }
  ];

  const instanceId = $props.id();
  let toolbar: HTMLDivElement;
  let openGroup = $state<string | null>(null);
  let flyoutPosition = $state({ top: 0, right: 0 });

  function openFlyout(id: string) {
    const trigger = toolbar?.querySelector<HTMLButtonElement>(`[aria-controls="${id}"]`);
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    flyoutPosition = {
      top: Math.max(8, rect.top),
      right: Math.max(8, window.innerWidth - rect.left + 4)
    };
    openGroup = id;
    // The actual row size also includes theme borders and spacing. Measure the
    // rendered flyout so short landscape viewports keep every tool reachable.
    void tick().then(() => {
      if (openGroup !== id) return;
      const flyout = document.getElementById(id)?.getBoundingClientRect();
      if (!flyout) return;
      flyoutPosition = {
        top: Math.max(8, Math.min(rect.top, window.innerHeight - flyout.height - 8)),
        right: Math.max(8, Math.min(window.innerWidth - rect.left + 4, window.innerWidth - flyout.width - 8))
      };
    });
  }

  function toggleGroup(id: string) {
    if (openGroup === id) closeGroup();
    else openFlyout(id);
  }

  function chooseTool(id: string) {
    selectedTool.set(id);
    openGroup = null;
  }

  function closeGroup(restoreFocus = false) {
    if (restoreFocus && openGroup) {
      const trigger = toolbar?.querySelector<HTMLButtonElement>(`[aria-controls="${openGroup}"]`);
      trigger?.focus();
    }
    openGroup = null;
  }

  function handleFlyoutKeydown(ev: KeyboardEvent) {
    if (openGroup && ev.key === 'Escape' && !ev.defaultPrevented && !isDialogKeyboardTarget(ev.target)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      closeGroup(true);
    }
  }

  function handleOutsidePointer(ev: PointerEvent) {
    if (openGroup && ev.target instanceof Node && !toolbar?.contains(ev.target)) closeGroup();
  }

  function handleGroupKeydown(ev: KeyboardEvent, id: string) {
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      openFlyout(id);
      // Focus after rendering and applying the measured viewport clamp.
      void tick().then(() => tick()).then(() => {
        if (openGroup === id) document.getElementById(id)?.querySelector<HTMLButtonElement>('button')?.focus();
      });
    }
  }

  const groupActive = (e: Entry) => !!e.sub?.some((s) => s.id === $selectedTool);

  function handleKeydown(ev: KeyboardEvent) {
    if (!canUseDrawingShortcut(ev)) return;
    // Shift+S (multi seam) before plain S
    if (drawingShortcutTool(ev) === 'seam-multi') { ev.preventDefault(); chooseTool('seam-multi'); return; }
    // Other shifted keys belong to app-level bindings (Shift+V variables, Shift+M mirror-Y).
    if (ev.shiftKey) return;
    // M doubles as "mirror selection" (studio page handler) — an active selection wins over the tool.
    if (ev.key.toLowerCase() === 'm' &&
        (editorView.selection.get('point').size || editorView.selection.get('path').size || editorView.selection.get('piece').size)) return;
    const all: Item[] = [];
    for (const e of entries) { if (e.id) all.push(e as Item); if (e.sub) all.push(...e.sub); }
    const t = all.find((x) => x.id === drawingShortcutTool(ev));
    if (t) { ev.preventDefault(); chooseTool(t.id); }
  }

  $effect(() => {
    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('keydown', handleFlyoutKeydown, true);
    window.addEventListener('pointerdown', handleOutsidePointer, true);
    const onResize = () => closeGroup();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('keydown', handleFlyoutKeydown, true);
      window.removeEventListener('pointerdown', handleOutsidePointer, true);
      window.removeEventListener('resize', onResize);
    };
  });
</script>

{#snippet toolBtn(item: Item, active: boolean, showLabel = false)}
  <button
    type="button"
    title="{item.label}{item.hotkey ? ` (${item.hotkey})` : ''}"
    aria-label={item.label}
    aria-pressed={active}
    class="tool-button relative shrink-0 flex items-center h-9 justify-center btn btn-primary p-0 my-0.5 overflow-hidden transition-all self-end shadow"
    class:aspect-square={!showLabel}
    class:aspect-auto={showLabel}
    class:!btn-accent={active}
    onclick={() => chooseTool(item.id)}
  >
    <span class="tool-label min-w-0" class:visible-label={showLabel}>
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

<div bind:this={toolbar} class="flex flex-col m-2 absolute right-0 top-0 z-20 items-end overflow-y-auto overscroll-contain" style="max-height: calc(100% - 1rem); scrollbar-gutter: stable;" onscroll={() => closeGroup()} data-tour-id="tour-drawing-tools">
  {#each entries as e, index}
    {#if e.gap}<div class="h-4 shrink-0"></div>{/if}
    {#if e.sub}
      {@const flyoutId = `${instanceId}-drawing-group-${index}`}
      <div class="relative shrink-0 flex items-center self-end">
        <button
          type="button"
          title={e.group}
          aria-label={e.group}
          aria-expanded={openGroup === flyoutId}
          aria-controls={flyoutId}
          class="tool-group-button flex items-center h-9 justify-center btn btn-primary p-0 my-0.5 aspect-square shadow"
          class:!btn-accent={groupActive(e)}
          onclick={() => toggleGroup(flyoutId)}
          onkeydown={(ev) => handleGroupKeydown(ev, flyoutId)}
        >
          <span class="block aspect-square h-full flex items-center justify-center">
            {#if e.icon}<span class="material-symbols-rounded" aria-hidden="true">{e.icon}</span>
            {:else if e.svg}{@html e.svg}{/if}
          </span>
        </button>
        <div
          id={flyoutId}
          role="group"
          aria-label={e.group}
          hidden={openGroup !== flyoutId}
          class="fixed z-20 flex flex-col items-end bg-base-200/95 rounded-box p-1 shadow-lg max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto"
          style:top={`${flyoutPosition.top}px`}
          style:right={`${flyoutPosition.right}px`}
          class:!hidden={openGroup !== flyoutId}
        >
          {#each e.sub as s}{@render toolBtn(s, $selectedTool === s.id, true)}{/each}
        </div>
      </div>
    {:else}
      {@render toolBtn(e as Item, $selectedTool === e.id)}
    {/if}
  {/each}
</div>

<style>
  .tool-label { display: none; }
  .tool-label.visible-label { display: inline; }
  @media (max-width: 1023px) {
    .tool-button, .tool-group-button { height: 2.75rem; min-width: 2.75rem; }
  }
  /* Expand labels on a desktop pointer without shifting touch targets in a narrow pane. */
  @media (hover: hover) and (min-width: 1024px) {
    .tool-button:hover { aspect-ratio: auto; }
    .tool-button:hover .tool-label { display: inline; }
  }
</style>
