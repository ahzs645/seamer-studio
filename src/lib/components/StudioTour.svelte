<script lang="ts">
  // Element-targeted guided tour. Each step highlights an existing `data-tour-id` anchor by
  // dimming the rest of the screen (box-shadow cutout) and positioning a tooltip card next to the
  // element's bounding rect. Steps whose anchor isn't currently rendered are skipped, so the tour
  // adapts to view mode / collapsed panels. Completion persists in localStorage ('seamer.tourDone')
  // so the first-run flow only offers it once.
  import { onMount, tick } from 'svelte';
  import { containModalTab } from '$lib/utils/focus';

  const DONE_KEY = 'seamer.tourDone';
  const instanceId = $props.id();
  let dialog = $state<HTMLDialogElement>();
  let card = $state<HTMLDivElement>();
  let nextButton = $state<HTMLButtonElement>();
  let launcher: HTMLElement | null = null;
  let mounted = false;
  let finished = false;
  let cardHeight = $state(180);
  let viewport = $state({ width: 0, height: 0 });
  let { onclose }: { onclose: () => void } = $props();

  interface TourStep { target: string; title: string; body: string }

  const allSteps: TourStep[] = [
    { target: 'tour-drawing-tools', title: 'Drawing tools', body: 'All drawing tools live on this vertical bar. Pick the pen, point, piece or seam tools to draft your pattern.' },
    { target: 'tour-toolbar', title: 'Canvas toolbar', body: 'Switch tools, toggle the grid and piece names, and zoom the 2D canvas from this bar.' },
    { target: 'tour-view-mode', title: 'View modes', body: 'Flip between the 2D drafting canvas, the 3D try-on view, or both side by side.' },
    { target: 'tour-left-panel', title: 'Layers, body & fabric', body: 'Manage layers, adjust the avatar’s body measurements, assign fabrics and connect seams from these tabs.' },
    { target: 'tour-properties', title: 'Properties', body: 'Everything you select — points, paths, pieces — exposes its properties and formulas here.' },
    { target: 'tour-canvas-3d', title: '3D try-on', body: 'Your pieces drape on a parametric avatar in real time. Orbit with the mouse to inspect the fit.' },
    { target: 'tour-3d-controls', title: 'Simulation controls', body: 'Run, pause and reset the cloth simulation — and tweak drape quality — from this rail.' },
    { target: 'tour-save', title: 'Save your work', body: 'Patterns auto-save locally, and this button saves on demand (Ctrl+S works too).' }
  ];

  /** Steps whose anchor is visible in the current workspace. */
  let steps = $state<TourStep[]>([]);
  let index = $state(0);
  let rect = $state<DOMRect | null>(null);

  const findEl = (id: string) => document.querySelector<HTMLElement>(`[data-tour-id="${id}"]`);

  function visibleAnchor(id: string): HTMLElement | null {
    const el = findEl(id);
    if (!el || getComputedStyle(el).visibility === 'hidden') return null;
    const bounds = el.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 &&
      bounds.top < window.innerHeight && bounds.left < window.innerWidth ? el : null;
  }

  function measure() {
    if (!mounted) return;
    viewport = { width: window.innerWidth, height: window.innerHeight };
    const el = steps[index] && visibleAnchor(steps[index].target);
    rect = el ? el.getBoundingClientRect() : null;
  }

  function refreshSteps() {
    if (!mounted) return;
    const previousTarget = steps[index]?.target;
    steps = allSteps.filter((step) => visibleAnchor(step.target));
    const previousIndex = steps.findIndex((step) => step.target === previousTarget);
    index = previousIndex >= 0 ? previousIndex : Math.min(index, Math.max(0, steps.length - 1));
    if (!steps.length) { finish(); return; }
    measure();
  }

  onMount(() => {
    mounted = true;
    launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    refreshSteps();
    let observer: ResizeObserver | null = null;
    void tick().then(() => {
      if (!mounted || finished || !dialog || !card || !nextButton) return;
      dialog.showModal();
      nextButton.focus();
      observer = new ResizeObserver(() => { if (card) cardHeight = card.getBoundingClientRect().height; });
      observer.observe(card);
    });
    return () => {
      mounted = false;
      observer?.disconnect();
      if (dialog?.open) dialog.close();
      if (launcher?.isConnected) launcher.focus({ preventScroll: true });
    };
  });

  $effect(() => { index; steps; if (mounted) measure(); });

  function finish() {
    if (finished) return;
    finished = true;
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* storage unavailable */ }
    if (dialog?.open) dialog.close();
    if (launcher?.isConnected) launcher.focus({ preventScroll: true });
    onclose();
  }

  const next = () => { if (index < steps.length - 1) index += 1; else finish(); };
  const back = () => {
    if (index <= 0) return;
    const focusedButton = document.activeElement;
    index -= 1;
    if (index === 0) void tick().then(() => {
      if (mounted && !finished && focusedButton instanceof HTMLButtonElement && focusedButton.disabled) nextButton?.focus();
    });
  };

  function handleKeydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); finish(); }
    else if (!event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'ArrowRight') { event.preventDefault(); next(); }
    else if (!event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); back(); }
    else if (dialog) containModalTab(event, dialog);
    // Enter/Space activate the focused native button (including Back and Skip).
  }

  const PAD = 6; // highlight padding around the target rect
  const CARD_W = 300;

  /** Tooltip card position: below the target if there's room, otherwise above; clamped to viewport. */
  let cardStyle = $derived.by(() => {
    const width = Math.min(CARD_W, Math.max(0, viewport.width - 16));
    const height = Math.min(cardHeight, Math.max(0, viewport.height - 16));
    const left = rect ? Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), viewport.width - width - 8) : Math.max(8, (viewport.width - width) / 2);
    const below = rect ? rect.bottom + PAD + 12 : (viewport.height - height) / 2;
    const idealTop = rect && below + height > viewport.height - 8 ? rect.top - PAD - 12 - height : below;
    const top = Math.max(8, Math.min(idealTop, viewport.height - height - 8));
    return `left:${left}px;top:${top}px;width:${width}px;max-height:calc(100dvh - 16px);overflow-y:auto`;
  });
</script>

<svelte:window onresize={refreshSteps} onscroll={measure} />

{#if steps.length}
  <dialog bind:this={dialog} class="fixed inset-0 z-[300] m-0 p-0 border-0 w-screen h-[100dvh] max-w-none max-h-none bg-transparent text-base-content overflow-hidden backdrop:bg-transparent" aria-label="Guided tour" aria-describedby={`${instanceId}-body`}
    onkeydown={handleKeydown} oncancel={(event) => { event.preventDefault(); finish(); }}
  >
    <!-- dimmer with a cutout: the highlight box casts a huge shadow over everything else -->
    {#if rect}
      <div
        class="absolute rounded-lg border-2 border-primary pointer-events-none transition-all duration-200"
        style={`left:${rect.left - PAD}px;top:${rect.top - PAD}px;width:${rect.width + PAD * 2}px;height:${rect.height + PAD * 2}px;box-shadow:0 0 0 100vmax rgba(0,0,0,0.55)`}
      ></div>
    {:else}
      <div class="absolute inset-0 bg-black/55 pointer-events-none"></div>
    {/if}

    <div bind:this={card} class="absolute bg-base-100 rounded-lg shadow-2xl p-4" style={cardStyle}>
      <div class="flex items-start justify-between gap-2 mb-1">
        <h3 aria-live="polite" class="font-lexend font-semibold text-sm">{steps[index].title}</h3>
        <span class="text-xs opacity-50 shrink-0">{index + 1}/{steps.length}</span>
      </div>
      <p id={`${instanceId}-body`} class="text-xs opacity-80 mb-3">{steps[index].body}</p>
      <div class="flex items-center gap-1 mb-3" aria-hidden="true">
        {#each steps as _, i}
          <span class="w-1.5 h-1.5 rounded-full {i === index ? 'bg-primary' : 'bg-base-300'}"></span>
        {/each}
      </div>
      <div class="flex items-center justify-between">
        <button class="btn btn-ghost btn-xs" onclick={finish}>Skip</button>
        <div class="flex gap-1">
          <button class="btn btn-ghost btn-xs" onclick={back} disabled={index === 0}>Back</button>
          <button bind:this={nextButton} class="btn btn-primary btn-xs" onclick={next}>{index === steps.length - 1 ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </div>
  </dialog>
{/if}
