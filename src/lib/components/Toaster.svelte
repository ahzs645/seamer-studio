<script lang="ts">
  import { toasts, dismissToast, type Toast } from '$lib/stores/toast';
  const icon = (k: Toast['kind']) => (k === 'success' ? 'check_circle' : k === 'error' ? 'error' : 'info');
</script>

<div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
  {#each $toasts as t (t.id)}
    <div
      class="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-lg shadow-lg text-sm text-white max-w-md"
      class:bg-success={t.kind === 'success'}
      class:bg-error={t.kind === 'error'}
      class:bg-neutral={t.kind === 'info'}
      role="status"
    >
      <span class="material-symbols-rounded text-base">{icon(t.kind)}</span>
      <span class="min-w-0">{t.message}</span>
      <button class="material-symbols-rounded text-base opacity-70 hover:opacity-100 ml-1" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>close</button>
    </div>
  {/each}
</div>
