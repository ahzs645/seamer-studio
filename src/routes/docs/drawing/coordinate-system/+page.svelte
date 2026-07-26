<script lang="ts">
</script>

<svelte:head>
  <title>Coordinate System — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Coordinate System</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      All 2D geometry in a Seamer pattern is stored in <strong>millimeters</strong>,
      regardless of the display unit you draft in.
    </p>

    <h2 class="text-2xl font-bold mt-8">Units</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><strong>Storage:</strong> point coordinates, handle offsets, seam allowances, and notch sizes are always mm.</li>
      <li><strong>Display:</strong> the pattern's <code>lengthUnit</code> (inch, cm, or mm) controls how values appear in panels and formula inputs; conversion happens at the UI boundary.</li>
      <li><strong>Angles:</strong> stored and solved in degrees (a <code>radians</code> display option exists).</li>
      <li><strong>3D:</strong> the renderer divides mm by 1000 — 3D space is in meters.</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Spaces</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>
        <strong>Drafting space</strong> — where points and paths live. This is the space
        constraints solve in.
      </li>
      <li>
        <strong>Piece-local space</strong> — each piece has an <code>origin</code> point,
        a <code>position</code>, and a <code>rotation</code>; internal markers (drill/punch)
        are stored piece-local.
      </li>
      <li>
        <strong>Plan (world) space</strong> — pieces placed on the canvas via their transform,
        including mirroring and material shrinkage scaling. Markers and exports use world space.
      </li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Canvas view</h2>
    <p>
      The view is a pan offset (<code>graphicsOffset</code>) plus a zoom factor
      (<code>graphicsScale</code>, canvas pixels per mm). Grid display, grid snapping, and
      guide snapping are pattern settings, so they travel with the file.
    </p>

    <h2 class="text-2xl font-bold mt-8">Practical notes</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Formulas always evaluate in mm and degrees — a formula result of <code>25.4</code> is one inch.</li>
      <li>The default seam allowance of <code>12.7</code> mm is 1/2 inch.</li>
      <li>Y increases downward on the 2D canvas, matching screen coordinates.</li>
    </ul>
  </div>
</div>
