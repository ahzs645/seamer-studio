<script lang="ts">
  const faqs: { q: string; a: string }[] = [
    {
      q: 'What is Seamer?',
      a: 'Seamer is free digital pattern drafting software that runs entirely in your browser. You draft parametric 2D garment patterns with points, paths, and pieces, then drape them on a customizable 3D avatar with real-time cloth simulation — no installation, no account required.'
    },
    {
      q: 'What drawing tools does the studio include?',
      a: 'The studio has a modify/select tool, a pen tool for lines and Bézier curves, circle/ellipse and arc tools (center arc and three-point arc), a point tool, piece creation, internal paths for darts and fold lines, single and multi seam tools, plus text and image insertion. Every tool has a keyboard shortcut (V, P, C, N, T, S, and more).'
    },
    {
      q: 'How does the parametric drafting work?',
      a: 'Points can be constrained with formulas — offsets, length/angle constructions, sliding points on paths, mirrors, and ray intersections. Formulas reference your own variables and body measurements (like body.waistGirth), so changing a measurement re-drafts the whole pattern automatically.'
    },
    {
      q: 'How does the 3D simulation work?',
      a: 'Pattern pieces are triangulated and arranged around a statistically reconstructed body avatar. A GPU cloth simulation sews the pieces together along their seams and drapes them with realistic fabric parameters — stretch, bend, thickness, and weight per material.'
    },
    {
      q: 'Can I customize the 3D avatar?',
      a: 'Yes. The avatar is driven by real body measurements (height, weight, chest, waist, hip girths, and dozens more). Enter the measurements you know and Seamer statistically completes the rest to reconstruct an accurate body double.'
    },
    {
      q: 'What import and export formats are supported?',
      a: 'Patterns are saved as JSON (.seamer.json). You can import DXF and SVG outlines, and export to PDF (print-ready, tiled), SVG, DXF, and HPGL for plotters and cutters. Seamly2D-compatible workflows are supported via standard DXF exchange.'
    },
    {
      q: 'Does Seamer work offline?',
      a: 'Yes. Seamer is an installable PWA with a service worker — once loaded, the studio works fully offline. You can add it to your home screen or dock like a native app.'
    },
    {
      q: 'Where are my patterns stored?',
      a: 'Locally, on your device. Seamer is local-first: patterns are saved to your browser’s IndexedDB and settings to localStorage. Nothing is uploaded unless you explicitly export and share a file yourself.'
    },
    {
      q: 'Does Seamer support grading?',
      a: 'Yes. Grading profiles let you define named sizes with per-size variable overrides, plus grading-by-example "alteration tracks" that morph geometry as a driver measurement changes.'
    },
    {
      q: 'How much does Seamer cost?',
      a: 'Nothing. Seamer is free and open source. If you find it useful, you can support development on the Support Us page.'
    }
  ];
</script>

<svelte:head>
  <title>FAQ — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Frequently Asked Questions</h1>
  <p class="text-lg mb-8">
    Common questions about the Seamer pattern studio. Can't find what you need?
    Check the <a href="/docs" class="link link-primary">documentation</a>.
  </p>

  <div class="space-y-3">
    {#each faqs as faq, i}
      <div class="collapse collapse-arrow bg-base-200">
        <input type="radio" name="faq-accordion" checked={i === 0} />
        <div class="collapse-title text-lg font-semibold">{faq.q}</div>
        <div class="collapse-content">
          <p>{faq.a}</p>
        </div>
      </div>
    {/each}
  </div>

  <div class="mt-10 text-center">
    <a href="/studio" class="btn btn-accent">Open Studio</a>
  </div>
</div>
