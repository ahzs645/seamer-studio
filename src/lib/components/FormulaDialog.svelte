<script lang="ts">
  import { untrack } from 'svelte';
  interface Var { name: string; value: number }
  /** A categorised, searchable token the picker can insert (label shown, token inserted). */
  export interface TokenItem { label: string; token: string; title?: string }
  export interface TokenCategory { name: string; items: TokenItem[] }
  let { formula = '', variables = [], categories = [], onsave, oncancel }:
    {
      formula?: string;
      variables?: Var[];
      categories?: TokenCategory[];
      onsave: (f: string, value: number | null) => void;
      oncancel: () => void;
    } = $props();

  let text = $state(untrack(() => formula));
  let area: HTMLTextAreaElement | undefined = $state();
  let search = $state('');

  // only valid JS identifiers can be referenced safely
  const usable = $derived(variables.filter((v) => /^[A-Za-z_$][\w$]*$/.test(v.name)));

  // The math functions the solver supports via Math.* — offered as a category.
  const FUNCTIONS: TokenItem[] = [
    { label: 'sqrt()', token: 'Math.sqrt()', title: 'square root' },
    { label: 'abs()', token: 'Math.abs()', title: 'absolute value' },
    { label: 'min()', token: 'Math.min()', title: 'minimum' },
    { label: 'max()', token: 'Math.max()', title: 'maximum' },
    { label: 'sin()', token: 'Math.sin()' },
    { label: 'cos()', token: 'Math.cos()' },
    { label: 'tan()', token: 'Math.tan()' },
    { label: 'round()', token: 'Math.round()' },
    { label: 'floor()', token: 'Math.floor()' },
    { label: 'ceil()', token: 'Math.ceil()' },
    { label: 'PI', token: 'Math.PI' },
    { label: 'pow(,)', token: 'Math.pow(,)', title: 'x to the power y' }
  ];

  // All categories: Functions + the variable list (as "Custom variables" when no explicit category
  // supplies them) + any geometry categories passed in.
  const allCategories = $derived<TokenCategory[]>([
    { name: 'Functions', items: FUNCTIONS },
    ...(categories.length ? [] : [{ name: 'Custom variables', items: usable.map((v) => ({ label: v.name, token: v.name, title: `${v.name} = ${v.value}` })) }]),
    ...categories
  ]);

  // Filtered view by the search box (matches label or token, case-insensitive).
  const filtered = $derived(
    allCategories
      .map((c) => ({ name: c.name, items: search.trim() ? c.items.filter((i) => (i.label + ' ' + i.token).toLowerCase().includes(search.trim().toLowerCase())) : c.items }))
      .filter((c) => c.items.length)
  );

  // Geometric / measurement tokens can't be previewed here (they need solved geometry), so detect
  // them and skip the numeric preview rather than showing a misleading "invalid".
  const hasGeometry = $derived(/\.(x|y|angle|length|handle|length2|angle2)\b/.test(text) || text.includes('body.'));

  /** Evaluate the expression with the variables (and Math.*) in scope. Returns null on error. */
  function evalFormula(expr: string): number | null {
    if (!expr.trim()) return null;
    if (!/^[\w\s+\-*/().,%]*$/.test(expr)) return null; // reject anything but math + identifiers
    try {
      const names = usable.map((v) => v.name);
      const vals = usable.map((v) => v.value);
      // eslint-disable-next-line no-new-func
      const fn = new Function(...names, 'Math', `"use strict"; return (${expr});`);
      const r = fn(...vals, Math);
      return typeof r === 'number' && isFinite(r) ? r : null;
    } catch { return null; }
  }

  const result = $derived(hasGeometry ? null : evalFormula(text));

  function insert(token: string) {
    const el = area;
    // place the caret inside a trailing "()" or "(,)" so the user can type the argument next
    const inner = token.endsWith('()') ? token.length - 1 : token.endsWith('(,)') ? token.length - 2 : token.length;
    if (!el) { text += token; return; }
    const s = el.selectionStart ?? text.length, e = el.selectionEnd ?? text.length;
    text = text.slice(0, s) + token + text.slice(e);
    queueMicrotask(() => { el.focus(); el.selectionStart = el.selectionEnd = s + inner; });
  }
</script>

<div class="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
  <div class="bg-base-100 rounded-lg shadow-xl w-[min(560px,95vw)] p-5">
    <div class="flex items-center mb-3">
      <h3 class="font-bold flex items-center gap-2"><span class="material-symbols-rounded">function</span> Formula editor</h3>
      <button class="ml-auto btn btn-sm btn-ghost btn-circle" aria-label="Close" onclick={oncancel}><span class="material-symbols-rounded">close</span></button>
    </div>

    <textarea bind:this={area} bind:value={text} rows="3" class="textarea textarea-bordered w-full font-mono text-sm" placeholder="e.g. waist / 4 + 1.5"></textarea>

    <div class="mt-2 text-sm flex items-center gap-2">
      <span class="opacity-70">=</span>
      {#if hasGeometry}
        <span class="font-mono opacity-50" title="Resolves against the pattern's geometry">geometry ref</span>
      {:else}
        <span class="font-mono {result === null ? 'text-error' : 'text-success'}">{result === null ? (text.trim() ? 'invalid' : '—') : result.toFixed(3)}</span>
      {/if}
    </div>

    <div class="mt-2 flex flex-wrap gap-1">
      {#each ['+', '−', '×', '÷', '(', ')'] as op, i}
        <button class="btn btn-xs btn-ghost font-mono" onclick={() => insert(['+', '-', '*', '/', '(', ')'][i])}>{op}</button>
      {/each}
    </div>

    <input bind:value={search} class="input input-bordered input-xs w-full mt-3" placeholder="Search tokens…" />
    <div class="mt-2 max-h-56 overflow-y-auto pr-1 space-y-2">
      {#each filtered as cat}
        <div>
          <p class="text-xs opacity-60 mb-1">{cat.name}</p>
          <div class="flex flex-wrap gap-1">
            {#each cat.items as it}
              <button class="btn btn-xs" title={it.title ?? it.token} onclick={() => insert(it.token)}>{it.label}</button>
            {/each}
          </div>
        </div>
      {/each}
      {#if !filtered.length}
        <p class="text-xs opacity-50">No tokens match.</p>
      {/if}
    </div>

    <div class="flex justify-end gap-2 mt-4">
      <button class="btn btn-sm btn-ghost" onclick={oncancel}>Cancel</button>
      <button class="btn btn-sm btn-primary" onclick={() => onsave(text, result)}>Apply</button>
    </div>
  </div>
</div>
