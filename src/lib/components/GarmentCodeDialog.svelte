<script lang="ts">
  import { base } from '$app/paths';
  import type { Pattern } from '@seamer/pattern-model';
  import { toMetricKnown } from '@seamer/avatar';
  import { untrack } from 'svelte';
  import { GARMENTCODE_PRESETS, GARMENTCODE_EXAMPLES, type GarmentCodePreset, type GarmentCodeRequest } from '$lib/data/garmentCode';

  let { currentPattern, ongenerate, onexample, onclose }: {
    currentPattern: Pattern;
    ongenerate: (specification: unknown, request: GarmentCodeRequest) => Promise<void>;
    onexample: (file: string, label: string, signal?: AbortSignal) => Promise<void>;
    onclose: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  let launcher: HTMLElement | null = null;
  let pending = $state(false);
  let error = $state('');
  let controller: AbortController | null = null;
  const initialPattern = untrack(() => currentPattern);
  const previous = initialPattern.garmentCodeSource?.generation;
  const initialPreset = GARMENTCODE_PRESETS.find(option => option.id === previous?.preset)?.id ?? 't-shirt';
  function savedStyle(section: string, key: string): unknown {
    const value = previous?.design[section];
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  }
  function savedRatio(section: string, key: string, fallback: number): number {
    const value = savedStyle(section, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
  let preset = $state<GarmentCodePreset>(initialPreset);
  let topLength = $state(savedRatio('shirt', 'length', initialPreset === 'dress' ? 1.0 : 1.2));
  let bottomLength = $state(savedRatio(initialPreset === 'pants' ? 'pants' : 'skirt', 'length', initialPreset === 'pants' ? 0.9 : 0.5));
  let sleeveLength = $state(savedRatio('sleeve', 'length', initialPreset === 'hoodie' ? 1.0 : 0.3));
  let sleeveless = $state(savedStyle('sleeve', 'sleeveless') === true);
  const known = toMetricKnown(initialPattern.body);
  let body = $state({
    height: known.get('height') ?? 171.99,
    bust: known.get('chestGirth') ?? 99.8407,
    waist: known.get('waistGirth') ?? 84.3338,
    hips: known.get('hipGirth') ?? 103.478,
    arm_length: known.get('armLength') ?? 53.9697
  });
  const bodyFields = [
    { key: 'height', label: 'Height' }, { key: 'bust', label: 'Bust / chest' },
    { key: 'waist', label: 'Waist' }, { key: 'hips', label: 'Hips' },
    { key: 'arm_length', label: 'Arm length' }
  ] as const;

  $effect(() => {
    const element = dialog;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The generator's menu item becomes hidden when the modal takes focus. Return to the visible
    // Templates trigger so keyboard users can reopen its menu after closing the dialog.
    launcher = active?.closest('.dropdown')?.querySelector<HTMLElement>('[data-testid="templates-menu-trigger"]') ?? active;
    element.showModal();
    return () => {
      controller?.abort();
      if (element.open) element.close();
      if (launcher?.isConnected) launcher.focus({ preventScroll: true });
    };
  });

  function close() {
    controller?.abort();
    if (dialog.open) dialog.close();
    launcher?.focus({ preventScroll: true });
    onclose();
  }

  function finish() {
    // A completed import should expose the garment, rather than reopen the focus-driven menu.
    launcher = document.querySelector<HTMLElement>('[data-testid="pattern-scene-3d"]') ?? launcher;
    close();
  }

  function changePreset(value: GarmentCodePreset) {
    preset = value;
    topLength = value === 'dress' ? 1.0 : 1.2;
    bottomLength = value === 'pants' ? 0.9 : 0.5;
    sleeveLength = value === 'hoodie' ? 1.0 : 0.3;
    sleeveless = false;
    error = '';
  }

  async function generate(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    const design: Record<string, unknown> = {};
    if (preset === 't-shirt' || preset === 'hoodie' || preset === 'dress') {
      design.shirt = { length: topLength };
      design.sleeve = { sleeveless, length: sleeveLength };
    }
    if (preset === 'skirt' || preset === 'dress') design.skirt = { length: bottomLength };
    if (preset === 'pants') design.pants = { length: bottomLength };
    const request: GarmentCodeRequest = { preset, body: $state.snapshot(body), design };
    pending = true;
    error = '';
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const response = await fetch(`${base}/api/garmentcode`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request), signal
      });
      if (signal.aborted) return;
      if ([404, 405].includes(response.status) || !(response.headers.get('content-type') ?? '').includes('application/json')) {
        throw new Error('Garment generation is unavailable on this host. Open an example or import a GarmentCode JSON file.');
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The generator could not build this garment.');
      if (signal.aborted) return;
      await ongenerate(result, request);
      if (!signal.aborted) finish();
    } catch (failure) {
      if (!signal.aborted) error = failure instanceof Error ? failure.message : 'Could not generate the garment.';
    } finally {
      pending = false;
    }
  }

  async function openExample(file: string, label: string) {
    if (pending) return;
    pending = true;
    error = '';
    controller = new AbortController();
    const signal = controller.signal;
    try { await onexample(file, label, signal); if (!signal.aborted) finish(); }
    catch (failure) { if (!signal.aborted) error = failure instanceof Error ? failure.message : 'Could not open the example.'; }
    finally { pending = false; }
  }
</script>

<dialog bind:this={dialog} class="garment-dialog bg-base-100 text-base-content rounded-lg shadow-2xl p-0 backdrop:bg-black/40"
  aria-labelledby="garmentcode-title" oncancel={(event) => { event.preventDefault(); close(); }}
  onclick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  }}>
  <div class="p-4 space-y-4">
    <div class="flex items-center justify-between gap-3">
      <h2 id="garmentcode-title" class="text-lg font-bold">GarmentCode garment</h2>
      <button type="button" class="btn btn-ghost btn-sm btn-square" aria-label="Close garment generator" onclick={close}>✕</button>
    </div>
    <p class="text-sm opacity-70">Generate an editable sewing pattern with curves, seams and initial 3D panel placement. Use Start simulation in the 3D view to try sewing and draping it.</p>
    <form class="space-y-4" onsubmit={generate}>
      <label class="flex items-center justify-between gap-3 text-sm">Garment
        <select class="select select-bordered select-sm" value={preset} disabled={pending}
          onchange={(event) => changePreset(event.currentTarget.value as GarmentCodePreset)}>
          {#each GARMENTCODE_PRESETS as option}<option value={option.id}>{option.label}</option>{/each}
        </select>
      </label>
      <fieldset disabled={pending} class="grid grid-cols-2 gap-3">
        <legend class="text-sm font-semibold mb-2">Body measurements (cm)</legend>
        {#each bodyFields as field}
          <label class="flex flex-col gap-1 text-sm">{field.label}
            <input type="number" class="input input-bordered input-sm w-full" min="1" max="400" step="any" required bind:value={body[field.key]} />
          </label>
        {/each}
      </fieldset>
      <p class="text-xs opacity-60">Additional drafting measurements use the neutral preset. Generate again after changing measurements; the imported draft stays editable.</p>
      <fieldset disabled={pending} class="space-y-3">
        <legend class="text-sm font-semibold mb-2">Style</legend>
        {#if preset === 't-shirt' || preset === 'hoodie' || preset === 'dress'}
          <label class="flex items-center justify-between gap-3 text-sm">Top length ratio
            <input class="input input-bordered input-sm w-24" type="number" min="0.5" max="3.5" step="0.05" required bind:value={topLength} />
          </label>
          <label class="flex items-center justify-between gap-3 text-sm">Sleeveless
            <input type="checkbox" class="toggle toggle-sm" bind:checked={sleeveless} />
          </label>
          {#if !sleeveless}
            <label class="flex items-center justify-between gap-3 text-sm">Sleeve length ratio
              <input class="input input-bordered input-sm w-24" type="number" min="0.1" max="1.15" step="0.05" required bind:value={sleeveLength} />
            </label>
          {/if}
        {/if}
        {#if preset === 'skirt' || preset === 'dress' || preset === 'pants'}
          <label class="flex items-center justify-between gap-3 text-sm">{preset === 'pants' ? 'Pants' : 'Skirt'} length ratio
            <input class="input input-bordered input-sm w-24" type="number" min={preset === 'pants' ? 0.2 : 0.05} max={preset === 'pants' ? 0.9 : 0.95} step="0.05" required bind:value={bottomLength} />
          </label>
        {/if}
      </fieldset>
      {#if error}<p role="alert" class="text-sm text-error break-words">{error}</p>{/if}
      <div class="flex justify-end gap-2">
        <button class="btn btn-ghost btn-sm" type="button" onclick={close}>Cancel</button>
        <button class="btn btn-primary btn-sm" type="submit" disabled={pending}>{pending ? 'Generating…' : 'Generate garment'}</button>
      </div>
    </form>
    <div class="border-t pt-3 space-y-2">
      <p class="text-sm font-semibold">Open an example</p>
      <div class="grid grid-cols-2 gap-2">
        {#each GARMENTCODE_EXAMPLES as example}
          <button class="btn btn-outline btn-sm" type="button" disabled={pending} onclick={() => openExample(example.file, example.label)}>{example.label.replace('GarmentCode ', '')}</button>
        {/each}
      </div>
    </div>
  </div>
</dialog>

<style>
  .garment-dialog { width: min(520px, 94vw); max-height: calc(100dvh - 2rem); overflow-y: auto; }
  @media (max-width: 1023px) { button, input, select { min-height: 44px; } }
</style>
