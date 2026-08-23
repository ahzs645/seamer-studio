<script lang="ts">
  import type { Pattern, Material, TextureSlot } from '@seamer/pattern-model';
  import MaterialPreview3D from '$lib/components/MaterialPreview3D.svelte';
  import TextureMapSource from '$lib/components/TextureMapSource.svelte';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
  }

  let { currentPattern, onchange }: Props = $props();
  let editingId: string | null = $state(null);

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
    onchange({ ...currentPattern, materials: [...currentPattern.materials, mat], hasChanged: true });
    editingId = id;
  }

  function removeMaterial(id: string) {
    onchange({ ...currentPattern, materials: currentPattern.materials.filter((m) => m.id !== id), hasChanged: true });
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

<div class="text-xs">
  <h3 class="font-bold mb-2">Fabric</h3>

  <div class="space-y-1 mb-2 max-h-72 overflow-y-auto">
    {#each currentPattern.materials as mat (mat.id)}
      {#if editingId === mat.id}
        <div class="bg-base-200 p-2 rounded space-y-1">
          <MaterialPreview3D material={mat} />
          <input type="text" class="input input-bordered input-xs w-full" value={mat.name}
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
          <button class="btn btn-xs btn-ghost w-full" onclick={() => (editingId = null)}>Done</button>
        </div>
      {:else}
        <div role="button" tabindex="0" class="flex items-center gap-1 p-1 rounded hover:bg-base-200 cursor-pointer w-full text-left"
          ondblclick={() => (editingId = mat.id)}
          onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') editingId = mat.id; }}>
          <span class="w-3 h-3 rounded-full inline-block border" style="background: {swatch(mat)}"></span>
          <span class="flex-1 truncate">{mat.name}</span>
          <span class="text-xs opacity-50">↔{mat.stretchWarpValue}/{mat.stretchWeftValue}</span>
          <button class="btn btn-xs btn-ghost px-1" onclick={(e: MouseEvent) => { e.stopPropagation(); editingId = mat.id; }}>✎</button>
          <button class="btn btn-xs btn-ghost px-0.5 text-error" onclick={(e: MouseEvent) => { e.stopPropagation(); removeMaterial(mat.id); }}>&times;</button>
        </div>
      {/if}
    {/each}
    {#if currentPattern.materials.length === 0}
      <p class="text-xs opacity-50 my-1">No fabrics defined.</p>
    {/if}
  </div>

  <button class="btn btn-xs btn-ghost w-full" onclick={addMaterial}>+ Add Fabric</button>
</div>
