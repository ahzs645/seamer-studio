<script lang="ts">
</script>

<svelte:head>
  <title>Cutting Room — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Cutting Room</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      The Cutting Room takes finished patterns from the studio to the cutting table:
      lay out pieces on fabric, nest them efficiently, and send the result straight
      to a plotter or cutter.
    </p>

    <h2 class="text-2xl font-bold mt-8">Marker layout &amp; nesting</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Lay out graded pieces on a fabric width of your choice</li>
      <li>Automatic nesting to minimize fabric waste, with manual fine-tuning</li>
      <li>Respect grain lines, cut counts (left/right pairs, mirrored pieces), and fold lines</li>
      <li>Per-material shrinkage compensation scales pieces for cut accuracy</li>
      <li>Seam allowance polygons computed per edge, with corner finishing (miter, radius, or square)</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">From screen to blade</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><strong>HPGL export</strong> — drive pen plotters and CNC fabric cutters directly</li>
      <li><strong>PDF export</strong> — tiled, print-at-home markers with assembly guides</li>
      <li><strong>DXF / SVG export</strong> — exchange with other CAD and cutting software</li>
      <li>Notches, drill holes, and punch markers carried through to the cut file</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Local-first, like everything else</h2>
    <p>
      Nesting runs in your browser — no upload, no per-marker fees. Your production data
      stays on your machine. See <a href="/connect" class="link link-primary">Connect</a> for
      hooking up cutting hardware, and <a href="/flow" class="link link-primary">Flow</a> for
      the full pattern-to-cut workflow.
    </p>
  </div>

  <div class="mt-10 text-center">
    <a href="/studio" class="btn btn-accent btn-lg">Open Studio</a>
  </div>
</div>
