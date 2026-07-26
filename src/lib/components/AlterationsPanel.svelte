<script lang="ts">
  import type { Pattern, AlterationTrack, GradeAnchor, Variable } from '@seamer/pattern-model';

  interface EditState {
    trackId: string; driverVariableId: string; driverValue: number;
    base: Record<string, { x: number; y: number }>;
  }
  interface Props {
    currentPattern: Pattern;
    onchange: (p: Pattern) => void;
    onclose: () => void;
    editState: EditState | null;
    onstartedit: (trackId: string, driverValue: number) => void;
    onsetdriver: (driverValue: number) => void;
    onsavesample: () => void;
    onendedit: (cancel: boolean) => void;
  }
  let { currentPattern, onchange, onclose, editState, onstartedit, onsetdriver, onsavesample, onendedit }: Props = $props();

  const uid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
  const profile = $derived(currentPattern.gradingProfile ?? { sizes: [] });
  const tracks = $derived<AlterationTrack[]>(profile.alterationTracks ?? []);
  const anchors = $derived<GradeAnchor[]>(profile.anchors ?? []);
  const numericVars = $derived(currentPattern.variables.filter((v) => ['number', 'length', 'angle'].includes(v.type)));
  const enumVars = $derived(currentPattern.variables.filter((v) => v.type === 'enum'));
  const categoryVarIds = $derived<string[]>(profile.categoryVariableIds ?? []);
  const varName = (id: string | null | undefined) => currentPattern.variables.find((v) => v.id === id)?.name ?? '—';
  const editingTrack = $derived(editState ? tracks.find((t) => t.id === editState.trackId) ?? null : null);

  function updateProfile(partial: Partial<NonNullable<Pattern['gradingProfile']>>) {
    onchange({ ...currentPattern, gradingProfile: { ...profile, ...partial }, hasChanged: true });
  }
  function updateTracks(next: AlterationTrack[]) { updateProfile({ alterationTracks: next }); }
  function patchTrack(id: string, partial: Partial<AlterationTrack>) {
    updateTracks(tracks.map((t) => (t.id === id ? { ...t, ...partial } : t)));
  }

  function addTrack() {
    const driverVariableId = profile.mainDriverVariableId ?? numericVars[0]?.id ?? null;
    const track: AlterationTrack = { id: uid('alt_track'), name: `Alteration ${tracks.length + 1}`, enabled: true, driverVariableId, samples: [] };
    updateTracks([...tracks, track]);
  }
  function deleteTrack(id: string) { updateTracks(tracks.filter((t) => t.id !== id)); }
  function deleteSample(trackId: string, sampleId: string) {
    patchTrack(trackId, { samples: (tracks.find((t) => t.id === trackId)?.samples ?? []).filter((s) => s.id !== sampleId) });
  }

  // ---- driver preview (no edit mode): set the driver variable's value -> redraft interpolates -------
  let previewTrackId = $state<string>('');
  const previewTrack = $derived(tracks.find((t) => t.id === previewTrackId) ?? tracks[0] ?? null);
  const previewDriver = $derived(previewTrack?.driverVariableId ? currentPattern.variables.find((v) => v.id === previewTrack.driverVariableId)?.value ?? 0 : 0);
  function setDriverValue(varId: string, value: number) {
    const variables = currentPattern.variables.map((v) => (v.id === varId ? { ...v, value } : v));
    onchange({ ...currentPattern, variables, hasChanged: true });
  }
  const sampleRange = $derived(() => {
    const ds = (previewTrack?.samples ?? []).map((s) => s.driverValue);
    const lo = Math.min(0, ...ds), hi = Math.max(0, ...ds);
    const pad = Math.max(1, (hi - lo) * 0.5);
    return { min: lo - pad, max: hi + pad };
  });

  // ---- edit mode ------------------------------------------------------------
  let editDriver = $state(10);
  function beginEdit(trackId: string) { onstartedit(trackId, editDriver); }

  // ---- baseline anchors -----------------------------------------------------
  function addAnchor() {
    const driverValue = profile.mainDriverVariableId ? currentPattern.variables.find((v) => v.id === profile.mainDriverVariableId)?.value ?? 0 : 0;
    const categories: Record<string, string> = {};
    for (const id of categoryVarIds) { const v = currentPattern.variables.find((x) => x.id === id); const opt = (v?.options?.[0] as string) ?? ''; if (opt) categories[id] = opt; }
    const anchor: GradeAnchor = { id: uid('anchor'), name: `Anchor ${anchors.length + 1}`, driverValue, categories, geometry: { points: {}, handles: {} } };
    updateProfile({ anchors: [...anchors, anchor] });
  }
  function patchAnchor(id: string, partial: Partial<GradeAnchor>) {
    updateProfile({ anchors: anchors.map((a) => (a.id === id ? { ...a, ...partial } : a)) });
  }
  function deleteAnchor(id: string) { updateProfile({ anchors: anchors.filter((a) => a.id !== id) }); }
  function setAnchorCategory(anchorId: string, varId: string, opt: string) {
    const a = anchors.find((x) => x.id === anchorId); if (!a) return;
    patchAnchor(anchorId, { categories: { ...a.categories, [varId]: opt } });
  }
  function loadAnchor(a: GradeAnchor) {
    // apply the anchor's driver value + enum category selections (sets variable overrideValue)
    const variables = currentPattern.variables.map((v) => {
      if (profile.mainDriverVariableId && v.id === profile.mainDriverVariableId) return { ...v, value: a.driverValue };
      if (a.categories[v.id] != null) return { ...v, overrideValue: a.categories[v.id] };
      return v;
    });
    onchange({ ...currentPattern, variables, hasChanged: true });
  }
  function toggleCategoryVar(id: string) {
    updateProfile({ categoryVariableIds: categoryVarIds.includes(id) ? categoryVarIds.filter((x) => x !== id) : [...categoryVarIds, id] });
  }
</script>

<div class="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" role="dialog" tabindex="-1">
  <div class="bg-base-100 rounded-lg shadow-xl w-[840px] max-w-full max-h-[90vh] flex flex-col overflow-hidden">
    <!-- header -->
    <div class="flex items-center justify-between px-4 py-2.5 border-b">
      <div class="flex items-center gap-2">
        <span class="material-symbols-rounded text-primary">tune</span>
        <h2 class="font-semibold">Alterations — grade by example</h2>
      </div>
      <button class="btn btn-ghost btn-xs btn-circle" onclick={onclose} aria-label="Close"><span class="material-symbols-rounded">close</span></button>
    </div>

    {#if editState && editingTrack}
      <!-- ============ EDIT MODE ============ -->
      <div class="p-4 space-y-3 overflow-y-auto">
        <div class="alert alert-info py-2 text-sm">
          <span class="material-symbols-rounded">edit</span>
          Editing <b>{editingTrack.name}</b>. Drag points in the 2D canvas to sculpt the shape at this driver value, then save it as a sample.
        </div>
        <div class="flex items-end gap-3">
          <label class="form-control">
            <span class="label-text text-xs">Driver — {varName(editState.driverVariableId)}</span>
            <input type="number" class="input input-bordered input-sm w-32" value={editState.driverValue}
              onchange={(e) => onsetdriver(Number((e.currentTarget as HTMLInputElement).value))} />
          </label>
          <button class="btn btn-primary btn-sm" onclick={onsavesample}><span class="material-symbols-rounded text-base">photo_camera</span> Save sample</button>
          <div class="flex-1"></div>
          <button class="btn btn-success btn-sm" onclick={() => onendedit(false)}><span class="material-symbols-rounded text-base">check</span> Done</button>
          <button class="btn btn-ghost btn-sm" onclick={() => onendedit(true)}>Cancel</button>
        </div>
        <div>
          <div class="text-xs font-semibold opacity-60 mb-1">Samples ({editingTrack.samples.length})</div>
          {#if editingTrack.samples.length === 0}
            <div class="text-xs opacity-50">No samples yet. Set a non-zero driver value, drag points, then Save sample.</div>
          {:else}
            <div class="flex flex-wrap gap-1.5">
              {#each editingTrack.samples as s (s.id)}
                <span class="badge badge-outline gap-1">
                  @{s.driverValue} · {Object.keys(s.deltaGeometry.points).length}pt
                  <button class="hover:text-error" onclick={() => onsetdriver(s.driverValue)} title="Go to this driver value"><span class="material-symbols-rounded text-sm">my_location</span></button>
                  <button class="hover:text-error" onclick={() => deleteSample(editingTrack.id, s.id)} aria-label="Delete sample"><span class="material-symbols-rounded text-sm">delete</span></button>
                </span>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {:else}
      <!-- ============ MANAGE MODE ============ -->
      <div class="p-4 space-y-4 overflow-y-auto">
        {#if numericVars.length === 0}
          <div class="alert alert-warning py-2 text-sm"><span class="material-symbols-rounded">warning</span> Add a numeric variable first — alterations are driven by one.</div>
        {/if}

        <!-- main driver + tracks -->
        <section>
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-semibold text-sm">Tracks</h3>
            <button class="btn btn-xs btn-primary" onclick={addTrack} disabled={numericVars.length === 0}><span class="material-symbols-rounded text-base">add</span> Track</button>
          </div>
          {#if tracks.length === 0}
            <div class="text-xs opacity-50">No alteration tracks. A track records how the shape morphs as a measurement (its “driver”) changes.</div>
          {/if}
          <div class="space-y-2">
            {#each tracks as t (t.id)}
              <div class="border rounded-md p-2.5 space-y-2">
                <div class="flex items-center gap-2">
                  <input type="checkbox" class="checkbox checkbox-sm" checked={t.enabled} onchange={(e) => patchTrack(t.id, { enabled: (e.currentTarget as HTMLInputElement).checked })} title="Enabled" />
                  <input class="input input-bordered input-xs flex-1" value={t.name} onchange={(e) => patchTrack(t.id, { name: (e.currentTarget as HTMLInputElement).value })} />
                  <select class="select select-bordered select-xs" value={t.driverVariableId ?? ''} onchange={(e) => patchTrack(t.id, { driverVariableId: (e.currentTarget as HTMLSelectElement).value || null })}>
                    <option value="">— driver —</option>
                    {#each numericVars as v (v.id)}<option value={v.id}>{v.name}</option>{/each}
                  </select>
                  <button class="btn btn-ghost btn-xs btn-circle text-error" onclick={() => deleteTrack(t.id)} aria-label="Delete track"><span class="material-symbols-rounded text-base">delete</span></button>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                  {#each t.samples as s (s.id)}
                    <span class="badge badge-sm badge-outline gap-1">@{s.driverValue} · {Object.keys(s.deltaGeometry.points).length}pt
                      <button class="hover:text-error" onclick={() => deleteSample(t.id, s.id)} aria-label="Delete sample"><span class="material-symbols-rounded text-sm">close</span></button>
                    </span>
                  {/each}
                  {#if t.samples.length === 0}<span class="text-xs opacity-40">no samples</span>{/if}
                  <div class="flex-1"></div>
                  <input type="number" class="input input-bordered input-xs w-20" bind:value={editDriver} title="Driver value to edit at" />
                  <button class="btn btn-xs btn-outline" disabled={!t.driverVariableId} onclick={() => beginEdit(t.id)}><span class="material-symbols-rounded text-base">edit</span> Edit at {editDriver}</button>
                </div>
              </div>
            {/each}
          </div>
        </section>

        <!-- live preview slider -->
        {#if tracks.length > 0}
          <section class="border-t pt-3">
            <h3 class="font-semibold text-sm mb-2">Preview</h3>
            <div class="flex items-center gap-2">
              <select class="select select-bordered select-xs" bind:value={previewTrackId}>
                {#each tracks as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
              </select>
              {#if previewTrack?.driverVariableId}
                <span class="text-xs opacity-60 w-28">{varName(previewTrack.driverVariableId)} = {Number(previewDriver).toFixed(1)}</span>
                <input type="range" class="range range-xs flex-1" min={sampleRange().min} max={sampleRange().max} step="0.5"
                  value={previewDriver} oninput={(e) => setDriverValue(previewTrack.driverVariableId!, Number((e.currentTarget as HTMLInputElement).value))} />
              {:else}
                <span class="text-xs opacity-50">assign a driver variable to preview</span>
              {/if}
            </div>
          </section>
        {/if}

        <!-- baseline anchors + categories (multi-axis grading) -->
        <section class="border-t pt-3">
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-semibold text-sm">Baseline anchors</h3>
            <button class="btn btn-xs btn-outline" onclick={addAnchor}><span class="material-symbols-rounded text-base">add</span> Anchor</button>
          </div>
          <label class="form-control mb-2">
            <span class="label-text text-xs">Main driver variable (default for new tracks &amp; anchors)</span>
            <select class="select select-bordered select-xs w-56" value={profile.mainDriverVariableId ?? ''} onchange={(e) => updateProfile({ mainDriverVariableId: (e.currentTarget as HTMLSelectElement).value || null })}>
              <option value="">— none —</option>
              {#each numericVars as v (v.id)}<option value={v.id}>{v.name}</option>{/each}
            </select>
          </label>
          {#if enumVars.length > 0}
            <div class="mb-2">
              <div class="text-xs opacity-60 mb-1">Grading axes (enum categories)</div>
              <div class="flex flex-wrap gap-1.5">
                {#each enumVars as v (v.id)}
                  <button class="badge {categoryVarIds.includes(v.id) ? 'badge-primary' : 'badge-outline'}" onclick={() => toggleCategoryVar(v.id)}>{v.name}</button>
                {/each}
              </div>
            </div>
          {/if}
          {#if anchors.length === 0}
            <div class="text-xs opacity-50">No anchors. An anchor is a named baseline (driver value + category selection) you can load and edit relative to.</div>
          {/if}
          <div class="space-y-1.5">
            {#each anchors as a (a.id)}
              <div class="flex items-center gap-2 flex-wrap border rounded p-1.5">
                <input class="input input-bordered input-xs w-32" value={a.name} onchange={(e) => patchAnchor(a.id, { name: (e.currentTarget as HTMLInputElement).value })} />
                <label class="text-xs opacity-60">@<input type="number" class="input input-bordered input-xs w-16" value={a.driverValue} onchange={(e) => patchAnchor(a.id, { driverValue: Number((e.currentTarget as HTMLInputElement).value) })} /></label>
                {#each categoryVarIds as cid (cid)}
                  {@const cv = currentPattern.variables.find((x) => x.id === cid)}
                  <select class="select select-bordered select-xs" value={a.categories[cid] ?? ''} onchange={(e) => setAnchorCategory(a.id, cid, (e.currentTarget as HTMLSelectElement).value)}>
                    <option value="">{cv?.name}: —</option>
                    {#each (cv?.options ?? []) as opt}<option value={String(opt)}>{String(opt)}</option>{/each}
                  </select>
                {/each}
                <div class="flex-1"></div>
                <button class="btn btn-xs btn-ghost" onclick={() => loadAnchor(a)} title="Apply this anchor's driver + categories"><span class="material-symbols-rounded text-base">download</span></button>
                <button class="btn btn-xs btn-ghost text-error" onclick={() => deleteAnchor(a.id)} aria-label="Delete anchor"><span class="material-symbols-rounded text-base">delete</span></button>
              </div>
            {/each}
          </div>
        </section>
      </div>
    {/if}
  </div>
</div>
