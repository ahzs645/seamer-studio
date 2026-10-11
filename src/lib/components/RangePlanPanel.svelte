<script lang="ts">
  import type { Pattern } from '@seamer/pattern-model';
  import { createRangePlan, validateRangePlan, type RangePlan, type RangeStyle } from '../../../packages/pattern-model/src/rangePlan';
  import { rangeStyleFromPattern, rangePlanSummary } from '$lib/utils/rangePlan';
  import { listPatterns } from '$lib/stores/localDB';

  let { currentPattern, onchange, onopenpattern }: { currentPattern: Pattern; onchange: (pattern: Pattern, label?: string) => void; onopenpattern?: (id: string) => void } = $props();
  // Root adds this optional canonical field to Pattern; using the intersection also supports old documents.
  const plan = $derived((currentPattern as Pattern & { rangePlan?: RangePlan }).rangePlan);
  const summary = $derived(plan ? rangePlanSummary(plan) : null);
  let savedPatterns = $state<Pattern[]>([]);
  let selectedPatternId = $state('');
  let status = $state('');
  let loading = $state(false);
  function update(next: RangePlan, label = 'Edit collection range plan') {
    validateRangePlan(next);
    onchange({ ...currentPattern, rangePlan: next, hasChanged: true } as Pattern, label);
  }
  function patch(updates: Partial<RangePlan>) { if (plan) update({ ...plan, ...updates }); }
  function edit(id: string, updates: Partial<RangeStyle>) { if (plan) update({ ...plan, styles: plan.styles.map(style => style.id === id ? { ...style, ...updates } : style) }); }
  function add(source?: Pattern) {
    if (!plan) return;
    const style = source ? rangeStyleFromPattern(source, crypto.randomUUID()) : { id: crypto.randomUUID(), patternId: null, name: 'New style', category: '', status: 'idea' as const, colorwayNames: [], sizes: [], plannedUnits: null, targetUnitCost: null, notes: '' };
    if (source && plan.styles.some(style => style.patternId === source.id)) { status = 'This saved pattern is already in the collection.'; return; }
    update({ ...plan, styles: [...plan.styles, style] }, 'Add collection style'); status = '';
  }
  async function refreshSaved() {
    loading = true;
    try { savedPatterns = await listPatterns(); status = `${savedPatterns.length} locally saved patterns available.`; }
    catch (error) { status = error instanceof Error ? error.message : 'Saved patterns could not be read.'; }
    finally { loading = false; }
  }
  function number(event: Event, integer = false): number | null | undefined {
    const input = event.currentTarget as HTMLInputElement;
    if (!input.value.trim()) return null;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0 || integer && !Number.isInteger(value)) { status = 'Enter a nonnegative number (whole units for quantity).'; return undefined; }
    return value;
  }
  function download() {
    if (!plan) return;
    const blob = new Blob([JSON.stringify($state.snapshot(plan), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${plan.name.replace(/[^a-z0-9_-]/gi, '_') || 'collection'}.range.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  async function importPlan(event: Event) {
    const patternId = currentPattern.id;
    const input = event.currentTarget as HTMLInputElement, file = input.files?.[0]; input.value = '';
    if (!file) return;
    try { if (file.size > 2 * 1024 * 1024) throw new Error('Collection file exceeds 2 MB.'); const data: unknown = JSON.parse(await file.text()); validateRangePlan(data); if (currentPattern.id !== patternId) throw new Error('The active document changed. Import the collection again in the intended document.'); update(data, 'Import collection range plan'); status = 'Collection imported. Saved pattern references require matching local IDs.'; }
    catch (error) { status = error instanceof Error ? error.message : 'Invalid collection file.'; }
  }
</script>

<section class="range-panel text-xs space-y-2" aria-label="Collection range plan" data-document-keyboard>
  <h3 class="font-bold">Collection &amp; range plan</h3>
  {#if !plan}
    <p>Plan styles, size ranges, colorways and production quantities together. The collection is saved with this document.</p>
    <button class="btn btn-xs w-full" onclick={() => update(createRangePlan(), 'Create collection range plan')}>Create collection</button>
  {:else}
    <label class="block">Collection name<input class="input input-bordered input-xs w-full" value={plan.name} onchange={(e) => patch({ name: e.currentTarget.value })} /></label>
    <label class="block">Season<input class="input input-bordered input-xs w-full" value={plan.season} onchange={(e) => patch({ season: e.currentTarget.value })} /></label>
    <label class="block">Collection currency<input class="input input-bordered input-xs w-full" maxlength="3" value={plan.currency} onchange={(e) => { const currency = e.currentTarget.value.toUpperCase(); if (/^[A-Z]{3}$/.test(currency)) patch({ currency }); else { e.currentTarget.value = plan.currency; status = 'Use a three-letter currency code.'; } }} /></label>
    <p>{summary?.knownUnits ?? 'Overflow'} known units · {summary?.knownBudget?.toFixed(2) ?? 'Overflow'} {plan.currency} known planned budget · {summary?.incompleteStyles} styles without complete costing</p>
    <button class="btn btn-xs w-full" onclick={() => add(currentPattern)}>Add current pattern to collection</button>
    <button class="btn btn-xs w-full" disabled={loading} onclick={refreshSaved}>{loading ? 'Reading saved patterns…' : 'Browse locally saved patterns'}</button>
    {#if savedPatterns.length}
      <label class="block">Saved pattern<select class="select select-bordered select-xs w-full" bind:value={selectedPatternId}><option value="">Choose saved pattern</option>{#each savedPatterns as pattern}<option value={pattern.id}>{pattern.name}</option>{/each}</select></label>
      <button class="btn btn-xs w-full" disabled={!selectedPatternId} onclick={() => { const source = savedPatterns.find(pattern => pattern.id === selectedPatternId); if (source) add(source); }}>Add saved pattern</button>
    {/if}
    <button class="btn btn-xs w-full" onclick={() => add()}>Add planned style</button>
    {#each plan.styles as style, index (style.id)}
      <fieldset class="rounded border border-base-300 p-2 space-y-1">
        <legend>{index + 1}. {style.name}</legend>
        <label class="block">Style name<input class="input input-bordered input-xs w-full" value={style.name} onchange={(e) => edit(style.id, { name: e.currentTarget.value })} /></label>
        <label class="block">Style category<input class="input input-bordered input-xs w-full" value={style.category} onchange={(e) => edit(style.id, { category: e.currentTarget.value })} /></label>
        <label class="block">Style status<select class="select select-bordered select-xs w-full" value={style.status} onchange={(e) => edit(style.id, { status: e.currentTarget.value as RangeStyle['status'] })}>{#each ['idea', 'draft', 'sampling', 'approved', 'production'] as state}<option>{state}</option>{/each}</select></label>
        <label class="block">Planned colorways<input class="input input-bordered input-xs w-full" value={style.colorwayNames.join(', ')} onchange={(e) => edit(style.id, { colorwayNames: e.currentTarget.value.split(',').map(value => value.trim()).filter(Boolean) })} /></label>
        <label class="block">Planned sizes<input class="input input-bordered input-xs w-full" value={style.sizes.join(', ')} onchange={(e) => edit(style.id, { sizes: e.currentTarget.value.split(',').map(value => value.trim()).filter(Boolean) })} /></label>
        <label class="block">Planned units<input class="input input-bordered input-xs w-full" type="number" min="0" step="1" value={style.plannedUnits ?? ''} onchange={(e) => { const value = number(e, true); if (value !== undefined) edit(style.id, { plannedUnits: value }); }} /></label>
        <label class="block">Target unit cost ({plan.currency})<input class="input input-bordered input-xs w-full" type="number" min="0" step="0.01" value={style.targetUnitCost ?? ''} onchange={(e) => { const value = number(e); if (value !== undefined) edit(style.id, { targetUnitCost: value }); }} /></label>
        <label class="block">Style notes<textarea class="textarea textarea-bordered textarea-xs w-full" value={style.notes} onchange={(e) => edit(style.id, { notes: e.currentTarget.value })}></textarea></label>
        {#if style.patternId}<p>Linked pattern: {style.patternId}</p>{#if onopenpattern}<button class="btn btn-xs" onclick={() => onopenpattern?.(style.patternId!)}>Open linked pattern</button>{/if}{/if}
        <div class="flex gap-1"><button class="btn btn-xs" disabled={index === 0} onclick={() => { const styles = [...plan.styles]; [styles[index - 1], styles[index]] = [styles[index], styles[index - 1]]; patch({ styles }); }}>Move style up</button><button class="btn btn-xs" onclick={() => patch({ styles: plan.styles.filter(item => item.id !== style.id) })}>Remove style</button></div>
      </fieldset>
    {/each}
    <label class="block">Collection notes<textarea class="textarea textarea-bordered textarea-xs w-full" value={plan.notes} onchange={(e) => patch({ notes: e.currentTarget.value })}></textarea></label>
    <button class="btn btn-xs w-full" onclick={download}>Export collection JSON</button>
  {/if}
  <label class="block">Import collection JSON<input type="file" accept="application/json,.json" class="file-input file-input-bordered file-input-xs w-full" onchange={importPlan} /></label>
  {#if status}<p role="status">{status}</p>{/if}
</section>

<style>
  @media (max-width: 1023px) { .range-panel :global(input), .range-panel :global(select), .range-panel :global(button), .range-panel :global(textarea) { min-height: 44px; font-size: 16px; } }
</style>
