<script lang="ts">
</script>

<svelte:head>
  <title>Formulas — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Formulas</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      Formulas appear everywhere a number can: constraint offsets, lengths and angles,
      variable values, Bézier handle lengths, and sliding-point positions. They are plain
      arithmetic expressions, evaluated safely (no arbitrary code), in mm and degrees.
    </p>

    <h2 class="text-2xl font-bold mt-8">Syntax</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Numbers and the operators <code>+ - * / %</code> with parentheses</li>
      <li><code>Math.*</code> helpers: <code>Math.sqrt(x)</code>, <code>Math.min(a, b)</code>, <code>Math.abs(x)</code>, <code>Math.sin(x)</code>, and the rest of the standard Math object</li>
      <li>Anything else (assignments, function definitions, property access) is rejected — invalid formulas evaluate to nothing rather than guessing</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Tokens</h2>
    <p>References to other values are written in braces; the formula picker inserts them for you.</p>

    <h3 class="text-xl font-bold mt-4">Variables</h3>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`{var_89ti3xo9e} / 4 + 10`}</code></pre>
    <p>Reference any pattern variable by id. See <a href="/docs/drawing/variables" class="link link-primary">Variables</a>.</p>

    <h3 class="text-xl font-bold mt-4">Body measurements</h3>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`body.waistGirth / 4 + 15`}</code></pre>
    <p>
      Any avatar measurement is available as <code>body.&lt;name&gt;</code> —
      <code>body.chestGirth</code>, <code>body.hipGirth</code>, <code>body.armLength</code>,
      <code>body.neckToWaistBack</code>, and dozens more. Measurement-driven patterns re-draft
      when the body changes.
    </p>

    <h3 class="text-xl font-bold mt-4">Path lengths</h3>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`{Path_armhole.length} * 0.95`}</code></pre>
    <p>Use a path's measured length in another formula — e.g. drafting a sleeve cap against the armhole it must fit.</p>

    <h2 class="text-2xl font-bold mt-8">Examples</h2>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`body.waistGirth / 4 + {ease} / 4       quarter waist plus ease
Math.sqrt({a}*{a} + {b}*{b})           hypotenuse of two measurements
({Path_hem.length} % 50) / 2           remainder distribution along a hem`}</code></pre>

    <h2 class="text-2xl font-bold mt-8">Units</h2>
    <p>
      Formulas evaluate in millimeters (lengths) and degrees (angles). The unit shown in the
      editor follows the pattern's display unit; conversion happens at the input boundary,
      not inside the expression.
    </p>
  </div>
</div>
