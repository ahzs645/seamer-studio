<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type { WorkspaceDockNode, WorkspaceLayout, WorkspacePaneId } from '@seamer/pattern-model';
  import {
    WORKSPACE_PANES, PANE_LABELS, MIN_WORKSPACE_RATIO, MAX_WORKSPACE_RATIO,
    normalizeWorkspaceLayout, workspacePreset, layoutPanes, nodePanes, dockPane,
    setPaneVisible, setSplitRatio, arrangeWorkspacePanes, splitDefaultRatio,
    type DockPlacement, type WorkspacePreset
  } from '$lib/utils/workspaceLayout';

  interface Props {
    layout: WorkspaceLayout;
    onchange: (layout: WorkspaceLayout) => void;
    draft: Snippet;
    garment: Snippet;
    specs: Snippet;
    disabled?: boolean;
  }
  let { layout, onchange, draft, garment, specs, disabled = false }: Props = $props();
  let resizeLayout = $state<WorkspaceLayout | null>(null);
  const safeLayout = $derived(normalizeWorkspaceLayout(resizeLayout ?? layout) ?? workspacePreset('2d'));
  const visible = $derived(layoutPanes(safeLayout));
  // Fixed keyed order keeps the component instances alive when the split tree changes order.
  const mounted = $derived(WORKSPACE_PANES.filter(pane => visible.includes(pane)));
  const slots = new SvelteMap<WorkspacePaneId, HTMLDivElement>();
  const hosts = new SvelteMap<WorkspacePaneId, HTMLDivElement>();
  const paneDomIds: Record<WorkspacePaneId, string> = {
    '2d': 'studio-draft-view', '3d': 'studio-garment-view', specs: 'studio-specs-view'
  };
  let stacked = $state(false);
  let optionsOpen = $state(false);
  let source = $state<WorkspacePaneId>('2d');
  let target = $state<WorkspacePaneId>('3d');
  let placement = $state<DockPlacement>('after');
  let optionsButton = $state<HTMLButtonElement>();
  let optionsPanel = $state<HTMLDivElement>();
  let optionsTrigger: HTMLElement | null = null;
  let pendingFocus: HTMLElement | null = null;
  let draggedPane = $state<WorkspacePaneId | null>(null);
  let dropTarget = $state<{ pane: WorkspacePaneId; placement: DockPlacement } | null>(null);
  let resize = $state<{ id: string; pointer: number; origin: number; ratio: number; size: number; vertical: boolean } | null>(null);
  const targetOptions = $derived(visible.filter(pane => pane !== source));
  $effect(() => {
    if (!visible.includes(source)) source = visible[0];
    if (!visible.includes(target) || target === source) target = visible.find(pane => pane !== source) ?? source;
  });

  onMount(() => {
    const media = matchMedia('(max-width: 767px) and (orientation: portrait)');
    const update = () => { stacked = media.matches; };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  });

  function registerSlot(node: HTMLDivElement, pane: WorkspacePaneId) {
    let registered = pane;
    slots.set(pane, node);
    return {
      update(next: WorkspacePaneId) {
        if (next === registered) return;
        if (slots.get(registered) === node) slots.delete(registered);
        registered = next;
        slots.set(next, node);
      },
      destroy: () => { if (slots.get(registered) === node) slots.delete(registered); }
    };
  }
  function registerHost(node: HTMLDivElement, pane: WorkspacePaneId) {
    hosts.set(pane, node);
    return { destroy: () => { if (hosts.get(pane) === node) hosts.delete(pane); } };
  }
  // Reparent the existing pane DOM; rendering a snippet at each tree leaf would remount its renderer.
  $effect(() => {
    safeLayout.root;
    for (const pane of mounted) {
      const slot = slots.get(pane), host = hosts.get(pane);
      if (slot && host && host.parentElement !== slot) slot.appendChild(host);
    }
    const focused = pendingFocus;
    if (focused) {
      pendingFocus = null;
      if (focused.isConnected && !focused.matches(':disabled')) focused.focus({ preventScroll: true });
      else optionsButton?.focus({ preventScroll: true });
    }
  });

  function change(next: WorkspaceLayout) {
    if (disabled || JSON.stringify(next) === JSON.stringify(safeLayout)) return;
    pendingFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onchange(next);
  }
  function containKeys(event: KeyboardEvent) {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
  }
  async function openOptions(event: MouseEvent, pane?: WorkspacePaneId) {
    if (disabled) return;
    optionsTrigger = event.currentTarget as HTMLElement;
    source = pane ?? visible[0];
    target = visible.find(id => id !== source) ?? source;
    optionsOpen = true;
    await tick();
    optionsPanel?.querySelector<HTMLElement>('select:not([disabled]),button:not([disabled])')?.focus();
  }
  function closeOptions() {
    optionsOpen = false;
    optionsTrigger?.focus({ preventScroll: true });
  }
  function optionsKey(event: KeyboardEvent) {
    containKeys(event);
    if (event.key === 'Escape') { event.preventDefault(); closeOptions(); }
  }
  function updateSource(value: WorkspacePaneId) {
    source = value;
    if (!visible.includes(target) || source === target) target = visible.find(id => id !== source) ?? source;
  }
  function movePane() { change(dockPane(safeLayout, source, target, placement)); }
  function label(node: WorkspaceDockNode): string {
    const panes = nodePanes(node);
    return panes.length === 2 && panes.includes('2d') && panes.includes('3d') ? 'Design' :
      panes.map(pane => PANE_LABELS[pane]).join(' + ');
  }
  function branchId(node: WorkspaceDockNode, id: string, side: string): string | undefined {
    if (node.type === 'pane') return;
    const panes = nodePanes(node);
    return panes.length === 2 && panes.includes('2d') && panes.includes('3d') ? 'studio-design-view' : `workspace-${id}-${side}`;
  }
  function startResize(event: PointerEvent, node: Extract<WorkspaceDockNode, { type: 'split' }>) {
    if (disabled || event.button !== 0 || resize) return;
    event.preventDefault(); event.stopPropagation();
    const handle = event.currentTarget as HTMLDivElement;
    const bounds = handle.parentElement!.getBoundingClientRect();
    const vertical = stacked || node.direction === 'vertical';
    resize = { id: node.id, pointer: event.pointerId, origin: vertical ? event.clientY : event.clientX,
      ratio: node.ratio, size: Math.max(1, vertical ? bounds.height - handle.offsetHeight : bounds.width - handle.offsetWidth), vertical };
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
  }
  function resizeMove(event: PointerEvent) {
    if (!resize || resize.pointer !== event.pointerId || disabled) return;
    const position = resize.vertical ? event.clientY : event.clientX;
    resizeLayout = setSplitRatio(safeLayout, resize.id, resize.ratio + (position - resize.origin) / resize.size);
  }
  function resizeEnd(event: PointerEvent, cancel = false) {
    if (!resize || resize.pointer !== event.pointerId) return;
    const next = resizeLayout;
    resize = null;
    resizeLayout = null;
    if (next && !cancel) change(next);
    const handle = event.currentTarget as HTMLDivElement;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  }
  function resizeKey(event: KeyboardEvent, node: Extract<WorkspaceDockNode, { type: 'split' }>) {
    if (disabled || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    containKeys(event);
    const vertical = stacked || node.direction === 'vertical';
    const decrease = vertical ? 'ArrowUp' : 'ArrowLeft', increase = vertical ? 'ArrowDown' : 'ArrowRight';
    if (![decrease, increase, 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    const ratio = event.key === 'Home' ? MIN_WORKSPACE_RATIO : event.key === 'End' ? MAX_WORKSPACE_RATIO :
      event.key === 'Enter' ? splitDefaultRatio(node) : node.ratio + (event.key === decrease ? -0.05 : 0.05);
    change(setSplitRatio(safeLayout, node.id, ratio));
  }
  function dragStart(event: DragEvent, pane: WorkspacePaneId) {
    if (disabled || !event.dataTransfer || visible.length < 2) { event.preventDefault(); return; }
    draggedPane = pane;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-seamer-workspace-pane', pane);
  }
  function dragEnd() { draggedPane = null; dropTarget = null; }
  function dragOver(event: DragEvent, pane: WorkspacePaneId) {
    if (disabled || !draggedPane || draggedPane === pane) return;
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const bounds = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = (event.clientX - bounds.left) / Math.max(1, bounds.width), y = (event.clientY - bounds.top) / Math.max(1, bounds.height);
    const distance = Math.min(x, 1 - x, y, 1 - y);
    const placement: DockPlacement = distance === y ? 'above' : distance === 1 - y ? 'below' : distance === x ? 'before' : 'after';
    dropTarget = { pane, placement };
  }
  function drop(event: DragEvent, pane: WorkspacePaneId) {
    if (disabled || !draggedPane || !dropTarget || dropTarget.pane !== pane) return;
    event.preventDefault(); event.stopPropagation();
    change(dockPane(safeLayout, draggedPane, pane, dropTarget.placement));
    dragEnd();
  }
</script>

<div class="workspace-dock" data-testid="workspace-dock" aria-disabled={disabled}>
  <div class="layout-heading" data-keyboard-scope="workspace">
    <span class="text-xs">Custom workspace</span>
    <button bind:this={optionsButton} type="button" class="btn btn-ghost btn-xs" aria-label="Workspace layout options"
      aria-expanded={optionsOpen} disabled={disabled} onclick={(event) => optionsOpen ? closeOptions() : openOptions(event)}
      onkeydown={containKeys}>Layout</button>
  </div>
  {#if optionsOpen}
    <div bind:this={optionsPanel} class="layout-options" role="dialog" aria-label="Arrange workspace panes" tabindex="-1" onkeydown={optionsKey} data-keyboard-scope="workspace">
      <div class="options-title"><strong>Arrange workspace panes</strong><button type="button" class="btn btn-ghost btn-xs" aria-label="Close layout options" onclick={closeOptions}>✕</button></div>
      <fieldset disabled={disabled}>
        <legend>Visible panes</legend>
        <div class="pane-toggles">
          {#each WORKSPACE_PANES as pane}
            <label><input type="checkbox" checked={visible.includes(pane)} aria-label={`Show ${PANE_LABELS[pane]} pane`}
              disabled={disabled || (visible.length === 1 && visible.includes(pane))}
              onchange={(event) => change(setPaneVisible(safeLayout, pane, event.currentTarget.checked))} /> {PANE_LABELS[pane]}</label>
          {/each}
        </div>
        <div class="move-controls">
          <label>Move pane<select aria-label="Move pane" value={source} onchange={(event) => updateSource(event.currentTarget.value as WorkspacePaneId)}>
            {#each visible as pane}<option value={pane}>{PANE_LABELS[pane]}</option>{/each}
          </select></label>
          <label>Relative to<select aria-label="Relative to pane" bind:value={target} disabled={disabled || !targetOptions.length}>
            {#each targetOptions as pane}<option value={pane}>{PANE_LABELS[pane]}</option>{/each}
          </select></label>
          <label>Position<select aria-label="Dock position" bind:value={placement}>
            <option value="before">Before (left)</option><option value="after">After (right)</option>
            <option value="above">Above</option><option value="below">Below</option>
          </select></label>
          <button type="button" class="btn btn-sm" disabled={disabled || !targetOptions.length} onclick={movePane}>Move pane</button>
        </div>
        <div class="preset-controls">
          <button type="button" class="btn btn-ghost btn-sm" disabled={disabled || visible.length < 2} onclick={() => change(arrangeWorkspacePanes(safeLayout, 'horizontal'))}>Arrange horizontally</button>
          <button type="button" class="btn btn-ghost btn-sm" disabled={disabled || visible.length < 2} onclick={() => change(arrangeWorkspacePanes(safeLayout, 'vertical'))}>Arrange vertically</button>
          <label>Preset<select aria-label="Workspace layout preset" value="" onchange={(event) => { if (event.currentTarget.value) change(workspacePreset(event.currentTarget.value as WorkspacePreset)); event.currentTarget.value = ''; }}>
            <option value="" disabled>Choose preset</option><option value="2d">2D only</option><option value="both">2D + 3D</option>
            <option value="3d">3D only</option><option value="specs">Specs only</option><option value="all">2D + 3D + Specs</option>
          </select></label>
        </div>
      </fieldset>
      <p class="text-xs">Move panes with these controls or drag a pane heading to an edge of another pane. Drag dividers to resize; arrow keys adjust, Enter resets.</p>
    </div>
  {/if}
  <div class="dock-tree">{@render renderNode(safeLayout.root)}</div>
  <div class="pane-pool" aria-hidden="true">
    {#each mounted as pane (pane)}
      <div use:registerHost={pane} id={paneDomIds[pane]} class="dock-pane" data-workspace-pane={pane}>
        <div class="pane-heading" role="toolbar" aria-label={`${PANE_LABELS[pane]} pane tools`} tabindex="-1" onkeydown={containKeys} data-keyboard-scope="workspace">
          <span>{PANE_LABELS[pane]}</span>
          <button type="button" class="btn btn-ghost btn-xs" aria-label={`Move ${PANE_LABELS[pane]} pane`} title="Move pane: drag or open layout controls"
            disabled={disabled || visible.length < 2} draggable={!disabled && visible.length > 1}
            ondragstart={(event) => dragStart(event, pane)} ondragend={dragEnd} onclick={(event) => openOptions(event, pane)}>↕</button>
          <button type="button" class="btn btn-ghost btn-xs" aria-label={`Hide ${PANE_LABELS[pane]} pane`} disabled={disabled || visible.length === 1}
            onclick={() => change(setPaneVisible(safeLayout, pane, false))}>×</button>
        </div>
        <div class="pane-content">{#if pane === '2d'}{@render draft()}{:else if pane === '3d'}{@render garment()}{:else}{@render specs()}{/if}</div>
      </div>
    {/each}
  </div>
</div>

{#snippet renderNode(node: WorkspaceDockNode)}
  {#if node.type === 'pane'}
    <!-- Internal pane drag/drop only; native move controls supply the keyboard/touch alternative. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pane-slot" use:registerSlot={node.pane} data-pane-slot={node.pane} class:drop-active={dropTarget?.pane === node.pane}
      ondragover={(event) => dragOver(event, node.pane)} ondrop={(event) => drop(event, node.pane)}>
      {#if dropTarget?.pane === node.pane}<div class="drop-marker" data-placement={dropTarget.placement}>{dropTarget.placement === 'before' ? 'Dock left' : dropTarget.placement === 'after' ? 'Dock right' : `Dock ${dropTarget.placement}`}</div>{/if}
    </div>
  {:else}
    <div class="dock-split" class:vertical={stacked || node.direction === 'vertical'} data-split-id={node.id} data-split-direction={node.direction}>
      <div class="split-child" id={branchId(node.first, node.id, 'first')} style:flex-grow={node.ratio}>{@render renderNode(node.first)}</div>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div class="dock-divider" role="separator" tabindex={disabled ? -1 : 0}
        aria-label={`Resize ${label(node.first)} and ${label(node.second)} views`}
        aria-controls={nodePanes(node).map(pane => paneDomIds[pane]).join(' ')}
        aria-orientation={stacked || node.direction === 'vertical' ? 'horizontal' : 'vertical'}
        aria-valuemin={MIN_WORKSPACE_RATIO * 100} aria-valuemax={MAX_WORKSPACE_RATIO * 100}
        aria-valuenow={Math.round(node.ratio * 100)} aria-valuetext={`${label(node.first)} ${Math.round(node.ratio * 100)}%, ${label(node.second)} ${Math.round((1 - node.ratio) * 100)}%`}
        aria-disabled={disabled} title="Drag to resize. Arrow keys adjust; Enter or double-click resets."
        onpointerdown={(event) => startResize(event, node)} onpointermove={resizeMove} onpointerup={resizeEnd}
        onpointercancel={(event) => resizeEnd(event, true)} onlostpointercapture={(event) => resizeEnd(event, true)} onkeydown={(event) => resizeKey(event, node)}
        ondblclick={() => change(setSplitRatio(safeLayout, node.id, splitDefaultRatio(node)))}><span></span></div>
      <div class="split-child" id={branchId(node.second, node.id, 'second')} style:flex-grow={1 - node.ratio}>{@render renderNode(node.second)}</div>
    </div>
  {/if}
{/snippet}

<style>
  .workspace-dock { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
  .layout-heading { display: flex; justify-content: space-between; align-items: center; min-height: 28px; padding: 0 0.5rem; background: oklch(var(--b2)); border-bottom: 1px solid oklch(var(--b3)); flex-shrink: 0; }
  .layout-options { position: absolute; top: 28px; right: 0; z-index: 35; width: min(540px, 100%); max-height: min(440px, 80%); overflow: auto; padding: 0.75rem; border: 1px solid oklch(var(--b3)); border-radius: 0.35rem; background: oklch(var(--b1)); box-shadow: 0 4px 20px #0004; }
  .options-title, .pane-toggles { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  fieldset { margin-top: 0.5rem; } legend { font-size: 0.8rem; margin-bottom: 0.25rem; }
  .pane-toggles label { display: flex; align-items: center; gap: 0.25rem; min-height: 36px; }
  .move-controls { display: grid; grid-template-columns: 1fr 1fr; align-items: end; gap: 0.5rem; margin: 0.5rem 0; }
  .move-controls label, .preset-controls label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; min-width: 0; }
  select { padding: 0.25rem; min-width: 0; min-height: 32px; border: 1px solid oklch(var(--b3)); border-radius: 0.25rem; background: oklch(var(--b2)); }
  .preset-controls { display: flex; gap: 0.25rem; flex-wrap: wrap; align-items: end; margin-bottom: 0.5rem; }
  .dock-tree, .dock-split, .split-child, .pane-slot, .pane-content { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  .dock-split.vertical { flex-direction: column; }
  .split-child { flex-basis: 0; }
  .pane-slot { position: relative; }
  .dock-pane { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
  .pane-heading { display: flex; align-items: center; gap: 0.25rem; min-height: 28px; flex-shrink: 0; padding-left: 0.35rem; border-bottom: 1px solid oklch(var(--b3)); background: oklch(var(--b2)); font-size: 0.75rem; }
  .pane-heading > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pane-heading button { flex-shrink: 0; }
  .pane-content { flex-direction: column; }
  .pane-pool { display: none; }
  .dock-divider { display: flex; align-items: center; justify-content: center; width: 10px; flex-shrink: 0; background: oklch(var(--b2)); cursor: col-resize; touch-action: none; }
  .dock-divider > span { width: 2px; height: 28px; border-radius: 2px; background: oklch(var(--bc) / 0.35); }
  .vertical > .dock-divider { height: 10px; width: 100%; cursor: row-resize; }
  .vertical > .dock-divider > span { width: 28px; height: 2px; }
  .dock-divider:focus-visible, .dock-divider:hover { background: oklch(var(--p) / 0.2); outline: 2px solid oklch(var(--p)); outline-offset: -2px; }
  .dock-divider[aria-disabled="true"] { cursor: default; }
  .drop-marker { position: absolute; inset: 0; z-index: 30; pointer-events: none; border: 3px solid oklch(var(--p)); background: oklch(var(--p) / 0.12); display: flex; align-items: center; justify-content: center; font-weight: bold; }
  @media (max-width: 1023px), (pointer: coarse) { .pane-heading button, .layout-heading button, .layout-options button, .layout-options select { min-height: 44px; min-width: 44px; } .pane-toggles label { min-height: 44px; } .layout-options { top: 44px; } .dock-divider { width: 20px; } .vertical > .dock-divider { height: 20px; } }
</style>
