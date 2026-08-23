<script lang="ts">
  // Bug report / feature request — local only (no login, no backend). Composes a structured report
  // with auto-collected diagnostics, then lets the user copy it, download it, or open their mail
  // client. The original app POSTed feedback to a server; here the same intent is satisfied offline.
  import type { Pattern } from '@seamer/pattern-model';
  import { toastSuccess } from '$lib/stores/toast';

  let { currentPattern, onclose, contactEmail = 'support@seamer.app' }:
    { currentPattern: Pattern; onclose: () => void; contactEmail?: string } = $props();

  let kind = $state<'bug' | 'feature'>('bug');
  let title = $state('');
  let body = $state('');
  let includeDiagnostics = $state(true);

  function diagnostics(): string {
    const p = currentPattern;
    const lines = [
      `pattern: ${p.name} (${p.id})`,
      `version: ${p.versionName} v${p.versionNumber} · software ${p.softwareVersion}`,
      `counts: ${p.points.length} points, ${p.paths.length} paths, ${p.pieces.length} pieces, ${p.seams.length} seams, ${p.variables.length} vars`,
      `units: ${p.lengthUnit}/${p.angleUnit} · seamAllowance ${p.seamAllowance}mm`,
      typeof navigator !== 'undefined' ? `userAgent: ${navigator.userAgent}` : '',
      typeof window !== 'undefined' ? `viewport: ${window.innerWidth}x${window.innerHeight}` : ''
    ].filter(Boolean);
    return lines.join('\n');
  }

  const kindLabel = $derived(kind === 'bug' ? 'File bug report' : 'Feature request');

  function compose(): string {
    const header = `[${kind === 'bug' ? 'Bug Report' : 'Feature Request'}] ${title || '(no title)'}`;
    const parts = [header, `type: ${kind}`, '', body || '(no description)'];
    if (includeDiagnostics) parts.push('', '--- diagnostics ---', diagnostics());
    return parts.join('\n');
  }

  async function copy() {
    try { await navigator.clipboard.writeText(compose()); toastSuccess('Report copied to clipboard'); }
    catch { /* clipboard unavailable */ }
  }

  function download() {
    const blob = new Blob([compose()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${kind}-report-${currentPattern.name.replace(/\s+/g, '-').toLowerCase()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function email() {
    const subject = encodeURIComponent(`[${kind === 'bug' ? 'Bug' : 'Feature'}] ${title}`.trim());
    const mailBody = encodeURIComponent(compose());
    window.location.href = `mailto:${contactEmail}?subject=${subject}&body=${mailBody}`;
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onclose(); }} />

<div
  class="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
  role="button" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}
  onkeydown={() => {}}
>
  <div class="bg-base-100 w-[min(560px,92vw)] rounded-lg shadow-2xl p-4" role="dialog" aria-label="Send feedback">
    <div class="flex items-center justify-between mb-3">
      <h2 class="font-bold text-lg">{kindLabel}</h2>
      <button class="btn btn-ghost btn-sm btn-square" onclick={onclose} aria-label="Close">✕</button>
    </div>

    <label class="block text-sm font-medium mb-1" for="fb-type">Type</label>
    <select id="fb-type" class="select select-sm select-bordered w-full mb-3" bind:value={kind}>
      <option value="bug">File bug report</option>
      <option value="feature">Feature request</option>
    </select>

    <label class="block text-sm font-medium mb-1" for="fb-title">Title</label>
    <input id="fb-title" bind:value={title} class="input input-sm input-bordered w-full mb-3"
      placeholder={kind === 'bug' ? 'Short summary of the problem' : 'Short summary of the idea'} />

    <label class="block text-sm font-medium mb-1" for="fb-body">Details</label>
    <textarea id="fb-body" bind:value={body} rows="5" class="textarea textarea-bordered w-full mb-3"
      placeholder={kind === 'bug' ? 'What happened? What did you expect? Steps to reproduce?' : 'Describe the feature you would like to see…'}></textarea>

    <label class="flex items-center gap-2 text-sm mb-3">
      <input type="checkbox" class="checkbox checkbox-sm" bind:checked={includeDiagnostics} />
      Include diagnostics (pattern stats, browser, viewport)
    </label>

    {#if includeDiagnostics}
      <pre class="bg-base-200 text-[11px] rounded p-2 mb-3 max-h-28 overflow-auto whitespace-pre-wrap">{diagnostics()}</pre>
    {/if}

    <div class="flex gap-2 justify-end">
      <button class="btn btn-ghost btn-sm" onclick={download}>Download</button>
      <button class="btn btn-ghost btn-sm" onclick={copy}>Copy</button>
      <button class="btn btn-primary btn-sm" onclick={email}>Email…</button>
    </div>
  </div>
</div>
