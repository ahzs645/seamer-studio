<script lang="ts">
  // Grid and snapping belong to the active pattern; the other preferences belong to this device.
  import type { Pattern } from '@seamer/pattern-model';
  import { interactionMode, autoSaveSeconds, show3dStats, showCoordinates } from '$lib/stores/pattern';
  import { isDarkTheme, toggleTheme } from '$lib/utils/theme';
  import { mcpSessionId, mcpSessionPending, mcpSessionUnavailable, mcpSessionError, enableMcpSession, disableMcpSession, copyMcpSessionId } from '$lib/stores/mcpSession';

  interface Props {
    currentPattern: Pattern;
    onchange: (pattern: Pattern) => void;
    onclose: () => void;
  }

  let { currentPattern, onchange, onclose }: Props = $props();
  let dialog: HTMLDialogElement;
  let launcher: HTMLElement | null = null;

  $effect(() => {
    const element = dialog;
    launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTarget = launcher;
    element.showModal();
    return () => {
      if (element.open) element.close();
      if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    };
  });
  let dark = $state(isDarkTheme());

  function flipTheme() { toggleTheme(); dark = isDarkTheme(); }

  function closeSettings() {
    // Close before the parent removes the dialog; native cancellation otherwise races unmount.
    if (dialog.open) dialog.close();
    if (launcher?.isConnected) launcher.focus({ preventScroll: true });
    onclose();
  }
</script>

<dialog
  bind:this={dialog}
  class="bg-base-100 text-base-content w-[min(440px,92vw)] max-h-[calc(100dvh-2rem)] rounded-lg shadow-2xl p-0 overflow-y-auto backdrop:bg-black/40"
  aria-labelledby="settings-title"
  oncancel={(e) => { e.preventDefault(); closeSettings(); }}
  onclick={(e) => {
    if (e.target !== e.currentTarget) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) closeSettings();
  }}
>
  <div class="p-4 space-y-3">
    <div class="flex items-center justify-between">
      <h2 id="settings-title" class="font-bold text-lg flex items-center gap-2"><span class="material-symbols-rounded" aria-hidden="true">settings</span> Settings</h2>
      <button class="btn btn-ghost btn-sm btn-square" onclick={closeSettings} aria-label="Close">✕</button>
    </div>

    <div class="space-y-2 text-sm">
      <div class="flex items-center justify-between">
        <span>Theme</span>
        <button class="btn btn-sm btn-ghost gap-1" onclick={flipTheme}>
          <span class="material-symbols-rounded text-base">{dark ? 'dark_mode' : 'light_mode'}</span>{dark ? 'Dark' : 'Light'}
        </button>
      </div>

      <label class="flex items-center justify-between gap-3 min-h-11 md:min-h-8"><span>Show grid</span>
        <input type="checkbox" class="toggle toggle-sm" checked={currentPattern.showGrid} onchange={(e) => onchange({ ...currentPattern, showGrid: e.currentTarget.checked })} /></label>

      <label class="flex items-center justify-between gap-3 min-h-11 md:min-h-8"><span>Snap to grid</span>
        <input type="checkbox" class="toggle toggle-sm" checked={currentPattern.snapToGrid} onchange={(e) => onchange({ ...currentPattern, snapToGrid: e.currentTarget.checked })} /></label>

      <label class="flex items-center justify-between gap-3 min-h-11 md:min-h-8"><span>Show coordinates</span>
        <input type="checkbox" class="toggle toggle-sm" checked={$showCoordinates} onchange={(e) => showCoordinates.set(e.currentTarget.checked)} /></label>

      <span class="text-xs font-semibold opacity-70 block pt-1">Interaction</span>
      <label class="flex flex-wrap items-center justify-between gap-2 min-h-11 md:min-h-8"><span>Interaction mode</span>
        <select class="select select-bordered select-sm" value={$interactionMode} onchange={(e) => interactionMode.set(e.currentTarget.value as 'fast' | 'safe')}>
          <option value="safe">Safe (select first)</option><option value="fast">Fast (direct drag)</option>
        </select></label>

      <label class="flex items-center justify-between gap-3 min-h-11 md:min-h-8"><span>3D stats overlay (FPS)</span>
        <input type="checkbox" class="toggle toggle-sm" checked={$show3dStats} onchange={(e) => show3dStats.set(e.currentTarget.checked)} /></label>

      <label class="flex items-center justify-between gap-2 min-h-11 md:min-h-8"><span>Autosave every</span>
        <span class="flex items-center gap-1">
          <input type="number" min="2" max="120" step="1" class="input input-bordered input-sm w-20" value={$autoSaveSeconds}
            onchange={(e) => {
              // commit on Enter/blur so multi-digit values can be typed freely; clamp only then
              const v = parseInt(e.currentTarget.value);
              const s = Number.isFinite(v) ? Math.max(2, Math.min(120, v)) : $autoSaveSeconds;
              autoSaveSeconds.set(s);
              e.currentTarget.value = String(s);
            }} />
          <span class="text-base-content/60">s</span>
        </span></label>

      <span class="text-xs font-semibold opacity-70 block pt-1">MCP</span>
      <label class="flex items-center justify-between gap-3 min-h-11 md:min-h-8"><span>Enable MCP session</span>
        <input type="checkbox" class="toggle toggle-sm" checked={$mcpSessionId !== null || $mcpSessionPending} disabled={$mcpSessionPending || $mcpSessionUnavailable}
          aria-describedby="mcp-session-status" onchange={(e) => e.currentTarget.checked ? enableMcpSession() : disableMcpSession()} /></label>
      <p id="mcp-session-status" class="text-xs text-base-content/60" role="status">
        {#if $mcpSessionPending}Starting MCP session…
        {:else if $mcpSessionError}{$mcpSessionError}
        {:else if $mcpSessionId}MCP session active.
        {:else}MCP sessions require a server-enabled deployment.{/if}
      </p>
      {#if $mcpSessionId}
        <div class="flex items-center justify-between gap-2">
          <code class="text-[11px] truncate text-base-content/60" title={$mcpSessionId}>{$mcpSessionId}</code>
          <button class="btn btn-ghost btn-xs shrink-0" onclick={copyMcpSessionId}>Copy MCP session ID</button>
        </div>
        <p class="text-[11px] text-base-content/50">External agents can read and edit this pattern via <code>/api/mcp-session/&lt;id&gt;</code>.</p>
      {/if}
    </div>

    <p class="text-[11px] text-base-content/50">Grid and snapping are saved with the pattern. Other preferences are saved on this device.</p>
  </div>
</dialog>

<style>
  @media (max-width: 767px) {
    button, select, input[type="number"] { min-height: 44px; }
    button[aria-label="Close"] { min-width: 44px; }
  }
</style>
