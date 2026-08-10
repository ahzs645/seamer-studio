<script lang="ts">
  import type { Pattern } from '@seamer/pattern-model';
  import { BODY_FIELDS, unitSuffix, COLUMN_NAMES, type MeasurementDef } from '@seamer/avatar';
  import { loadGenderModel } from '@seamer/avatar';
  import { toMetricKnown, completeMeasurements } from '@seamer/avatar';
  import { bodyProfiles, saveBodyProfile, updateBodyProfile, removeBodyProfile } from '$lib/stores/bodyProfiles';
  import { bodyZoomRequest } from '$lib/stores/pattern';
  import { bodyToJson, bodyToCsv, bodyToObj, bodyToStl } from '$lib/utils/bodyExport';
  import { bodyToSeamlyMe } from '$lib/utils/seamlyExport';
  import { downloadText, downloadBlob } from '$lib/utils/exporters';
  import { toastSuccess, toastError } from '$lib/stores/toast';

  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
  }

  let { currentPattern, onchange }: Props = $props();

  const imperial = $derived(currentPattern.body.unitType !== 'metric');

  // Estimated measurements (from the statistical model), in DISPLAY units, used as the value when
  // the user hasn't entered one — so steppers start from the current value, not 0.
  let estimates = $state<Record<string, number>>({});

  $effect(() => {
    const body = currentPattern.body;
    const imp = body.unitType !== 'metric';
    loadGenderModel(body.gender)
      .then((model) => {
        const full = completeMeasurements(model, toMetricKnown(body)); // metric, COLUMN_NAMES order
        const out: Record<string, number> = {};
        for (const f of BODY_FIELDS) {
          let metric: number;
          if (f.name === 'weight') metric = Math.pow(full[COLUMN_NAMES.indexOf('weightCbrt')] || 0, 3);
          else if (f.name === 'age') metric = full[COLUMN_NAMES.indexOf('age')] || 0;
          else metric = full[COLUMN_NAMES.indexOf(f.name)] || 0;
          out[f.name] = toDisplay(metric, f, imp);
        }
        estimates = out;
      })
      .catch(() => {});
  });

  function toDisplay(metric: number, f: MeasurementDef, imp: boolean): number {
    if (f.kind === 'age') return Math.round(metric);
    if (f.kind === 'weight') return imp ? metric * 2.20462 : metric;
    return imp ? metric / 2.54 : metric; // length cm -> in
  }

  function displayValue(f: MeasurementDef): number {
    const set = currentPattern.body.fields[f.name];
    if (set != null && !Number.isNaN(set)) return set;
    return estimates[f.name] ?? 0;
  }

  function stepSize(f: MeasurementDef): number {
    if (f.kind === 'age') return 1;
    if (f.kind === 'weight') return imperial ? 2 : 1;
    return imperial ? 0.5 : 1;
  }

  function setGender(gender: 'male' | 'female' | 'neutral') {
    onchange({ ...currentPattern, body: { ...currentPattern.body, gender, useLegacyDefaultAvatar: false }, hasChanged: true });
  }
  function setUnit(unitType: 'imperial' | 'metric') {
    onchange({ ...currentPattern, body: { ...currentPattern.body, unitType }, hasChanged: true });
  }
  function useImportedMeasurements() {
    onchange({
      ...currentPattern,
      body: { ...currentPattern.body, useLegacyDefaultAvatar: false },
      hasChanged: true
    });
  }
  function updateField(name: string, value: number) {
    const fields = { ...currentPattern.body.fields, [name]: Math.round(value * 10) / 10 };
    onchange({ ...currentPattern, body: { ...currentPattern.body, fields, useLegacyDefaultAvatar: false }, hasChanged: true });
  }
  function bump(f: MeasurementDef, dir: number) {
    updateField(f.name, displayValue(f) + dir * stepSize(f));
  }
  function clearField(name: string) {
    const fields = { ...currentPattern.body.fields };
    delete fields[name];
    onchange({ ...currentPattern, body: { ...currentPattern.body, fields, useLegacyDefaultAvatar: false }, hasChanged: true });
  }
  function updateBodyColor(color: string) {
    onchange({ ...currentPattern, body: { ...currentPattern.body, bodyColor: color }, hasChanged: true });
  }

  let showAll = $state(false);
  const visibleFields = $derived(showAll ? BODY_FIELDS : BODY_FIELDS.filter((f) => f.primary));

  // ---- body profiles: named reusable bodies (Save as new / Rename / Delete / Apply) --------------
  let selectedProfileId = $state('');
  function applyProfile(id: string) {
    selectedProfileId = id;
    const profile = $bodyProfiles.find((p) => p.id === id);
    if (!profile) return;
    onchange({
      ...currentPattern,
      body: { ...structuredClone(profile.body), useLegacyDefaultAvatar: false },
      hasChanged: true
    });
    toastSuccess(`Applied body "${profile.name}"`);
  }
  function saveAsNewProfile() {
    const name = prompt('Profile name:', `Body ${$bodyProfiles.length + 1}`);
    if (name === null) return;
    const profile = saveBodyProfile(name, structuredClone($state.snapshot(currentPattern.body)));
    selectedProfileId = profile.id;
    toastSuccess(`Saved body profile "${profile.name}"`);
  }
  function updateSelectedProfile() {
    if (!selectedProfileId) return;
    updateBodyProfile(selectedProfileId, { body: structuredClone($state.snapshot(currentPattern.body)) });
    toastSuccess('Profile updated from current body');
  }
  function renameSelectedProfile() {
    const profile = $bodyProfiles.find((p) => p.id === selectedProfileId);
    if (!profile) return;
    const name = prompt('Rename profile:', profile.name);
    if (name === null || !name.trim()) return;
    updateBodyProfile(profile.id, { name: name.trim() });
  }
  function deleteSelectedProfile() {
    if (!selectedProfileId) return;
    removeBodyProfile(selectedProfileId);
    selectedProfileId = '';
  }

  // ---- export: measurements (JSON / CSV / SeamlyMe) + the body mesh alone (OBJ / STL) ------------
  async function exportBody(kind: 'json' | 'csv' | 'seamlyme' | 'obj' | 'stl') {
    const body = $state.snapshot(currentPattern.body);
    const base = `body-${body.gender}`;
    try {
      if (kind === 'json') downloadText(`${base}.json`, await bodyToJson(body), 'application/json');
      else if (kind === 'csv') downloadText(`${base}.csv`, await bodyToCsv(body), 'text/csv');
      else if (kind === 'seamlyme') downloadText(`${base}.smis`, await bodyToSeamlyMe(body), 'application/xml');
      else if (kind === 'obj') downloadText(`${base}.obj`, await bodyToObj(body), 'text/plain');
      else downloadBlob(`${base}.stl`, new Blob([await bodyToStl(body)], { type: 'model/stl' }));
      toastSuccess('Body exported');
    } catch (e) {
      toastError((e as Error)?.message || 'Body export failed');
    }
  }
</script>

<div class="text-xs">
  <h3 class="font-bold mb-2">Body</h3>

  {#if currentPattern.body.useLegacyDefaultAvatar}
    <div class="alert alert-info p-2 mb-2 block text-[11px] leading-snug">
      <div class="font-semibold">Reference avatar active</div>
      <div class="opacity-75 mt-0.5">This legacy SSP keeps its saved drape on SeamScape’s default body. The imported measurements are still preserved.</div>
      <button class="btn btn-info btn-xs w-full mt-2" onclick={useImportedMeasurements}>Apply imported measurements</button>
    </div>
  {/if}

  <div class="mb-2">
    <span class="text-xs opacity-70">Body profile</span>
    <div class="flex items-center gap-1 mt-0.5">
      <select class="select select-bordered select-xs flex-1 min-w-0" value={selectedProfileId} onchange={(e) => applyProfile(e.currentTarget.value)} aria-label="Body profile">
        <option value="">— this pattern's body —</option>
        {#each $bodyProfiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
      </select>
      <div class="dropdown dropdown-end">
        <button class="btn btn-xs px-1.5" aria-label="Body profile options">…</button>
        <ul class="dropdown-content z-10 menu p-1 shadow bg-base-100 rounded-box w-44 text-xs">
          <li><button onclick={saveAsNewProfile}>Save as new…</button></li>
          {#if selectedProfileId}
            <li><button onclick={updateSelectedProfile}>Update from current</button></li>
            <li><button onclick={renameSelectedProfile}>Rename</button></li>
            <li><button class="text-error" onclick={deleteSelectedProfile}>Delete</button></li>
          {/if}
        </ul>
      </div>
    </div>
  </div>

  <div class="mb-2">
    <span class="text-xs opacity-70">Gender</span>
    <div class="join join-horizontal w-full mt-0.5">
      <button class="join-item btn btn-xs flex-1" class:btn-active={currentPattern.body.gender === 'female'} onclick={() => setGender('female')}>Female</button>
      <button class="join-item btn btn-xs flex-1" class:btn-active={currentPattern.body.gender === 'male'} onclick={() => setGender('male')}>Male</button>
      <button class="join-item btn btn-xs flex-1" class:btn-active={currentPattern.body.gender === 'neutral'} onclick={() => setGender('neutral')}>Neutral</button>
    </div>
  </div>

  <div class="mb-2">
    <span class="text-xs opacity-70">Units</span>
    <div class="join join-horizontal w-full mt-0.5">
      <button class="join-item btn btn-xs flex-1" class:btn-active={imperial} onclick={() => setUnit('imperial')}>Imperial</button>
      <button class="join-item btn btn-xs flex-1" class:btn-active={!imperial} onclick={() => setUnit('metric')}>Metric</button>
    </div>
  </div>

  <div class="mb-2">
    <span class="text-xs opacity-70">Skin Tone</span>
    <input type="color" class="w-full h-6 cursor-pointer rounded" value={currentPattern.body.bodyColor} oninput={(e) => updateBodyColor(e.currentTarget.value)} aria-label="Skin tone" />
  </div>

  <div class="mb-2">
    <span class="text-xs opacity-70">Measurements</span>
    <div class="space-y-1 mt-1">
      {#each visibleFields as f (f.name)}
        {@const isEstimate = currentPattern.body.fields[f.name] == null}
        <div class="flex items-center gap-1">
          <button class="truncate flex-1 text-left hover:text-accent" title="{f.label} — click to frame in 3D" onclick={() => bodyZoomRequest.set(f.name)}>{f.label}</button>
          <div class="join">
            <button class="join-item btn btn-xs px-1.5" aria-label="decrease" onclick={() => bump(f, -1)}>−</button>
            <input
              type="number"
              class="join-item input input-bordered input-xs w-12 text-right tabular-nums px-1"
              class:opacity-50={isEstimate}
              value={displayValue(f).toFixed(f.kind === 'age' ? 0 : 1)}
              step={stepSize(f)}
              oninput={(e) => { const v = parseFloat(e.currentTarget.value); if (!Number.isNaN(v)) updateField(f.name, v); }}
            />
            <button class="join-item btn btn-xs px-1.5" aria-label="increase" onclick={() => bump(f, 1)}>+</button>
          </div>
          <span class="text-[10px] opacity-50 w-5">{unitSuffix(f.kind, imperial)}</span>
          {#if !isEstimate}
            <button class="btn btn-xs btn-ghost px-0.5 text-error" title="Reset to estimate" onclick={() => clearField(f.name)}>×</button>
          {:else}
            <span class="w-4"></span>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <button class="btn btn-xs btn-ghost w-full" onclick={() => (showAll = !showAll)}>
    {showAll ? 'Show key measurements' : 'Show all measurements'}
  </button>
  <p class="text-[10px] opacity-50 mt-1">Faded values are estimated from the body model; edit to override.</p>

  <div class="dropdown dropdown-top w-full mt-2">
    <button class="btn btn-xs btn-secondary w-full">Export…</button>
    <ul class="dropdown-content z-10 menu p-1 shadow bg-base-100 rounded-box w-full text-xs">
      <li><button onclick={() => exportBody('json')}>Measurements (JSON)</button></li>
      <li><button onclick={() => exportBody('csv')}>Measurements (CSV)</button></li>
      <li><button onclick={() => exportBody('seamlyme')}>SeamlyMe (.smis)</button></li>
      <li><button onclick={() => exportBody('obj')}>3D Body (.obj)</button></li>
      <li><button onclick={() => exportBody('stl')}>3D Body (.stl)</button></li>
    </ul>
  </div>
</div>
