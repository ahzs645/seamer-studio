<script lang="ts">
  // curl example for the MCP session section — kept as a string so the template stays brace-free.
  const mcpCurlExample = `curl http://localhost:5173/api/mcp-session/<id>
curl -X POST http://localhost:5173/api/mcp-session/<id>/ops \\
  -H 'content-type: application/json' \\
  -d '{"ops": [{"kind": "command", "name": "selection.move", "payload": {"dx": 10, "dy": 0}}]}'`;
</script>

<svelte:head>
  <title>Connect — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Connect</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      Seamer plays well with the rest of your workshop. Connect cutting hardware,
      exchange files with other CAD tools, and automate the studio from outside.
    </p>

    <h2 class="text-2xl font-bold mt-8">Cutting devices</h2>
    <p>
      Export markers and pieces as <strong>HPGL</strong> (<code>.plt</code>/<code>.hpgl</code>)
      to drive pen plotters and CNC fabric cutters, or as <strong>DXF</strong> for cutter
      software that prefers CAD exchange formats. Notches, drill holes, and grain lines are
      included in the cut output. See the
      <a href="/cutting" class="link link-primary">Cutting Room</a> for the full pipeline.
    </p>

    <h2 class="text-2xl font-bold mt-8">File exchange</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><strong>Import:</strong> DXF and SVG outlines, plus Seamer's own JSON format</li>
      <li><strong>Export:</strong> PDF (tiled print), SVG, DXF, HPGL, and <code>.seamer.json</code></li>
      <li>DXF round-trips cleanly with Seamly2D and most apparel CAD packages</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">Pattern API</h2>
    <p>
      A REST-style API is available at <code>/api/patterns</code> for listing, reading, and
      writing patterns programmatically — useful for batch processing, backups, and
      integrating Seamer into a wider production system. See the
      <a href="/docs" class="link link-primary">documentation</a> for the endpoint reference.
    </p>

    <h2 class="text-2xl font-bold mt-8">MCP session</h2>
    <p>
      An MCP pattern session lets AI assistants and agents read and edit the pattern that's open
      in the studio, live. In the studio, open <strong>Settings → MCP → Enable MCP session</strong>,
      then <strong>Copy MCP session ID</strong> and hand it to your agent (an MCP server, a script,
      or plain <code>curl</code>). The studio syncs every couple of seconds: it publishes its current
      pattern snapshot and applies any operations the agent has queued.
    </p>
    <ul class="list-disc pl-6 space-y-2">
      <li><code>POST /api/mcp-session</code> — create a session, returns <code>{'{ id }'}</code> (the studio does this for you)</li>
      <li><code>GET /api/mcp-session/&lt;id&gt;</code> — session status + the latest pattern snapshot from the studio</li>
      <li><code>POST /api/mcp-session/&lt;id&gt;/ops</code> — queue operations: <code>{'{ kind: "pattern", pattern }'}</code> replaces
        the whole pattern; <code>{'{ kind: "command", name, payload }'}</code> runs a studio command
        (the same registry as <code>window.seamer.commands()</code>)</li>
      <li><code>DELETE /api/mcp-session/&lt;id&gt;</code> — end the session</li>
    </ul>
    <p>For example, read the open pattern and nudge the current selection 10&nbsp;mm right:</p>
    <pre><code>{mcpCurlExample}</code></pre>
    <p>
      Changes appear in the studio within a sync cycle and land in the undo history as
      "External edit". Sessions are in-memory, local-first, and expire after 30 minutes of inactivity.
      Full endpoint + command reference: <a href="/docs/api/mcp" class="link link-primary">MCP Session API docs</a>.
    </p>
  </div>
</div>
