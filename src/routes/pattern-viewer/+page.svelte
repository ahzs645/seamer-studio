<script lang="ts">
  import type { Pattern } from '@seamer/pattern-model';
  import { pieceWorldOutline, type Vec2 } from '@seamer/pattern-model';

  interface ViewPiece {
    name: string;
    points: string; // SVG polyline points attribute
  }

  let fileName = $state<string | null>(null);
  let patternName = $state<string | null>(null);
  let pieces: ViewPiece[] = $state([]);
  let viewBox = $state('0 0 100 100');
  let error = $state<string | null>(null);

  const COLORS = ['#0ea5e9', '#f97316', '#22c55e', '#a855f7', '#ef4444', '#eab308', '#14b8a6', '#ec4899'];

  async function onFileChange(ev: Event) {
    error = null;
    pieces = [];
    patternName = null;
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    fileName = file.name;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as Pattern;
      if (!Array.isArray(data.pieces) || !Array.isArray(data.points) || !Array.isArray(data.paths)) {
        throw new Error('Not a Seamer pattern: missing pieces/points/paths arrays.');
      }
      patternName = data.name || file.name;

      const outlines: { name: string; loop: Vec2[] }[] = [];
      for (const piece of data.pieces) {
        try {
          const loop = pieceWorldOutline(data, piece);
          if (loop.length >= 3) outlines.push({ name: piece.name, loop });
        } catch {
          // skip pieces whose geometry can't be resolved
        }
      }
      if (outlines.length === 0) {
        throw new Error('No renderable piece outlines found in this pattern.');
      }

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const o of outlines) {
        for (const p of o.loop) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }
      const pad = Math.max(maxX - minX, maxY - minY) * 0.05 + 10;
      viewBox = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
      pieces = outlines.map((o) => ({
        name: o.name,
        points: o.loop.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
      }));
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to read pattern file.';
    }
  }
</script>

<svelte:head>
  <title>Pattern Viewer — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-6xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Pattern Viewer</h1>
  <p class="text-lg mb-6">
    A read-only viewer for Seamer pattern files. Open a <code>.seamer.json</code> (or any
    Seamer-format JSON, e.g. a <a href="/flow/templates" class="link link-primary">template</a>)
    to preview its piece outlines — nothing is uploaded; the file is read locally in your browser.
  </p>

  <input
    type="file"
    accept=".json,application/json"
    class="file-input file-input-bordered w-full max-w-md"
    onchange={onFileChange}
  />

  {#if error}
    <div class="alert alert-warning mt-6">
      <span>{error}</span>
    </div>
  {/if}

  {#if pieces.length > 0}
    <div class="mt-6">
      <div class="flex items-baseline justify-between flex-wrap gap-2 mb-3">
        <h2 class="text-2xl font-bold">{patternName}</h2>
        <span class="text-sm opacity-60">{pieces.length} piece{pieces.length === 1 ? '' : 's'} · {fileName}</span>
      </div>
      <div class="bg-base-200 rounded-lg p-4">
        <svg {viewBox} class="w-full max-h-[70vh]" xmlns="http://www.w3.org/2000/svg">
          {#each pieces as p, i}
            <polygon
              points={p.points}
              fill={COLORS[i % COLORS.length]}
              fill-opacity="0.15"
              stroke={COLORS[i % COLORS.length]}
              stroke-width="2"
              vector-effect="non-scaling-stroke"
            />
          {/each}
        </svg>
      </div>
      <div class="flex flex-wrap gap-3 mt-4">
        {#each pieces as p, i}
          <span class="badge badge-lg gap-2">
            <span class="inline-block w-3 h-3 rounded-full" style="background: {COLORS[i % COLORS.length]}"></span>
            {p.name}
          </span>
        {/each}
      </div>
      <p class="mt-6">
        Want to edit it? <a href="/studio" class="link link-primary">Open the Studio</a> and import the same file.
      </p>
    </div>
  {/if}
</div>
