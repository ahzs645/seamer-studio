<!--
  Draft-buffered numeric input (the original SeamScape committed dimension fields on
  blur/Enter only, never per keystroke).

  - Shows the committed `value` (optionally fixed to `decimals`) until the user types;
    keystrokes only update a local draft string, so multi-digit typing is never
    reformatted mid-edit and no undo entries pile up per keystroke.
  - `change` (Enter/blur): the text is parsed; a finite number is handed to `oncommit`
    (the caller applies its own unit conversion/rounding/clamping); anything else —
    empty, "-", garbage — reverts the display to the committed value. Never coerced to 0.
  - Escape reverts the draft without committing; focus selects the text for retyping.
  - All other attributes (class/step/min/max/disabled/title/aria-*/data-*) pass through.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLInputAttributes, 'value' | 'type' | 'oninput' | 'onchange' | 'onkeydown' | 'onfocus'> {
    /** Committed value, in display units. */
    value: number;
    /** Called with the parsed finite number on Enter/blur; never called for invalid input. */
    oncommit: (v: number) => void;
    /** Fixed decimal places when displaying the committed value (default: String(value)). */
    decimals?: number;
  }

  let { value, oncommit, decimals, ...rest }: Props = $props();

  // Local draft while typing; null = show the committed value.
  let draft = $state<string | null>(null);
  const fmt = (v: number) => (decimals != null && Number.isFinite(v) ? v.toFixed(decimals) : String(v));

  function commit(el: HTMLInputElement) {
    const v = parseFloat(el.value);
    draft = null;
    if (Number.isFinite(v)) oncommit(v);
    // The rendered text can be unchanged (revert, or a commit the caller clamped back),
    // in which case Svelte won't touch the DOM — re-sync it to the committed value.
    tick().then(() => { el.value = fmt(value); });
  }

  function onkeydown(e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (e.key === 'Escape' && draft !== null) {
      draft = null;
      e.currentTarget.value = fmt(value);
      e.stopPropagation(); // an in-progress edit swallows Escape; it shouldn't also cancel canvas operations
    }
  }
</script>

<input
  type="number"
  {...rest}
  value={draft ?? fmt(value)}
  oninput={(e) => (draft = e.currentTarget.value)}
  onchange={(e) => commit(e.currentTarget)}
  {onkeydown}
  onfocus={(e) => e.currentTarget.select()}
/>
