<script lang="ts">
</script>

<svelte:head>
  <title>Elements — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Elements</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      A Seamer pattern is built from a small set of element types. Points define positions,
      paths connect them, and pieces assemble paths into cuttable panels.
    </p>

    <h2 class="text-2xl font-bold mt-8">The element hierarchy</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>
        <strong><a href="/docs/elements/points" class="link link-primary">Points</a></strong> —
        named positions in drafting space, optionally driven by parametric constraints.
      </li>
      <li>
        <strong><a href="/docs/elements/paths" class="link link-primary">Paths</a></strong> —
        lines, Bézier curves, and referenced (mirrored/copied) paths through ordered points.
      </li>
      <li>
        <strong>Pieces</strong> — closed loops of path spans forming fabric panels, with
        seam allowances, notches, internal paths (darts, fold lines), grain direction,
        cut counts, and 3D arrangement settings.
      </li>
      <li>
        <strong>Seams</strong> — connections between piece edges that pull together during
        3D simulation (and document construction order).
      </li>
      <li>
        <strong>Materials</strong> — fabrics with simulation parameters (stretch, bend,
        weight, thickness), textures, and shrinkage compensation.
      </li>
      <li>
        <strong>Annotations</strong> — text labels and reference images on the canvas.
      </li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Layers</h2>
    <p>
      Every point, path, and piece belongs to a layer. Layers can be hidden, locked,
      reordered, and styled — useful for separating construction geometry from the
      finished draft.
    </p>

    <h2 class="text-2xl font-bold mt-8">Naming</h2>
    <p>
      Elements have stable ids (used by formulas and seams) and human-readable names.
      Point names auto-generate from the pattern's labeling scheme (numeric or alphabetic
      with a prefix, e.g. <code>A0, A1, A2…</code>) and can be renamed at any time.
    </p>
  </div>
</div>
