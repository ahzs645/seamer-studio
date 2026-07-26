<script lang="ts">
</script>

<svelte:head>
  <title>Pricing — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6 text-center">Pricing</h1>
  <p class="text-lg text-center max-w-2xl mx-auto mb-10">
    Seamer is free and open. No trials, no feature gates, no accounts —
    the full pattern studio for everyone.
  </p>

  <div class="max-w-md mx-auto">
    <div class="card bg-base-200 border-2 border-accent shadow-lg">
      <div class="card-body items-center text-center">
        <h2 class="card-title text-2xl font-lexend">Free</h2>
        <p class="text-5xl font-bold my-4">$0<span class="text-lg font-normal opacity-60">/forever</span></p>
        <ul class="space-y-2 text-left w-full">
          <li>✓ Full 2D parametric pattern drafting</li>
          <li>✓ Real-time 3D draping on a custom avatar</li>
          <li>✓ Unlimited patterns, stored on your device</li>
          <li>✓ Grading profiles and multi-size output</li>
          <li>✓ DXF, SVG, PDF, and HPGL export</li>
          <li>✓ Offline support (installable PWA)</li>
        </ul>
        <div class="card-actions mt-6">
          <a href="/studio" class="btn btn-accent btn-lg">Open Studio</a>
        </div>
      </div>
    </div>
  </div>

  <div class="mt-12 p-6 bg-base-200 rounded-lg text-center max-w-2xl mx-auto">
    <h2 class="text-2xl font-bold mb-2">Want to help?</h2>
    <p class="mb-4">
      Seamer stays free because of community support. If it saves you time,
      consider chipping in.
    </p>
    <a href="/support-seamer" class="btn btn-outline">Support Seamer</a>
  </div>

  <p class="text-center mt-8">
    Not sure yet? <a href="/pricing/demo" class="link link-primary">Try the demo</a> — no setup required.
  </p>
</div>
