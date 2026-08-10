<script lang="ts">
  import { onMount } from 'svelte';
  import { applyStoredTheme, isDarkTheme, onThemeChange, toggleTheme } from '$lib/utils/theme';

  let {
    size = 'sm',
    showLabel = false
  }: {
    size?: 'xs' | 'sm';
    showLabel?: boolean;
  } = $props();

  let dark = $state(false);

  onMount(() => {
    applyStoredTheme();
    dark = isDarkTheme();
    return onThemeChange(() => (dark = isDarkTheme()));
  });

  function flipTheme() {
    dark = toggleTheme() === 'dark';
  }
</script>

<button
  type="button"
  class="btn btn-ghost {size === 'xs' ? 'btn-xs' : 'btn-sm'} {showLabel ? 'gap-1' : 'btn-square'}"
  aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
  aria-pressed={dark}
  title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
  onclick={flipTheme}
>
  <span class="material-symbols-rounded notranslate" aria-hidden="true" style="font-size:{size === 'xs' ? 18 : 20}px">
    {dark ? 'light_mode' : 'dark_mode'}
  </span>
  {#if showLabel}<span>{dark ? 'Light' : 'Dark'}</span>{/if}
</button>
