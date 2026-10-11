<script lang="ts">
  import {
    addPieceArtwork, artworkPlacementProblem, artworkSourceProblem, MAX_ARTWORK_SOURCE_BYTES,
    pieceArtworkBounds, removePieceArtwork, updatePieceArtwork,
    type ArtworkMimeType, type ArtworkSource, type Pattern, type PieceArtwork
  } from '@seamer/pattern-model';
  import NumericInput from './NumericInput.svelte';
  import { artworkImageMatchesSource } from '$lib/scene/pieceTextureImages';

  interface Props {
    currentPattern: Pattern;
    onchange: (pattern: Pattern, label?: string) => void;
    selectedPieceIds?: readonly string[];
  }
  let { currentPattern, onchange, selectedPieceIds = [] }: Props = $props();
  const instanceId = $props.id();
  let busy = $state(false);
  let error = $state('');
  let status = $state('');
  let brokenSources = $state<Record<string, string>>({});
  const rows = $derived(currentPattern.artwork ?? []);
  const selected = $derived(currentPattern.pieces.filter(piece => selectedPieceIds.includes(piece.id)));
  const target = $derived(selected.length === 1 ? selected[0] : null);
  const validTarget = $derived(target && pieceArtworkBounds(currentPattern, target.id));
  const validOwners = $derived(currentPattern.pieces.filter(piece => pieceArtworkBounds(currentPattern, piece.id)));

  const snapshot = () => $state.snapshot(currentPattern) as Pattern;
  const sourceProblem = (row: PieceArtwork) => artworkSourceProblem(row) ??
    (brokenSources[row.id] === row.dataUrl ? 'Image cannot be decoded or does not match its declared dimensions. Replace its source.' : null);

  function update(row: PieceArtwork, patch: Partial<Omit<PieceArtwork, 'id'>>, label: string) {
    error = ''; status = '';
    try {
      const previous = snapshot();
      const next = updatePieceArtwork(previous, row.id, patch);
      if (next !== previous) onchange(next, label);
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Artwork could not be updated.'; }
  }

  function center(row: PieceArtwork) {
    const bounds = pieceArtworkBounds(currentPattern, row.pieceId);
    if (!bounds) return;
    update(row, { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, 'Center artwork on piece');
  }

  async function readSource(file: File): Promise<ArtworkSource> {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Error('Choose a PNG, JPEG or WebP image.');
    if (file.size < 1 || file.size > MAX_ARTWORK_SOURCE_BYTES) throw Error('Choose an image no larger than 2 MiB.');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(Error('Image could not be read.'));
      reader.onerror = () => reject(Error('Image could not be read.'));
      reader.readAsDataURL(file);
    });
    const image = new Image();
    image.src = dataUrl;
    try { await image.decode(); } catch { throw Error('Image cannot be decoded. Choose a valid PNG, JPEG or WebP file.'); }
    const source: ArtworkSource = { dataUrl, mimeType: file.type as ArtworkMimeType,
      pixelWidth: image.naturalWidth, pixelHeight: image.naturalHeight };
    const problem = artworkSourceProblem(source);
    if (problem) throw Error(problem);
    return source;
  }

  async function upload(event: Event & { currentTarget: HTMLInputElement }, replacing?: PieceArtwork) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || busy) return;
    const documentId = currentPattern.id;
    const ownerId = replacing?.pieceId ?? target?.id;
    if (!replacing && (!ownerId || !validTarget)) { error = 'Select exactly one piece with a valid boundary first.'; input.value = ''; return; }
    busy = true; error = ''; status = '';
    try {
      const source = await readSource(file);
      if (currentPattern.id !== documentId) throw Error('The project changed while reading the image. Choose the image again.');
      if (replacing) {
        if (!rows.some(row => row.id === replacing.id)) throw Error('This artwork was removed while the image was loading.');
        update(replacing, source, 'Replace artwork image');
        if (!error) {
          const repairedSources = { ...brokenSources };
          delete repairedSources[replacing.id];
          brokenSources = repairedSources;
          status = 'Replaced image; physical placement is preserved.';
        }
      } else {
        const next = addPieceArtwork(snapshot(), ownerId!, source, crypto.randomUUID(), file.name.replace(/\.[^.]+$/, ''));
        onchange(next, 'Add piece artwork');
        status = `Added ${file.name} to ${currentPattern.pieces.find(piece => piece.id === ownerId)?.name ?? 'the selected piece'}.`;
      }
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Image could not be added.'; }
    finally { busy = false; input.value = ''; }
  }
</script>

<section class="p-3 space-y-3" aria-labelledby={`${instanceId}-title`} data-testid="artwork-panel" data-keyboard-scope="artwork">
  <div>
    <h3 id={`${instanceId}-title`} class="font-semibold text-sm">Artwork</h3>
    <p class="text-xs opacity-70 mt-1">Front-face print; clips to the piece boundary. Placement uses the piece’s draft coordinates in millimetres.</p>
  </div>
  <div class="rounded-lg border border-base-300 p-2 space-y-2">
    <p class="text-xs" data-testid="artwork-target">{target ? `Selected piece: ${target.name || 'Unnamed piece'}` : 'Select exactly one piece to add artwork.'}</p>
    {#if target && !validTarget}<p class="text-xs text-warning">This piece has no usable boundary for artwork.</p>{/if}
    <label for={`${instanceId}-upload`} class="block text-xs font-medium">Add image to selected piece</label>
    <input id={`${instanceId}-upload`} type="file" accept="image/png,image/jpeg,image/webp"
      class="file-input file-input-bordered file-input-xs w-full max-w-full" disabled={!validTarget || busy} onchange={upload} />
    <p class="text-[11px] opacity-60">PNG, JPEG or WebP · 2 MiB per image · 8 MiB per project. Images are stored with the project.</p>
  </div>
  {#if busy}<p role="status" class="text-xs">Reading image…</p>{/if}
  {#if error}<p role="alert" class="text-xs text-error">{error}</p>{/if}
  {#if status}<p role="status" class="text-xs">{status}</p>{/if}
  {#if !rows.length}<p class="text-xs opacity-60">No artwork in this project.</p>{/if}
  {#each rows as row (row.id)}
    {@const owner = currentPattern.pieces.find(piece => piece.id === row.pieceId)}
    {@const imageProblem = sourceProblem(row)}
    {@const placementProblem = artworkPlacementProblem(row)}
    <article class="rounded-lg border border-base-300 p-2 space-y-2" data-testid="artwork-entry" aria-label={row.name || 'Artwork'}>
      <div class="flex items-center gap-2">
        {#if !imageProblem}<img src={row.dataUrl} alt={`Source for ${row.name}`} class="w-12 h-12 rounded object-contain bg-base-200 shrink-0"
          onerror={() => brokenSources = { ...brokenSources, [row.id]: row.dataUrl }}
          onload={event => { if (!artworkImageMatchesSource(event.currentTarget as HTMLImageElement, row)) brokenSources = { ...brokenSources, [row.id]: row.dataUrl }; }} />{/if}
        <label class="flex-1 min-w-0 text-xs">Name
          <input class="input input-bordered input-xs w-full" aria-label="Artwork name" value={row.name} onchange={event => update(row, { name: event.currentTarget.value }, 'Rename artwork')} />
        </label>
      </div>
      <label class="block text-xs">Piece
        <select class="select select-bordered select-xs w-full" aria-label="Artwork piece" value={row.pieceId}
          onchange={event => update(row, { pieceId: event.currentTarget.value }, 'Move artwork to piece')}>
          {#if !validOwners.some(piece => piece.id === row.pieceId)}<option value={row.pieceId}>{owner ? `${owner.name} (missing boundary)` : 'Missing piece'}</option>{/if}
          {#each validOwners as piece (piece.id)}<option value={piece.id}>{piece.name || 'Unnamed piece'}</option>{/each}
        </select>
      </label>
      {#if !owner}<p class="text-xs text-warning" role="status">The owner piece is missing. Choose another piece or remove this artwork.</p>{/if}
      {#if owner?.hidden}<p class="text-xs opacity-60">The owner piece is hidden. Show the piece to see its print.</p>{/if}
      {#if imageProblem}<p class="text-xs text-warning" role="status">{imageProblem}</p>{/if}
      {#if placementProblem}<p class="text-xs text-warning" role="status">{placementProblem}</p>{/if}
      <div class="grid grid-cols-2 gap-2">
        <label class="text-xs">X (mm)<NumericInput class="input input-bordered input-xs w-full" aria-label="Artwork X position" value={row.x} oncommit={value => update(row, { x: value }, 'Move artwork X')} /></label>
        <label class="text-xs">Y (mm)<NumericInput class="input input-bordered input-xs w-full" aria-label="Artwork Y position" value={row.y} oncommit={value => update(row, { y: value }, 'Move artwork Y')} /></label>
        <label class="text-xs">Width (mm)<NumericInput class="input input-bordered input-xs w-full" aria-label="Artwork width" value={row.widthMm} min="0.01" max="10000" oncommit={value => update(row, { widthMm: value }, 'Resize artwork width')} /></label>
        <label class="text-xs">Height (mm)<NumericInput class="input input-bordered input-xs w-full" aria-label="Artwork height" value={row.heightMm} min="0.01" max="10000" oncommit={value => update(row, { heightMm: value }, 'Resize artwork height')} /></label>
        <label class="text-xs">Rotation (°)<NumericInput class="input input-bordered input-xs w-full" aria-label="Artwork rotation" value={row.rotation} oncommit={value => update(row, { rotation: value }, 'Rotate artwork')} /></label>
        <label class="text-xs">Opacity<NumericInput class="input input-bordered input-xs w-full" aria-label="Artwork opacity" value={row.opacity} min="0" max="1" step="0.05" oncommit={value => update(row, { opacity: value }, 'Change artwork opacity')} /></label>
      </div>
      <label class="block text-xs" for={`${instanceId}-${row.id}-replace`}>Replace image (keeps placement)</label>
      <input id={`${instanceId}-${row.id}-replace`} type="file" accept="image/png,image/jpeg,image/webp"
        class="file-input file-input-bordered file-input-xs w-full max-w-full" disabled={busy} onchange={event => upload(event, row)} />
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-ghost btn-xs" disabled={!pieceArtworkBounds(currentPattern, row.pieceId)} onclick={() => center(row)}>Center on piece</button>
        <button class="btn btn-ghost btn-xs text-error" onclick={() => { onchange(removePieceArtwork(snapshot(), row.id), 'Remove artwork'); status = 'Removed artwork.'; error = ''; }}>Remove artwork</button>
      </div>
    </article>
  {/each}
</section>
