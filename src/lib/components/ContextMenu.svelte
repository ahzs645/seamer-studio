<script lang="ts">
  export interface MenuItem {
    label: string;
    icon?: string;
    danger?: boolean;
    sep?: boolean;
    onClick: () => void;
  }
  let { x, y, items, onclose }: { x: number; y: number; items: MenuItem[]; onclose: () => void } = $props();
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- click-away catcher -->
<div
  class="fixed inset-0 z-[90]"
  role="presentation"
  onclick={onclose}
  oncontextmenu={(e) => { e.preventDefault(); onclose(); }}
></div>
<ul class="menu menu-sm bg-base-100 rounded-box shadow-xl border border-base-200 absolute z-[91] w-52 p-1" style="left:{x}px; top:{y}px">
  {#each items as it}
    {#if it.sep}<li class="my-1 border-t border-base-200 pointer-events-none"></li>{/if}
    <li>
      <button class="flex items-center gap-2" class:text-error={it.danger} onclick={(e) => { e.stopPropagation(); it.onClick(); onclose(); }}>
        {#if it.icon}<span class="material-symbols-rounded text-base">{it.icon}</span>{/if}
        <span>{it.label}</span>
      </button>
    </li>
  {/each}
</ul>
