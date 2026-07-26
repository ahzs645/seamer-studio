<script lang="ts">
</script>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Documentation</h1>
  <div class="prose max-w-none">
    <h2 class="text-2xl font-bold mt-6">Guides</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><a href="/docs/seamer-in-action" class="link link-primary">Seamer in Action</a> — drafting a skirt from blank canvas to cut file</li>
    </ul>

    <h2 class="text-2xl font-bold mt-6">Drawing</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><a href="/docs/drawing/tools" class="link link-primary">Drawing Tools</a> — the toolbar and hotkeys</li>
      <li><a href="/docs/drawing/coordinate-system" class="link link-primary">Coordinate System</a> — units, spaces, and the canvas view</li>
      <li><a href="/docs/drawing/constraints" class="link link-primary">Constraints</a> — parametric point constructions</li>
      <li><a href="/docs/drawing/formulas" class="link link-primary">Formulas</a> — expression syntax and tokens</li>
      <li><a href="/docs/drawing/variables" class="link link-primary">Variables</a> — named knobs and grading overrides</li>
    </ul>

    <h2 class="text-2xl font-bold mt-6">Elements</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><a href="/docs/elements" class="link link-primary">Elements Overview</a> — points, paths, pieces, seams, materials</li>
      <li><a href="/docs/elements/points" class="link link-primary">Points</a> — fixed and constrained positions</li>
      <li><a href="/docs/elements/paths" class="link link-primary">Paths</a> — lines, curves, handles, and spans</li>
    </ul>

    <h2 class="text-2xl font-bold mt-6">Pattern Data Format</h2>
    <p>
      Seamer patterns are stored as JSON with a <code>.seamer.json</code> extension.
      The format includes points, paths, pieces, seams, body measurements, and 3D settings.
    </p>

    <h3 class="text-xl font-bold mt-4">Key Data Structures</h3>

    <h4 class="font-bold mt-4">Point</h4>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`{
  "id": "unique-id",
  "name": "A0",
  "x": 100.0,
  "y": 200.0
}`}</code></pre>

    <h4 class="font-bold mt-4">Path</h4>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`{
  "id": "unique-id",
  "name": "Path 1",
  "pathType": "line",
  "pathPoints": [
    { "pointId": "point-id-1", "curveControl1": null, "curveControl2": null },
    { "pointId": "point-id-2", "curveControl1": null, "curveControl2": null }
  ]
}`}</code></pre>

    <h4 class="font-bold mt-4">Piece</h4>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{`{
  "id": "unique-id",
  "name": "Front Panel",
  "materialId": "fabric-1",
  "points": ["point-id-1", "point-id-2", "point-id-3"],
  "paths": [{ "pathId": "path-id-1" }],
  "triangles": [[0, 1, 2]]
}`}</code></pre>

    <h3 class="text-xl font-bold mt-4">3D Body Model</h3>
    <p>
      The 3D avatar uses a PCA-based body model with covariance matrices for male and female bodies.
      Shape coefficients control body proportions. The base model defines body part segmentation
      via vertex index groups.
    </p>

    <h2 class="text-2xl font-bold mt-6">API</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><a href="/docs/api" class="link link-primary">API Overview</a> — the local pattern REST API and misc endpoints</li>
      <li><a href="/docs/api/mcp" class="link link-primary">MCP Session API</a> — drive the live studio from external agents (sessions, ops, command catalogue)</li>
    </ul>

    <h3 class="text-xl font-bold mt-4">API Endpoints</h3>
    <ul class="list-disc pl-6 space-y-2">
      <li><code>GET /api/patterns</code> - List user patterns</li>
      <li><code>POST /api/patterns</code> - Create a new pattern</li>
      <li><code>GET /api/patterns/:id</code> - Get pattern by ID</li>
      <li><code>PUT /api/patterns/:id</code> - Update pattern</li>
      <li><code>DELETE /api/patterns/:id</code> - Delete pattern</li>
      <li><code>GET /api/patterns/public</code> - List public patterns</li>
    </ul>
  </div>
</div>
