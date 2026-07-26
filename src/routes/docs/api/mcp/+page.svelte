<script lang="ts">
  const createExample = `# 1. In the studio, enable "MCP session" (Connect menu) — or create a session yourself:
curl -X POST http://localhost:5173/api/mcp-session
# -> { "id": "f3c1…" }   (HTTP 201)`;

  const readExample = `# 2. Read the session: status + the studio's latest pattern snapshot
curl http://localhost:5173/api/mcp-session/<id>
# -> { "id": "…", "createdAt": …, "queuedOps": 0, "pattern": { …full Seamer pattern… } }`;

  const opsExample = `# 3. Queue operations for the studio to apply
curl -X POST http://localhost:5173/api/mcp-session/<id>/ops \\
  -H 'Content-Type: application/json' \\
  -d '{ "ops": [
        { "kind": "command", "name": "pattern.setName", "payload": { "name": "Agent skirt" } },
        { "kind": "command", "name": "point.move",      "payload": { "id": "pt_1", "x": 120, "y": 80 } }
      ] }'
# -> { "queued": 2 }`;

  const endExample = `# 4. End the session when done
curl -X DELETE http://localhost:5173/api/mcp-session/<id>
# -> { "success": true }`;

  const commands: { group: string; names: string[] }[] = [
    { group: 'Pattern', names: ['pattern.setName', 'pattern.setDescription', 'pattern.setUnit', 'pattern.setSeamAllowance', 'pattern.setDefaultNotchSize', 'pattern.setPointNaming', 'pattern.setPublic'] },
    { group: 'Create', names: ['point.create', 'path.createLine', 'path.createCurve', 'path.createEllipse', 'path.createCenterArc', 'path.createThreePointArc', 'piece.createDynamic', 'seam.create', 'notch.add', 'variable.create', 'material.upsert', 'layer.create', 'text.create'] },
    { group: 'Points', names: ['point.move', 'point.rename', 'point.convertToCurvePoint', 'point.convertToSlidingPoint', 'point.releaseSlidingPoint', 'point.disconnectPaths', 'slidingPoint.update'] },
    { group: 'Paths', names: ['path.reverse', 'path.update', 'path.convertToCurve', 'path.convertToLine', 'path.splitCurveAtPoint', 'path.splitLineAtPoint', 'path.mergeCurvesAtPoint', 'path.mergeLinesAtPoint'] },
    { group: 'Pieces & seams', names: ['piece.update', 'piece.rotate', 'piece.breakout', 'piecePath.add', 'piecePath.update', 'seam.reverse', 'notch.update', 'notch.delete'] },
    { group: 'Elements', names: ['element.rename', 'element.delete', 'element.bringToFront', 'element.sendToBack', 'element.moveToLayer'] },
    { group: 'Selection', names: ['selection.move', 'selection.rotate', 'selection.scale', 'selection.mirror', 'selection.delete', 'selection.moveToLayer'] },
    { group: 'Layers', names: ['layer.rename', 'layer.delete', 'layer.setCurrent', 'layer.setVisible', 'layer.setLocked', 'layer.setStyle'] },
    { group: 'Variables & materials', names: ['variable.setValue', 'variable.setType', 'variable.setEditable', 'variable.setVisible', 'variable.setDescription', 'variable.setOptions', 'variable.reorder', 'variable.delete', 'material.delete'] },
    { group: 'Annotations', names: ['text.update', 'image.update'] }
  ];
</script>

<svelte:head>
  <title>MCP Session API — Seamer Docs</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">MCP Session API</h1>
  <div class="prose max-w-none">
    <p>
      The MCP session API is the live bridge between the Seamer studio and external agents — an MCP
      server, a script, or any HTTP client. The studio polls the session every ~2&nbsp;seconds: it
      pushes its current pattern snapshot (so agents can <em>read</em> the live state) and drains the
      queued operations (so agents can <em>edit</em> it). Pattern replacements and commands both go
      through the studio's normal undo-aware update path — the user can undo agent edits like their
      own.
    </p>

    <h2 class="text-2xl font-bold mt-6">Security model</h2>
    <p>
      Sessions are capability-based: the unguessable session id <em>is</em> the credential. Sessions
      live in memory only and expire after 30&nbsp;minutes of inactivity. There are no accounts or
      API keys — this is a local, serverless API.
    </p>

    <h2 class="text-2xl font-bold mt-6">Endpoints</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li><code>POST /api/mcp-session</code> — create a session → <code>{'{ id }'}</code> (201)</li>
      <li><code>GET /api/mcp-session/:id</code> — session status: <code>{'{ id, createdAt, queuedOps, pattern }'}</code>; <code>pattern</code> is the studio's latest snapshot (null until the first sync)</li>
      <li><code>POST /api/mcp-session/:id/ops</code> — queue operations (body: <code>{'{ ops: [...] }'}</code> or a bare array) → <code>{'{ queued }'}</code></li>
      <li><code>POST /api/mcp-session/:id/sync</code> — used by the studio: pushes <code>{'{ pattern }'}</code>, drains and returns <code>{'{ ops }'}</code></li>
      <li><code>DELETE /api/mcp-session/:id</code> — end the session</li>
    </ul>
    <p>All endpoints return <code>404 {'{ "error": "Not found" }'}</code> for unknown or expired session ids.</p>

    <h2 class="text-2xl font-bold mt-6">Operations</h2>
    <p>An op is one of:</p>
    <ul class="list-disc pl-6 space-y-2">
      <li>
        <code>{'{ "kind": "pattern", "pattern": { … } }'}</code> — replace the whole pattern with the
        given Seamer JSON (the studio applies it as a single undoable edit).
      </li>
      <li>
        <code>{'{ "kind": "command", "name": "…", "payload": { … } }'}</code> — run one studio
        command. Commands are granular, validated edits — preferred over full replacements for small
        changes.
      </li>
    </ul>

    <h3 class="text-xl font-bold mt-4">Command catalogue</h3>
    {#each commands as c}
      <p class="mb-1 mt-3 font-bold">{c.group}</p>
      <p class="font-mono text-sm">{c.names.join(' · ')}</p>
    {/each}
    <p class="mt-3">
      Command payloads use plain JSON fields (ids, names, numbers in mm/degrees). With the studio
      open, the same catalogue (with input schemas and examples) is available in the browser console
      via <code>window.seamer.commands()</code> — useful for building agent tool schemas.
    </p>

    <h2 class="text-2xl font-bold mt-6">Walkthrough</h2>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{createExample}</code></pre>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{readExample}</code></pre>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{opsExample}</code></pre>
    <pre class="bg-base-200 p-4 rounded-lg text-sm overflow-x-auto"><code>{endExample}</code></pre>

    <h2 class="text-2xl font-bold mt-6">Notes for MCP servers</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Poll <code>GET /api/mcp-session/:id</code> to observe the studio's state; <code>queuedOps</code> tells you how many of your ops are still pending.</li>
      <li>Ops apply in queue order on the studio's next sync (≤ ~2 s).</li>
      <li>Prefer <code>command</code> ops; send a <code>pattern</code> op only for wholesale changes (imports, generated drafts).</li>
      <li>Sessions are in-memory: a server restart or 30 min of inactivity invalidates the id — create a new session and continue.</li>
    </ul>

    <p class="mt-6">
      See also: <a href="/connect" class="link link-primary">Connect</a> for the studio-side setup,
      and <a href="/docs/api" class="link link-primary">the API overview</a>.
    </p>
  </div>
</div>
