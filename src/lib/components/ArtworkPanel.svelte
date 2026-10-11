<script lang="ts">
  import {
    addPieceArtwork, artworkPlacementProblem, artworkSourceProblem, MAX_ARTWORK_SOURCE_BYTES,
    pieceArtworkBounds, removePieceArtwork, updatePieceArtwork,
    saveAppearanceVersion, restoreAppearanceVersion, removeAppearanceVersion,
    type VectorArtworkDesign,
    type ArtworkMimeType, type ArtworkSource, type Pattern, type PieceArtwork
  } from '@seamer/pattern-model';
  import { artworkEditing } from '$lib/stores/artworkEditing';
  import { artworkSurfaceProblem, artworkRepeatTiles } from '$lib/utils/artworkSurface';
  import VectorArtworkEditor from './VectorArtworkEditor.svelte';
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
  let versionName=$state('');
  let vectorDesign=$state<VectorArtworkDesign | undefined>();
  let editingVectorId=$state<string|null>(null);
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
      const candidate={...row,...patch};const surfaceProblem=artworkSurfaceProblem(candidate);if(surfaceProblem)throw Error(surfaceProblem);
      if(candidate.repeat){const bounds=pieceArtworkBounds(previous,candidate.pieceId);if(bounds)artworkRepeatTiles(candidate,bounds);}
      const next = updatePieceArtwork(previous, row.id, patch);
      if (next !== previous) onchange(next, label);
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Artwork could not be updated.'; }
  }

  function center(row: PieceArtwork) {
    const bounds = pieceArtworkBounds(currentPattern, row.pieceId);
    if (!bounds) return;
    update(row, { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, 'Center artwork on piece');
  }

  function createVector(source: ArtworkSource, design: VectorArtworkDesign) {
    error='';try {
      if(editingVectorId) {const row=rows.find(item=>item.id===editingVectorId);if(!row)throw Error('The print was removed.');update(row,{...source,vectorDesign:design},'Edit vector print');}
      else {if(!target)throw Error('Select one piece first.');const next=addPieceArtwork(snapshot(),target.id,source,crypto.randomUUID(),'Vector print');next.artwork!.at(-1)!.vectorDesign=design;onchange(next,'Create vector artwork');}
    }catch(cause){error=cause instanceof Error?cause.message:'Could not create vector artwork.';}
  }
  function saveVersion(){try{onchange(saveAppearanceVersion(snapshot(),crypto.randomUUID(),versionName,new Date().toISOString()),'Save appearance version');versionName='';error='';}catch(cause){error=cause instanceof Error?cause.message:'Appearance could not be saved.';}}
  function zoneToSelection(row:PieceArtwork){const bounds=pieceArtworkBounds(currentPattern,row.pieceId);if(!bounds)return;
    update(row,{zone:[{x:bounds.minX,y:bounds.minY},{x:bounds.maxX,y:bounds.minY},{x:bounds.maxX,y:bounds.maxY},{x:bounds.minX,y:bounds.maxY}]},'Define print zone');}
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
  <VectorArtworkEditor oncreate={createVector} initialDesign={vectorDesign} disabled={busy || (!editingVectorId && !validTarget)} />
  {#if editingVectorId}<button class="btn btn-xs btn-ghost" onclick={()=>{editingVectorId=null;vectorDesign=undefined;}}>Finish editing vector print</button>{/if}
  <details class="rounded-lg border border-base-300 p-2" data-testid="appearance-history"><summary class="text-xs font-medium cursor-pointer">Appearance versions</summary>
    <label class="block text-xs mt-2">Version name<input class="input input-bordered input-xs w-full" bind:value={versionName} maxlength="200" /></label>
    <button class="btn btn-xs mt-1" disabled={!versionName.trim()} onclick={saveVersion}>Save appearance version</button>
    {#each currentPattern.appearanceHistory?.versions ?? [] as version (version.id)}<div class="text-xs flex gap-1 items-center mt-2"><span class="flex-1">{version.name}</span><button class="btn btn-xs" onclick={()=>onchange(restoreAppearanceVersion(snapshot(),version.id),'Restore appearance version')}>Restore</button><button class="btn btn-xs btn-ghost text-error" aria-label={`Remove version ${version.name}`} onclick={()=>onchange(removeAppearanceVersion(snapshot(),version.id),'Remove appearance version')}>×</button></div>{/each}
    <p class="text-[11px] opacity-60 mt-1">Stores fabric, assignments, colorways and prints; restoration preserves geometry and drape checkpoints. Up to eight named versions.</p>
  </details>
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
      <label class="text-xs flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={row.flipX??false} onchange={event=>update(row,{flipX:event.currentTarget.checked},'Reflect artwork source')} />Reflect artwork image</label>
      <fieldset class="space-y-2 rounded border border-base-300 p-2"><legend class="text-xs">Canvas print tool</legend>
        <div class="flex gap-1">{#each ['translate','rotate','resize'] as mode}<button class="btn btn-xs" class:btn-primary={$artworkEditing?.id===row.id && $artworkEditing.mode===mode} onclick={()=>artworkEditing.set({id:row.id,mode:mode as 'translate'|'rotate'|'resize'})}>{mode==='translate'?'Move':mode==='rotate'?'Rotate':'Resize'}</button>{/each}<button class="btn btn-xs btn-ghost" onclick={()=>artworkEditing.set(null)}>Done</button></div>
        <p class="text-[11px] opacity-60">Drag the print in 2D or 3D. Each release is one undoable edit; Escape cancels.</p>
      </fieldset>
      <details class="rounded border border-base-300 p-2"><summary class="text-xs cursor-pointer">Repeat, ink and print zone</summary>
        <label class="block text-xs mt-2">Repeat<select class="select select-xs w-full" value={row.repeat?.mode??'none'} onchange={event=>update(row,{repeat:event.currentTarget.value==='none'?undefined:{mode:event.currentTarget.value as 'grid'|'brick'|'half-drop',gapXmm:row.repeat?.gapXmm??0,gapYmm:row.repeat?.gapYmm??0}},'Change print repeat')}><option value="none">Single placement</option><option value="grid">Grid</option><option value="brick">Half brick</option><option value="half-drop">Half drop</option></select></label>
        {#if row.repeat}<div class="grid grid-cols-2 gap-2"><label class="text-xs">Gap X (mm)<NumericInput class="input input-xs w-full" min="0" value={row.repeat.gapXmm} oncommit={value=>update(row,{repeat:{...row.repeat!,gapXmm:value}},'Change repeat gap')} /></label><label class="text-xs">Gap Y (mm)<NumericInput class="input input-xs w-full" min="0" value={row.repeat.gapYmm} oncommit={value=>update(row,{repeat:{...row.repeat!,gapYmm:value}},'Change repeat gap')} /></label></div>{/if}
        <label class="block text-xs">Ink blend<select class="select select-xs w-full" value={row.treatment?.blend??'source-over'} onchange={event=>update(row,{treatment:{...row.treatment,blend:event.currentTarget.value as 'source-over'|'multiply'|'screen'}},'Change ink blend')}><option value="source-over">Normal ink</option><option value="multiply">Multiply ink</option><option value="screen">Screen ink</option></select></label>
        <label class="text-xs flex items-center gap-2"><input type="checkbox" class="checkbox checkbox-xs" checked={!!row.treatment?.tint} onchange={event=>update(row,{treatment:{blend:row.treatment?.blend??'source-over',tint:event.currentTarget.checked?'#111827':undefined}},'Toggle ink colour')} />Override ink colour</label>
        {#if row.treatment?.tint}<input type="color" aria-label="Print ink colour" value={row.treatment.tint} onchange={event=>update(row,{treatment:{...row.treatment!,tint:event.currentTarget.value}},'Change ink colour')} />{/if}
        {#if row.zone}<p class="text-[11px]">Zone: {row.zone.length} vertices in draft millimetres</p>{#each row.zone as point,index}<div class="grid grid-cols-2 gap-1"><label class="text-xs">Zone {index+1} X<NumericInput class="input input-xs w-full" value={point.x} oncommit={value=>update(row,{zone:row.zone!.map((p,i)=>i===index?{...p,x:value}:p)},'Edit print zone')} /></label><label class="text-xs">Zone {index+1} Y<NumericInput class="input input-xs w-full" value={point.y} oncommit={value=>update(row,{zone:row.zone!.map((p,i)=>i===index?{...p,y:value}:p)},'Edit print zone')} /></label></div>{/each}<button class="btn btn-xs btn-ghost" onclick={()=>update(row,{zone:undefined},'Remove print zone')}>Remove zone</button>{:else}<button class="btn btn-xs btn-ghost" onclick={()=>zoneToSelection(row)}>Define print zone</button>{/if}
      </details>
      {#if row.vectorDesign}<button class="btn btn-xs" onclick={()=>{editingVectorId=row.id;vectorDesign=structuredClone($state.snapshot(row.vectorDesign));}}>Edit vector design</button>{/if}
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-ghost btn-xs" disabled={!pieceArtworkBounds(currentPattern, row.pieceId)} onclick={() => center(row)}>Center on piece</button>
        <button class="btn btn-ghost btn-xs text-error" onclick={() => { onchange(removePieceArtwork(snapshot(), row.id), 'Remove artwork'); status = 'Removed artwork.'; error = ''; }}>Remove artwork</button>
      </div>
    </article>
  {/each}
</section>
