<script lang="ts">
</script>

<svelte:head>
  <title>Variables — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Variables</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      Variables are the named knobs of a parametric pattern. A skirt block with
      <code>waist_width</code>, <code>hip_width</code>, and <code>skirt_length</code>
      variables re-drafts itself when you change them — no point pushing required.
    </p>

    <h2 class="text-2xl font-bold mt-8">Anatomy of a variable</h2>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`{
  "id": "var_89ti3xo9e",
  "name": "waist_width",
  "description": "Quarter waist incl. ease",
  "type": "length",
  "valueFormula": { "formula": "body.waistGirth / 4 + 10", "unit": "mm" },
  "isEditable": true,
  "isVisible": true
}`}</code></pre>
    <ul class="list-disc pl-6 space-y-2">
      <li><strong>Value formula</strong> — a variable's value can itself be a formula, referencing other variables and body measurements.</li>
      <li><strong>Type</strong> — <code>number</code>, <code>length</code>, <code>angle</code>, <code>boolean</code>, <code>enum</code>, or <code>string</code>. Enum variables carry an options list and can act as grading axes.</li>
      <li><strong>Editable / visible</strong> — control which variables appear as user-facing knobs vs. internal helpers.</li>
      <li><strong>Description</strong> — notes for future-you (or the next pattern maker).</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Using variables</h2>
    <p>
      Reference a variable from any formula with a brace token: <code>{'{var_89ti3xo9e}'}</code>.
      The formula picker lists variables by name so you never type ids by hand. See
      <a href="/docs/drawing/formulas" class="link link-primary">Formulas</a>.
    </p>

    <h2 class="text-2xl font-bold mt-8">Variables and grading</h2>
    <p>
      Grading profiles override variable values per size: each named size can carry its own
      <code>waist_width</code>, so one drafted block produces a full size run. Enum variables
      can serve as category axes (e.g. <em>Regular / Tall</em>) for multi-axis grading.
    </p>

    <h2 class="text-2xl font-bold mt-8">Tips</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Name variables like code: <code>waist_ease</code>, not <code>x2</code>.</li>
      <li>Derive, don't duplicate — make <code>hip_width</code> a formula over <code>body.hipGirth</code> rather than a hard number.</li>
      <li>Hide internal helper variables to keep the pattern's public knobs clean.</li>
    </ul>
  </div>
</div>
