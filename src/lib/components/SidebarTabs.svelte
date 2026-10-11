<script lang="ts">
  import { nextSidebarTab } from '$lib/utils/studioTasks';
  export interface SidebarTab { id: string; label: string; icon?: string }
  let { tabs, active, onchange, disabled = false, idPrefix = 'studio-sidebar' }: { tabs: readonly SidebarTab[]; active: string; onchange: (id: string) => void; disabled?: boolean; idPrefix?: string } = $props();
  let list: HTMLDivElement;
  function keydown(event: KeyboardEvent) {
    if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
    const next = nextSidebarTab(tabs.map(tab => tab.id), active, event.key);
    if (!next) return;
    event.preventDefault(); event.stopPropagation(); onchange(next);
    const index = tabs.findIndex(tab => tab.id === next);
    list.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
  }
</script>
<div bind:this={list} class="sidebar-tabs" role="tablist" tabindex="-1" aria-label="Studio panels" onkeydown={keydown}>
  {#each tabs as tab (tab.id)}
    <button type="button" role="tab" id={`${idPrefix}-tab-${tab.id}`} aria-controls={`${idPrefix}-panel-${tab.id}`}
      aria-selected={active === tab.id} tabindex={active === tab.id ? 0 : -1} {disabled} class="btn btn-ghost btn-xs" class:btn-active={active === tab.id}
      onclick={() => onchange(tab.id)}>
      {#if tab.icon}<span class="material-symbols-rounded text-base" aria-hidden="true">{tab.icon}</span>{/if}{tab.label}
    </button>
  {/each}
</div>
<style>
  .sidebar-tabs { display:flex; flex-wrap:wrap; gap:0.25rem; padding:0.25rem; }
  @media(max-width:1023px) { .sidebar-tabs button { min-height:44px; } }
</style>
