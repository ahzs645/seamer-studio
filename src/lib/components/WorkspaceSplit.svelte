<script lang="ts">
  import { onMount, type Snippet } from 'svelte';

  let {
    first, second, disabled = false,
    firstLabel = '2D', secondLabel = '3D',
    firstId = 'studio-draft-view', secondId = 'studio-garment-view',
    preferenceKey = 'seamer.workspaceSplit', defaultPercentage = 50
  }: {
    first: Snippet; second: Snippet; disabled?: boolean;
    firstLabel?: string; secondLabel?: string; firstId?: string; secondId?: string;
    preferenceKey?: string; defaultPercentage?: number;
  } = $props();
  const minimum = 25;
  const maximum = 75;
  let percentage = $state(50);
  let stacked = $state(false);
  let workspace: HTMLDivElement;
  let dragging = $state(false);
  let activePointer: number | null = null;
  let dragOrigin = 0;
  let dragPercentage = 50;
  let dragSize = 1;
  const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value));

  function savePreference() {
    try { localStorage.setItem(preferenceKey, String(percentage)); } catch { /* Keep working without storage. */ }
  }

  onMount(() => {
    percentage = clamp(defaultPercentage);
    try {
      const stored = localStorage.getItem(preferenceKey);
      const value = stored === null ? NaN : Number(stored);
      if (Number.isFinite(value)) percentage = clamp(value);
    } catch { /* Keep the default when storage is unavailable. */ }
    const query = matchMedia('(max-width: 767px) and (orientation: portrait)');
    const updateOrientation = () => { stacked = query.matches; };
    updateOrientation();
    query.addEventListener('change', updateOrientation);
    return () => query.removeEventListener('change', updateOrientation);
  });

  function startDrag(event: PointerEvent) {
    if (disabled || event.button !== 0 || activePointer !== null) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLDivElement;
    const bounds = workspace.getBoundingClientRect();
    dragOrigin = stacked ? event.clientY : event.clientX;
    dragPercentage = percentage;
    dragSize = Math.max(1, (stacked ? bounds.height - handle.offsetHeight : bounds.width - handle.offsetWidth));
    activePointer = event.pointerId;
    dragging = true;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent) {
    if (disabled || activePointer !== event.pointerId) return;
    const coordinate = stacked ? event.clientY : event.clientX;
    percentage = clamp(dragPercentage + (coordinate - dragOrigin) / dragSize * 100);
  }

  function finishDrag(event: PointerEvent) {
    if (activePointer !== event.pointerId) return;
    activePointer = null;
    dragging = false;
    savePreference();
    const handle = event.currentTarget as HTMLDivElement;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  }

  function resizeWithKeyboard(event: KeyboardEvent) {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const decrease = stacked ? 'ArrowUp' : 'ArrowLeft';
    const increase = stacked ? 'ArrowDown' : 'ArrowRight';
    if (![decrease, increase, 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === decrease) percentage = clamp(percentage - 5);
    else if (event.key === increase) percentage = clamp(percentage + 5);
    else if (event.key === 'Home') percentage = minimum;
    else if (event.key === 'End') percentage = maximum;
    else percentage = clamp(defaultPercentage);
    savePreference();
  }
</script>

<div bind:this={workspace} class="split-workspace" class:dragging style:--first-pane={`${percentage}`}>
  <div id={firstId} class="split-pane draft-pane">{@render first()}</div>
  <!-- WAI-ARIA's window splitter is a focusable separator with keyboard resizing. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="workspace-divider"
    role="separator"
    tabindex={disabled ? -1 : 0}
    aria-label={`Resize ${firstLabel} and ${secondLabel} views`}
    aria-controls={`${firstId} ${secondId}`}
    aria-orientation={stacked ? 'horizontal' : 'vertical'}
    aria-valuemin={minimum}
    aria-valuemax={maximum}
    aria-valuenow={Math.round(percentage)}
    aria-valuetext={`${firstLabel} ${Math.round(percentage)}%, ${secondLabel} ${Math.round(100 - percentage)}%`}
    aria-disabled={disabled}
    title="Drag to resize. Arrow keys adjust; Enter or double-click resets."
    onpointerdown={startDrag}
    onpointermove={moveDrag}
    onpointerup={finishDrag}
    onpointercancel={finishDrag}
    onlostpointercapture={finishDrag}
    onkeydown={resizeWithKeyboard}
    ondblclick={() => { if (!disabled) { percentage = clamp(defaultPercentage); savePreference(); } }}
  ><span></span></div>
  <div id={secondId} class="split-pane garment-pane">{@render second()}</div>
</div>

<style>
  .split-workspace { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  .split-pane { display: flex; min-width: 0; min-height: 0; overflow: hidden; flex-basis: 0; }
  .draft-pane { flex-grow: var(--first-pane); }
  .garment-pane { flex-grow: calc(100 - var(--first-pane)); }
  .workspace-divider { display: flex; align-items: center; justify-content: center; width: 10px; flex-shrink: 0; cursor: col-resize; touch-action: none; background: oklch(var(--b2)); }
  .workspace-divider span { width: 2px; height: 28px; border-radius: 2px; background: oklch(var(--bc) / 0.35); }
  .workspace-divider:hover, .workspace-divider:focus-visible, .dragging .workspace-divider { background: oklch(var(--p) / 0.2); }
  .workspace-divider:focus-visible { outline: 2px solid oklch(var(--p)); outline-offset: -2px; }
  .dragging { user-select: none; }
  .workspace-divider[aria-disabled="true"] { cursor: default; }
  @media (pointer: coarse) { .workspace-divider { width: 20px; } }
  @media (max-width: 767px) and (orientation: portrait) {
    .split-workspace { flex-direction: column; }
    .workspace-divider { width: 100%; height: 20px; cursor: row-resize; }
    .workspace-divider span { width: 28px; height: 2px; }
  }
</style>
