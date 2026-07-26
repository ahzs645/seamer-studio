<script lang="ts">
  // Element-targeted guided tour. Each step highlights an existing `data-tour-id` anchor by
  // dimming the rest of the screen (box-shadow cutout) and positioning a tooltip card next to the
  // element's bounding rect. Steps whose anchor isn't currently rendered are skipped, so the tour
  // adapts to view mode / collapsed panels. Completion persists in localStorage ('seamer.tourDone')
  // so the first-run flow only offers it once.
  import { onMount } from 'svelte';

  const DONE_KEY = 'seamer.tourDone';
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

  /** Steps whose anchor element exists right now. */
  let steps = $state<TourStep[]>([]);
  let index = $state(0);
  let rect = $state<DOMRect | null>(null);

  const findEl = (id: string) => document.querySelector<HTMLElement>(`[data-tour-id="${id}"]`);

  function measure() {
    const step = steps[index];
    if (!step) { rect = null; return; }
    const el = findEl(step.target);
    if (!el) { rect = null; return; }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    rect = el.getBoundingClientRect();
  }

  onMount(() => {
    steps = allSteps.filter((s) => findEl(s.target));
    if (!steps.length) { finish(); return; }
    measure();
  });

  $effect(() => { index; steps; measure(); });

  function finish() {
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* storage unavailable */ }
    onclose();
  }

  const next = () => { if (index < steps.length - 1) index += 1; else finish(); };
  const back = () => { if (index > 0) index -= 1; };

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  }

  const PAD = 6; // highlight padding around the target rect
  const CARD_W = 300;

  /** Tooltip card position: below the target if there's room, otherwise above; clamped to viewport. */
  let cardStyle = $derived.by(() => {
    if (!rect) return `left:50%;top:50%;transform:translate(-50%,-50%);width:${CARD_W}px`;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - CARD_W / 2), vw - CARD_W - 8);
    const below = rect.bottom + PAD + 12;
    const top = below + 180 < vh ? below : Math.max(8, rect.top - PAD - 12 - 180);
    return `left:${left}px;top:${top}px;width:${CARD_W}px`;
  });
</script>

<svelte:window onresize={measure} onkeydown={handleKeydown} />

{#if steps.length}
  <div class="fixed inset-0 z-[300]" role="dialog" aria-modal="true" aria-label="Guided tour">
    <!-- dimmer with a cutout: the highlight box casts a huge shadow over everything else -->
    {#if rect}
      <div
        class="absolute rounded-lg border-2 border-primary pointer-events-none transition-all duration-200"
        style={`left:${rect.left - PAD}px;top:${rect.top - PAD}px;width:${rect.width + PAD * 2}px;height:${rect.height + PAD * 2}px;box-shadow:0 0 0 100vmax rgba(0,0,0,0.55)`}
      ></div>
    {:else}
      <div class="absolute inset-0 bg-black/55 pointer-events-none"></div>
    {/if}

    <div class="absolute bg-base-100 rounded-lg shadow-2xl p-4" style={cardStyle}>
      <div class="flex items-start justify-between gap-2 mb-1">
        <h3 class="font-lexend font-semibold text-sm">{steps[index].title}</h3>
        <span class="text-xs opacity-50 shrink-0">{index + 1}/{steps.length}</span>
      </div>
      <p class="text-xs opacity-80 mb-3">{steps[index].body}</p>
      <div class="flex items-center gap-1 mb-3" aria-hidden="true">
        {#each steps as _, i}
          <span class="w-1.5 h-1.5 rounded-full {i === index ? 'bg-primary' : 'bg-base-300'}"></span>
        {/each}
      </div>
      <div class="flex items-center justify-between">
        <button class="btn btn-ghost btn-xs" onclick={finish}>Skip</button>
        <div class="flex gap-1">
          <button class="btn btn-ghost btn-xs" onclick={back} disabled={index === 0}>Back</button>
          <button class="btn btn-primary btn-xs" onclick={next}>{index === steps.length - 1 ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </div>
  </div>
{/if}
