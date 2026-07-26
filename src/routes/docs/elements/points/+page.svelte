<script lang="ts">
</script>

<svelte:head>
  <title>Points — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Points</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      Points are the atoms of a pattern. Every path runs through points, every piece's
      boundary is anchored to them, and every constraint resolves to a point position.
    </p>

    <h2 class="text-2xl font-bold mt-8">Data shape</h2>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`{
  "id": "point_abc123",
  "name": "A0",
  "x": 100.0,        // millimeters
  "y": 200.0,        // millimeters
  "layerId": "default",
  "constraint": {     // optional — parametric construction
    "type": "offset",
    "from": "point_origin",
    "dxFormula": "{waist_width}/4",
    "dyFormula": "0"
  }
}`}</code></pre>

    <h2 class="text-2xl font-bold mt-8">Fixed vs. constrained</h2>
    <p>
      Without a constraint, <code>x</code>/<code>y</code> are the point's fixed position —
      dragging it on canvas updates them directly. With a constraint, the solver computes
      the position from formulas and <code>x</code>/<code>y</code> hold the solved result
      (cached for fast rendering). The five constraint types — offset, length/angle, sliding,
      mirror, intersection — are documented in
      <a href="/docs/drawing/constraints" class="link link-primary">Constraints</a>.
    </p>

    <h2 class="text-2xl font-bold mt-8">Special point roles</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><strong>Sliding points</strong> — points carried <em>on</em> a path at a formula-driven position; paths list them so they re-place when the path changes.</li>
      <li><strong>Piece origins</strong> — each piece designates an origin point used for placement, rotation, grading scale, and shrinkage compensation.</li>
      <li><strong>Seam endpoints</strong> — piece edges are spans <em>from</em> one point <em>to</em> another along a path.</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Naming</h2>
    <p>
      Names follow the pattern's labeling scheme — a prefix plus a counter
      (<code>A0, A1, …</code>), numeric or alphabetic. Rename freely; formulas reference
      ids, so renames never break geometry.
    </p>
  </div>
</div>
