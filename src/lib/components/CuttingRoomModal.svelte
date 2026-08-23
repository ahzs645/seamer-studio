<script lang="ts">
  // Cutting Room — nest pieces onto fabric, preview the marker, track which pieces have been cut,
  // then export/print. Offers the fast shelf packer and Atelier true-shape nesting, either on the
  // main thread or in a cancellable worker. Settings + cut state persist in pattern.markerSettings.
  import type { Pattern } from '@seamer/pattern-model';
  import {
    nestPieces, nestPiecesTrueShape, markerToSVG, type MarkerLayout, type CutOffType
  } from '$lib/utils/markerLayout';
  import {
    readMarkerSettings,
    writeMarkerSettings,
    type MarkerSettings
  } from '$lib/utils/markerSettings';
  import { nestInWorker, type NestJob, type NestProgress } from '$lib/utils/nestingClient';
  import { printMarkerTiled, downloadText, downloadBlob, markerToPDF, markerToHPGL } from '$lib/utils/exporters';
  import { toast, toastSuccess, toastError } from '$lib/stores/toast';
  import { machines, selectedMachineId, addMachine, updateMachine, removeMachine, type CuttingMachine } from '$lib/stores/machines';
  import { markerToCutFile, machineUsableWidthMm, printPieceLabels } from '$lib/utils/cutfile';
  import { warpLayoutToFabric, matchLayoutToRepeat } from '$lib/utils/markerLayout';

  let { currentPattern, onchange, onclose }:
    { currentPattern: Pattern; onchange: (p: Pattern, label?: string) => void; onclose: () => void } = $props();

  // svelte-ignore state_referenced_locally -- intentional one-time read of persisted settings on open
  const saved = readMarkerSettings(currentPattern.markerSettings);

  let algorithm = $state<MarkerSettings['algorithm']>(saved.algorithm);
  let fabricWidthMm = $state(saved.fabricWidthMm);
  let gapMm = $state(saved.gapMm);
  let maxLengthMm = $state(saved.maxLengthMm ?? 0); // 0 = unlimited (single sheet)
  let rotationMode = $state(rotationsToMode(saved.allowedRotations));
  let generations = $state(saved.generations);
  let gravity = $state(saved.gravity);
  let curveToleranceMm = $state(saved.curveToleranceMm);
  // fabric distortion compensation (the original's TPS warpToMesh), applied to machine cut files
  let fabricBowMm = $state(0);
  let fabricSkewMm = $state(0);
  // print/plaid matching: snap placements onto the fabric's repeat grid after nesting
  let matchEnabled = $state(false);
  let matchCellWmm = $state(50);
  let matchCellHmm = $state(50);
  let cutOff = $state<CutOffType>(saved.cutOff);
  let cutIds = $state<Set<string>>(new Set(saved.cutIds));

  let layout = $state<MarkerLayout | null>(null);
  let busy = $state(false);
  let job: NestJob | null = null;
  let progress = $state<NestProgress | null>(null);

  function rotationsToMode(r?: number[]): '0' | '0,180' | '4way' | 'free' {
    if (!r || r.length <= 1) return '0';
    if (r.length === 2) return '0,180';
    if (r.length === 4) return '4way';
    return 'free';
  }
  function modeToRotations(): number[] {
    switch (rotationMode) {
      case '0': return [0];
      case '0,180': return [0, 180];
      case '4way': return [0, 90, 180, 270];
      case 'free': return [0, 45, 90, 135, 180, 225, 270, 315];
    }
  }

  function persist() {
    const settings = writeMarkerSettings({
      algorithm,
      fabricWidthMm,
      gapMm,
      maxLengthMm,
      allowedRotations: modeToRotations(),
      generations,
      gravity,
      curveToleranceMm,
      cutOff,
      cutIds: [...cutIds]
    });
    onchange({ ...currentPattern, markerSettings: settings, hasChanged: true }, 'Cutting room settings');
  }

  async function nest() {
    busy = true;
    progress = null;
    // yield so the spinner paints before a potentially heavy true-shape run
    await new Promise((r) => setTimeout(r, 10));
    try {
      if (algorithm === 'nfp') {
        // worker-based Atelier GA: real generation progress and hard cancellation via solve host
        job?.cancel();
        job = nestInWorker(
          currentPattern,
          {
            fabricWidthMm,
            gapMm,
            maxLengthMm,
            allowedRotations: modeToRotations(),
            generations,
            population: 16,
            strategy: 'nfp',
            gravity,
            curveToleranceMm
          },
          (p) => (progress = p)
        );
        layout = await job.promise;
        job = null;
      } else {
        layout = algorithm === 'fast'
          ? nestPieces(currentPattern, fabricWidthMm, gapMm)
          : nestPiecesTrueShape(currentPattern, { fabricWidthMm, gapMm, allowedRotations: modeToRotations() });
      }
      if (layout.placements.length && matchEnabled) {
        // plaid/print matching: align every piece to the repeat grid so the print lands identically
        layout = matchLayoutToRepeat(layout, { cellWidthMm: matchCellWmm, cellHeightMm: matchCellHmm }, gapMm);
      }
      if (!layout.placements.length) toastError('No pieces to nest');
      else persist();
    } catch (e) {
      if ((e as Error)?.message !== 'cancelled') toastError((e as Error)?.message || 'Nesting failed');
    } finally {
      busy = false;
      progress = null;
    }
  }

  function cancelNest() {
    job?.cancel();
    job = null;
  }
  // tear the worker down if the modal closes mid-nest
  $effect(() => () => job?.cancel());

  const svg = $derived(layout ? markerToSVG(layout, cutOff, cutIds) : '');
  const uncut = $derived(layout ? layout.placements.filter((p) => !cutIds.has(p.instanceId ?? '')).length : 0);

  function toggleCut(id: string) {
    const next = new Set(cutIds);
    next.has(id) ? next.delete(id) : next.add(id);
    cutIds = next;
    persist();
  }
  function markAllCut() { if (!layout) return; cutIds = new Set(layout.placements.map((p) => p.instanceId ?? '')); persist(); }
  function resetCut() { cutIds = new Set(); persist(); }

  function exportSVG() {
    if (!layout) return;
    const base = (currentPattern.name || 'pattern').replace(/\s+/g, '_');
    downloadText(`${base}_marker.svg`, markerToSVG(layout, cutOff, cutIds), 'image/svg+xml');
    toastSuccess('Marker exported');
  }
  function print() {
    if (!layout) return;
    printMarkerTiled(layout, { title: (currentPattern.name || 'Pattern') + ' — marker' });
  }
  async function exportPDF() {
    if (!layout) return;
    const base = (currentPattern.name || 'pattern').replace(/\s+/g, '_');
    try {
      downloadBlob(`${base}_marker.pdf`, await markerToPDF(layout, { page: 'A0', tile: true, title: `${currentPattern.name} marker` }));
      toastSuccess('Marker PDF exported (A0, tiled)');
    } catch { toastError('PDF export failed'); }
  }
  async function exportHPGL() {
    if (!layout) return;
    const base = (currentPattern.name || 'pattern').replace(/\s+/g, '_');
    try {
      downloadText(`${base}_marker.hpgl`, await markerToHPGL(layout), 'application/vnd.hp-hpgl');
      toastSuccess('Marker HPGL exported');
    } catch { toastError('HPGL export failed'); }
  }

  // --- Machines (local cutting-room integration) -----------------------------------------------
  let manageMachines = $state(false);
  const machine = $derived($machines.find((m) => m.id === $selectedMachineId) ?? $machines[0] ?? null);

  function patchMachine(id: string, patch: Partial<Omit<CuttingMachine, 'id'>>) { updateMachine(id, patch); }
  function addNewMachine() {
    const m = addMachine({ name: `Machine ${$machines.length + 1}` });
    $selectedMachineId = m.id;
    manageMachines = true;
  }
  function deleteMachine(id: string) {
    removeMachine(id);
    if ($selectedMachineId === id) $selectedMachineId = $machines[0]?.id ?? '';
  }

  /** Nest at the machine's usable bed width (its bed minus margins), reusing the normal nest flow. */
  async function nestForMachine() {
    if (!machine) return;
    fabricWidthMm = machineUsableWidthMm(machine);
    await nest();
  }

  /** Generate + download the machine's cut file(s) for the current marker — the local equivalent of
   *  the production "Send to cutting room". Marks every piece cut on success. */
  async function sendToCuttingRoom() {
    if (!machine) { toastError('No machine selected'); return; }
    if (!layout || layout.fabricWidthMm !== machineUsableWidthMm(machine)) await nestForMachine();
    if (!layout || !layout.placements.length) { toastError('No pieces to nest'); return; }
    try {
      toast(`Sending to ${machine.name}…`);
      // fabric bow/skew compensation: TPS-warp the placements onto the measured fabric shape
      const warped = warpLayoutToFabric(layout, { bowMm: fabricBowMm, skewMm: fabricSkewMm });
      const res = markerToCutFile(warped, machine);
      for (const warning of res.warnings) toast(warning, 'info', 5000);
      const base = (currentPattern.name || 'pattern').replace(/\s+/g, '_');
      const slug = machine.name.replace(/\s+/g, '_');
      res.files.forEach((f, i) => {
        const part = res.files.length > 1 ? `_part${i + 1}` : '';
        downloadText(`${base}_${slug}${part}.${res.extension}`, f.text, res.mime);
      });
      markAllCut();
      toastSuccess('All materials have been cut');
    } catch { toastError('Cut file generation failed'); }
  }

  function printLabels() {
    if (!layout) return;
    try { printPieceLabels(layout, currentPattern.name || 'Pattern', currentPattern); }
    catch { toastError('Error printing label'); }
  }

  // initial nest on open
  $effect(() => { if (!layout) nest(); });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onclose(); }} />

<div
  class="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
  role="button" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}
  onkeydown={() => {}}
>
  <div class="bg-base-100 w-[min(1000px,96vw)] h-[min(700px,92vh)] rounded-lg shadow-2xl flex flex-col overflow-hidden" role="dialog" aria-label="Cutting room">
    <div class="flex items-center justify-between px-4 py-2 border-b border-base-300">
      <h2 class="font-bold text-lg flex items-center gap-2"><span class="material-symbols-rounded">content_cut</span> Cutting Room</h2>
      <button class="btn btn-ghost btn-sm btn-square" onclick={onclose} aria-label="Close">✕</button>
    </div>

    <div class="flex flex-1 overflow-hidden">
      <!-- controls -->
      <div class="w-64 border-r border-base-300 p-3 overflow-y-auto text-sm space-y-3 shrink-0">
        <label class="flex flex-col gap-1">Algorithm
          <select class="select select-bordered select-sm" bind:value={algorithm}>
            <option value="fast">Fast (bounding box)</option>
            <option value="trueShape">True shape (Atelier)</option>
            <option value="nfp">True shape (Atelier, background)</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">Fabric width (mm)
          <input type="number" min="100" step="10" class="input input-bordered input-sm" bind:value={fabricWidthMm} /></label>
        <label class="flex flex-col gap-1">Gap (mm)
          <input type="number" min="0" step="1" class="input input-bordered input-sm" bind:value={gapMm} /></label>
        {#if algorithm === 'nfp'}
          <label class="flex flex-col gap-1" title="Limit each fabric sheet's marker length; overflow pieces spill onto more sheets (bins)">Max sheet length (mm, 0 = unlimited)
            <input type="number" min="0" step="100" class="input input-bordered input-sm" bind:value={maxLengthMm} /></label>
        {/if}
        {#if algorithm === 'trueShape' || algorithm === 'nfp'}
          <label class="flex flex-col gap-1">Allowed rotations
            <select class="select select-bordered select-sm" bind:value={rotationMode}>
              <option value="0">None (0°)</option>
              <option value="0,180">Flip (0°, 180°)</option>
              <option value="4way">Quarter (0/90/180/270°)</option>
              <option value="free">Free (8 angles)</option>
            </select>
          </label>
        {/if}
        {#if algorithm === 'nfp'}
          <label class="flex flex-col gap-1">Search effort (generations): {generations}
            <input type="range" min="0" max="40" step="1" class="range range-xs" bind:value={generations} /></label>
          <label class="flex flex-col gap-1" title="Which fabric edge pieces snug toward">Gravity
            <select class="select select-bordered select-sm" bind:value={gravity}>
              <option value="bottom">Bottom</option>
              <option value="top">Top</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label class="flex flex-col gap-1" title="Simplification tolerance for curved cut outlines — coarser = faster nesting">Curve tolerance (mm)
            <input type="number" min="0.2" max="5" step="0.2" class="input input-bordered input-sm" bind:value={curveToleranceMm} /></label>
        {/if}
        <label class="flex items-center gap-2 text-sm" title="Snap pieces onto the print's repeat grid so checks/stripes land identically on every piece">
          <input type="checkbox" class="checkbox checkbox-sm" bind:checked={matchEnabled} /> Pattern matching
        </label>
        {#if matchEnabled}
          <div class="grid grid-cols-2 gap-1">
            <label class="flex flex-col gap-1 text-xs">Repeat W (mm)
              <input type="number" min="1" step="1" class="input input-bordered input-xs" bind:value={matchCellWmm} /></label>
            <label class="flex flex-col gap-1 text-xs">Repeat H (mm)
              <input type="number" min="1" step="1" class="input input-bordered input-xs" bind:value={matchCellHmm} /></label>
          </div>
        {/if}
        <label class="flex flex-col gap-1">Cut-off boundary
          <select class="select select-bordered select-sm" bind:value={cutOff}>
            <option value="none">None</option>
            <option value="boundingBox">Bounding box</option>
            <option value="convexHull">Convex hull</option>
            <option value="concaveHull">Concave hull</option>
          </select>
        </label>
        <button class="btn btn-primary btn-sm w-full" onclick={nest} disabled={busy}>
          {#if busy}<span class="loading loading-spinner loading-xs"></span> Nesting…{:else}Nest pieces{/if}
        </button>
        {#if busy && algorithm === 'nfp'}
          <div class="space-y-1">
            {#if progress}
              <progress class="progress progress-primary w-full" value={progress.generation} max={Math.max(1, progress.generations)}></progress>
              <div class="text-xs opacity-70">
                Gen {progress.generation}/{progress.generations} · {Math.round(progress.bestLengthMm)} mm · {(progress.efficiency * 100).toFixed(1)}%
              </div>
            {/if}
            <button class="btn btn-ghost btn-xs w-full" onclick={cancelNest}>Cancel</button>
          </div>
        {/if}

        <!-- Machines: pick/manage a cutting machine, nest at its bed width, send the cut file -->
        <div class="border-t border-base-300 pt-2 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase opacity-60">Machines</span>
            <button class="btn btn-ghost btn-xs" onclick={() => (manageMachines = !manageMachines)}>{manageMachines ? 'Done' : 'Manage'}</button>
          </div>
          <select class="select select-bordered select-sm w-full" bind:value={$selectedMachineId} aria-label="Cutting machine">
            {#each $machines as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
          </select>
          {#if machine}
            <div class="text-xs opacity-70">
              {machine.format.toUpperCase()} · bed {machine.bedWidthMm}×{machine.bedLengthMm} mm · margin {machine.marginMm} mm
              {#if machine.speed} · {machine.speed} cm/s{/if}
            </div>
          {/if}
          {#if manageMachines}
            {#if machine}
              <div class="space-y-1 rounded bg-base-200 p-2">
                <label class="flex flex-col gap-1 text-xs">Name
                  <input class="input input-bordered input-xs" value={machine.name}
                    onchange={(e) => patchMachine(machine.id, { name: e.currentTarget.value })} /></label>
                <label class="flex flex-col gap-1 text-xs">Format
                  <select class="select select-bordered select-xs" value={machine.format}
                    onchange={(e) => patchMachine(machine.id, { format: e.currentTarget.value as CuttingMachine['format'] })}>
                    <option value="hpgl">HPGL</option>
                    <option value="cut">CUT</option>
                    <option value="svg">SVG</option>
                  </select>
                </label>
                <div class="grid grid-cols-2 gap-1">
                  <label class="flex flex-col gap-1 text-xs">Bed width (mm)
                    <input type="number" min="100" step="10" class="input input-bordered input-xs" value={machine.bedWidthMm}
                      onchange={(e) => patchMachine(machine.id, { bedWidthMm: Number(e.currentTarget.value) || 100 })} /></label>
                  <label class="flex flex-col gap-1 text-xs">Bed length (mm)
                    <input type="number" min="100" step="10" class="input input-bordered input-xs" value={machine.bedLengthMm}
                      onchange={(e) => patchMachine(machine.id, { bedLengthMm: Number(e.currentTarget.value) || 100 })} /></label>
                  <label class="flex flex-col gap-1 text-xs">Margin (mm)
                    <input type="number" min="0" step="1" class="input input-bordered input-xs" value={machine.marginMm}
                      onchange={(e) => patchMachine(machine.id, { marginMm: Math.max(0, Number(e.currentTarget.value) || 0) })} /></label>
                  <label class="flex flex-col gap-1 text-xs">Speed (cm/s)
                    <input type="number" min="0" step="1" class="input input-bordered input-xs" value={machine.speed ?? ''}
                      onchange={(e) => patchMachine(machine.id, { speed: Number(e.currentTarget.value) || undefined })} /></label>
                  <label class="flex flex-col gap-1 text-xs" title="Pull slit notches inward along the edge so the knife doesn't nick the corner">Slit offset (mm)
                    <input type="number" min="0" step="0.5" class="input input-bordered input-xs" value={machine.slitNotchOffsetMm ?? 0}
                      onchange={(e) => patchMachine(machine.id, { slitNotchOffsetMm: Math.max(0, Number(e.currentTarget.value) || 0) })} /></label>
                  <label class="flex flex-col gap-1 text-xs" title="Raster export resolution for camera/projection workflows">Final px/mm
                    <input type="number" min="0" step="0.5" class="input input-bordered input-xs" value={machine.finalPixelsPerMm ?? 0}
                      onchange={(e) => patchMachine(machine.id, { finalPixelsPerMm: Math.max(0, Number(e.currentTarget.value) || 0) })} /></label>
                </div>
                <button class="btn btn-ghost btn-xs w-full text-error" onclick={() => deleteMachine(machine.id)}>Remove machine</button>
              </div>
            {/if}
            <button class="btn btn-ghost btn-xs w-full" onclick={addNewMachine}>+ Add machine</button>
          {/if}
          <!-- fabric distortion compensation: cut files are TPS-warped onto the measured bow/skew -->
          <div class="grid grid-cols-2 gap-1">
            <label class="flex flex-col gap-1 text-xs" title="Lateral mid-length bow of the fabric on the table (mm)">Fabric bow (mm)
              <input type="number" step="1" class="input input-bordered input-xs" bind:value={fabricBowMm} /></label>
            <label class="flex flex-col gap-1 text-xs" title="Sideways drift of the far end relative to the near end (mm)">Fabric skew (mm)
              <input type="number" step="1" class="input input-bordered input-xs" bind:value={fabricSkewMm} /></label>
          </div>
          <button class="btn btn-secondary btn-sm w-full" onclick={sendToCuttingRoom} disabled={busy || !machine}>
            <span class="material-symbols-rounded text-base">send</span> Send to cutting room
          </button>
          <button class="btn btn-ghost btn-xs w-full" onclick={printLabels} disabled={!layout || !layout.placements.length}>Print labels…</button>
        </div>

        {#if layout}
          <div class="border-t border-base-300 pt-2 text-xs space-y-1">
            <div>Pieces: <b>{layout.placements.length}</b> ({uncut} uncut)</div>
            <div>Length: <b>{Math.round(layout.usedLengthMm)}</b> mm</div>
            {#if layout.bins?.length}<div>Sheets: <b>{layout.bins.length}</b></div>{/if}
            {#if layout.efficiency !== undefined}<div>Efficiency: <b>{(layout.efficiency * 100).toFixed(1)}%</b></div>{/if}
          </div>
          <div class="flex gap-1">
            <button class="btn btn-ghost btn-xs flex-1" onclick={markAllCut}>Mark all cut</button>
            <button class="btn btn-ghost btn-xs flex-1" onclick={resetCut}>Reset</button>
          </div>
          <div class="flex gap-1">
            <button class="btn btn-ghost btn-xs flex-1" onclick={exportSVG}>SVG</button>
            <button class="btn btn-ghost btn-xs flex-1" onclick={exportPDF}>PDF</button>
            <button class="btn btn-ghost btn-xs flex-1" onclick={exportHPGL}>HPGL</button>
            <button class="btn btn-ghost btn-xs flex-1" onclick={print}>Print…</button>
          </div>
        {/if}
      </div>

      <!-- preview -->
      <div class="flex-1 flex flex-col overflow-hidden">
        <div class="flex-1 overflow-auto bg-base-200 p-3 flex items-start justify-center">
          {#if svg}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="bg-white shadow max-w-full [&_svg]:max-w-full [&_svg]:h-auto">{@html svg}</div>
          {:else}
            <div class="text-base-content/50 text-sm mt-12">No layout yet.</div>
          {/if}
        </div>
        {#if layout && layout.placements.length}
          <div class="h-28 border-t border-base-300 overflow-y-auto p-2">
            <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
              {#each layout.placements as pl (pl.instanceId)}
                <label class="flex items-center gap-1 truncate">
                  <input type="checkbox" class="checkbox checkbox-xs" checked={cutIds.has(pl.instanceId ?? '')} onchange={() => toggleCut(pl.instanceId ?? '')} />
                  <span class="truncate" class:line-through={cutIds.has(pl.instanceId ?? '')} class:opacity-50={cutIds.has(pl.instanceId ?? '')}>{pl.name}{pl.rotationDeg ? ` · ${pl.rotationDeg}°` : ''}</span>
                </label>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
