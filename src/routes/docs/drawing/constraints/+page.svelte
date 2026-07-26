<script lang="ts">
</script>

<svelte:head>
  <title>Constraints — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Constraints</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      A constraint turns a fixed point into a parametric construction: the solver computes its
      position from formulas instead of stored coordinates. Constrained patterns re-draft
      themselves when variables or body measurements change.
    </p>

    <h2 class="text-2xl font-bold mt-8">Constraint types</h2>

    <h3 class="text-xl font-bold mt-4">Offset</h3>
    <p>
      Position relative to another point by <code>dx</code>/<code>dy</code> formulas.
      The workhorse of block drafting: "B is 1/4 waist to the right of A".
    </p>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`{ "type": "offset", "from": "A0", "dxFormula": "{waist_width}/4", "dyFormula": "0" }`}</code></pre>

    <h3 class="text-xl font-bold mt-4">Length &amp; angle</h3>
    <p>
      A polar construction: distance and direction from an anchor point, both formula-driven.
      Useful for shoulder slopes and dart legs.
    </p>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`{ "type": "lengthAngle", "from": "A1", "lengthFormula": "120", "angleFormula": "-18" }`}</code></pre>

    <h3 class="text-xl font-bold mt-4">Sliding</h3>
    <p>
      A point <em>on</em> a path — placed by a distance formula from an anchor, or at a fixed
      fraction of the path's arc length. Notch positions and dart apexes commonly use this.
    </p>

    <h3 class="text-xl font-bold mt-4">Mirror</h3>
    <p>
      A point reflected across the line defined by an axis path's endpoints. Used for
      symmetric halves and referenced/mirror copies.
    </p>

    <h3 class="text-xl font-bold mt-4">Intersection</h3>
    <p>
      The crossing of two rays, each leaving an anchor point at a formula-driven angle.
      The classic "extend these two lines until they meet" drafting move.
    </p>

    <h2 class="text-2xl font-bold mt-8">Solving order</h2>
    <p>
      The solver orders constraints by their dependencies (which points and variables each
      formula references) and evaluates them in millimeters and degrees. Unconstrained points
      keep their stored x/y. Circular references are reported, not silently evaluated.
    </p>

    <h2 class="text-2xl font-bold mt-8">See also</h2>
    <ul class="list-disc pl-6 space-y-1">
      <li><a href="/docs/drawing/formulas" class="link link-primary">Formula syntax</a></li>
      <li><a href="/docs/drawing/variables" class="link link-primary">Variables</a></li>
      <li><a href="/docs/elements/points" class="link link-primary">Points</a></li>
    </ul>
  </div>
</div>
