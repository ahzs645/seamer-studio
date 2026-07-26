<script lang="ts">
  // /test-nfp — developer playground for Atelier's no-fit-polygon nesting worker.
  import { nestItemsInWorker, type NestProgress } from '$lib/utils/nestingClient';
  import { markerToSVG, type MarkerLayout, type NestItem } from '$lib/utils/markerLayout';
  import type { Vec2 } from '@seamer/pattern-model';

  const poly = (pts: [number, number][]): Vec2[] => pts.map(([x, y]) => ({ x, y }));
  const area = (p: Vec2[]) => {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const u = p[i], v = p[(i + 1) % p.length]; a += u.x * v.y - v.x * u.y; }
    return Math.abs(a) / 2;
  };
  const item = (id: string, p: Vec2[]): NestItem => ({ pieceId: id, name: id, cut: p, outline: p, instanceId: id, area: area(p) });

  // Awkward test shapes (mm): two Ls, a T, a triangle, a notch plate and filler squares.
  const SHAPES: NestItem[] = [
    item('L-large', poly([[0, 0], [120, 0], [120, 120], [240, 120], [240, 240], [0, 240]])),
    item('L-small', poly([[0, 0], [80, 0], [80, 80], [160, 80], [160, 160], [0, 160]])),
    item('T-shape', poly([[0, 0], [210, 0], [210, 60], [140, 60], [140, 180], [70, 180], [70, 60], [0, 60]])),
    item('triangle', poly([[0, 0], [180, 0], [0, 140]])),
    item('notch-plate', poly([[0, 0], [200, 0], [200, 80], [120, 80], [120, 40], [80, 40], [80, 80], [0, 80]])),
    item('sq-90', poly([[0, 0], [90, 0], [90, 90], [0, 90]])),
    item('sq-70', poly([[0, 0], [70, 0], [70, 70], [0, 70]])),
    item('sq-50a', poly([[0, 0], [50, 0], [50, 50], [0, 50]])),
    item('sq-50b', poly([[0, 0], [50, 0], [50, 50], [0, 50]]))
  ];

  let fabricWidthMm = $state(500);
  let gapMm = $state(6);
  interface RunState { layout: MarkerLayout | null; progress: NestProgress | null; busy: boolean; ms: number }
  let fixed = $state<RunState>({ layout: null, progress: null, busy: false, ms: 0 });
  let rotated = $state<RunState>({ layout: null, progress: null, busy: false, ms: 0 });

  async function run() {
    for (const [rotations, slot] of [[[0], fixed], [[0, 90, 180, 270], rotated]] as const) {
      slot.busy = true;
      slot.layout = null;
      const t0 = performance.now();
      try {
        const job = nestItemsInWorker(
          SHAPES,
          { fabricWidthMm, gapMm, allowedRotations: [...rotations] },
          (p) => (slot.progress = p)
        );
        slot.layout = await job.promise;
      } catch (e) {
        console.error(e);
      } finally {
        slot.ms = Math.round(performance.now() - t0);
        slot.busy = false;
        slot.progress = null;
      }
    }
  }

  const svgOf = (l: MarkerLayout | null) => (l ? markerToSVG(l) : '');
</script>

<svelte:head>
  <title>NFP nesting test — Seamer</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="px-4 py-8 max-w-6xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-2">NFP nesting test</h1>
  <p class="mb-6 opacity-70">
    Developer playground for the no-fit-polygon nesting worker. The same shapes are nested with the
    Atelier's NFP nester packs the same awkward shapes with fixed and quarter-turn rotations.
  </p>

  <div class="flex flex-wrap items-end gap-3 mb-6">
    <label class="flex flex-col gap-1 text-sm">Fabric width (mm)
      <input type="number" min="200" step="10" class="input input-bordered input-sm w-32" bind:value={fabricWidthMm} /></label>
    <label class="flex flex-col gap-1 text-sm">Gap (mm)
      <input type="number" min="0" step="1" class="input input-bordered input-sm w-24" bind:value={gapMm} /></label>
    <button class="btn btn-primary btn-sm" onclick={run} disabled={fixed.busy || rotated.busy}>
      {#if fixed.busy || rotated.busy}<span class="loading loading-spinner loading-xs"></span>{/if}
      Run both rotation sets
    </button>
  </div>

  <div class="grid md:grid-cols-2 gap-6">
    {#each [{ title: 'Fixed grain (0°)', s: fixed }, { title: 'Quarter turns', s: rotated }] as col}
      <div>
        <div class="flex items-baseline justify-between mb-2">
          <h2 class="text-xl font-bold">{col.title}</h2>
          {#if col.s.layout}
            <span class="text-sm opacity-70">
              {Math.round(col.s.layout.usedLengthMm)} mm
              {#if col.s.layout.efficiency !== undefined} · {(col.s.layout.efficiency * 100).toFixed(1)}%{/if}
              · {col.s.ms} ms
            </span>
          {/if}
        </div>
        {#if col.s.busy}
          <div class="bg-base-200 rounded-lg p-8 text-center text-sm">
            <span class="loading loading-spinner loading-sm"></span>
            {#if col.s.progress}
              <div class="mt-2 opacity-70">Gen {col.s.progress.generation}/{col.s.progress.generations} · best {Math.round(col.s.progress.bestLengthMm)} mm</div>
            {/if}
          </div>
        {:else if col.s.layout}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <div class="bg-white rounded-lg shadow p-2 [&_svg]:w-full [&_svg]:h-auto">{@html svgOf(col.s.layout)}</div>
        {:else}
          <div class="bg-base-200 rounded-lg p-8 text-center text-sm opacity-50">Run to see the layout.</div>
        {/if}
      </div>
    {/each}
  </div>
</div>
