<script lang="ts">
  import { onMount } from 'svelte';
  import { navigateMenu } from '$lib/utils/focus';

  export interface MenuItem {
    label: string;
    icon?: string;
    danger?: boolean;
    sep?: boolean;
    onClick: () => void;
  }
  let { x, y, items, onclose, returnFocusTo }: {
    x: number; y: number; items: MenuItem[]; onclose: () => void; returnFocusTo?: HTMLElement;
  } = $props();

  let menu: HTMLUListElement;
  let position = $state({ left: 0, top: 0 });
  let launcher: HTMLElement | null = null;
  let closing = false;

  function positionMenu() {
    const bounds = menu.getBoundingClientRect();
    position = {
      left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))
    };
  }

  onMount(() => {
    const active = document.activeElement;
    // Selection can resize the canvas before mounting; the opener provides its exact element.
    launcher = returnFocusTo ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    positionMenu();
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  });

  function close(restoreFocus = true) {
    if (closing) return;
    closing = true;
    if (restoreFocus && launcher?.isConnected) launcher.focus({ preventScroll: true });
    onclose();
  }

  function handleKey(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close(false);
    else navigateMenu(event, menu);
  }
</script>

<svelte:window onresize={positionMenu} onkeydown={(event) => {
  if (event.key === 'Escape') { event.preventDefault(); close(); }
}} />

<!-- click-away catcher -->
<div
  class="fixed inset-0 z-[90]"
  role="presentation"
  onclick={() => close(false)}
  oncontextmenu={(e) => { e.preventDefault(); close(false); }}
></div>
<ul bind:this={menu} role="menu" aria-label="Selection actions"
  class="menu menu-sm bg-base-100 rounded-box shadow-xl border border-base-200 fixed z-[91] w-52 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto flex-nowrap p-1"
  style="left:{position.left}px; top:{position.top}px"
  onkeydown={handleKey}
  onfocusout={(event) => { if (event.relatedTarget instanceof Node && !menu.contains(event.relatedTarget)) close(false); }}
>
  {#each items as it}
    {#if it.sep}<li role="separator" class="my-1 border-t border-base-200 pointer-events-none"></li>{/if}
    <li role="none">
      <button role="menuitem" tabindex="-1" class="flex items-center gap-2" class:text-error={it.danger} onclick={(e) => { e.stopPropagation(); close(); it.onClick(); }}>
        {#if it.icon}<span class="material-symbols-rounded text-base" aria-hidden="true">{it.icon}</span>{/if}
        <span>{it.label}</span>
      </button>
    </li>
  {/each}
</ul>
