<script lang="ts">
</script>

<svelte:head>
  <title>Cutting Features — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Cutting Features</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      Everything Seamer knows about your pattern carries through to the cut: seam allowances,
      notches, grain lines, drill markers, and cut counts all land in the output file.
    </p>

    <h2 class="text-2xl font-bold mt-8">Seam allowances done properly</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Pattern-wide default allowance with per-piece and per-edge overrides</li>
      <li>Corner finishing per edge: mitered intersection (with cap), rounded radius, or square by-length cuts</li>
      <li>Inside or outside allowances, with coverage toggles at each corner</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Production markings</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Notches: single, double, slit, and tee — balance notches placed along seam edges</li>
      <li>Drill holes and punch markers in piece-local coordinates</li>
      <li>Grain vectors and piece labels on every output</li>
      <li>Cut-on-fold pieces via first-edge symmetry; left/right cut counts with mirroring</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Shrinkage compensation</h2>
    <p>
      Materials can carry warp and weft shrinkage percentages; pieces that opt in are scaled
      up at cut time so the garment ends up the drafted size after washing and pressing.
    </p>

    <h2 class="text-2xl font-bold mt-8">Output formats</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><strong>HPGL</strong> for plotters and CNC cutters</li>
      <li><strong>PDF</strong> tiled for home printing, or full-width for wide-format</li>
      <li><strong>DXF / SVG</strong> for downstream CAD and cutter software</li>
    </ul>

    <p>
      For the marker layout and nesting workflow, see the
      <a href="/cutting" class="link link-primary">Cutting Room</a>.
    </p>
  </div>

  <div class="mt-10 text-center">
    <a href="/studio" class="btn btn-accent btn-lg">Open Studio</a>
  </div>
</div>
