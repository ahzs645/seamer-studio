<script lang="ts">
  const tools: { name: string; hotkey: string; desc: string }[] = [
    { name: 'Modify & select', hotkey: 'V', desc: 'Select, move, and edit points, paths, pieces, and handles. The default tool.' },
    { name: 'Pen', hotkey: 'P', desc: 'Draw lines and cubic Bézier curves point by point. Click for line points, drag for curve handles.' },
    { name: 'Circle / ellipse', hotkey: 'C', desc: 'Create a circle or ellipse path.' },
    { name: 'Center arc', hotkey: 'A', desc: 'Create an arc from a center point, radius, and sweep.' },
    { name: 'Three-point arc', hotkey: 'Q', desc: 'Create an arc through three points.' },
    { name: 'Point', hotkey: 'N', desc: 'Place a standalone point. Points can later be constrained with formulas.' },
    { name: 'Piece', hotkey: 'T', desc: 'Build a pattern piece by selecting boundary paths to form a closed loop.' },
    { name: 'Internal path', hotkey: 'D', desc: 'Add a dart, fold line, or internal seam to the selected piece.' },
    { name: 'Single seam', hotkey: 'S', desc: 'Connect one piece edge to another so they sew together in 3D.' },
    { name: 'Multi seam', hotkey: 'Shift+S', desc: 'Sew a chain of edges to another chain — e.g. a sleeve cap into an armhole.' },
    { name: 'Text', hotkey: 'I', desc: 'Place annotation text on the canvas.' },
    { name: 'Image', hotkey: 'G', desc: 'Insert a reference image or logo (tracing scans, appliques).' }
  ];
</script>

<svelte:head>
  <title>Drawing Tools — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Drawing Tools</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      The drawing toolbar sits on the right edge of the 2D canvas. Every tool has a
      single-key hotkey (shortcuts are ignored while typing in a text field).
    </p>
  </div>

  <div class="overflow-x-auto mt-6">
    <table class="table table-zebra">
      <thead>
        <tr><th>Tool</th><th>Hotkey</th><th>What it does</th></tr>
      </thead>
      <tbody>
        {#each tools as t}
          <tr>
            <td class="font-semibold whitespace-nowrap">{t.name}</td>
            <td><span class="kbd kbd-sm">{t.hotkey}</span></td>
            <td>{t.desc}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="prose max-w-none mt-8">
    <h2 class="text-2xl font-bold">Command bus</h2>
    <p>
      Beyond the toolbar, every edit goes through a unified command layer — moving and
      rotating selections, renaming elements, reordering variables, layer operations, and
      pattern settings are all named commands
      (e.g. <code>selection.move</code>, <code>point.rename</code>, <code>variable.setValue</code>)
      with full undo support. Scripts can drive the same commands the UI uses.
    </p>
    <h2 class="text-2xl font-bold mt-6">See also</h2>
    <ul class="list-disc pl-6 space-y-1">
      <li><a href="/docs/drawing/constraints" class="link link-primary">Constraints</a></li>
      <li><a href="/docs/drawing/formulas" class="link link-primary">Formulas</a></li>
      <li><a href="/docs/elements" class="link link-primary">Elements</a></li>
    </ul>
  </div>
</div>
