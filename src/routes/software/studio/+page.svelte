<script lang="ts">
</script>

<svelte:head>
  <title>Pattern Studio — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">The Pattern Studio</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      The studio is Seamer's heart: a 2D drafting canvas and a 3D simulation view, side by
      side, editing the same parametric pattern.
    </p>

    <h2 class="text-2xl font-bold mt-8">Drafting canvas</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Pen tool for lines and cubic Bézier curves with mirrored handle constraints</li>
      <li>Circle, ellipse, center-arc, and three-point-arc tools</li>
      <li>Constraint-driven points: offsets, length/angle, sliding on paths, mirrors, intersections</li>
      <li>Pieces with boundary loops, internal paths (darts, fold lines), and seam definitions</li>
      <li>Layers, grid and guide snapping, construction geometry toggle, reference images, and text</li>
      <li>Full undo/redo with labeled history</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Parametric core</h2>
    <p>
      Variables with formulas, body-measurement tokens (<code>body.waistGirth</code>), and
      path-length references make the pattern a living document — change one number and the
      draft, the grade, and the 3D drape all update. See the
      <a href="/docs/drawing/formulas" class="link link-primary">formula docs</a>.
    </p>

    <h2 class="text-2xl font-bold mt-8">Integrated 3D</h2>
    <p>
      Switch between 2D, 3D, or split view. Pieces drape on a measurement-driven avatar with
      GPU cloth simulation — details on the
      <a href="/software/3d" class="link link-primary">3D simulation page</a>.
    </p>

    <h2 class="text-2xl font-bold mt-8">Local-first by design</h2>
    <p>
      Patterns save to your browser's local database with autosave; the whole studio works
      offline as an installable PWA. No account, no upload, no lock-in — the file format is
      plain JSON.
    </p>
  </div>

  <div class="mt-10 text-center">
    <a href="/studio" class="btn btn-accent btn-lg">Open Studio</a>
    <a href="/docs" class="btn btn-outline btn-lg ml-2">Read the Docs</a>
  </div>
</div>
