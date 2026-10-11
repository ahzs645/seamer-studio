<script lang="ts">
  import { createTechPack, type Pattern, type TechPackDocument, type TechPackMetadata, type TechPackSizeMeasurement, type TechPackConstruction, type TechPackCosting } from '@seamer/pattern-model';
  import { downloadText } from '@atelier/io/browser';
  import { resolveSizeMeasurement, resolveTechPackCosting, techPackCostSummary } from '$lib/utils/techPack';
  import { prepareTechPackHtml, patternToTechPackCsv, printTechPack } from '$lib/utils/techPackExport';
  import { toast, toastError } from '$lib/stores/toast';

  interface Props { pattern: Pattern; onchange: (pattern: Pattern, label?: string) => void; }
  let { pattern, onchange }: Props = $props();
  let section = $state<'overview' | 'sizes' | 'construction' | 'costing' | 'preview'>('overview');
  const doc = $derived(pattern.techPack ?? createTechPack());
  const measurements = $derived(pattern.productionSpec?.measurements ?? []);
  const costSummary = $derived(techPackCostSummary(pattern));
  const orphanPoms = $derived(Object.keys(doc.sizeMeasurements).filter(id => !measurements.some(row => row.id === id)));
  let previewHtml = $state('');
  let previewLoading = $state(false);
  let preparingExport = $state(false);
  $effect(() => {
    if (section !== 'preview') { previewHtml = ''; previewLoading = false; return; }
    const snapshot = $state.snapshot(pattern) as Pattern;
    let cancelled = false;
    previewLoading = true;
    void prepareTechPackHtml(snapshot).then(html => { if (!cancelled) previewHtml = html; })
      .catch(() => { if (!cancelled) previewHtml = '<p>Could not prepare the document preview.</p>'; })
      .finally(() => { if (!cancelled) previewLoading = false; });
    return () => { cancelled = true; };
  });
  const sections = [{ id: 'overview', label: 'Document' }, { id: 'sizes', label: 'Size chart' }, { id: 'construction', label: 'Construction' }, { id: 'costing', label: 'Supplier costing' }, { id: 'preview', label: 'Preview' }] as const;
  const displayNumber = (value: number | null) => value === null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);

  function save(next: TechPackDocument, label: string) {
    onchange({ ...($state.snapshot(pattern) as Pattern), techPack: $state.snapshot(next), hasChanged: true }, label);
  }
  function updateMetadata<K extends keyof TechPackMetadata>(key: K, value: TechPackMetadata[K]) {
    save({ ...doc, metadata: { ...doc.metadata, [key]: value } }, `Edit tech pack ${key}`);
  }
  function numberInput(value: string): number | null {
    if (!value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  function addSize() { save({ ...doc, sizes: [...doc.sizes, { id: crypto.randomUUID(), name: `Size ${doc.sizes.length + 1}` }] }, 'Add production size'); }
  function removeSize(id: string) {
    const sizeMeasurements = Object.fromEntries(Object.entries(doc.sizeMeasurements).map(([pomId, values]) => [pomId, Object.fromEntries(Object.entries(values).filter(([sizeId]) => sizeId !== id))]));
    save({ ...doc, sizes: doc.sizes.filter(size => size.id !== id), sampleSizeId: doc.sampleSizeId === id ? null : doc.sampleSizeId, sizeMeasurements }, 'Delete production size');
  }
  function importSizeLabels() {
    const names = new Set(doc.sizes.map(size => size.name));
    const added = (pattern.gradingProfile?.sizes ?? []).filter(size => !names.has(size.name)).map(size => ({ id: crypto.randomUUID(), name: size.name }));
    if (added.length) save({ ...doc, sizes: [...doc.sizes, ...added] }, 'Import grading size labels');
  }
  function updateSizeValue(pomId: string, sizeId: string, patch: Partial<TechPackSizeMeasurement>) {
    const prior = doc.sizeMeasurements[pomId]?.[sizeId] ?? { target: null, actual: null, notes: '' };
    const pomIndex = measurements.findIndex(row => row.id === pomId) + 1;
    const sizeIndex = doc.sizes.findIndex(size => size.id === sizeId) + 1;
    save({ ...doc, sizeMeasurements: { ...doc.sizeMeasurements, [pomId]: { ...doc.sizeMeasurements[pomId], [sizeId]: { ...prior, ...patch } } } }, `Edit size ${sizeIndex} POM ${pomIndex} ${Object.keys(patch)[0]}`);
  }
  function addInstruction() { save({ ...doc, construction: [...doc.construction, { id: crypto.randomUUID(), title: 'New instruction', pieceId: null, instruction: '' }] }, 'Add construction instruction'); }
  function updateInstruction(id: string, patch: Partial<TechPackConstruction>) {
    const index = doc.construction.findIndex(row => row.id === id) + 1;
    save({ ...doc, construction: doc.construction.map(row => row.id === id ? { ...row, ...patch } : row) }, `Edit construction ${index} ${Object.keys(patch)[0]}`);
  }
  function moveInstruction(index: number, direction: -1 | 1) {
    const rows = [...doc.construction]; const nextIndex = index + direction;
    if (!rows[nextIndex]) return;
    [rows[index], rows[nextIndex]] = [rows[nextIndex], rows[index]];
    save({ ...doc, construction: rows }, 'Reorder construction instructions');
  }
  function addCost() { save({ ...doc, costing: [...doc.costing, { id: crypto.randomUUID(), name: 'New cost item', procurementId: null, materialId: null, supplier: doc.metadata.supplier, sku: '', quantity: null, unit: 'each', unitCost: null, notes: '' }] }, 'Add supplier cost'); }
  function updateCost(id: string, patch: Partial<TechPackCosting>) {
    const index = doc.costing.findIndex(row => row.id === id) + 1;
    save({ ...doc, costing: doc.costing.map(row => row.id === id ? { ...row, ...patch } : row) }, `Edit cost item ${index} ${Object.keys(patch)[0]}`);
  }
  function linkCost(row: TechPackCosting, source: string) {
    if (source.startsWith('procurement:')) {
      const id = source.slice(12); const procurement = pattern.productionSpec?.procurement.find(item => item.id === id);
      updateCost(row.id, { procurementId: id, materialId: null, name: procurement?.name ?? row.name, quantity: procurement?.quantity ?? null, unit: procurement?.unit ?? row.unit });
    } else if (source.startsWith('material:')) {
      const id = source.slice(9); const material = pattern.materials.find(item => item.id === id);
      updateCost(row.id, { procurementId: null, materialId: id, name: material?.name ?? row.name, quantity: null, unit: 'm' });
    } else {
      const resolved = resolveTechPackCosting(pattern, row);
      updateCost(row.id, { procurementId: null, materialId: null, name: resolved.name, quantity: resolved.quantity, unit: resolved.unit });
    }
  }
  const exportName = () => (doc.metadata.styleCode || pattern.name || 'garment').replace(/[^a-z0-9._-]+/gi, '_').replace(/^\.+/, '') || 'garment';
  async function exportHtml() {
    if (preparingExport) return;
    const snapshot = $state.snapshot(pattern) as Pattern;
    const filename = `${exportName()}_tech-pack.html`;
    preparingExport = true;
    try {
      downloadText(filename, await prepareTechPackHtml(snapshot), 'text/html');
      toast('Tech Pack HTML downloaded. Open it offline or print it to PDF.');
    } catch { toastError('Could not prepare the Tech Pack document. Try again.'); }
    finally { preparingExport = false; }
  }
  function exportCsv(kind: 'measurements' | 'bom') { downloadText(`${exportName()}_${kind}.csv`, patternToTechPackCsv(pattern, kind), 'text/csv'); }
  async function print() {
    try { if (!await printTechPack($state.snapshot(pattern) as Pattern)) toastError('Your browser blocked the print window. Allow pop-ups or download the HTML and print it.'); }
    catch { toastError('Could not open the print dialog. Download the HTML and print it from your browser.'); }
  }
</script>

<div class="tech-pack-panel" data-testid="tech-pack-panel">
  <div class="flex flex-wrap justify-between items-start gap-3 mb-4">
    <div><h3 class="font-semibold">Tech Pack</h3><p class="text-xs opacity-60 mt-1">Production document, size values, instructions and supplier costs</p></div>
    <div class="flex flex-wrap gap-2"><button class="btn btn-sm btn-primary" disabled={preparingExport} onclick={exportHtml}>Download Tech Pack HTML</button><button class="btn btn-sm" onclick={print}>Print / Save as PDF</button></div>
  </div>
  <div class="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Tech Pack sections">
    {#each sections as item}<button class="btn btn-xs" class:btn-primary={section === item.id} role="tab" id={`tech-pack-${item.id}-tab`} aria-selected={section === item.id} aria-controls={`tech-pack-${item.id}`} onclick={() => section = item.id}>{item.label}</button>{/each}
  </div>
  <div role="tabpanel" id={`tech-pack-${section}`} aria-labelledby={`tech-pack-${section}-tab`}>
    {#if section === 'overview'}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <label class="field">Style code<input class="input input-bordered input-sm" aria-label="Style code" value={doc.metadata.styleCode} onchange={e => updateMetadata('styleCode', e.currentTarget.value)} /></label>
        <label class="field">Brand<input class="input input-bordered input-sm" aria-label="Brand" value={doc.metadata.brand} onchange={e => updateMetadata('brand', e.currentTarget.value)} /></label>
        <label class="field">Season<input class="input input-bordered input-sm" aria-label="Season" value={doc.metadata.season} onchange={e => updateMetadata('season', e.currentTarget.value)} /></label>
        <label class="field">Document revision<input class="input input-bordered input-sm" aria-label="Document revision" placeholder={pattern.versionName || String(pattern.versionNumber)} value={doc.metadata.revision} onchange={e => updateMetadata('revision', e.currentTarget.value)} /></label>
        <label class="field">Document status<select class="select select-bordered select-sm" aria-label="Document status" value={doc.metadata.status} onchange={e => updateMetadata('status', e.currentTarget.value as TechPackMetadata['status'])}><option value="draft">Draft</option><option value="sampling">Sampling</option><option value="released">Released</option></select></label>
        <label class="field">Primary supplier<input class="input input-bordered input-sm" aria-label="Primary supplier" value={doc.metadata.supplier} onchange={e => updateMetadata('supplier', e.currentTarget.value)} /></label>
        <label class="field">Cost currency<input class="input input-bordered input-sm" aria-label="Cost currency" placeholder="USD" value={doc.metadata.currency} onchange={e => updateMetadata('currency', e.currentTarget.value.trim().toUpperCase())} /></label>
      </div>
      <label class="field mt-4">Document notes<textarea class="textarea textarea-bordered min-h-24" aria-label="Document notes" value={doc.metadata.notes} onchange={e => updateMetadata('notes', e.currentTarget.value)}></textarea></label>
      <p class="text-xs opacity-60 mt-3">Status is a document label set by you. Record and verify sample measurements, consumption and instructions with your production partner.</p>
      <div class="text-xs opacity-60 mt-4 border-t border-base-300 pt-3">Project {pattern.id} · version {pattern.versionNumber} · {doc.sizes.length} sizes · {doc.construction.length} instructions · {doc.costing.length} cost items</div>
    {:else if section === 'sizes'}
      <div class="flex flex-wrap justify-between gap-2 mb-3"><div><h4 class="font-semibold text-sm">Production size chart</h4><p class="text-xs opacity-60 mt-1">Enter targets and sample actuals for each size. Values use the POM’s unit and asymmetric tolerances.</p></div><div class="flex gap-2"><button class="btn btn-sm" disabled={!pattern.gradingProfile?.sizes.length} onclick={importSizeLabels}>Use grading size labels</button><button class="btn btn-primary btn-sm" onclick={addSize}>Add production size</button></div></div>
      <p class="text-xs opacity-60 mb-3">Size labels can come from grading; production values are entered separately and do not redraft geometry.</p>
      {#if doc.sizes.length}
        <div class="flex flex-wrap gap-2 mb-3">{#each doc.sizes as size, index (size.id)}<div class="flex gap-1 items-center border border-base-300 rounded-lg p-2"><input class="input input-bordered input-xs w-28" aria-label={`Size name ${index + 1}`} value={size.name} onchange={e => save({ ...doc, sizes: doc.sizes.map(item => item.id === size.id ? { ...item, name: e.currentTarget.value } : item) }, `Rename production size ${index + 1}`)} /><button class="btn btn-ghost btn-xs" aria-label={`Delete size ${size.name}`} onclick={() => removeSize(size.id)}>✕</button></div>{/each}</div>
        <label class="field max-w-xs mb-4">Sample size<select class="select select-bordered select-sm" aria-label="Sample size" value={doc.sampleSizeId ?? ''} onchange={e => save({ ...doc, sampleSizeId: e.currentTarget.value || null }, 'Set production sample size')}><option value="">Unspecified</option>{#each doc.sizes as size (size.id)}<option value={size.id}>{size.name}</option>{/each}</select></label>
        {#if measurements.length}<div class="overflow-x-auto"><table class="table table-xs"><thead><tr><th>POM / unit / tolerance</th>{#each doc.sizes as size (size.id)}<th>{size.name}{size.id === doc.sampleSizeId ? ' · sample' : ''}</th>{/each}</tr></thead><tbody>
          {#each measurements as row (row.id)}<tr><td class="align-top min-w-36"><strong>{row.name}</strong><p class="text-xs opacity-60">{row.unit} · −{row.tolMinus} / +{row.tolPlus}</p></td>{#each doc.sizes as size (size.id)}{@const resolved = resolveSizeMeasurement(pattern, row.id, size.id)}<td class="align-top min-w-44" data-testid="tech-pack-size-cell"><div class="flex gap-2"><label class="field">Target<input class="input input-bordered input-xs w-20" type="number" min="0" step="any" aria-label={`${row.name} ${size.name} target`} value={resolved.values.target ?? ''} onchange={e => updateSizeValue(row.id, size.id, { target: numberInput(e.currentTarget.value) })} /></label><label class="field">Actual<input class="input input-bordered input-xs w-20" type="number" min="0" step="any" aria-label={`${row.name} ${size.name} actual`} value={resolved.values.actual ?? ''} onchange={e => updateSizeValue(row.id, size.id, { actual: numberInput(e.currentTarget.value) })} /></label></div><p class="text-[10px] my-2" class:text-success={resolved.status === 'Within tolerance'} class:text-error={resolved.status === 'Outside tolerance'} data-testid="tech-pack-size-status">{resolved.status}</p><input class="input input-bordered input-xs w-full" aria-label={`${row.name} ${size.name} notes`} placeholder="Measurement notes" value={resolved.values.notes} onchange={e => updateSizeValue(row.id, size.id, { notes: e.currentTarget.value })} /></td>{/each}</tr>{/each}
        </tbody></table></div>{:else}<p class="text-sm opacity-70">Add garment POMs in the Measurements tab before entering size values.</p>{/if}
      {:else}<div class="empty">Add production sizes to record a measurement chart.</div>{/if}
      {#each orphanPoms as id}<div class="mt-3 text-xs text-error">Stored size values reference a missing POM ({id}). <button class="btn btn-xs" onclick={() => save({ ...doc, sizeMeasurements: Object.fromEntries(Object.entries(doc.sizeMeasurements).filter(([key]) => key !== id)) }, 'Remove obsolete size values')}>Remove obsolete size values</button></div>{/each}
    {:else if section === 'construction'}
      <div class="flex justify-between items-center mb-3 gap-2"><div><h4 class="font-semibold text-sm">Construction instructions</h4><p class="text-xs opacity-60 mt-1">Ordered instructions linked to the garment or a pattern piece.</p></div><button class="btn btn-primary btn-sm" onclick={addInstruction}>Add construction instruction</button></div>
      {#if !doc.construction.length}<div class="empty">Record seam finishes, assembly steps and other production details.</div>{/if}
      {#each doc.construction as row, index (row.id)}<article class="border border-base-300 rounded-lg p-3 mb-3" data-testid="tech-pack-construction-row"><div class="flex flex-wrap gap-2 items-center mb-2"><span class="badge badge-outline">{index + 1}</span><input class="input input-bordered input-sm flex-1 min-w-32" aria-label="Instruction title" value={row.title} onchange={e => updateInstruction(row.id, { title: e.currentTarget.value })} /><select class="select select-bordered select-sm max-w-56" aria-label="Instruction piece" value={row.pieceId ?? ''} onchange={e => updateInstruction(row.id, { pieceId: e.currentTarget.value || null })}><option value="">Whole garment</option>{#if row.pieceId && !pattern.pieces.some(piece => piece.id === row.pieceId)}<option value={row.pieceId}>Missing piece</option>{/if}{#each pattern.pieces as piece (piece.id)}<option value={piece.id}>{piece.name}</option>{/each}</select><button class="btn btn-ghost btn-xs" aria-label={`Move instruction ${index + 1} up`} disabled={index === 0} onclick={() => moveInstruction(index, -1)}>↑</button><button class="btn btn-ghost btn-xs" aria-label={`Move instruction ${index + 1} down`} disabled={index === doc.construction.length - 1} onclick={() => moveInstruction(index, 1)}>↓</button><button class="btn btn-ghost btn-xs" aria-label={`Delete instruction ${row.title}`} onclick={() => save({ ...doc, construction: doc.construction.filter(item => item.id !== row.id) }, 'Delete construction instruction')}>✕</button></div><textarea class="textarea textarea-bordered w-full min-h-20" aria-label="Construction instruction" placeholder="Describe stitch type, seam finish, assembly and inspection details…" value={row.instruction} onchange={e => updateInstruction(row.id, { instruction: e.currentTarget.value })}></textarea>{#if row.pieceId && !pattern.pieces.some(piece => piece.id === row.pieceId)}<p class="text-xs text-error mt-2">This instruction references a missing piece.</p>{/if}</article>{/each}
    {:else if section === 'costing'}
      <div class="flex justify-between gap-2 items-center mb-3"><div><h4 class="font-semibold text-sm">Supplier costing · {doc.metadata.currency || 'currency unspecified'}</h4><p class="text-xs opacity-60 mt-1">Link a BOM item or fabric, or enter a separate cost. Procurement quantities stay linked to the BOM.</p></div><button class="btn btn-primary btn-sm" onclick={addCost}>Add supplier cost</button></div>
      <p class="text-xs opacity-60 mb-3">Fabric quantities are entered consumption per garment, separate from pattern cut-copy counts. All unit costs use the document currency; no currency conversion is applied.</p>
      {#if !doc.costing.length}<div class="empty">Add materials, labor or other costs with explicit quantities and unit prices.</div>{:else}<div class="overflow-x-auto"><table class="table table-xs"><thead><tr><th>Item / source</th><th>Supplier / SKU</th><th>Quantity / unit</th><th>Unit cost</th><th>Total</th><th>Notes</th><th></th></tr></thead><tbody>
        {#each doc.costing as row (row.id)}{@const resolved = resolveTechPackCosting(pattern, row)}<tr data-testid="tech-pack-cost-row"><td><input class="input input-bordered input-xs w-40 mb-2" aria-label="Cost item name" disabled={!!row.procurementId || !!row.materialId} value={resolved.name} onchange={e => updateCost(row.id, { name: e.currentTarget.value })} /><select class="select select-bordered select-xs w-40" aria-label="Cost item source" value={row.procurementId ? `procurement:${row.procurementId}` : row.materialId ? `material:${row.materialId}` : ''} onchange={e => linkCost(row, e.currentTarget.value)}><option value="">Standalone item</option>{#if resolved.missing}<option value={row.procurementId ? `procurement:${row.procurementId}` : `material:${row.materialId}`}>Missing reference</option>{/if}{#each pattern.productionSpec?.procurement ?? [] as item (item.id)}<option value={`procurement:${item.id}`}>BOM · {item.name}</option>{/each}{#each pattern.materials as material (material.id)}<option value={`material:${material.id}`}>Fabric · {material.name}</option>{/each}</select>{#if resolved.missing}<p class="text-error text-xs mt-1">Missing BOM or fabric reference</p>{/if}</td><td><input class="input input-bordered input-xs w-36 mb-2" aria-label="Cost supplier" value={row.supplier} onchange={e => updateCost(row.id, { supplier: e.currentTarget.value })} /><input class="input input-bordered input-xs w-36" aria-label="Cost SKU" value={row.sku} onchange={e => updateCost(row.id, { sku: e.currentTarget.value })} /></td><td><input class="input input-bordered input-xs w-24 mb-2" type="number" min="0" step="any" aria-label="Cost quantity" disabled={!!row.procurementId} value={resolved.quantity ?? ''} onchange={e => updateCost(row.id, { quantity: numberInput(e.currentTarget.value) })} /><input class="input input-bordered input-xs w-24" aria-label="Cost unit" disabled={!!row.procurementId} value={resolved.unit} onchange={e => updateCost(row.id, { unit: e.currentTarget.value })} /></td><td><input class="input input-bordered input-xs w-24" type="number" min="0" step="any" aria-label="Unit cost" value={row.unitCost ?? ''} onchange={e => updateCost(row.id, { unitCost: numberInput(e.currentTarget.value) })} /></td><td class="whitespace-nowrap" data-testid="tech-pack-line-total">{displayNumber(resolved.total)} {doc.metadata.currency}</td><td><input class="input input-bordered input-xs w-40" aria-label="Cost notes" value={row.notes} onchange={e => updateCost(row.id, { notes: e.currentTarget.value })} /></td><td><button class="btn btn-ghost btn-xs" aria-label={`Delete cost item ${resolved.name}`} onclick={() => save({ ...doc, costing: doc.costing.filter(item => item.id !== row.id) }, 'Delete supplier cost')}>✕</button></td></tr>{/each}
      </tbody></table></div>{/if}
      <p class="font-semibold text-sm mt-4" data-testid="tech-pack-cost-subtotal">{costSummary.complete ? 'Recorded item total' : 'Known cost subtotal'}: {displayNumber(costSummary.subtotal)} {doc.metadata.currency} · {costSummary.pricedCount}/{costSummary.totalCount} rows priced</p><p class="text-xs opacity-60 mt-1">Unrecorded labor, freight, tax and wastage are excluded.</p>
    {:else}
      <div class="flex flex-wrap gap-2 mb-3"><button class="btn btn-sm" onclick={() => exportCsv('measurements')}>Download measurements CSV</button><button class="btn btn-sm" onclick={() => exportCsv('bom')}>Download BOM CSV</button></div>
      <p class="text-xs opacity-60 mb-3">This is the standalone document that will be downloaded. Use your browser’s Print dialog to save a PDF.</p>
      {#if previewLoading}<p class="text-sm opacity-70" role="status">Preparing document and checking artwork images…</p>{:else}<iframe title="Tech Pack export preview" class="w-full border border-base-300 rounded-lg bg-white" style="height:70vh;min-height:420px" sandbox="" srcdoc={previewHtml}></iframe>{/if}
    {/if}
  </div>
</div>

<style>
  .field { display: flex; flex-direction: column; gap: .375rem; font-size: .75rem; }
  .field input, .field select, .field textarea { min-width: 0; }
  .empty { border: 1px dashed hsl(var(--bc) / .2); padding: 1.75rem; border-radius: .5rem; text-align: center; font-size: .875rem; opacity: .7; }
  th { white-space: nowrap; }
</style>
