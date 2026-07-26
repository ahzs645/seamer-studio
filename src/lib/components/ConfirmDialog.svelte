<script lang="ts">
  import { confirmState, resolveConfirm } from '$lib/stores/confirm';
</script>

<svelte:window onkeydown={(e) => { if (!$confirmState) return; if (e.key === 'Escape') resolveConfirm(false); if (e.key === 'Enter') resolveConfirm(true); }} />

{#if $confirmState}
  <div class="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
    <div class="bg-base-100 rounded-lg shadow-xl max-w-sm w-full p-5">
      {#if $confirmState.title}<h3 class="font-bold text-base mb-2">{$confirmState.title}</h3>{/if}
      <p class="text-sm text-base-content/80 mb-4">{$confirmState.message}</p>
      <div class="flex justify-end gap-2">
        <button class="btn btn-sm btn-ghost" onclick={() => resolveConfirm(false)}>{$confirmState.cancelLabel ?? 'Cancel'}</button>
        <button class="btn btn-sm {$confirmState.danger ? 'btn-error' : 'btn-primary'}" onclick={() => resolveConfirm(true)}>{$confirmState.confirmLabel ?? 'Confirm'}</button>
      </div>
    </div>
  </div>
{/if}
