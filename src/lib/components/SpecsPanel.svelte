<script lang="ts">
  import type { Pattern, ProductionMeasurement, ProductionMeasurementUnit, ProductionSpec, ProcurementCategory, ProcurementRow } from '@seamer/pattern-model';
  import { assignedMaterialRows, changeSpecUnit, convertSpecValue, evaluateSpecMeasurement } from '$lib/utils/productionSpec';
  import TechPackPanel from '$lib/components/TechPackPanel.svelte';
  import { convertTechPackMeasurementUnits } from '$lib/utils/techPack';

  interface Props {
    pattern: Pattern;
    onchange: (pattern: Pattern, label?: string) => void;
    request?: { tab: 'measurements' | 'bom' | 'techpack'; revision: number };
  }
  let { pattern, onchange, request }: Props = $props();
  let tab = $state<'measurements' | 'bom' | 'techpack'>('measurements');
  $effect(() => { if (request) { void request.revision; tab = request.tab; } });
  const spec = $derived(pattern.productionSpec ?? { measurements: [], procurement: [] });
  const fabrics = $derived(assignedMaterialRows(pattern));
  const categories: ProcurementCategory[] = ['material', 'trim', 'thread', 'fusing', 'label', 'packaging'];

  function save(next: ProductionSpec, label: string) {
    onchange({ ...($state.snapshot(pattern) as Pattern), productionSpec: next, hasChanged: true }, label);
  }
  function updateMeasurement(id: string, patch: Partial<ProductionMeasurement>, label?: string) {
    const fieldLabels: Record<string, string> = { name: 'name', manualValue: 'sample actual', target: 'target', tolMinus: 'minus tolerance', tolPlus: 'plus tolerance', notes: 'notes', annotationId: 'source', unit: 'unit' };
    const index = spec.measurements.findIndex(row => row.id === id);
    const field = fieldLabels[Object.keys(patch)[0]] ?? 'values';
    const next = { ...spec, measurements: spec.measurements.map(row => row.id === id ? { ...row, ...patch } : row) };
    const previous = spec.measurements[index];
    if (pattern.techPack && previous && patch.unit && patch.unit !== previous.unit) {
      onchange({ ...($state.snapshot(pattern) as Pattern), productionSpec: next,
        techPack: convertTechPackMeasurementUnits(pattern.techPack, id, previous.unit, patch.unit), hasChanged: true }, label ?? `Edit measurement ${index + 1} ${field}`);
    } else save(next, label ?? `Edit measurement ${index + 1} ${field}`);
  }
  function addMeasurement() {
    const unit = pattern.lengthUnit;
    save({ ...spec, measurements: [...spec.measurements, { id: crypto.randomUUID(), name: 'New measurement',
      annotationId: null, unit, manualValue: null, target: null, tolMinus: 0, tolPlus: 0, notes: '' }] }, 'Add production measurement');
  }
  function linkSource(row: ProductionMeasurement, annotationId: string) {
    const annotation = pattern.measurements?.find(m => m.id === annotationId);
    if (!annotation) { updateMeasurement(row.id, { annotationId: null }); return; }
    const unit: ProductionMeasurementUnit = annotation.kind === 'angle' ? 'deg' : row.unit === 'deg' ? pattern.lengthUnit : row.unit;
    const converted = changeSpecUnit(row, unit);
    updateMeasurement(row.id, { ...converted, annotationId, manualValue: null,
      target: converted.target ?? convertSpecValue(annotation.targetMm, annotation.kind === 'angle' ? 'deg' : 'mm', unit) }, 'Link production measurement');
  }
  function readNumber(value: string): number | null {
    if (!value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  function updateProcurement(id: string, patch: Partial<ProcurementRow>) {
    const index = spec.procurement.findIndex(row => row.id === id);
    save({ ...spec, procurement: spec.procurement.map(row => row.id === id ? { ...row, ...patch } : row) }, `Edit BOM item ${index + 1} ${Object.keys(patch)[0]}`);
  }
  function addProcurement() {
    save({ ...spec, procurement: [...spec.procurement, { id: crypto.randomUUID(), name: 'New item', category: 'trim', quantity: null, unit: 'each', notes: '' }] }, 'Add BOM row');
  }
  const displayValue = (value: number | null) => value === null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
</script>

<section class="specs-workspace h-full min-h-0 flex flex-col bg-base-100" data-testid="specs-workspace" data-keyboard-scope="specs" aria-label="Production specifications">
  <header class="border-b border-base-300 p-4 shrink-0">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div><h2 class="font-semibold">Specs</h2><p class="text-xs opacity-60 mt-1">{pattern.name} · Measurements and bill of materials</p></div>
      <span class="badge badge-outline text-xs">{spec.measurements.length} POMs · {spec.procurement.length} BOM items</span>
    </div>
    <div class="flex flex-wrap gap-2 mt-3" role="tablist" aria-label="Specification sections">
      <button class="btn btn-sm" class:btn-primary={tab === 'measurements'} role="tab" aria-selected={tab === 'measurements'} aria-controls="spec-measurements" id="spec-measurements-tab" onclick={() => tab = 'measurements'}>Measurements</button>
      <button class="btn btn-sm" class:btn-primary={tab === 'bom'} role="tab" aria-selected={tab === 'bom'} aria-controls="spec-bom" id="spec-bom-tab" onclick={() => tab = 'bom'}>Bill of materials</button>
      <button class="btn btn-sm" class:btn-primary={tab === 'techpack'} role="tab" aria-selected={tab === 'techpack'} aria-controls="spec-techpack" id="spec-techpack-tab" onclick={() => tab = 'techpack'}>Tech Pack</button>
    </div>
  </header>
  <div class="overflow-auto flex-1 min-h-0 p-4">
    {#if tab === 'measurements'}
      <div id="spec-measurements" role="tabpanel" aria-labelledby="spec-measurements-tab">
        <div class="flex items-center justify-between gap-3 mb-3"><h3 class="text-sm font-semibold">Garment points of measure</h3><button class="btn btn-sm btn-primary" onclick={addMeasurement}>Add measurement row</button></div>
        <p class="text-xs opacity-60 leading-relaxed mb-4">Enter a measured sample actual, or link a saved 2D Measure annotation for a live endpoint distance or angle. Pattern layout distances do not establish sewn garment fit. Targets and tolerances use each row’s unit.</p>
        {#if !spec.measurements.length}
          <div class="border border-dashed border-base-300 rounded-lg p-8 text-center text-sm opacity-70">Add your first point of measure. Saved canvas annotations can be linked from each row’s Source menu.</div>
        {:else}
          <div class="overflow-x-auto">
            <table class="table table-xs measurement-table">
              <thead><tr><th>Point of measure</th><th>Source</th><th>Unit</th><th>Actual</th><th>Target</th><th>− tolerance</th><th>+ tolerance</th><th>Check</th><th>Notes</th><th></th></tr></thead>
              <tbody>
                {#each spec.measurements as row (row.id)}
                  {@const evaluated = evaluateSpecMeasurement(pattern, row)}
                  {@const annotationKind = pattern.measurements?.find(annotation => annotation.id === row.annotationId)?.kind ?? 'distance'}
                  <tr data-testid="spec-measurement-row">
                    <td><input class="input input-bordered input-xs w-36" aria-label="Measurement name" value={row.name} onchange={e => updateMeasurement(row.id, { name: e.currentTarget.value })} /></td>
                    <td><select class="select select-bordered select-xs w-40" aria-label="Measurement source" value={row.annotationId ?? ''} onchange={e => linkSource(row, e.currentTarget.value)}>
                      <option value="">Manual sample actual</option>
                      {#if row.annotationId && !pattern.measurements?.some(m => m.id === row.annotationId)}<option value={row.annotationId}>Missing annotation</option>{/if}
                      {#each pattern.measurements ?? [] as annotation (annotation.id)}<option value={annotation.id}>{annotation.name} ({annotation.kind === 'angle' ? 'angle' : 'distance'})</option>{/each}
                    </select></td>
                    <td><select class="select select-bordered select-xs w-20" aria-label="Measurement unit" value={row.unit} onchange={e => updateMeasurement(row.id, changeSpecUnit(row, e.currentTarget.value as ProductionMeasurementUnit), 'Change production measurement unit')}>
                      {#if !row.annotationId || annotationKind !== 'angle' || row.unit !== 'deg'}<option value="mm">mm</option><option value="cm">cm</option><option value="inch">inch</option>{/if}
                      {#if !row.annotationId || annotationKind === 'angle' || row.unit === 'deg'}<option value="deg">deg</option>{/if}
                    </select></td>
                    <td>{#if row.annotationId}<output class="whitespace-nowrap font-mono" data-testid="spec-actual" aria-label="Live actual">{displayValue(evaluated.actual)}</output>{:else}<input class="input input-bordered input-xs w-24" type="number" min="0" step="any" aria-label="Sample actual" value={row.manualValue ?? ''} onchange={e => updateMeasurement(row.id, { manualValue: readNumber(e.currentTarget.value) })} />{/if}</td>
                    <td><input class="input input-bordered input-xs w-24" type="number" min="0" step="any" aria-label="Measurement target" value={row.target ?? ''} onchange={e => updateMeasurement(row.id, { target: readNumber(e.currentTarget.value) })} /></td>
                    <td><input class="input input-bordered input-xs w-20" type="number" min="0" step="any" aria-label="Minus tolerance" value={row.tolMinus} onchange={e => updateMeasurement(row.id, { tolMinus: readNumber(e.currentTarget.value) ?? 0 })} /></td>
                    <td><input class="input input-bordered input-xs w-20" type="number" min="0" step="any" aria-label="Plus tolerance" value={row.tolPlus} onchange={e => updateMeasurement(row.id, { tolPlus: readNumber(e.currentTarget.value) ?? 0 })} /></td>
                    <td><span class="text-xs whitespace-nowrap" class:text-success={evaluated.status === 'within'} class:text-error={evaluated.status === 'outside' || evaluated.status === 'missing-reference' || evaluated.status === 'invalid'} data-testid="spec-measurement-status">{evaluated.label}</span>{#if evaluated.lower !== null}<p class="text-[10px] opacity-60 whitespace-nowrap">{displayValue(evaluated.lower)}–{displayValue(evaluated.upper)} {row.unit}</p>{/if}</td>
                    <td><input class="input input-bordered input-xs w-40" aria-label="Measurement notes" value={row.notes} onchange={e => updateMeasurement(row.id, { notes: e.currentTarget.value })} /></td>
                    <td><button class="btn btn-ghost btn-xs" aria-label={`Delete measurement ${row.name}`} onclick={() => save({ ...spec, measurements: spec.measurements.filter(m => m.id !== row.id) }, 'Delete production measurement')}>✕</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {:else if tab === 'bom'}
      <div id="spec-bom" role="tabpanel" aria-labelledby="spec-bom-tab">
        <h3 class="text-sm font-semibold mb-2">Assigned fabrics</h3>
        <p class="text-xs opacity-60 mb-3">Linked live to piece assignments. Cut copies are piece counts; fabric consumption must be estimated separately.</p>
        {#if !fabrics.length}<p class="text-sm opacity-70">No assigned pieces yet.</p>{:else}
          <div class="overflow-x-auto mb-6"><table class="table table-sm"><thead><tr><th>Fabric</th><th>Used by</th><th>Cut copies</th></tr></thead><tbody>
            {#each fabrics as fabric (fabric.materialId)}<tr data-testid="spec-assigned-fabric"><td><span class="inline-block h-3 w-3 rounded-sm mr-2 border border-base-300" style:background={fabric.color}></span><span class:text-error={fabric.missing}>{fabric.name}</span></td><td>{fabric.pieces.join(', ')}</td><td>{fabric.cutCopies}</td></tr>{/each}
          </tbody></table></div>
        {/if}
        <div class="flex items-center justify-between gap-3 mb-2"><h3 class="text-sm font-semibold">Procurement items</h3><button class="btn btn-sm btn-primary" onclick={addProcurement}>Add BOM row</button></div>
        <p class="text-xs opacity-60 mb-4">Add fabric quantities, trims, threads and packaging needed for one garment. These notes do not modify simulation materials.</p>
        {#if !spec.procurement.length}<div class="border border-dashed border-base-300 rounded-lg p-6 text-center text-sm opacity-70">Add a procurement item and record its quantity and unit.</div>{:else}
          <div class="overflow-x-auto"><table class="table table-xs"><thead><tr><th>Item</th><th>Category</th><th>Quantity</th><th>Unit</th><th>Notes</th><th></th></tr></thead><tbody>
            {#each spec.procurement as row (row.id)}<tr data-testid="spec-procurement-row">
              <td><input class="input input-bordered input-xs w-40" aria-label="BOM item name" value={row.name} onchange={e => updateProcurement(row.id, { name: e.currentTarget.value })} /></td>
              <td><select class="select select-bordered select-xs" aria-label="BOM category" value={row.category} onchange={e => updateProcurement(row.id, { category: e.currentTarget.value as ProcurementCategory })}>{#each categories as category}<option value={category}>{category}</option>{/each}</select></td>
              <td><input class="input input-bordered input-xs w-24" type="number" min="0" step="any" aria-label="BOM quantity" value={row.quantity ?? ''} onchange={e => updateProcurement(row.id, { quantity: readNumber(e.currentTarget.value) })} /></td>
              <td><input class="input input-bordered input-xs w-20" aria-label="BOM unit" value={row.unit} onchange={e => updateProcurement(row.id, { unit: e.currentTarget.value })} /></td>
              <td><input class="input input-bordered input-xs w-48" aria-label="BOM notes" value={row.notes} onchange={e => updateProcurement(row.id, { notes: e.currentTarget.value })} /></td>
              <td><button class="btn btn-ghost btn-xs" aria-label={`Delete BOM item ${row.name}`} onclick={() => save({ ...spec, procurement: spec.procurement.filter(item => item.id !== row.id) }, 'Delete BOM row')}>✕</button></td>
            </tr>{/each}
          </tbody></table></div>
        {/if}
      </div>
    {:else}
      <div id="spec-techpack" role="tabpanel" aria-labelledby="spec-techpack-tab"><TechPackPanel {pattern} {onchange} /></div>
    {/if}
  </div>
</section>

<style>
  .specs-workspace { min-width: 0; }
  .measurement-table th { white-space: nowrap; }
</style>
