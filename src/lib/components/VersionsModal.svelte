<script lang="ts">
  // Local version history — named on-device snapshots of a pattern (no login, no cloud sync). Save a
  // version, browse, restore, or delete. Also exposes the local `isPublic` metadata flag.
  import type { Pattern } from '@seamer/pattern-model';
  import { saveVersion, listVersions, deleteVersion, type VersionRecord } from '$lib/stores/localDB';
  import { toastSuccess, toastError } from '$lib/stores/toast';

  let { currentPattern, onrestore, onchange, onclose }:
    { currentPattern: Pattern; onrestore: (p: Pattern) => void; onchange: (p: Pattern, label?: string) => void; onclose: () => void } = $props();

  let versions = $state<VersionRecord[]>([]);
  let newName = $state('');
  let loading = $state(true);

  async function refresh() {
    loading = true;
    try { versions = await listVersions(currentPattern.id); }
    catch { versions = []; }
    loading = false;
  }
  $effect(() => { refresh(); });

  async function save() {
    const nextNumber = (currentPattern.versionNumber ?? 0) + 1;
    const name = newName.trim() || `Version ${nextNumber}`;
    try {
      await saveVersion(currentPattern.id, name, currentPattern, nextNumber);
      // bump the live pattern's version metadata so subsequent saves increment
      onchange({ ...currentPattern, versionNumber: nextNumber, versionName: name, hasChanged: true }, 'Save version');
      newName = '';
      toastSuccess(`Saved “${name}”`);
      await refresh();
    } catch (e) {
      toastError('Could not save version');
    }
  }

  function restore(v: VersionRecord) {
    // keep the same pattern id so it stays the same document; adopt the snapshot's geometry + meta
    onrestore({ ...v.snapshot, id: currentPattern.id });
    toastSuccess(`Restored “${v.name}”`);
    onclose();
  }

  async function remove(v: VersionRecord) {
    await deleteVersion(v.id);
    await refresh();
  }

  function togglePublic() {
    onchange({ ...currentPattern, isPublic: !currentPattern.isPublic, hasChanged: true }, 'Toggle visibility');
  }

  const fmt = (iso: string) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onclose(); }} />

<div
  class="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
  role="button" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}
  onkeydown={() => {}}
>
  <div class="bg-base-100 w-[min(560px,94vw)] max-h-[80vh] rounded-lg shadow-2xl flex flex-col overflow-hidden" role="dialog" aria-label="Version history">
    <div class="flex items-center justify-between px-4 py-2 border-b border-base-300">
      <h2 class="font-bold text-lg flex items-center gap-2"><span class="material-symbols-rounded">history</span> Versions</h2>
      <button class="btn btn-ghost btn-sm btn-square" onclick={onclose} aria-label="Close">✕</button>
    </div>

    <div class="p-3 border-b border-base-300 space-y-2">
      <div class="flex gap-2">
        <input class="input input-bordered input-sm flex-1" placeholder="Version name (optional)" bind:value={newName}
          onkeydown={(e) => e.key === 'Enter' && save()} />
        <button class="btn btn-primary btn-sm" onclick={save}>Save current</button>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" class="toggle toggle-sm" checked={currentPattern.isPublic} onchange={togglePublic} />
        Public (local metadata) — currently <b>{currentPattern.isPublic ? 'public' : 'private'}</b>
      </label>
    </div>

    <div class="flex-1 overflow-y-auto p-2">
      {#if loading}
        <div class="p-4 text-center text-sm text-base-content/50">Loading…</div>
      {:else if versions.length === 0}
        <div class="p-4 text-center text-sm text-base-content/50">No saved versions yet. Save one above to snapshot this pattern.</div>
      {:else}
        {#each versions as v (v.id)}
          <div class="flex items-center gap-2 px-2 py-1.5 hover:bg-base-200 rounded">
            <div class="flex-1 min-w-0">
              <div class="font-medium truncate">{v.name} <span class="badge badge-ghost badge-xs">v{v.versionNumber}</span></div>
              <div class="text-[11px] text-base-content/50">{fmt(v.savedAt)} · {v.snapshot.pieces?.length ?? 0} pieces</div>
            </div>
            <button class="btn btn-ghost btn-xs" onclick={() => restore(v)}>Restore</button>
            <button class="btn btn-ghost btn-xs text-error" onclick={() => remove(v)} aria-label="Delete version">✕</button>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>
