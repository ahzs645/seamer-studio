<script lang="ts">
  import {
    captureColorwayPieces, colorwayProblems, createColorway, deleteColorway, duplicateColorway,
    renameColorway, removeColorwayPiece, switchColorway, updateColorwayPiece,
    type ColorwayPiece, type Pattern
  } from '@seamer/pattern-model';

  let { currentPattern, onchange, selectedPieceIds = [] }: {
    currentPattern: Pattern;
    onchange: (pattern: Pattern, label?: string) => void;
    selectedPieceIds?: readonly string[];
  } = $props();
  let newName = $state('');
  let editingId = $state<string | null>(null);
  let status = $state('');
  const colorwayState = $derived(currentPattern.colorways);
  const active = $derived(colorwayState?.variants.find(variant => variant.id === colorwayState.activeId));
  const selected = $derived(colorwayState?.variants.find(variant => variant.id === editingId) ?? active);
  const displayed = $derived(selected && selected.id === colorwayState?.activeId
    ? { ...selected, pieces: captureColorwayPieces(currentPattern) } : selected);
  const errors = $derived(displayed ? colorwayProblems(currentPattern, displayed) : []);
  const rows = $derived(currentPattern.pieces.filter(piece => !selectedPieceIds.length || selectedPieceIds.includes(piece.id)));
  const missingPieces = $derived(displayed ? Object.keys(displayed.pieces).filter(id => !currentPattern.pieces.some(piece => piece.id === id)) : []);

  function commit(next: Pattern, label: string, message: string) {
    if (next !== currentPattern) onchange(next, label);
    status = message;
  }
  function add() {
    if (!newName.trim()) return;
    const next = createColorway($state.snapshot(currentPattern) as Pattern, newName);
    editingId = next.colorways?.activeId ?? null;
    commit(next, 'Create colorway', `Saved ${newName.trim()}.`);
    newName = '';
  }
  function activate(id: string) {
    const result = switchColorway($state.snapshot(currentPattern) as Pattern, id);
    if (result.errors.length) { status = result.errors.join(' '); return; }
    editingId = id;
    commit(result.pattern, 'Switch colorway', 'Colorway applied. Geometry is shared across all colorways.');
  }
  function update(pieceId: string, override: ColorwayPiece) {
    if (!selected) return;
    const result = updateColorwayPiece($state.snapshot(currentPattern) as Pattern, selected.id, pieceId, override);
    if (result.errors.length) { status = result.errors.join(' '); return; }
    commit(result.pattern, 'Edit colorway fabric', selected.id === colorwayState?.activeId ? 'Colorway fabric updated.' : 'Saved override updated. Activate this colorway to view it.');
  }
  function removeMissing(id: string) {
    if (!selected) return;
    commit(removeColorwayPiece($state.snapshot(currentPattern) as Pattern, selected.id, id), 'Remove obsolete colorway reference', 'Obsolete piece reference removed.');
  }
</script>

<div class="colorway-panel text-xs space-y-3" data-testid="colorway-panel" data-keyboard-scope="colorways">
  <div><h3 class="font-bold">Colorways</h3><p class="opacity-70 mt-1">Named fabrics and tints over one shared pattern.</p></div>
  <p>Active: <strong>{active?.name ?? 'Working fabrics (no active colorway)'}</strong></p>
  <div class="space-y-1">
    <label class="block" for="new-colorway-name">New colorway name</label>
    <input id="new-colorway-name" class="input input-bordered input-xs w-full" bind:value={newName} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
    <button class="btn btn-xs btn-primary w-full" disabled={!newName.trim() || !currentPattern.pieces.length} onclick={add}>Save current as colorway</button>
    {#if !colorwayState?.variants.length}<p class="opacity-60">Your current fabrics are also saved as Original when you create the first colorway.</p>{/if}
  </div>
  {#if colorwayState?.variants.length}
    <div class="space-y-1" aria-label="Saved colorways">
      {#each colorwayState.variants as variant (variant.id)}
        <div class="rounded border border-base-300 p-1 flex flex-wrap gap-1" data-testid="colorway-row">
          <button class="btn btn-xs btn-ghost flex-1" class:btn-active={selected?.id === variant.id} aria-pressed={selected?.id === variant.id}
            aria-label={`Edit colorway ${variant.name}`} onclick={() => { editingId = variant.id; status = ''; }}>{variant.name}{colorwayState.activeId === variant.id ? ' · active' : ''}</button>
          <button class="btn btn-xs btn-outline" aria-label={`Activate colorway ${variant.name}`} onclick={() => activate(variant.id)}>Use</button>
        </div>
      {/each}
    </div>
  {/if}
  {#if selected && displayed}
    <div class="border-t border-base-300 pt-2 space-y-2">
      <label class="block">Colorway name
        <input class="input input-bordered input-xs w-full" value={selected.name} onchange={(event) => commit(renameColorway($state.snapshot(currentPattern) as Pattern, selected.id, event.currentTarget.value), 'Rename colorway', 'Colorway renamed.')} />
      </label>
      <div class="flex gap-1">
        <button class="btn btn-xs btn-outline flex-1" onclick={() => {
          const next = duplicateColorway($state.snapshot(currentPattern) as Pattern, selected.id);
          editingId = next.colorways?.variants.at(-1)?.id ?? selected.id;
          commit(next, 'Duplicate colorway', 'Duplicated colorway. Activate it to view or edit its fabrics.');
        }}>Duplicate colorway</button>
        <button class="btn btn-xs btn-ghost text-error flex-1" onclick={() => {
          const wasActive = colorwayState?.activeId === selected.id;
          const next = deleteColorway($state.snapshot(currentPattern) as Pattern, selected.id);
          editingId = null;
          commit(next, 'Delete colorway', wasActive ? 'Colorway deleted. Current displayed fabrics are kept.' : 'Colorway deleted.');
        }}>Delete colorway</button>
      </div>
      {#if errors.length}<div role="alert" class="text-warning space-y-1"><strong>References need attention before switching.</strong>{#each errors as error}<p>{error}</p>{/each}</div>{/if}
      {#each missingPieces as id}<button class="btn btn-xs btn-outline w-full" onclick={() => removeMissing(id)}>Remove obsolete piece {id}</button>{/each}
      <p class="opacity-60">{selectedPieceIds.length ? 'Showing selected pieces.' : 'Showing all pieces.'} Fabric changes and tints apply immediately to the active colorway.</p>
      {#each rows as piece (piece.id)}
        {@const override = displayed.pieces[piece.id] ?? { materialId: piece.materialId }}
        {@const material = currentPattern.materials.find(material => material.id === override.materialId)}
        {@const sourceId = colorwayState?.generatedMaterialSources[override.materialId]}
        <div class="border border-base-300 rounded p-2 space-y-1" data-testid="colorway-piece-row" data-piece-id={piece.id}>
          <strong>{piece.name}</strong>
          <label class="block">Fabric for {piece.name}
            <select class="select select-bordered select-xs w-full" value={override.materialId}
              onchange={(event) => update(piece.id, { materialId: event.currentTarget.value })}>
              <option value="">No fabric</option>
              {#if override.materialId && !material}<option value={override.materialId}>Missing fabric — choose a replacement</option>{/if}
              {#each currentPattern.materials as fabric}<option value={fabric.id}>{fabric.name}</option>{/each}
            </select>
          </label>
          {#if material}
            {#if sourceId && !currentPattern.materials.some(fabric => fabric.id === sourceId)}<p class="text-warning">The original fabric was removed. This tint copy remains a project fabric.</p>{/if}
            <div class="flex flex-wrap gap-2">
              <label class="flex items-center gap-1">Front tint for {piece.name}<input type="color" value={override.frontColor ?? material.frontTexture?.color ?? '#6b7a8f'} onchange={(event) => update(piece.id, { ...override, frontColor: event.currentTarget.value })} /></label>
              <label class="flex items-center gap-1">Back tint for {piece.name}<input type="color" value={override.backColor ?? material.backTexture?.color ?? material.frontTexture?.color ?? '#6b7a8f'} onchange={(event) => update(piece.id, { ...override, backColor: event.currentTarget.value })} /></label>
            </div>
            <p class="opacity-60">Change the fabric to use its original colors. Tints preserve texture maps and fabric physics.</p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if status}<p role="status">{status}</p>{/if}
</div>

<style>
  input[type='color'] { width: 36px; height: 30px; flex-shrink: 0; cursor: pointer; }
  @media (pointer: coarse) {
    .colorway-panel :global(button), .colorway-panel :global(input), .colorway-panel :global(select) { min-height: 44px; }
  }
</style>
