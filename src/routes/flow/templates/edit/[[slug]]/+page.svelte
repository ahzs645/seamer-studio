<script lang="ts">
  // Template editor (/flow/templates/edit/[[slug]]) — open a built-in or custom template (or upload
  // a .seamer.json), edit its metadata + parametric variables with a live re-drafted preview, then
  // save it to "My templates" (localStorage), download it, or open it in the studio.
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { EMPTY_PATTERN, type Pattern } from '@seamer/pattern-model';
  import { pieceWorldOutline, type Vec2 } from '$lib/utils/patternGeometry';
  import { isSimpleFormat, convertSimplePattern } from '$lib/utils/importSimplePattern';
  import { redraft, hasConstraints, resolveVariables } from '@seamer/pattern-model/solver/solve';
  import { builtinBySlug, BUILTIN_TEMPLATES } from '$lib/data/templates';
  import { customTemplateBySlug, saveCustomTemplate, slugify } from '$lib/stores/customTemplates';
  import { savePattern } from '$lib/stores/localDB';
  import { downloadText } from '$lib/utils/exporters';
  import Toaster from '$lib/components/Toaster.svelte';
  import { toastSuccess, toastError } from '$lib/stores/toast';

  let pattern = $state<Pattern | null>(null);
  let name = $state('');
  let description = $state('');
  let sourceLabel = $state('');
  let error = $state<string | null>(null);
  let loading = $state(false);

  const slug = $derived($page.params.slug || '');

  /** Fill any arrays/fields a template may omit (same normalisation the studio applies). */
  function normalize(data: Pattern): Pattern {
    return {
      ...EMPTY_PATTERN,
      ...data,
      points: data.points ?? [], paths: data.paths ?? [], pieces: data.pieces ?? [],
      seams: data.seams ?? [], variables: data.variables ?? [], materials: data.materials ?? [],
      texts: data.texts ?? [], images: data.images ?? [],
      layers: data.layers?.length ? data.layers : [{ id: 'default', name: 'Default', visible: true, locked: false, order: 0, style: null }],
      currentLayerId: data.currentLayerId ?? 'default',
      body: data.body ?? EMPTY_PATTERN.body,
      settings3d: data.settings3d ?? EMPTY_PATTERN.settings3d
    };
  }

  function setPattern(raw: unknown, label: string, nameHint?: string, descHint?: string) {
    const data = isSimpleFormat(raw) ? convertSimplePattern(raw as Parameters<typeof convertSimplePattern>[0]) : (raw as Pattern);
    pattern = normalize(structuredClone(data));
    name = nameHint || pattern.name || 'Template';
    description = descHint ?? pattern.description ?? '';
    sourceLabel = label;
    error = null;
  }

  async function loadFromSlug(s: string) {
    loading = true;
    error = null;
    try {
      const custom = customTemplateBySlug(s);
      if (custom) {
        setPattern(custom.pattern, 'My templates', custom.name, custom.description);
        return;
      }
      const builtin = builtinBySlug(s);
      if (builtin) {
        const res = await fetch(`/templates/${builtin.file}`);
        if (!res.ok) throw new Error(`Could not load template "${builtin.file}"`);
        setPattern(await res.json(), 'Built-in template', builtin.name, builtin.description);
        return;
      }
      error = `No template called "${s}" — pick one below or upload a file.`;
    } catch (e) {
      error = (e as Error)?.message || 'Failed to load the template.';
    } finally {
      loading = false;
    }
  }

  $effect(() => { if (slug) void loadFromSlug(slug); });

  function onUpload(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    file.text().then((text) => {
      try { setPattern(JSON.parse(text), file.name); }
      catch { error = 'Not a valid Seamer pattern JSON file.'; }
    });
  }

  // ---- variables ---------------------------------------------------------------------------------

  /** Update one variable's formula and re-draft the constrained geometry for the live preview. */
  function setVariableFormula(id: string, formula: string) {
    if (!pattern) return;
    const next = structuredClone($state.snapshot(pattern)) as Pattern;
    const v = next.variables.find((x) => x.id === id);
    if (!v) return;
    v.valueFormula = { ...v.valueFormula, formula };
    v.value = null; // recompute from the formula
    try {
      pattern = hasConstraints(next) ? redraft(next) : next;
    } catch {
      pattern = next; // keep the edit; preview just won't re-draft
    }
  }

  function setVariableFlag(id: string, key: 'isEditable' | 'isVisible', value: boolean) {
    if (!pattern) return;
    const next = structuredClone($state.snapshot(pattern)) as Pattern;
    const v = next.variables.find((x) => x.id === id);
    if (!v) return;
    v[key] = value;
    pattern = next;
  }

  const resolved = $derived.by<Record<string, number>>(() => {
    if (!pattern) return {};
    try { return resolveVariables($state.snapshot(pattern) as Pattern); } catch { return {}; }
  });

  // ---- preview -----------------------------------------------------------------------------------

  const preview = $derived.by(() => {
    if (!pattern) return null;
    const p = $state.snapshot(pattern) as Pattern;
    const outlines: { name: string; points: string }[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const piece of p.pieces) {
      try {
        const loop = pieceWorldOutline(p, piece);
        if (loop.length < 3) continue;
        for (const pt of loop) {
          if (pt.x < minX) minX = pt.x; if (pt.y < minY) minY = pt.y;
          if (pt.x > maxX) maxX = pt.x; if (pt.y > maxY) maxY = pt.y;
        }
        outlines.push({ name: piece.name, points: loop.map((pt: Vec2) => `${pt.x.toFixed(1)},${(-pt.y).toFixed(1)}`).join(' ') });
      } catch { /* skip unresolvable pieces */ }
    }
    if (!outlines.length) return null;
    const pad = Math.max(maxX - minX, maxY - minY) * 0.05 + 10;
    return { outlines, viewBox: `${minX - pad} ${-maxY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}` };
  });

  const COLORS = ['#0ea5e9', '#f97316', '#22c55e', '#a855f7', '#ef4444', '#eab308', '#14b8a6', '#ec4899'];

  // ---- actions -----------------------------------------------------------------------------------

  function applyMeta(p: Pattern): Pattern {
    return { ...p, name, description };
  }

  function saveToMyTemplates() {
    if (!pattern) return;
    const p = applyMeta($state.snapshot(pattern) as Pattern);
    const s = saveCustomTemplate({ slug: slugify(name), name, description, pattern: p });
    toastSuccess(`Saved to My templates as "${s.name}"`);
    if (slug !== s.slug) goto(`/flow/templates/edit/${s.slug}`, { replaceState: true });
  }

  function download() {
    if (!pattern) return;
    const p = applyMeta($state.snapshot(pattern) as Pattern);
    downloadText(`${slugify(name)}.seamer.json`, JSON.stringify(p, null, 2), 'application/json');
  }

  async function openInStudio() {
    if (!pattern) return;
    try {
      const p = applyMeta(structuredClone($state.snapshot(pattern)) as Pattern);
      p.id = crypto.randomUUID();
      p.versionId = crypto.randomUUID();
      await savePattern(p);
      await goto(`/studio/${p.id}`);
    } catch {
      toastError('Could not open the template in the studio');
    }
  }
</script>

<svelte:head>
  <title>Template editor — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-6xl mx-auto">
  <div class="flex items-baseline justify-between flex-wrap gap-2 mb-6">
    <h1 class="text-3xl font-bold font-lexend">Template editor</h1>
    <a href="/flow/templates" class="link link-primary text-sm">← All templates</a>
  </div>

  {#if error}
    <div class="alert alert-warning mb-4"><span>{error}</span></div>
  {/if}

  {#if !pattern}
    <p class="text-lg mb-6 max-w-3xl">
      Open a template to tweak its variables and metadata without the full studio — everything runs
      locally. Pick a built-in template, or upload a <code>.seamer.json</code>.
    </p>
    {#if loading}
      <span class="loading loading-spinner loading-md"></span>
    {:else}
      <input type="file" accept=".json,application/json" class="file-input file-input-bordered w-full max-w-md mb-8" onchange={onUpload} />
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {#each BUILTIN_TEMPLATES as t (t.slug)}
          <a href="/flow/templates/edit/{t.slug}" class="btn btn-sm btn-ghost justify-start truncate">{t.name}</a>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="text-sm opacity-60 mb-4">Editing from: {sourceLabel}</div>
    <div class="grid lg:grid-cols-2 gap-8">
      <div class="space-y-4">
        <label class="form-control w-full">
          <span class="label-text font-semibold mb-1">Name</span>
          <input class="input input-bordered" bind:value={name} />
        </label>
        <label class="form-control w-full">
          <span class="label-text font-semibold mb-1">Description</span>
          <textarea class="textarea textarea-bordered" rows="2" bind:value={description}></textarea>
        </label>

        <div>
          <h2 class="font-semibold mb-2">Variables ({pattern.variables.length})</h2>
          {#if pattern.variables.length === 0}
            <p class="text-sm opacity-60">This template has no parametric variables. You can still edit its metadata, or open it in the studio to add some.</p>
          {:else}
            <div class="overflow-x-auto max-h-[26rem] overflow-y-auto border border-base-300 rounded-lg">
              <table class="table table-xs table-pin-rows">
                <thead><tr><th>Name</th><th>Formula</th><th class="text-right">Value</th><th>Edit</th><th>Show</th></tr></thead>
                <tbody>
                  {#each pattern.variables as v (v.id)}
                    <tr>
                      <td class="whitespace-nowrap font-mono">{v.name}</td>
                      <td>
                        <input
                          class="input input-bordered input-xs w-36 font-mono"
                          value={v.valueFormula?.formula ?? ''}
                          onchange={(e) => setVariableFormula(v.id, e.currentTarget.value)}
                        />
                      </td>
                      <td class="text-right tabular-nums">{Number.isFinite(resolved[v.name]) ? resolved[v.name].toFixed(1) : '—'}</td>
                      <td><input type="checkbox" class="checkbox checkbox-xs" checked={v.isEditable} onchange={(e) => setVariableFlag(v.id, 'isEditable', e.currentTarget.checked)} /></td>
                      <td><input type="checkbox" class="checkbox checkbox-xs" checked={v.isVisible} onchange={(e) => setVariableFlag(v.id, 'isVisible', e.currentTarget.checked)} /></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <p class="text-xs opacity-50 mt-1">Formulas may reference other variables and <code>body.*</code> measurements; constrained templates re-draft live in the preview.</p>
          {/if}
        </div>

        <div class="flex flex-wrap gap-2 pt-2">
          <button class="btn btn-primary btn-sm" onclick={saveToMyTemplates}>Save to My templates</button>
          <button class="btn btn-sm" onclick={download}>Download JSON</button>
          <button class="btn btn-accent btn-sm" onclick={openInStudio}>Open in Studio</button>
        </div>
      </div>

      <div>
        <h2 class="font-semibold mb-2">Preview · {pattern.pieces.length} piece{pattern.pieces.length === 1 ? '' : 's'}</h2>
        <div class="bg-base-200 rounded-lg p-4">
          {#if preview}
            <svg viewBox={preview.viewBox} class="w-full max-h-[60vh]" xmlns="http://www.w3.org/2000/svg">
              {#each preview.outlines as o, i}
                <polygon points={o.points} fill="{COLORS[i % COLORS.length]}22" stroke={COLORS[i % COLORS.length]} stroke-width="2" vector-effect="non-scaling-stroke" />
              {/each}
            </svg>
          {:else}
            <p class="text-sm opacity-60 py-12 text-center">No renderable piece outlines in this template.</p>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<Toaster />
