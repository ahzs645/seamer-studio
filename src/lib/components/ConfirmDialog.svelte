<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { confirmState, resolveConfirm } from '$lib/stores/confirm';
  const dialogId = $props.id();
  let dialog = $state<HTMLDivElement>();
  let cancelButton = $state<HTMLButtonElement>();
  onMount(() => {
    let activeState: object | null = null;
    let trigger: HTMLElement | null = null;
    return confirmState.subscribe((state) => {
      if (state) {
        if (!activeState) trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        activeState = state;
        void tick().then(() => { if (activeState === state) cancelButton?.focus({ preventScroll: true }); });
      } else if (activeState) {
        activeState = null;
        const restore = trigger;
        void tick().then(() => { if (!activeState && restore?.isConnected) restore.focus({ preventScroll: true }); });
      }
    });
  });
</script>

<svelte:window onfocusin={(event) => {
  if ($confirmState && dialog && event.target instanceof Node && !dialog.contains(event.target)) cancelButton?.focus({ preventScroll: true });
}} onkeydown={(e) => {
  if (!$confirmState || e.defaultPrevented) return;
  if (e.key === 'Escape') { e.preventDefault(); resolveConfirm(false); }
  if (e.key === 'Tab') {
    const buttons = [...(dialog?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const first = buttons[0], last = buttons.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  if (e.key === 'Enter' && !(e.target instanceof Element && e.target.closest('button'))) {
    e.preventDefault(); resolveConfirm(true);
  }
}} />

{#if $confirmState}
  <div bind:this={dialog} class="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby={$confirmState.title ? `${dialogId}-title` : undefined} aria-label={$confirmState.title ? undefined : 'Confirmation'} aria-describedby={`${dialogId}-message`}>
    <div class="bg-base-100 rounded-lg shadow-xl max-w-sm w-full p-5">
      {#if $confirmState.title}<h3 id={`${dialogId}-title`} class="font-bold text-base mb-2">{$confirmState.title}</h3>{/if}
      <p id={`${dialogId}-message`} class="text-sm text-base-content/80 mb-4">{$confirmState.message}</p>
      <div class="confirmation-actions flex justify-end gap-2">
        <button bind:this={cancelButton} class="btn btn-sm btn-ghost" onclick={() => resolveConfirm(false)}>{$confirmState.cancelLabel ?? 'Cancel'}</button>
        <button class="btn btn-sm {$confirmState.danger ? 'btn-error' : 'btn-primary'}" onclick={() => resolveConfirm(true)}>{$confirmState.confirmLabel ?? 'Confirm'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  @media (pointer: coarse) {
    .confirmation-actions button.btn, .confirmation-actions button.btn:active {
      min-height: 44px; min-width: 44px;
      --btn-focus-scale: 1;
      animation: none; transform: none;
    }
  }
</style>
