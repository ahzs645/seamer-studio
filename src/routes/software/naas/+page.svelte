<script lang="ts">
</script>

<svelte:head>
  <title>Nesting — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Nesting, Without the Service</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      Many pattern CAD vendors sell automatic marker nesting as a metered cloud service —
      you upload your pieces, pay per marker, and wait for results. Seamer takes the
      opposite approach: nesting runs locally, in your browser, for free.
    </p>

    <h2 class="text-2xl font-bold mt-8">Local nesting</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Automatic piece placement to reduce fabric waste, computed on your machine</li>
      <li>No upload — your production patterns never leave your device</li>
      <li>No per-marker fees, no queue, no rate limits</li>
      <li>Manual drag-and-drop refinement after the automatic pass</li>
      <li>Constraints respected: grain direction, cut counts, mirroring, fold pieces</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Honest trade-offs</h2>
    <p>
      Dedicated industrial nesting engines running on server farms can squeeze out a percent
      or two more utilization on very large markers. For most studios and small production
      runs, local nesting plus a minute of manual adjustment gets equivalent results —
      with zero marginal cost and full data privacy.
    </p>

    <h2 class="text-2xl font-bold mt-8">Straight to the cutter</h2>
    <p>
      Finished markers export as HPGL, PDF, DXF, or SVG. See
      <a href="/software/cutting" class="link link-primary">cutting features</a> and the
      <a href="/cutting" class="link link-primary">Cutting Room</a> overview.
    </p>
  </div>

  <div class="mt-10 text-center">
    <a href="/studio" class="btn btn-accent btn-lg">Open Studio</a>
  </div>
</div>
