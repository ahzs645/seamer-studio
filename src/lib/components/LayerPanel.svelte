<script lang="ts">
  import {
    layerRename,
    layerSetStyle,
    type Layer,
    type LayerStyle,
    type Pattern
  } from '@seamer/pattern-model';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
  }

  let { currentPattern, onchange }: Props = $props();
  let newLayerName = $state('');
  let editingId = $state<string | null>(null);
  let editName = $state('');
  let styleId = $state<string | null>(null);

  function startRename(layer: Layer) { editingId = layer.id; editName = layer.name; }
  function commitRename() {
    if (editingId && editName.trim()) onchange(layerRename(currentPattern, editingId, editName.trim()));
    editingId = null;
  }
  function styleOf(layer: Layer): LayerStyle {
    return (layer.style && typeof layer.style === 'object' ? layer.style : {}) as LayerStyle;
  }
  function setStyle(layerId: string, patch: Partial<LayerStyle>) {
    const layer = currentPattern.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const next = { ...styleOf(layer), ...patch };
    onchange(layerSetStyle(currentPattern, layerId, next));
  }
  function clearStyle(layerId: string) { onchange(layerSetStyle(currentPattern, layerId, null)); }

  function toggleVisibility(layerId: string) {
    const layers = currentPattern.layers.map(l =>
      l.id === layerId ? { ...l, visible: !l.visible } : l
    );
    onchange({ ...currentPattern, layers, hasChanged: true });
  }

  function toggleLock(layerId: string) {
    const layers = currentPattern.layers.map(l =>
      l.id === layerId ? { ...l, locked: !l.locked } : l
    );
    onchange({ ...currentPattern, layers, hasChanged: true });
  }

  function selectLayer(layerId: string) {
    onchange({ ...currentPattern, currentLayerId: layerId, hasChanged: true });
  }

  function addLayer() {
    if (!newLayerName.trim()) return;
    const id = 'layer_' + crypto.randomUUID().slice(0, 9);
    const newLayer: Layer = {
      id,
      name: newLayerName.trim(),
      visible: true,
      locked: false,
      order: currentPattern.layers.length,
      style: {}
    };
    onchange({
      ...currentPattern,
      layers: [...currentPattern.layers, newLayer],
      currentLayerId: id,
      hasChanged: true
    });
    newLayerName = '';
  }

  function deleteLayer(layerId: string) {
    if (currentPattern.layers.length <= 1 || layerId === 'default') return; // default layer cannot be deleted
    const layers = currentPattern.layers.filter(l => l.id !== layerId);
    const fallback = layers.find(l => l.id === 'default')?.id ?? layers[0]?.id ?? 'default';
    const newCurrentId = currentPattern.currentLayerId === layerId ? fallback : currentPattern.currentLayerId;
    // move the deleted layer's elements onto the fallback layer
    const reassign = <T extends { layerId?: string }>(arr: T[]): T[] => arr.map(e => (e.layerId === layerId ? { ...e, layerId: fallback } : e));
    onchange({
      ...currentPattern,
      layers,
      currentLayerId: newCurrentId,
      points: reassign(currentPattern.points),
      paths: reassign(currentPattern.paths),
      pieces: reassign(currentPattern.pieces),
      hasChanged: true
    });
  }
</script>

<div class="text-xs">
  <h3 class="font-bold mb-2">Layers</h3>

  <div class="space-y-1 mb-2">
    {#each currentPattern.layers as layer (layer.id)}
      <div
        role="button"
        tabindex="0"
        class="flex items-center gap-1 p-1 rounded cursor-pointer w-full text-left {currentPattern.currentLayerId === layer.id ? 'bg-base-300' : 'hover:bg-base-200'}"
        onclick={() => selectLayer(layer.id)}
        onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') selectLayer(layer.id); }}
      >
        <button
          class="btn btn-xs btn-ghost px-1"
          class:text-opacity-30={!layer.visible}
          onclick={(e: MouseEvent) => { e.stopPropagation(); toggleVisibility(layer.id); }}
        >
          {layer.visible ? '👁' : '🚫'}
        </button>
        {#if editingId === layer.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="input input-bordered input-xs flex-1 h-5"
            bind:value={editName}
            autofocus
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') editingId = null; }}
            onblur={commitRename}
          />
        {:else}
          <span class="flex-1 truncate" ondblclick={(e) => { e.stopPropagation(); startRename(layer); }} role="textbox" tabindex="-1">{layer.name}</span>
        {/if}
        <button class="btn btn-xs btn-ghost px-1" title="Rename" onclick={(e: MouseEvent) => { e.stopPropagation(); startRename(layer); }} aria-label="Rename layer">✎</button>
        <button class="btn btn-xs btn-ghost px-1" class:text-primary={styleId === layer.id} title="Layer style" onclick={(e: MouseEvent) => { e.stopPropagation(); styleId = styleId === layer.id ? null : layer.id; }} aria-label="Layer style">🎨</button>
        <button
          class="btn btn-xs btn-ghost px-1"
          class:text-error={layer.locked}
          onclick={(e: MouseEvent) => { e.stopPropagation(); toggleLock(layer.id); }}
        >
          {layer.locked ? '🔒' : '🔓'}
        </button>
        {#if currentPattern.layers.length > 1 && layer.id !== 'default'}
          <button class="btn btn-xs btn-ghost px-1 text-error" onclick={(e: MouseEvent) => { e.stopPropagation(); deleteLayer(layer.id); }}>✕</button>
        {/if}
      </div>
      {#if styleId === layer.id}
        {@const st = styleOf(layer)}
        <div class="ml-6 mb-1 p-2 rounded bg-base-200 space-y-1">
          <div class="flex items-center gap-2">
            <span class="w-16">Light color</span>
            <input type="color" class="h-5 w-8 p-0 border-0 bg-transparent" value={st.color ?? '#000000'} onchange={(e) => setStyle(layer.id, { color: (e.currentTarget as HTMLInputElement).value })} />
            <button class="btn btn-ghost btn-xs ml-auto" onclick={() => clearStyle(layer.id)}>Clear</button>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-16">Dark color</span>
            <input type="color" class="h-5 w-8 p-0 border-0 bg-transparent" value={st.colorDark ?? st.color ?? '#e2e8f0'} onchange={(e) => setStyle(layer.id, { colorDark: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <label class="flex items-center gap-2">
            <span class="w-16">Width</span>
            <input type="range" min="0.5" max="4" step="0.5" class="range range-xs flex-1" value={st.lineWidth ?? 1} onchange={(e) => setStyle(layer.id, { lineWidth: +(e.currentTarget as HTMLInputElement).value })} />
            <span class="w-6 text-right">{st.lineWidth ?? 1}</span>
          </label>
          <label class="flex items-center gap-2">
            <span class="w-16">Opacity</span>
            <input type="range" min="0.1" max="1" step="0.1" class="range range-xs flex-1" value={st.opacity ?? 1} onchange={(e) => setStyle(layer.id, { opacity: +(e.currentTarget as HTMLInputElement).value })} />
            <span class="w-6 text-right">{st.opacity ?? 1}</span>
          </label>
          <label class="flex items-center gap-2">
            <span class="w-16">Line style</span>
            <select class="select select-bordered select-xs flex-1" value={st.lineStyle ?? (st.dashed ? 'dashed' : 'solid')}
              onchange={(e) => setStyle(layer.id, { lineStyle: (e.currentTarget as HTMLSelectElement).value as LayerStyle['lineStyle'] })}>
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
              <option value="dash-dot">Dash-dot</option>
              <option value="dash-dot-dot">Dash-dot-dot</option>
            </select>
          </label>
        </div>
      {/if}
    {/each}
  </div>

  <div class="flex gap-1">
    <input
      type="text"
      class="input input-bordered input-xs flex-1"
      placeholder="New layer..."
      bind:value={newLayerName}
      onkeydown={(e) => e.key === 'Enter' && addLayer()}
    />
    <button class="btn btn-xs btn-ghost" onclick={addLayer}>+</button>
  </div>
</div>
