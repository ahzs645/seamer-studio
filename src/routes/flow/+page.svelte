<script lang="ts">
  const steps = [
    {
      title: '1. Draft',
      body: 'Draft parametric pattern blocks in the studio — points, paths, pieces, darts, and seams, all driven by formulas and body measurements.'
    },
    {
      title: '2. Grade',
      body: 'Define a grading profile: named sizes with per-size variable overrides, or grading-by-example alteration tracks driven by a measurement.'
    },
    {
      title: '3. Marker',
      body: 'Nest the graded pieces on your fabric width in the Cutting Room, honoring grain lines, cut counts, and shrinkage compensation.'
    },
    {
      title: '4. Cut',
      body: 'Export HPGL for plotters and cutters, tiled PDF for print-at-home, or DXF/SVG for any downstream CAD or cutting software.'
    }
  ];
</script>

<svelte:head>
  <title>Flow — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Flow: Pattern to Production</h1>
  <p class="text-lg mb-10">
    Flow is Seamer's end-to-end production workflow — from first draft to cut fabric,
    without leaving your browser or uploading your designs anywhere.
  </p>

  <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
    {#each steps as step}
      <div class="card bg-base-200">
        <div class="card-body">
          <h2 class="card-title">{step.title}</h2>
          <p>{step.body}</p>
        </div>
      </div>
    {/each}
  </div>

  <div class="prose max-w-none">
    <h2 class="text-2xl font-bold">Why a single flow matters</h2>
    <p>
      In a fragmented toolchain, every handoff loses information: grading software doesn't know
      your construction logic, marker software doesn't know your grain rules, and a change in the
      block means redoing everything downstream. In Seamer the pattern is parametric all the way
      through — change a measurement or a variable and the grade, marker, and cut files all follow.
    </p>
    <h2 class="text-2xl font-bold mt-8">Start from a template</h2>
    <p>
      Don't draft from scratch — Seamer ships with a library of
      <a href="/flow/templates" class="link link-primary">built-in pattern templates</a>:
      skirt blocks, shirts, trousers, dresses, and more.
    </p>
  </div>

  <div class="mt-10 text-center">
    <a href="/studio" class="btn btn-accent btn-lg">Open Studio</a>
    <a href="/flow/templates" class="btn btn-outline btn-lg ml-2">Browse Templates</a>
  </div>
</div>
