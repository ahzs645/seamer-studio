<script lang="ts">
  // Non-blocking review prompt. After a few successful saves in a session (saveCount prop), checks
  // /api/reviews/prompt-state; if the user never dismissed or reviewed, a small corner card asks
  // "Enjoying Seamer?". The outcome is POSTed back and mirrored in localStorage
  // ('seamer.reviewPromptDone') so it never nags again — even offline.
  const DONE_KEY = 'seamer.reviewPromptDone';
  const THRESHOLD = 3; // successful saves this session before we ask

  let { saveCount = 0 }: { saveCount?: number } = $props();

  let open = $state(false);
  let checked = false; // only hit the API once per session
  let laterThisSession = false;

  $effect(() => {
    if (saveCount >= THRESHOLD && !checked && !laterThisSession) {
      checked = true;
      void maybeShow();
    }
  });

  async function maybeShow() {
    try { if (localStorage.getItem(DONE_KEY)) return; } catch { /* storage unavailable */ }
    try {
      const res = await fetch('/api/reviews/prompt-state');
      if (!res.ok) return;
      const state = await res.json();
      if (state.dismissedAt || state.reviewedAt) {
        try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ }
        return;
      }
      open = true;
    } catch { /* offline — fail silently */ }
  }

  async function settle(outcome: 'dismissedAt' | 'reviewedAt') {
    open = false;
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ }
    try {
      await fetch('/api/reviews/prompt-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [outcome]: new Date().toISOString() })
      });
    } catch { /* offline — localStorage mirror still prevents re-asking */ }
  }

  function maybeLater() {
    open = false;
    laterThisSession = true; // ask again another session, not this one
  }
</script>

{#if open}
  <div class="fixed bottom-4 right-4 z-[150] bg-base-100 rounded-lg shadow-xl border border-base-300 w-80 p-4" role="status" aria-label="Review prompt">
    <div class="flex items-start justify-between gap-2 mb-1">
      <h3 class="font-lexend font-semibold text-sm">Enjoying Seamer?</h3>
      <button class="btn btn-ghost btn-xs btn-square" onclick={maybeLater} aria-label="Close">✕</button>
    </div>
    <p class="text-xs opacity-70 mb-3">
      If Pattern Studio is useful to you, a review or a star helps a lot.
    </p>
    <div class="flex items-center gap-2">
      <a class="btn btn-primary btn-xs" href="/support-seamer" target="_blank" rel="noopener" onclick={() => settle('reviewedAt')}>
        Leave a review
      </a>
      <button class="btn btn-ghost btn-xs" onclick={maybeLater}>Maybe later</button>
      <button class="btn btn-ghost btn-xs opacity-60" onclick={() => settle('dismissedAt')}>Don't ask again</button>
    </div>
  </div>
{/if}
