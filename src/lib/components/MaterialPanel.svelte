<script lang="ts">
  import type { Pattern, Material, TextureSlot } from '@seamer/pattern-model';
  import MaterialPreview3D from '$lib/components/MaterialPreview3D.svelte';
  import TextureMapSource from '$lib/components/TextureMapSource.svelte';
  import { materialLibrary, instantiateFromLibrary, saveNewLibraryItem } from '$lib/stores/materialLibrary';
  import { applyFabric, removeFabric, type FabricSource } from '$lib/utils/fabricApplication';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern, label?: string) => void;
    selectedPieceIds?: readonly string[];
  }

  let { currentPattern, onchange, selectedPieceIds = [] }: Props = $props();
  let editingId: string | null = $state(null);
  let query = $state('');
  let sourceTab = $state<'project' | 'library'>('project');
  let chosen = $state<{ kind: 'project' | 'library'; id: string } | null>(null);
  let status = $state('');
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  const projectResults = $derived(currentPattern.materials.filter(material => material.id === editingId || matches(material.name)));
  const libraryResults = $derived($materialLibrary.filter(item => matches(item.name)));
  const selectedIds = $derived(currentPattern.pieces.filter(piece => selectedPieceIds.includes(piece.id)).map(piece => piece.id));
  const activeSource: FabricSource | null = $derived.by(() => {
    const selected = chosen;
    if (!selected || selected.kind !== sourceTab) return null;
    if (selected.kind === 'project') return currentPattern.materials.some(material => material.id === selected.id)
      ? { kind: 'project', id: selected.id } : null;
    const item = $materialLibrary.find(item => item.id === selected.id);
    return item ? { kind: 'library', item } : null;
  });
  const activeName = $derived(activeSource?.kind === 'library' ? activeSource.item.name
    : activeSource ? currentPattern.materials.find(material => material.id === activeSource.id)?.name : undefined);

  function choose(kind: 'project' | 'library', id: string) {
    chosen = { kind, id };
    status = '';
  }

  function apply(scope: 'selected' | 'all') {
    if (!activeSource) return;
    const targets = scope === 'all' ? currentPattern.pieces.map(piece => piece.id) : selectedIds;
    const result = applyFabric($state.snapshot(currentPattern) as Pattern, activeSource.kind === 'library'
      ? { kind: 'library', item: structuredClone($state.snapshot(activeSource.item)) } : activeSource, targets);
    if (result.count) {
      const sourceLabel = activeSource.kind === 'library'
        ? `${activeName} (library copy ${currentPattern.materials.filter(material => material.libraryItemId === activeSource.item.id).length + 1})`
        : `${activeName} (fabric ${currentPattern.materials.findIndex(material => material.id === activeSource.id) + 1})`;
      const scopeLabel = scope === 'all' ? 'all pieces' : currentPattern.pieces.filter(piece => targets.includes(piece.id)).map(piece => piece.name || 'Unnamed piece').join(', ');
      onchange(result.pattern, `Apply ${sourceLabel} to ${scopeLabel}`);
      status = `Applied ${activeName} to ${result.count} ${result.count === 1 ? 'piece' : 'pieces'}.`;
    } else status = targets.length ? 'These pieces already use this fabric.' : 'Select a piece to apply fabric.';
  }

  function createFromLibrary() {
    if (activeSource?.kind !== 'library') return;
    const material = structuredClone(instantiateFromLibrary($state.snapshot(activeSource.item), crypto.randomUUID()));
    onchange({ ...currentPattern, materials: [...currentPattern.materials, material], hasChanged: true }, 'Create fabric from library');
    sourceTab = 'project'; query = ''; choose('project', material.id); editingId = material.id;
  }

  function saveToLibrary(material: Material) {
    const link = saveNewLibraryItem($state.snapshot(material), new Date().toISOString());
    patch(material.id, value => ({ ...value, ...link }));
    status = `Saved ${material.name} to the local fabric library.`;
  }

  function defaultSlot(color: string): TextureSlot {
    return {
      url: '', mediaId: null, color, scale: 100,
      normalUrl: '', normalMediaId: null, normalMapScale: 100,
      opacityUrl: '', opacityMediaId: null, opacityMapScale: 100
    };
  }

  function swatch(mat: Material): string {
    return mat.frontTexture?.color ?? '#7c8aa0';
  }

  function addMaterial() {
    const id = crypto.randomUUID();
    const mat: Material = {
      id,
      name: 'New Fabric',
      frontTexture: defaultSlot('#6b7a8f'),
      backTexture: defaultSlot('#6b7a8f'),
      useSeparateBackSide: false,
      stretchWarpValue: 10,
      stretchWeftValue: 10,
      bendValue: 0,
      thickness: 0.5,
      weight: 150,
      shrinkageHorizontalPercentage: 0,
      shrinkageVerticalPercentage: 0,
      roughness: 0.8,
      metalness: 0.1,
      specularIntensity: 0.25,
      opacity: 1,
      normalScale: 1,
      alphaCutoff: 0,
      libraryItemId: null,
      libraryVersion: null,
      libraryUpdatedAt: null
    };
    onchange({ ...currentPattern, materials: [...currentPattern.materials, mat], hasChanged: true }, 'Create fabric');
    sourceTab = 'project'; query = ''; choose('project', id);
    editingId = id;
  }

  function removeMaterial(id: string) {
    onchange(removeFabric($state.snapshot(currentPattern) as Pattern, id), 'Remove fabric');
    if (editingId === id) editingId = null;
    if (chosen?.id === id && chosen.kind === 'project') chosen = null;
    status = 'Fabric removed. Pieces using it now use the first remaining fabric, or have no fabric.';
  }

  function patch(id: string, fn: (m: Material) => Material) {
    const materials = currentPattern.materials.map((m) => (m.id === id ? fn(m) : m));
    onchange({ ...currentPattern, materials, hasChanged: true });
  }

  /** Commit a numeric field on Enter/blur (one undo entry per edit). Non-numeric or empty input
   *  restores the previous value in the field instead of being coerced to 0. */
  function commitNumber(e: Event, current: number, apply: (v: number) => void) {
    const el = e.currentTarget as HTMLInputElement;
    const v = el.value.trim() === '' ? NaN : Number(el.value);
    if (Number.isFinite(v)) apply(v);
    else el.value = String(current);
  }

  function setColor(id: string, color: string) {
    patch(id, (m) => ({
      ...m,
      frontTexture: { ...(m.frontTexture ?? defaultSlot(color)), color },
      backTexture: m.useSeparateBackSide ? m.backTexture : { ...(m.backTexture ?? defaultSlot(color)), color }
    }));
  }

  // --- texture maps (diffuse / normal / opacity per slot; repeats every `scale` mm) ---------------
  type Side = 'frontTexture' | 'backTexture';
  const MAPS = [
    { label: 'Texture', kind: 'base' },
    { label: 'Normal', kind: 'normal' },
    { label: 'Opacity', kind: 'opacity' }
  ] as const;

  function patchSlot(id: string, side: Side, upd: Partial<TextureSlot>) {
    patch(id, (m) => ({ ...m, [side]: { ...(m[side] ?? defaultSlot(swatch(m))), ...upd } }));
  }

  function setSeparateBack(id: string, on: boolean) {
    patch(id, (m) => ({
      ...m,
      useSeparateBackSide: on,
      // when turning separate-back off, the back mirrors the front again
      backTexture: on ? (m.backTexture ?? m.frontTexture ?? defaultSlot(swatch(m))) : m.frontTexture
    }));
  }
</script>

<div class="material-panel text-xs">
  <h3 class="font-bold mb-2">Fabric</h3>
  <label class="block mb-2"><span class="sr-only">Search fabrics</span><input class="input input-bordered input-xs w-full" type="search" aria-label="Search fabrics" placeholder="Search fabrics…" bind:value={query} /></label>
  <div class="flex gap-1 mb-2" role="group" aria-label="Fabric sources">
    <button class="btn btn-xs flex-1" class:btn-active={sourceTab === 'project'} aria-pressed={sourceTab === 'project'} onclick={() => { sourceTab = 'project'; status = ''; }}>Project fabrics</button>
    <button class="btn btn-xs flex-1" class:btn-active={sourceTab === 'library'} aria-pressed={sourceTab === 'library'} onclick={() => { sourceTab = 'library'; status = ''; }}>Saved library</button>
  </div>
  <p class="mb-2 opacity-70">{selectedIds.length} selected {selectedIds.length === 1 ? 'piece' : 'pieces'} · {currentPattern.pieces.length} total</p>

  <div class="material-list space-y-1 mb-2 max-h-72 overflow-y-auto">
    {#if sourceTab === 'project'}
    {#each projectResults as mat (mat.id)}
      {#if editingId === mat.id}
        <div class="bg-base-200 p-2 rounded space-y-1">
          <MaterialPreview3D material={mat} />
          <input type="text" aria-label="Fabric name" class="input input-bordered input-xs w-full" value={mat.name}
            oninput={(e) => patch(mat.id, (m) => ({ ...m, name: e.currentTarget.value }))} />
          <label class="flex items-center gap-1">Color
            <input type="color" class="flex-1 h-6" value={swatch(mat)} oninput={(e) => setColor(mat.id, e.currentTarget.value)} />
          </label>
          <div class="grid grid-cols-2 gap-1">
            <label>Stretch warp
              <input type="number" min="0" max="100" class="input input-bordered input-xs w-full" value={mat.stretchWarpValue}
                onchange={(e) => commitNumber(e, mat.stretchWarpValue, (v) => patch(mat.id, (m) => ({ ...m, stretchWarpValue: v })))} /></label>
            <label>Stretch weft
              <input type="number" min="0" max="100" class="input input-bordered input-xs w-full" value={mat.stretchWeftValue}
                onchange={(e) => commitNumber(e, mat.stretchWeftValue, (v) => patch(mat.id, (m) => ({ ...m, stretchWeftValue: v })))} /></label>
            <label>Bend
              <input type="number" min="0" max="100" class="input input-bordered input-xs w-full" value={mat.bendValue}
                onchange={(e) => commitNumber(e, mat.bendValue, (v) => patch(mat.id, (m) => ({ ...m, bendValue: v })))} /></label>
            <label>Thickness (mm)
              <input type="number" step="0.1" class="input input-bordered input-xs w-full" value={mat.thickness}
                onchange={(e) => commitNumber(e, mat.thickness, (v) => patch(mat.id, (m) => ({ ...m, thickness: v })))} /></label>
            <label class="col-span-2">Weight (g/m²)
              <input type="number" class="input input-bordered input-xs w-full" value={mat.weight}
                onchange={(e) => commitNumber(e, mat.weight, (v) => patch(mat.id, (m) => ({ ...m, weight: v })))} /></label>
            <label class="col-span-2" title="3D-only visual shell: >0 extrudes the fabric front/back apart with a darkened edge strip">Visual thickness (mm, 3D)
              <input type="number" step="0.5" min="0" class="input input-bordered input-xs w-full" value={mat.visualizationThickness ?? 0}
                onchange={(e) => commitNumber(e, mat.visualizationThickness ?? 0, (v) => patch(mat.id, (m) => ({ ...m, visualizationThickness: Math.max(0, v) })))} /></label>
          </div>
          <div class="font-semibold mt-1 opacity-70">Material shrinkage</div>
          <div class="grid grid-cols-2 gap-1">
            <label>Horizontal (%)
              <input type="number" step="0.1" class="input input-bordered input-xs w-full" value={mat.shrinkageHorizontalPercentage ?? 0}
                onchange={(e) => commitNumber(e, mat.shrinkageHorizontalPercentage ?? 0, (v) => patch(mat.id, (m) => ({ ...m, shrinkageHorizontalPercentage: v })))} /></label>
            <label>Vertical (%)
              <input type="number" step="0.1" class="input input-bordered input-xs w-full" value={mat.shrinkageVerticalPercentage ?? 0}
                onchange={(e) => commitNumber(e, mat.shrinkageVerticalPercentage ?? 0, (v) => patch(mat.id, (m) => ({ ...m, shrinkageVerticalPercentage: v })))} /></label>
          </div>

          <div class="font-semibold mt-1 opacity-70">Texture maps</div>
          <label class="flex items-center gap-1">
            <input type="checkbox" class="checkbox checkbox-xs" checked={mat.useSeparateBackSide}
              onchange={(e) => setSeparateBack(mat.id, e.currentTarget.checked)} />
            Separate back side
          </label>
          {#each (mat.useSeparateBackSide ? [['frontTexture', 'Front'], ['backTexture', 'Back']] : [['frontTexture', '']]) as [side, sideLabel]}
            {@const slot = (side === 'backTexture' ? mat.backTexture : mat.frontTexture) ?? defaultSlot(swatch(mat))}
            {#if sideLabel}<div class="opacity-60 mt-0.5">{sideLabel}</div>{/if}
            {#each MAPS as map}
              <TextureMapSource
                textureSlot={slot}
                kind={map.kind}
                label={map.label}
                onchange={(update) => patchSlot(mat.id, side as Side, update)}
              />
            {/each}
          {/each}

          <div class="font-semibold mt-1 opacity-70">Appearance (3D)</div>
          <div class="grid grid-cols-2 gap-1">
            <label>Roughness (0–1)
              <input type="number" min="0" max="1" step="0.05" class="input input-bordered input-xs w-full" value={mat.roughness}
                onchange={(e) => commitNumber(e, mat.roughness, (v) => patch(mat.id, (m) => ({ ...m, roughness: v })))} /></label>
            <label>Metalness (0–1)
              <input type="number" min="0" max="1" step="0.05" class="input input-bordered input-xs w-full" value={mat.metalness}
                onchange={(e) => commitNumber(e, mat.metalness, (v) => patch(mat.id, (m) => ({ ...m, metalness: v })))} /></label>
            <label>Specularity (0–1)
              <input type="number" min="0" max="1" step="0.05" class="input input-bordered input-xs w-full" value={mat.specularIntensity}
                onchange={(e) => commitNumber(e, mat.specularIntensity, (v) => patch(mat.id, (m) => ({ ...m, specularIntensity: v })))} /></label>
            <label>Opacity (0–1)
              <input type="number" min="0" max="1" step="0.05" class="input input-bordered input-xs w-full" value={mat.opacity}
                onchange={(e) => commitNumber(e, mat.opacity, (v) => patch(mat.id, (m) => ({ ...m, opacity: v })))} /></label>
            <label>Normal scale
              <input type="number" min="0" max="4" step="0.1" class="input input-bordered input-xs w-full" value={mat.normalScale}
                onchange={(e) => commitNumber(e, mat.normalScale, (v) => patch(mat.id, (m) => ({ ...m, normalScale: v })))} /></label>
            <label>Alpha cutoff
              <input type="number" min="0" max="1" step="0.05" class="input input-bordered input-xs w-full" value={mat.alphaCutoff}
                onchange={(e) => commitNumber(e, mat.alphaCutoff, (v) => patch(mat.id, (m) => ({ ...m, alphaCutoff: v })))} /></label>
          </div>
          <button class="btn btn-xs btn-outline w-full" onclick={() => saveToLibrary(mat)}>Save to library</button>
          <button class="btn btn-xs btn-ghost w-full" onclick={() => (editingId = null)}>Done</button>
        </div>
      {:else}
        <div role="button" tabindex="0" class="fabric-card flex items-center gap-1 p-1 rounded hover:bg-base-200 cursor-pointer w-full text-left"
          class:chosen={chosen?.kind === 'project' && chosen.id === mat.id}
          data-testid="project-fabric-card" aria-pressed={chosen?.kind === 'project' && chosen.id === mat.id}
          onclick={() => choose('project', mat.id)} ondblclick={() => { choose('project', mat.id); editingId = mat.id; }}
          onkeydown={(e: KeyboardEvent) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose('project', mat.id); }
          }}>
          <span class="fabric-swatch" style:background={swatch(mat)}>{#if mat.frontTexture?.url}<img src={mat.frontTexture.url} alt="" loading="lazy" />{/if}</span>
          <span class="flex-1 truncate">{mat.name}</span>
          <span class="text-xs opacity-50">↔{mat.stretchWarpValue}/{mat.stretchWeftValue}</span>
          <button class="btn btn-xs btn-ghost px-1" aria-label={`Edit fabric ${mat.name}`} onclick={(e: MouseEvent) => { e.stopPropagation(); choose('project', mat.id); editingId = mat.id; }}>✎</button>
          <button class="btn btn-xs btn-ghost px-0.5 text-error" aria-label={`Remove fabric ${mat.name}`} onclick={(e: MouseEvent) => { e.stopPropagation(); removeMaterial(mat.id); }}>&times;</button>
        </div>
      {/if}
    {/each}
    {#if projectResults.length === 0}
      <p class="text-xs opacity-50 my-1">{query.trim() ? 'No project fabrics match your search.' : 'No fabrics defined.'}</p>
    {/if}
    {:else}
      {#each libraryResults as item (item.id)}
        <button type="button" class="fabric-card flex items-center gap-2 p-1 rounded hover:bg-base-200 w-full text-left"
          class:chosen={chosen?.kind === 'library' && chosen.id === item.id} aria-pressed={chosen?.kind === 'library' && chosen.id === item.id}
          data-testid="library-fabric-card" onclick={() => choose('library', item.id)}>
          <span class="fabric-swatch" style:background={item.material.frontTexture?.color ?? '#7c8aa0'}>{#if item.material.frontTexture?.url}<img src={item.material.frontTexture.url} alt="" loading="lazy" />{/if}</span>
          <span class="min-w-0 flex-1"><strong class="block truncate">{item.name}</strong><span class="opacity-60">Version {item.version} · {item.material.weight} g/m²</span></span>
        </button>
      {/each}
      {#if libraryResults.length === 0}<p class="opacity-60 py-2">{query.trim() ? 'No saved fabrics match your search.' : 'No saved fabrics yet. Edit a project fabric and save it to your library.'}</p>{/if}
    {/if}
  </div>
  <div class="border-t pt-2 space-y-1" aria-label="Apply fabric">
    <p>{activeName ? `Chosen: ${activeName}` : 'Choose a fabric to apply.'}</p>
    {#if sourceTab === 'library'}<p class="opacity-60">Applying creates a linked copy in this project.</p>{/if}
    <button class="btn btn-xs btn-primary w-full" disabled={!activeSource || selectedIds.length === 0} onclick={() => apply('selected')}>Apply to selected pieces</button>
    <button class="btn btn-xs btn-outline w-full" disabled={!activeSource || currentPattern.pieces.length === 0} onclick={() => apply('all')}>Apply to all pieces</button>
    {#if !selectedIds.length}<p class="opacity-60">Select pieces in 2D, 3D or the object browser to apply only to them.</p>{/if}
    {#if status}<p role="status" class="py-1">{status}</p>{/if}
  </div>
  {#if sourceTab === 'library'}<button class="btn btn-xs btn-ghost w-full mt-2" disabled={activeSource?.kind !== 'library'} onclick={createFromLibrary}>Create from library</button>{/if}
  <button class="btn btn-xs btn-ghost w-full" onclick={addMaterial}>+ Add Fabric</button>
</div>

<style>
  .fabric-card { border: 1px solid transparent; min-width: 0; }
  .fabric-card.chosen { border-color: oklch(var(--p)); background: oklch(var(--b2)); }
  .fabric-swatch { display: block; width: 40px; height: 40px; flex-shrink: 0; border-radius: 0.35rem; overflow: hidden; border: 1px solid oklch(var(--bc) / 0.15); }
  .fabric-swatch img { width: 100%; height: 100%; object-fit: cover; }
  @media (max-width: 1023px) {
    .material-list { max-height: none; overflow: visible; }
    .material-panel :global(button), .material-panel :global([role="button"]) { min-height: 44px; min-width: 44px; }
    .material-panel :global(input:not([type="checkbox"])) { min-height: 44px; font-size: 16px; }
  }
</style>
