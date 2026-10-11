<script lang="ts">
  import { tick } from 'svelte';
  import { base } from '$app/paths';
  import type { Pattern } from '@seamer/pattern-model';
  import { listPatterns } from '$lib/stores/localDB';
  import { libraryPanelViewport } from '$lib/utils/libraryViewport';
  import { referenceSspTemplates } from '$lib/data/referenceSspTemplates';
  import { GARMENTCODE_EXAMPLES } from '$lib/data/garmentCode';

  interface Props {
    draftingTemplates: readonly { key: string; name: string; description: string }[];
    ontemplate: (key: string) => void;
    ongarmentcode: () => void;
    onglobe: () => void;
    onexample: (file: string, label: string) => void;
    onfabric: () => void;
    onopenpattern?: (id: string) => void;
    oncollection?: () => void;
  }
  let { draftingTemplates, ontemplate, ongarmentcode, onglobe, onexample, onfabric, onopenpattern, oncollection }: Props = $props();
  let open = $state(false);
  let query = $state('');
  let savedPatterns = $state<Pattern[]>([]);
  let savedStatus = $state('');
  const savedResults = $derived(savedPatterns.filter(pattern => (category === 'All' || category === 'Saved patterns') && matches(pattern.name, pattern.description ?? '')));
  async function refreshSavedPatterns() {
    try { savedPatterns = await listPatterns(); savedStatus = ''; }
    catch (error) { savedStatus = error instanceof Error ? error.message : 'Saved patterns unavailable.'; }
  }
  let category = $state('All');
  let container: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let search = $state<HTMLInputElement>();
  let panel = $state<HTMLDivElement>();
  let closeButton = $state<HTMLButtonElement>();
  let lastLibraryFocus: HTMLElement | null = null;
  let availableHeight = $state<number>();
  let panelOffset = $state(0);
  const panelId = $props.id();
  const categories = ['All', 'Saved patterns', 'GarmentCode', '3D samples', '2D patterns', 'Generators'];
  const matches = (...values: string[]) => values.join(' ').toLowerCase().includes(query.trim().toLowerCase());
  const samples = $derived(referenceSspTemplates.filter((template) =>
    (category === 'All' || category === (template.dimension === '3D' ? '3D samples' : '2D patterns')) &&
    matches(template.name, template.author, template.description, template.dimension)));
  const drafts = $derived(draftingTemplates.filter((template) =>
    (category === 'All' || category === '2D patterns') && matches(template.name, template.description)));
  const examples = $derived(GARMENTCODE_EXAMPLES.filter((example) =>
    (category === 'All' || category === 'GarmentCode') && matches(example.label, 'GarmentCode garment sewing pattern 3D')));
  const showGarmentGenerator = $derived(['All', 'GarmentCode', 'Generators'].includes(category) && matches('GarmentCode garment T-shirt hoodie skirt pants dress measurements generator'));
  const showGlobe = $derived(['All', 'Generators'].includes(category) && matches('Globe lantern sphere wire generator'));
  const resultCount = $derived(savedResults.length + samples.length + drafts.length + examples.length + Number(showGarmentGenerator) + Number(showGlobe));

  function measureLibrary(node: HTMLDivElement) {
    const viewport = window.visualViewport;
    const update = () => {
      const originalTop = node.getBoundingClientRect().top - panelOffset;
      const layout = libraryPanelViewport(originalTop, viewport?.height ?? window.innerHeight, viewport?.offsetTop ?? 0);
      availableHeight = layout?.maxHeight;
      panelOffset = layout ? layout.top - originalTop : 0;
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    update();
    return { destroy() {
      observer.disconnect();
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    } };
  }
  function focusInitial() {
    (window.matchMedia('(pointer: coarse)').matches ? closeButton : search)?.focus({ preventScroll: true });
  }

  function close(restoreFocus = false) {
    open = false;
    panelOffset = 0;
    availableHeight = undefined;
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  function choose(action: () => void) {
    close(true);
    action();
  }
  async function toggle() {
    if (open) { close(true); return; }
    open = true;
    lastLibraryFocus = null;
    await tick();
    focusInitial();
    void refreshSavedPatterns();
  }
</script>

<svelte:window
  onpointerdown={(event) => { if (open && event.target instanceof Node && !container.contains(event.target)) close(); }}
  onfocusin={(event) => {
    if (!open || !(event.target instanceof HTMLElement)) return;
    if (panel?.contains(event.target)) lastLibraryFocus = event.target;
    else if (!container.contains(event.target)) {
      if (lastLibraryFocus) lastLibraryFocus.focus({ preventScroll: true });
      else focusInitial();
    }
  }}
  onkeydown={(event) => {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    if (event.key === 'Tab' && panel) {
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')].filter((element) => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}
/>

<div class="library-dropdown dropdown dropdown-end" class:dropdown-open={open} bind:this={container} data-document-keyboard>
  <button type="button" class="btn btn-xs btn-ghost library-trigger" bind:this={trigger}
    data-testid="templates-menu-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} onclick={toggle}>
    <span class="material-symbols-rounded notranslate" aria-hidden="true">local_library</span>
    <span>Library</span>
  </button>
  {#if open}
    <div id={panelId} bind:this={panel} use:measureLibrary class="dropdown-content library-panel bg-base-200 rounded-box z-50 p-2 shadow-xl" style:translate={panelOffset ? `0 ${panelOffset}px` : undefined} style:max-height={availableHeight !== undefined ? `${availableHeight}px` : undefined} role="dialog" aria-modal="false" aria-label="Pattern library">
      <div class="library-heading">
        <strong>Pattern library</strong>
        <button type="button" class="btn btn-ghost btn-xs" bind:this={closeButton} aria-label="Close pattern library" onclick={() => close(true)}>Close <span aria-hidden="true">✕</span></button>
      </div>
      <label class="library-search">
        <span class="sr-only">Search pattern library</span>
        <input class="input input-bordered input-sm w-full" type="search" placeholder="Search garments, patterns or makers…" bind:value={query} bind:this={search} />
      </label>
      <div class="library-categories" role="group" aria-label="Library categories">
        {#each categories as name}
          <button type="button" class="btn btn-xs" class:btn-accent={category === name} aria-pressed={category === name} onclick={() => (category = name)}>{name}</button>
        {/each}
      </div>
      <p class="text-xs opacity-60 py-2" aria-live="polite">{resultCount} {resultCount === 1 ? 'result' : 'results'}</p>
      {#if savedStatus}<p role="status" class="text-xs">{savedStatus}</p>{/if}
      <ul class="library-results">
        {#if savedResults.length}
          <li class="library-section-title">Your saved patterns</li>
          {#each savedResults as pattern (pattern.id)}
            <li><button type="button" class="library-item" disabled={!onopenpattern} onclick={() => choose(() => onopenpattern?.(pattern.id))}>
              {#if pattern.thumbnailUrl && /^data:image\/(png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(pattern.thumbnailUrl)}<img class="saved-preview" src={pattern.thumbnailUrl} alt="" />{:else}<span class="badge badge-sm">Saved</span>{/if}
              <span><strong>{pattern.name}</strong><small>{pattern.pieces.length} pieces · {pattern.materials.length} fabrics · {pattern.colorways?.variants.length ?? 0} colorways</small></span>
            </button></li>
          {/each}
        {/if}
        {#if showGarmentGenerator || showGlobe}
          <li class="library-section-title">Generators</li>
          {#if showGarmentGenerator}
            <li><button type="button" class="library-item" data-testid="template-garmentcode" onclick={() => choose(ongarmentcode)}>
              <span class="badge badge-accent badge-sm">Create</span>
              <span><strong>GarmentCode garment…</strong><small>T-shirt, hoodie, skirt, pants or dress from measurements</small></span>
            </button></li>
          {/if}
          {#if showGlobe}
            <li><button type="button" class="library-item" data-testid="template-globe-lantern" onclick={() => choose(onglobe)}>
              <span class="badge badge-sm">Create</span><span><strong>Globe lantern…</strong><small>Wire-in-seam sphere from a coiled strip</small></span>
            </button></li>
          {/if}
        {/if}
        {#if examples.length}
          <li class="library-section-title">GarmentCode examples</li>
          {#each examples as example}
            <li><button type="button" class="library-item" data-testid={`library-garmentcode-${example.file}`} onclick={() => choose(() => onexample(example.file, example.label))}>
              <span class="badge badge-accent badge-sm">3D</span><span><strong>{example.label}</strong><small>Original sewing pattern · ready to render</small></span>
            </button></li>
          {/each}
        {/if}
        {#if samples.length}
          <li class="library-section-title">Complete SSP samples ({samples.length})</li>
          {#each samples as template}
            <li><button type="button" class="library-item" data-testid={`template-${template.key}`} title={`${template.description} By ${template.author}. ${template.pieces} pieces, ${template.seams} seams, ${template.materials} materials.`} onclick={() => choose(() => ontemplate(template.key))}>
              <img class="saved-preview" src={`${base}/templates/previews/${template.key}.svg`} alt="" loading="lazy" /><span class="badge badge-sm" class:badge-accent={template.dimension === '3D'}>{template.dimension}</span>
              <span><strong>{template.name}</strong><small>{template.author} · {template.pieces} pieces · {template.seams} seams</small></span>
            </button></li>
          {/each}
        {/if}
        {#if drafts.length}
          <li class="library-section-title">Drafting examples</li>
          {#each drafts as template}
            <li><button type="button" class="library-item" data-testid={`template-${template.key}`} onclick={() => choose(() => ontemplate(template.key))}>
              <span class="badge badge-sm">2D</span><span><strong>{template.name}</strong><small>{template.description}</small></span>
            </button></li>
          {/each}
        {/if}
      </ul>
      {#if resultCount === 0}<p class="text-sm py-4">No patterns match. Try another search or category.</p>{/if}
      {#if oncollection}<button type="button" class="btn btn-sm w-full mt-2" onclick={() => choose(oncollection)}>Collection &amp; range plan</button>{/if}
      <button type="button" class="btn btn-sm w-full mt-2" onclick={() => choose(onfabric)}>Edit fabrics in this pattern</button>
    </div>
  {/if}
</div>

<style>
  .saved-preview { width: 72px; height: 56px; object-fit: contain; border-radius: 0.35rem; background: white; flex-shrink: 0; }
  .library-trigger > .material-symbols-rounded { font-size: 18px; }
  .library-panel { width: 24rem; display: block; max-height: calc(100dvh - 7rem); overflow-y: auto; overscroll-behavior: contain; }
  .library-heading { display: flex; align-items: center; justify-content: space-between; position: sticky; top: -0.5rem; z-index: 1; background: oklch(var(--b2)); padding: 0.25rem 0; }
  .library-categories { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.5rem; }
  .library-results { list-style: none; margin: 0; padding: 0; }
  .library-section-title { font-size: 0.75rem; font-weight: 700; opacity: 0.7; padding: 0.75rem 0.5rem 0.25rem; }
  .library-item { display: flex; gap: 0.5rem; align-items: flex-start; width: 100%; text-align: left; border-radius: 0.5rem; padding: 0.75rem 0.5rem; min-height: 44px; }
  .library-item:hover, .library-item:focus-visible { background: oklch(var(--b3)); }
  .library-item > .badge { flex-shrink: 0; margin-top: 0.125rem; }
  .library-item strong { display: block; font-size: 0.875rem; font-weight: 600; }
  .library-item small { display: block; font-size: 0.75rem; opacity: 0.65; }
  @media (pointer: coarse) {
    .library-panel button.btn, .library-panel button.btn:active, .library-trigger, .library-trigger:active {
      min-height: 44px; min-width: 44px;
      --btn-focus-scale: 1;
      animation: none; transform: none;
    }
  }
  @media (max-width: 1023px) {
    .library-trigger { padding-inline: 0.5rem; }
    .library-panel { position: fixed; inset: 104px 0.5rem auto; width: auto; max-height: calc(100dvh - 120px); }
    .library-panel button, .library-panel input { min-height: 44px; height: auto; }
    .library-panel input { font-size: 16px; }
    .library-categories .btn { padding: 0.5rem; }
  }
</style>
