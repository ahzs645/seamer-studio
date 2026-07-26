<script lang="ts">
</script>

<svelte:head>
  <title>Paths — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Paths</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      Paths connect points into pattern edges — straight lines, smooth curves, or
      references to other paths.
    </p>

    <h2 class="text-2xl font-bold mt-8">Path types</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><strong>Line</strong> — straight segments through its point list.</li>
      <li><strong>Curve</strong> — cubic Bézier through its points; each path point can carry a handle.</li>
      <li><strong>Referenced</strong> — a live copy of (a span of) another path, optionally mirrored across an axis. The copy follows the original as it changes.</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Bézier handles</h2>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`{
  "id": "point_abc",
  "handle": {
    "v1": { "x": -20, "y": 0 },   // incoming control offset (mm)
    "v2": { "x": 20, "y": 5 },    // outgoing control offset (mm)
    "sameLength": true,            // mirror constraint: equal handle lengths
    "sameAngle": true              // mirror constraint: opposite directions (smooth)
  }
}`}</code></pre>
    <p>
      Handles are stored as offsets relative to their anchor point. The
      <code>sameLength</code>/<code>sameAngle</code> flags keep curves smooth as you edit —
      with both set, dragging one handle mirrors the other. Handle length and angle can also
      be formula-driven.
    </p>

    <h2 class="text-2xl font-bold mt-8">Sliding points</h2>
    <p>
      A path can carry sliding points — points positioned along its arc length by a formula
      or fraction. They re-place automatically when the path's shape changes. See
      <a href="/docs/elements/points" class="link link-primary">Points</a>.
    </p>

    <h2 class="text-2xl font-bold mt-8">Paths in pieces</h2>
    <p>
      Pieces don't reference whole paths — they reference <em>spans</em>: a path id plus a
      from-point and to-point (optionally reversed). One long construction path can supply
      edges to several pieces. Each span carries its own notches, seam allowance override,
      and corner finishing.
    </p>

    <h2 class="text-2xl font-bold mt-8">Measuring</h2>
    <p>
      Every path exposes its length to the formula system as
      <code>{'{Path_id.length}'}</code> — draft a sleeve cap against the armhole length, or
      distribute gathers as a ratio of the seam they join.
    </p>
  </div>
</div>
