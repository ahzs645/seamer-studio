<script lang="ts">
  import type { Pattern, Seam } from '@seamer/pattern-model';
  import { indexPiecePathOwners, seamLabel } from '$lib/utils/patternGeometry';
  import { seamReverse } from '$lib/commands/create';
  import { selectedSeamId } from '$lib/stores/pattern';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
  }

  let { currentPattern, onchange }: Props = $props();
  let fromId = $state('');
  let toId = $state('');
  let fromMirror = $state(false);
  let toMirror = $state(false);

  // Flattened list of every piece edge (PiecePath) with a readable label — internal paths
  // included (the original supports sewing an edge to an internal line, e.g. pockets/yokes).
  interface EdgeOption { id: string; label: string }
  const edges = $derived.by<EdgeOption[]>(() => {
    const out: EdgeOption[] = [];
    const pathName = (id: string) => currentPattern.paths.find((p) => p.id === id)?.name ?? id.slice(0, 6);
    for (const piece of currentPattern.pieces) {
      for (const pp of piece.mainPaths) {
        out.push({ id: pp.id, label: `${piece.name} · ${pp.name || pathName(pp.path)}` });
      }
      for (const pp of piece.internalPaths) {
        out.push({ id: pp.id, label: `${piece.name} · ${pp.name || pathName(pp.path)} (internal)` });
      }
    }
    return out;
  });

  const edgeLabel = $derived.by(() => {
    const m = new Map<string, string>();
    for (const e of edges) m.set(e.id, e.label);
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  });

  // Faithful "Piece: Edge -> Piece: Edge (reversed)" label, shared with the Object browser.
  const owners = $derived(indexPiecePathOwners(currentPattern));

  function addSeam() {
    if (!fromId || !toId || fromId === toId) return;
    const seam: Seam = {
      id: 'Seam_' + crypto.randomUUID().slice(0, 9),
      name: '',
      fromPaths: [{ id: fromId, mirrored: fromMirror, reversed: false }],
      toPaths: [{ id: toId, mirrored: toMirror, reversed: false }]
    };
    onchange({ ...currentPattern, seams: [...currentPattern.seams, seam], hasChanged: true });
    fromId = ''; toId = ''; fromMirror = false; toMirror = false;
  }

  function removeSeam(id: string) {
    if ($selectedSeamId === id) selectedSeamId.set(null);
    onchange({ ...currentPattern, seams: currentPattern.seams.filter((s) => s.id !== id), hasChanged: true });
  }

  // Reverse one SIDE's sewing direction (the original's "Reverse source/target direction" — flips
  // the reversed flag on every ref of that side, which changes how the sim pairs the particles).
  function reverseSide(id: string, side: 'from' | 'to') {
    onchange(seamReverse(currentPattern, id, side));
  }

  function selectSeam(id: string) {
    selectedSeamId.set($selectedSeamId === id ? null : id);
  }
</script>

<div class="text-xs">
  <h3 class="font-bold mb-2">Seams</h3>

  <div class="space-y-1 mb-2 max-h-56 overflow-y-auto">
    {#each currentPattern.seams as seam (seam.id)}
      {@const isSel = $selectedSeamId === seam.id}
      <div class="p-1 rounded bg-base-200" class:ring-1={isSel} class:ring-primary={isSel}>
        <button class="w-full text-left truncate text-[11px]" title={seamLabel(currentPattern, seam, owners)} onclick={() => selectSeam(seam.id)}>
          {seamLabel(currentPattern, seam, owners)}
        </button>
        {#if isSel}
          <div class="flex flex-wrap gap-1 mt-1">
            <button class="btn btn-xs btn-ghost flex-1" title="Reverse source direction" onclick={() => reverseSide(seam.id, 'from')}>
              <span class="material-symbols-rounded text-sm align-middle">u_turn_left</span> Source
            </button>
            <button class="btn btn-xs btn-ghost flex-1" title="Reverse target direction" onclick={() => reverseSide(seam.id, 'to')}>
              <span class="material-symbols-rounded text-sm align-middle">u_turn_right</span> Target
            </button>
            <button class="btn btn-xs btn-ghost text-error" title="Delete seam" onclick={() => removeSeam(seam.id)}>
              <span class="material-symbols-rounded text-sm align-middle">delete</span>
            </button>
          </div>
        {/if}
      </div>
    {/each}
    {#if currentPattern.seams.length === 0}
      <p class="text-xs opacity-50 my-1">No seams defined.</p>
    {/if}
  </div>

  {#if edges.length >= 2}
    <div class="bg-base-200 p-2 rounded space-y-1">
      <div class="flex gap-1 items-center">
        <select class="select select-bordered select-xs flex-1" bind:value={fromId}>
          <option value="">From edge…</option>
          {#each edges as e}<option value={e.id}>{e.label}</option>{/each}
        </select>
        <label class="flex items-center gap-0.5"><input type="checkbox" class="checkbox checkbox-xs" bind:checked={fromMirror} />M</label>
      </div>
      <div class="flex gap-1 items-center">
        <select class="select select-bordered select-xs flex-1" bind:value={toId}>
          <option value="">To edge…</option>
          {#each edges as e}<option value={e.id} disabled={e.id === fromId}>{e.label}</option>{/each}
        </select>
        <label class="flex items-center gap-0.5"><input type="checkbox" class="checkbox checkbox-xs" bind:checked={toMirror} />M</label>
      </div>
      <button class="btn btn-xs btn-ghost w-full" onclick={addSeam} disabled={!fromId || !toId}>Add Seam</button>
    </div>
  {:else}
    <p class="text-xs opacity-50">Need at least 2 piece edges to create a seam.</p>
  {/if}
</div>
