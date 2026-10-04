<script lang="ts">
  import { toasts, dismissToast, type Toast } from '$lib/stores/toast';
  const icon = (k: Toast['kind']) => (k === 'success' ? 'check_circle' : k === 'error' ? 'error' : 'info');
</script>

<div class="toast-stack fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
  {#each $toasts as t (t.id)}
    <div
      class="toast-message pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-lg shadow-lg text-sm text-white max-w-md"
      class:bg-success={t.kind === 'success'}
      class:bg-error={t.kind === 'error'}
      class:bg-neutral={t.kind === 'info'}
      role="status"
    >
      <span class="material-symbols-rounded text-base">{icon(t.kind)}</span>
      <span class="min-w-0">{t.message}</span>
      <button class="toast-dismiss material-symbols-rounded text-base opacity-70 hover:opacity-100 ml-1" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>close</button>
    </div>
  {/each}
</div>

<style>
  @media (pointer: coarse) {
    /* Keep transient feedback above the fixed primary workspace controls. A defined
       width prevents left:50% shrink-to-fit from wrapping into half the phone. */
    .toast-stack { width: calc(100vw - 24px); max-width: 28rem; bottom: calc(96px + env(safe-area-inset-bottom, 0px)); }
    .toast-message { width: 100%; }
    .toast-dismiss { min-width: 44px; min-height: 44px; flex-shrink: 0; }
  }
</style>
