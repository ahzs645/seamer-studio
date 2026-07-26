<svelte:head>
  <title>API — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">API</h1>
  <div class="prose max-w-none">
    <p>
      Seamer is local-first and serverless: there are no accounts, no API keys, and nothing leaves
      your machine. The HTTP API below is served by the same app that serves the studio — point your
      tools at the origin you run Seamer on (e.g. <code>http://localhost:5173</code> in dev).
    </p>

    <h2 class="text-2xl font-bold mt-6">Pattern API</h2>
    <p>A small REST surface over the in-memory pattern store (handy for scripting and import/export):</p>
    <ul class="list-disc pl-6 space-y-2">
      <li><code>GET /api/patterns</code> — list patterns</li>
      <li><code>POST /api/patterns</code> — create a pattern (Seamer JSON body)</li>
      <li><code>GET /api/patterns/:id</code> — fetch one pattern</li>
      <li><code>PUT /api/patterns/:id</code> — update a pattern</li>
      <li><code>DELETE /api/patterns/:id</code> — delete a pattern</li>
      <li><code>GET /api/patterns/public</code> — list public patterns</li>
    </ul>
    <p>
      Patterns use the <code>.seamer.json</code> format described in the
      <a href="/docs" class="link link-primary">documentation overview</a>.
    </p>

    <h2 class="text-2xl font-bold mt-6">MCP session API</h2>
    <p>
      The live bridge between the studio and external agents (e.g. an MCP server driving Claude):
      create a session, read the studio's live pattern, and queue edits or commands that the studio
      applies through its undo-aware update path.
    </p>
    <p><a href="/docs/api/mcp" class="link link-primary">Full MCP session API reference →</a></p>

    <h2 class="text-2xl font-bold mt-6">Misc endpoints</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><code>GET /api/release-notes</code> — release notes (drives the changelog and What's New)</li>
      <li><code>GET /api/user/latest-version</code> — latest version marker</li>
      <li><code>POST /api/product-analytics/events</code> — accepted and discarded (local-first: no tracking)</li>
    </ul>
  </div>
</div>
