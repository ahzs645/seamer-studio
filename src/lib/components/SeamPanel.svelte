<script lang="ts">
  import {
    indexPiecePathOwners,
    seamLabel,
    seamReverse,
    type Pattern,
    type Seam
  } from '@seamer/pattern-model';
  import { diagnoseSeam, editableAssembly, moveAssemblyStep, splitAssemblySeams, type SeamEaseSettings } from '$lib/utils/seamDiagnostics';
  import NumericInput from '$lib/components/NumericInput.svelte';
  import type { Editor } from '@atelier/core';
  import { editorState } from '@atelier/svelte';

  interface Props {
    currentPattern: Pattern;
    editor: Editor<Pattern>;
    onchange: (p: Pattern, label?: string) => void;
    disabled?: boolean;
  }

  let { currentPattern, editor, onchange, disabled = false }: Props = $props();
  // svelte-ignore state_referenced_locally -- parent keys this component by Editor identity
  const editorView = editorState(editor);
  const seamIds = $derived(editorView.selection.get('seam'));
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
    if (disabled || !fromId || !toId || fromId === toId) return;
    const seam: Seam = {
      id: 'Seam_' + crypto.randomUUID().slice(0, 9),
      name: '',
      fromPaths: [{ id: fromId, mirrored: fromMirror, reversed: false }],
      toPaths: [{ id: toId, mirrored: toMirror, reversed: false }]
    };
    onchange({ ...currentPattern, seams: [...currentPattern.seams, seam], hasChanged: true });
    editor.setSelection(editor.selection.clear().replace('seam', [seam.id]));
    fromId = ''; toId = ''; fromMirror = false; toMirror = false;
  }

  function removeSeam(id: string) {
    if (disabled) return;
    if (editor.selection.has('seam', id)) editor.setSelection(editor.selection.remove('seam', id));
    onchange({ ...currentPattern, seams: currentPattern.seams.filter((s) => s.id !== id), hasChanged: true });
  }

  // Reverse one SIDE's sewing direction (the original's "Reverse source/target direction" — flips
  // the reversed flag on every ref of that side, which changes how the sim pairs the particles).
  function reverseSide(id: string, side: 'from' | 'to') {
    if (!disabled) onchange(seamReverse(currentPattern, id, side), 'Reverse seam');
  }

  function selectSeam(id: string) {
    editor.setSelection(editor.selection.clear().replace('seam', editor.selection.has('seam', id) ? [] : [id]));
  }

  function setEase(id: string, patch: SeamEaseSettings) {
    if (disabled) return;
    onchange({ ...currentPattern, seams: currentPattern.seams.map(seam => seam.id === id ? { ...seam, ...patch } : seam), hasChanged: true }, 'Edit seam ease');
  }
  const assembly = $derived(editableAssembly(currentPattern));
  function editStep(id: string, patch: { label?: string; settleFrames?: number }) {
    if (disabled) return;
    onchange({ ...currentPattern, assembly: { ...assembly, steps: assembly.steps.map(step => step.id === id ? { ...step, ...patch } : step) }, hasChanged: true }, 'Edit assembly step');
  }
</script>

<div class="text-xs" data-document-keyboard="true">
  <h3 class="font-bold mb-2">Seams</h3>

  <div class="space-y-1 mb-2 max-h-56 overflow-y-auto">
    {#each currentPattern.seams as seam (seam.id)}
      {@const isSel = seamIds.has(seam.id)}
      {@const diagnostic = diagnoseSeam(currentPattern, seam)}
      <div class="p-1 rounded bg-base-200" class:ring-1={isSel} class:ring-primary={isSel}>
        <button class="w-full text-left truncate text-[11px]" data-testid={`seam-select-${seam.id}`} aria-pressed={isSel} title={seamLabel(currentPattern, seam, owners)} onclick={() => selectSeam(seam.id)}>
          {seamLabel(currentPattern, seam, owners)}
        </button>
        <div class="text-[11px] mt-1" class:text-warning={diagnostic.status === 'mismatch'} data-testid={`seam-diagnostic-${seam.id}`}>
          {#if diagnostic.easeMm !== null}Source {diagnostic.fromMm?.toFixed(1)} mm · target {diagnostic.toMm?.toFixed(1)} mm<br />
            Ease {diagnostic.easeMm.toFixed(1)} mm · {diagnostic.status === 'matched' ? 'Within tolerance' : 'Outside tolerance'}
          {:else}Unresolved sewing edges{/if}
        </div>
        {#if isSel}
          <p class="text-[11px] opacity-60 mt-1">Both sewing edges are selected in the draft and garment views. Positive ease means a longer source edge.</p>
          <label class="flex items-center justify-between mt-1">Expected ease (mm)<NumericInput value={diagnostic.expectedEaseMm} class="input input-bordered input-xs w-20" {disabled} oncommit={(value) => setEase(seam.id, { expectedEaseMm: value })} /></label>
          <label class="flex items-center justify-between mt-1">Tolerance (mm)<NumericInput value={diagnostic.toleranceMm} min="0" class="input input-bordered input-xs w-20" {disabled} oncommit={(value) => { if (value >= 0) setEase(seam.id, { toleranceMm: value }); }} /></label>
          <div class="flex flex-wrap gap-1 mt-1">
            <button class="btn btn-xs btn-ghost flex-1" title="Reverse source direction" {disabled} onclick={() => reverseSide(seam.id, 'from')}>
              <span class="material-symbols-rounded text-sm align-middle">u_turn_left</span> Source
            </button>
            <button class="btn btn-xs btn-ghost flex-1" title="Reverse target direction" {disabled} onclick={() => reverseSide(seam.id, 'to')}>
              <span class="material-symbols-rounded text-sm align-middle">u_turn_right</span> Target
            </button>
            <button class="btn btn-xs btn-ghost text-error" title="Delete seam" {disabled} onclick={() => removeSeam(seam.id)}>
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
      <button class="btn btn-xs btn-ghost w-full" onclick={addSeam} disabled={disabled || !fromId || !toId || fromId === toId}>Add Seam</button>
    </div>
  {:else}
    <p class="text-xs opacity-50">Need at least 2 piece edges to create a seam.</p>
  {/if}
  <section class="mt-4 space-y-2" aria-label="Assembly order">
    <h3 class="font-bold">Assembly order</h3>
    <p class="opacity-60">The recording closes these seam groups in order, then settles for the specified frames.</p>
    {#each assembly.steps as step, index (step.id)}
      <div class="bg-base-200 rounded p-2 space-y-1">
        <label class="flex items-center gap-1">{index + 1}.<input aria-label={`Assembly step ${index + 1} name`} class="input input-bordered input-xs w-full" value={step.label} {disabled} onchange={(event) => editStep(step.id, { label: event.currentTarget.value })} /></label>
        <p>{step.seamIds.map(id => currentPattern.seams.find(seam => seam.id === id)?.name || edgeLabel(currentPattern.seams.find(seam => seam.id === id)?.fromPaths[0]?.id ?? id)).join(', ')}</p>
        <div class="flex gap-1 items-center">
          <button type="button" class="btn btn-xs" aria-label={`Move assembly step ${index + 1} up`} disabled={disabled || index === 0} onclick={() => onchange(moveAssemblyStep(currentPattern, step.id, -1), 'Reorder assembly')}>↑</button>
          <button type="button" class="btn btn-xs" aria-label={`Move assembly step ${index + 1} down`} disabled={disabled || index === assembly.steps.length - 1} onclick={() => onchange(moveAssemblyStep(currentPattern, step.id, 1), 'Reorder assembly')}>↓</button>
          <label class="flex items-center gap-1">Settle<NumericInput aria-label={`Assembly step ${index + 1} settle frames`} value={step.settleFrames ?? 12} min="0" max="3600" step="1" class="input input-bordered input-xs w-16" {disabled} oncommit={(value) => { if (Number.isInteger(value) && value >= 0 && value <= 3600) editStep(step.id, { settleFrames: value }); }} /></label>
        </div>
      </div>
    {/each}
    {#if currentPattern.seams.length}<button type="button" class="btn btn-xs w-full" {disabled} onclick={() => onchange(splitAssemblySeams(currentPattern), 'One seam per assembly step')}>One seam per step</button>{/if}
  </section>
</div>
