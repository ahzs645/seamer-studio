<script lang="ts">
  // "What's new" splash. On studio load, compares the server's latest version
  // (/api/user/latest-version → customData.latestVersion) against localStorage 'latestVersion';
  // when they differ the release notes are fetched and shown. "Dismiss updates" stores the new
  // version so the splash only appears once per release. All network failures are silent (offline).
  import { onMount } from 'svelte';

  const VERSION_KEY = 'latestVersion';

  interface ReleaseNote { version: string; content: string; date: string }
  let notes = $state<ReleaseNote[] | null>(null);
  let latest = '';

  onMount(async () => {
    try {
      const res = await fetch('/api/user/latest-version');
      if (!res.ok) return;
      const data = await res.json();
      latest = data?.customData?.latestVersion;
      if (!latest) return;
      let seen: string | null = null;
      try { seen = localStorage.getItem(VERSION_KEY); } catch { /* storage unavailable */ }
      if (seen === latest) return;
      if (!seen) {
        // first visit: nothing is "new" yet (and the welcome modal is already up) —
        // record the current version silently and only splash on future releases
        try { localStorage.setItem(VERSION_KEY, latest); } catch { /* ignore */ }
        return;
      }
      const rn = await fetch('/api/release-notes');
      if (!rn.ok) return;
      const all: ReleaseNote[] = await rn.json();
      // show everything newer than the last version the user dismissed (or all of them)
      const seenIdx = seen ? all.findIndex((n) => n.version === seen) : -1;
      notes = seenIdx > 0 ? all.slice(0, seenIdx) : all;
      if (!notes.length) notes = null;
    } catch { /* offline — fail silently */ }
  });

  function dismiss() {
    try { localStorage.setItem(VERSION_KEY, latest); } catch { /* ignore */ }
    notes = null;
  }

  type Block = { type: 'h'; text: string } | { type: 'ul'; items: string[] } | { type: 'p'; text: string };
  /** Tiny markdown-ish renderer: headings, bullet lists and paragraphs — no dependency. */
  function toBlocks(content: string): Block[] {
    const blocks: Block[] = [];
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (/^#{1,6}\s/.test(line)) blocks.push({ type: 'h', text: line.replace(/^#{1,6}\s+/, '') });
      else if (/^[-*]\s/.test(line)) {
        const item = line.replace(/^[-*]\s+/, '');
        const last = blocks[blocks.length - 1];
        if (last?.type === 'ul') last.items.push(item);
        else blocks.push({ type: 'ul', items: [item] });
      } else blocks.push({ type: 'p', text: line });
    }
    return blocks;
  }
</script>

{#if notes}
  <div
    class="fixed inset-0 z-[210] flex items-center justify-center bg-black/40"
    role="button" tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
    onkeydown={(e) => e.key === 'Escape' && dismiss()}
  >
    <div class="bg-base-100 w-[min(520px,92vw)] rounded-lg shadow-2xl p-5" role="dialog" aria-modal="true" aria-label="Pattern Studio update">
      <div class="flex items-center justify-between mb-1">
        <h2 class="font-lexend font-semibold text-xl">Pattern Studio update</h2>
        <button class="btn btn-ghost btn-sm btn-square" onclick={dismiss} aria-label="Close">✕</button>
      </div>
      <p class="text-sm opacity-70 mb-3">Here's what changed since your last visit.</p>
      <div class="max-h-[55vh] overflow-y-auto pr-1 mb-4">
        {#each notes as note}
          <div class="mb-4">
            <div class="flex items-baseline gap-2 mb-1">
              <span class="badge badge-primary badge-sm">v{note.version}</span>
              <span class="text-xs opacity-50">{note.date}</span>
            </div>
            {#each toBlocks(note.content) as block}
              {#if block.type === 'h'}
                <h3 class="font-semibold text-sm mt-2 mb-1">{block.text}</h3>
              {:else if block.type === 'ul'}
                <ul class="list-disc list-inside text-sm opacity-80 space-y-0.5">
                  {#each block.items as item}<li>{item}</li>{/each}
                </ul>
              {:else}
                <p class="text-sm opacity-80 my-1">{block.text}</p>
              {/if}
            {/each}
          </div>
        {/each}
      </div>
      <div class="flex justify-end">
        <button class="btn btn-primary btn-sm" onclick={dismiss}>Dismiss updates</button>
      </div>
    </div>
  </div>
{/if}
