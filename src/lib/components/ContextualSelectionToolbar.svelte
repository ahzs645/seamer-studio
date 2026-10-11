<script lang="ts">
  import type { Editor } from '@atelier/core';
  import { editorState } from '@atelier/svelte';
  import type { Pattern } from '@seamer/pattern-model';
  import { contextualSelection, type ContextualSelectionKind } from '$lib/utils/contextualSelection';

  interface Props {
    currentPattern: Pattern;
    editor: Editor<Pattern>;
    disabled?: boolean;
    onproperties: (kind: ContextualSelectionKind) => void;
    onduplicate?: () => void;
  }
  let { currentPattern, editor, disabled = false, onproperties, onduplicate }: Props = $props();
  // svelte-ignore state_referenced_locally -- parent keys this component by Editor identity
  const editorView = editorState(editor);
  const context = $derived(contextualSelection(currentPattern, editorView.selection));
  const geometrySelection = $derived(context?.kind === 'piece' || context?.kind === 'path' || context?.kind === 'point');
  // Ask the canonical reducer whether the selection has movable geometry; no local geometry logic.
  const canTransform = $derived(Boolean(context?.canMutate && geometrySelection &&
    editor.preview('selection.move', { dx: 1, dy: 0 }).changed));
  let error = $state<string | null>(null);
  let toolbar = $state<HTMLDivElement>();
  $effect(() => { editorView.selection; error = null; });

  function currentContext() {
    return contextualSelection(editor.content, editor.selection);
  }
  function properties() {
    if (disabled) return;
    const current = currentContext();
    if (current) onproperties(current.kind);
  }
  function duplicate() {
    const current = currentContext();
    if (disabled || !current?.canMutate || current.kind !== 'piece' || current.count !== 1) return;
    onduplicate?.();
  }
  function command(type: string, params: Record<string, unknown> = {}) {
    const current = currentContext();
    if (disabled || !current?.canMutate) return;
    if (type === 'seam.reverse' && (current.kind !== 'seam' || current.count !== 1)) return;
    if (type.startsWith('selection.') && type !== 'selection.delete' &&
      current.kind !== 'piece' && current.kind !== 'path' && current.kind !== 'point') return;
    // Resolve the seam ID at invocation time, after rechecking selection validity.
    const result = editor.execute(type, type === 'seam.reverse' ? { ...params, seamId: current.ids[0] } : params);
    if (!result.ok) { error = result.error ?? 'Could not apply this action'; return; }
    if (type === 'selection.delete' && result.changed) editor.setSelection(editor.selection.clear());
  }
  function handleKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Button keyboard input belongs to the toolbar, not to drawing/selection shortcuts behind it.
    event.stopPropagation();
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(toolbar?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
    buttons[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
</script>

{#if context}
  <div class="contextual-selection" data-testid="contextual-selection" aria-disabled={disabled}>
    <span class="contextual-summary text-xs" role="status">{context.label}</span>
    <div bind:this={toolbar} class="contextual-actions" role="toolbar" aria-label="Selection actions" tabindex="-1" onkeydown={handleKey}>
      <button type="button" class="btn btn-ghost btn-xs" disabled={disabled} onclick={properties}>Properties</button>
      {#if context.canMutate}
        {#if context.kind === 'piece' && context.count === 1 && onduplicate}
          <button type="button" class="btn btn-ghost btn-xs" disabled={disabled} onclick={duplicate}>Duplicate</button>
        {/if}
        {#if geometrySelection && canTransform}
          {#if context.kind === 'point'}
            <button type="button" class="btn btn-ghost btn-xs" disabled={disabled} aria-label="Move selection right 1 mm"
              onclick={() => command('selection.move', { dx: 1, dy: 0 })}>Move →</button>
            <button type="button" class="btn btn-ghost btn-xs" disabled={disabled} aria-label="Move selection up 1 mm"
              onclick={() => command('selection.move', { dx: 0, dy: 1 })}>Move ↑</button>
          {/if}
          {#if context.kind !== 'point' || context.count > 1}
            <button type="button" class="btn btn-ghost btn-xs" disabled={disabled} aria-label="Mirror selection left and right"
              onclick={() => command('selection.mirror', { axis: 'y' })}>Mirror ↔</button>
            <button type="button" class="btn btn-ghost btn-xs" disabled={disabled} aria-label="Mirror selection up and down"
              onclick={() => command('selection.mirror', { axis: 'x' })}>Mirror ↕</button>
            {#if context.kind !== 'piece'}
              <button type="button" class="btn btn-ghost btn-xs" disabled={disabled} aria-label="Rotate selection left 15 degrees"
                onclick={() => command('selection.rotate', { degrees: 15 })}>Rotate ↶</button>
              <button type="button" class="btn btn-ghost btn-xs" disabled={disabled} aria-label="Rotate selection right 15 degrees"
                onclick={() => command('selection.rotate', { degrees: -15 })}>Rotate ↷</button>
            {/if}
          {/if}
        {/if}
        {#if context.kind === 'seam' && context.count === 1}
          <button type="button" class="btn btn-ghost btn-xs" disabled={disabled} aria-label="Reverse seam source direction"
            onclick={() => command('seam.reverse', { side: 'from' })}>Reverse source</button>
          <button type="button" class="btn btn-ghost btn-xs" disabled={disabled} aria-label="Reverse seam target direction"
            onclick={() => command('seam.reverse', { side: 'to' })}>Reverse target</button>
        {/if}
        <button type="button" class="btn btn-ghost btn-xs text-error" disabled={disabled}
          aria-label={`Delete selected ${context.kind}${context.count === 1 ? '' : 's'}`}
          onclick={() => command('selection.delete')}>Delete</button>
      {/if}
    </div>
    {#if error}<span class="text-error text-xs" role="alert">{error}</span>{/if}
  </div>
{/if}

<style>
  .contextual-selection { display: flex; align-items: center; gap: 0.5rem; min-width: 0; width: 100%; padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--fallback-b3, oklch(var(--b3))); background: var(--fallback-b2, oklch(var(--b2))); flex-shrink: 0; }
  .contextual-summary { flex-shrink: 0; }
  .contextual-actions { display: flex; align-items: center; gap: 0.25rem; min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; }
  .contextual-actions button { flex-shrink: 0; white-space: nowrap; }
  @media (max-width: 1023px) { .contextual-actions button { min-height: 44px; min-width: 44px; } .contextual-selection { padding-top: 0; padding-bottom: 0; } }
</style>
