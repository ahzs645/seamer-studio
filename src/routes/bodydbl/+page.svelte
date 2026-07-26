<script lang="ts">
</script>

<svelte:head>
  <title>Body Double — Seamer</title>
</svelte:head>

<div class="hero min-h-[40vh] bg-base-200">
  <div class="hero-content text-center">
    <div class="max-w-2xl">
      <h1 class="text-4xl font-bold font-lexend">Body Double</h1>
      <p class="py-6 text-lg">
        Fit your patterns to a real body, not a standard size chart. Seamer reconstructs an
        accurate 3D avatar from the measurements you actually have — and fills in the rest.
      </p>
      <a href="/studio" class="btn btn-accent btn-lg">Build Your Body Double</a>
    </div>
  </div>
</div>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <img
    src="/images/bodydbl.jpg"
    alt="Seamer body double avatar built from body measurements"
    class="rounded-lg shadow-md w-full mb-8"
  />

  <div class="prose max-w-none">
    <h2 class="text-2xl font-bold">Measurements in, body out</h2>
    <p>
      Enter the measurements you know — height, weight, chest girth, waist girth, hip girth,
      shoulder width, arm length, crotch height, and dozens more. Seamer's statistical body
      model completes the missing measurements from the ones you provide, so a handful of tape
      readings is enough to reconstruct a full, anatomically plausible avatar.
    </p>

    <h2 class="text-2xl font-bold mt-8">Built on real body statistics</h2>
    <p>
      Under the hood, the avatar is driven by a 69-measurement statistical model. Each
      measurement you enter constrains the model; the rest are regressed from population
      covariance, then a compact coefficient vector reconstructs the body surface vertex by
      vertex. The result tracks how real bodies covary — a longer torso comes with the back
      length to match.
    </p>

    <h2 class="text-2xl font-bold mt-8">Drape on the double</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Drape any pattern on the avatar with real-time cloth simulation</li>
      <li>Use <code>body.*</code> measurements directly in drafting formulas — patterns re-draft when the body changes</li>
      <li>Switch between metric and imperial; female and male body models included</li>
      <li>All measurement data stays local on your device</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Why it matters</h2>
    <p>
      Standard size charts fit almost nobody exactly. A body double means you check fit
      before cutting fabric: see where a bodice pulls, where ease pools, and how a sleeve
      hangs — on the body the garment is actually for.
    </p>
  </div>

  <div class="mt-10 text-center">
    <a href="/studio" class="btn btn-accent btn-lg">Open Studio</a>
    <a href="/software/3d" class="btn btn-outline btn-lg ml-2">About 3D Simulation</a>
  </div>
</div>
