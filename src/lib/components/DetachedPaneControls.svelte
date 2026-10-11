<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import type { Pattern } from '@seamer/pattern-model';
  import { createDetachedWorkspace, type DetachedPane } from '$lib/utils/detachedWorkspace';
  let { pattern, readonly = false, onchange, onundo, onredo }: { pattern: Pattern; readonly?: boolean; onchange: (pattern: Pattern, label?: string, pane?: DetachedPane) => void; onundo?: () => void; onredo?: () => void } = $props();
  let pane = $state<DetachedPane>('3d'), error = $state(''), count = $state(0);
  let host: ReturnType<typeof createDetachedWorkspace> | null = null;
  onMount(() => { host = createDetachedWorkspace({ base, pattern: () => $state.snapshot(pattern), readonly: () => readonly, onchange, onundo, onredo, onerror: (message) => { error = message; }, onwindowschange: (value) => { count = value; } }); return () => host?.dispose(); });
  $effect(() => { void pattern; void readonly; host?.update(); });
</script>
<div class="detached-controls" data-keyboard-scope="workspace">
  <select class="select select-xs select-bordered" bind:value={pane} aria-label="Detached pane"><option value="2d">Draft window</option><option value="3d">Garment window</option><option value="specs">Specs window</option></select>
  <button class="btn btn-ghost btn-xs" onclick={() => { error = ''; host?.open(pane); }} title="Open a separate workspace window">Detach{count ? ` (${count})` : ''}</button>
  {#if error}<span class="text-error text-xs" role="alert">{error}</span>{/if}
</div>
<style>.detached-controls{display:flex;gap:.3rem;align-items:center;flex-wrap:wrap}</style>
