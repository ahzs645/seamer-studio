<script lang="ts">
  import { base } from '$app/paths';
  import type { TextureSlot } from '@seamer/pattern-model';
  import {
    TEXTURE_MAP_FIELDS,
    blobToDataUrl,
    clearTexturePatch,
    downloadTextureUrl,
    linkedTexturePatch,
    storedTexturePatch,
    textureMapMode,
    textureMapSourceUrl,
    type TextureMapKind
  } from '$lib/utils/materialAssets';
  import { toastError, toastSuccess } from '$lib/stores/toast';

  interface Props {
    textureSlot: TextureSlot;
    kind: TextureMapKind;
    label: string;
    onchange: (patch: Partial<TextureSlot>) => void;
    showScale?: boolean;
  }

  let { textureSlot, kind, label, onchange, showScale = true }: Props = $props();
  let urlInput = $state('');
  let downloading = $state(false);
  const fields = $derived(TEXTURE_MAP_FIELDS[kind]);
  const mapUrl = $derived(textureSlot[fields.url]);
  const mode = $derived(textureMapMode(textureSlot, kind));

  $effect(() => { urlInput = textureMapSourceUrl(textureSlot, kind); });

  async function upload(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      onchange(storedTexturePatch(kind, await blobToDataUrl(file), 'uploaded'));
      toastSuccess(`${label} map uploaded into the project`);
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not upload image');
    }
  }

  async function download() {
    if (downloading) return;
    downloading = true;
    try {
      const dataUrl = await downloadTextureUrl(urlInput, { basePath: base });
      onchange(storedTexturePatch(kind, dataUrl, 'downloaded', urlInput));
      toastSuccess(`${label} map downloaded into the project`);
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not download image');
    } finally {
      downloading = false;
    }
  }
</script>

<div class="rounded border border-base-300 p-1.5 space-y-1" data-testid={`texture-source-${kind}`}>
  <div class="flex items-center gap-1">
    <span class="font-medium flex-1">{label}</span>
    <span class="badge badge-xs" class:badge-info={mode === 'linked'} class:badge-success={mode === 'uploaded' || mode === 'downloaded'}>
      {mode === 'none' ? 'None' : mode === 'linked' ? 'URL only' : mode === 'uploaded' ? 'Uploaded' : 'Downloaded'}
    </span>
    {#if mapUrl}<img src={mapUrl} alt="{label} map" class="w-6 h-6 rounded border border-base-300 object-cover" />{/if}
  </div>

  <input
    type="url"
    class="input input-bordered input-xs w-full"
    placeholder="https://…"
    aria-label="{label} map URL"
    bind:value={urlInput}
  />

  <div class="flex flex-wrap gap-1">
    <button class="btn btn-xs" class:btn-info={mode === 'linked'} disabled={!urlInput.trim()} onclick={() => onchange(linkedTexturePatch(kind, urlInput))} title="Keep only this URL; internet access will be required">Reference URL</button>
    <button class="btn btn-xs" class:btn-success={mode === 'downloaded'} disabled={!urlInput.trim() || downloading} onclick={download} title="Fetch this URL now and store an offline copy in the project">{downloading ? 'Downloading…' : 'Download URL'}</button>
    <label class="btn btn-xs cursor-pointer" class:btn-success={mode === 'uploaded'} title="Choose an image from this device and store it in the project">
      Upload file
      <input type="file" accept="image/*" class="hidden" onchange={upload} />
    </label>
    {#if mapUrl}<button class="btn btn-xs btn-ghost text-error" onclick={() => onchange(clearTexturePatch(kind))}>Clear</button>{/if}
  </div>

  {#if showScale}
    <label class="flex items-center gap-1" title="The image tiles every N millimetres of fabric">
      <span class="opacity-60">Tile</span>
      <input
        type="number"
        min="1"
        step="5"
        class="input input-bordered input-xs w-20"
        value={textureSlot[fields.scale]}
        onchange={(event) => onchange({ [fields.scale]: Math.max(1, +event.currentTarget.value || 100) } as Partial<TextureSlot>)}
      />
      <span class="opacity-50">mm</span>
    </label>
  {/if}
</div>
