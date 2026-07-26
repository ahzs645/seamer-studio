<script lang="ts">
</script>

<svelte:head>
  <title>Seamer in Action — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Seamer in Action</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      A guided walkthrough: drafting a parametric pencil skirt from a blank canvas to a
      3D-draped, cut-ready pattern. Follow along in the
      <a href="/studio" class="link link-primary">studio</a>, or load the finished result
      from the <a href="/flow/templates" class="link link-primary">template library</a>
      (Pencil Skirt 2D / 3D).
    </p>

    <h2 class="text-2xl font-bold mt-8">1. Set up the body</h2>
    <p>
      Open the body panel and enter your measurements — waist girth, hip girth, waist-to-hip
      depth, and skirt length are enough for a skirt. Seamer completes the rest statistically
      (see <a href="/bodydbl" class="link link-primary">Body Double</a>).
    </p>

    <h2 class="text-2xl font-bold mt-8">2. Draft the block with constraints</h2>
    <p>
      Place an origin point, then build the block with offset constraints:
      hip line at <code>body.waistToHipsSide</code> below the waist, side seam at
      <code>body.hipGirth / 4 + ease</code>. Use the pen tool
      (<span class="kbd kbd-sm">P</span>) to connect the frame, curving the hip with
      Bézier handles.
    </p>

    <h2 class="text-2xl font-bold mt-8">3. Add the dart</h2>
    <p>
      Create the front piece (<span class="kbd kbd-sm">T</span>) from the boundary paths,
      then add an internal path (<span class="kbd kbd-sm">D</span>) for the waist dart.
      Give it a fold angle so the 3D simulation closes it.
    </p>

    <h2 class="text-2xl font-bold mt-8">4. Sew and simulate</h2>
    <p>
      Duplicate for the back, then use the seam tool (<span class="kbd kbd-sm">S</span>) to
      join side seams and waistband. Switch to 3D view: the pieces arrange around the avatar's
      torso, the simulation sews and drapes them, and you can judge the fit immediately.
      Pulling at the hip? Bump the ease variable and watch both views update.
    </p>

    <h2 class="text-2xl font-bold mt-8">5. Grade and export</h2>
    <p>
      Add a grading profile with per-size variable overrides, check the size run overlay,
      then export: tiled PDF for home printing, or DXF/HPGL for a cutter via the
      <a href="/cutting" class="link link-primary">Cutting Room</a>.
    </p>

    <h2 class="text-2xl font-bold mt-8">Where to go next</h2>
    <ul class="list-disc pl-6 space-y-1">
      <li><a href="/docs/drawing/tools" class="link link-primary">Drawing tools reference</a></li>
      <li><a href="/docs/drawing/constraints" class="link link-primary">Constraint types</a></li>
      <li><a href="/docs/drawing/formulas" class="link link-primary">Formula syntax</a></li>
    </ul>
  </div>
</div>
