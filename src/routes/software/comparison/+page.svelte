<script lang="ts">
  const rows: { feature: string; seamer: string; desktop: string; cloud: string }[] = [
    { feature: 'Price', seamer: 'Free', desktop: 'One-time or subscription', cloud: 'Subscription' },
    { feature: 'Installation', seamer: 'None — runs in the browser', desktop: 'Desktop install required', cloud: 'None' },
    { feature: 'Account required', seamer: 'No', desktop: 'Usually no', cloud: 'Yes' },
    { feature: 'Works offline', seamer: 'Yes (installable PWA)', desktop: 'Yes', cloud: 'Usually no' },
    { feature: 'Data location', seamer: 'Your device (local-first)', desktop: 'Your device', cloud: 'Vendor servers' },
    { feature: 'Parametric drafting (formulas + measurements)', seamer: 'Yes', desktop: 'Varies', cloud: 'Varies' },
    { feature: '3D draping on a custom avatar', seamer: 'Yes, real-time GPU simulation', desktop: 'Often separate product', cloud: 'Varies' },
    { feature: 'Grading', seamer: 'Sizes + grading-by-example', desktop: 'Yes', cloud: 'Yes' },
    { feature: 'Export formats', seamer: 'PDF, SVG, DXF, HPGL, JSON', desktop: 'Varies', cloud: 'Varies' },
    { feature: 'Open file format', seamer: 'Yes — plain JSON', desktop: 'Often proprietary', cloud: 'Often proprietary' }
  ];
</script>

<svelte:head>
  <title>Comparison — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-5xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">How Seamer Compares</h1>
  <p class="text-lg mb-8 max-w-3xl">
    A general comparison of Seamer against typical desktop and cloud pattern CAD software.
    Capabilities vary between specific products — this table describes common patterns,
    not any particular vendor.
  </p>

  <div class="overflow-x-auto">
    <table class="table table-zebra">
      <thead>
        <tr>
          <th>Feature</th>
          <th class="text-accent">Seamer</th>
          <th>Typical desktop CAD</th>
          <th>Typical cloud CAD</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row}
          <tr>
            <td class="font-semibold">{row.feature}</td>
            <td>{row.seamer}</td>
            <td>{row.desktop}</td>
            <td>{row.cloud}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="prose max-w-none mt-8">
    <h2 class="text-2xl font-bold">When Seamer might not be the right fit</h2>
    <p>
      Mature commercial suites have decades of specialized production tooling. If your factory
      workflow depends on a specific vendor ecosystem, Seamer's open DXF/HPGL exchange lets you
      use both — draft and fit in Seamer, hand off to production in whatever your floor runs.
    </p>
  </div>

  <div class="mt-10 text-center">
    <a href="/studio" class="btn btn-accent btn-lg">Try Seamer Free</a>
  </div>
</div>
