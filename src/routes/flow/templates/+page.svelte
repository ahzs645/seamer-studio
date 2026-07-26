<script lang="ts">
  // Mirrors the studio's built-in template library (static/templates/*.json), plus the user's own
  // saved templates from the template editor.
  import { BUILTIN_TEMPLATES } from '$lib/data/templates';
  import { customTemplates, removeCustomTemplate } from '$lib/stores/customTemplates';
</script>

<svelte:head>
  <title>Templates — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-6xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Built-in Pattern Templates</h1>
  <p class="text-lg mb-8 max-w-3xl">
    Every Seamer install ships with these templates — open the
    <a href="/studio" class="link link-primary">studio</a> and pick one from the new-pattern
    dialog, download the raw JSON and inspect it in the
    <a href="/pattern-viewer" class="link link-primary">pattern viewer</a>, or tweak one in the
    <a href="/flow/templates/edit" class="link link-primary">template editor</a>.
  </p>

  {#if $customTemplates.length}
    <h2 class="text-2xl font-bold font-lexend mb-4">My templates</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
      {#each $customTemplates as tpl (tpl.slug)}
        <div class="card bg-base-200 shadow-sm hover:shadow-md transition-shadow border border-primary/20">
          <div class="card-body">
            <h2 class="card-title text-lg">{tpl.name}</h2>
            <p class="text-sm opacity-70">{tpl.description || 'Saved from the template editor'}</p>
            <div class="card-actions justify-end mt-2">
              <button class="btn btn-sm btn-ghost text-error" onclick={() => removeCustomTemplate(tpl.slug)}>Delete</button>
              <a href="/flow/templates/edit/{tpl.slug}" class="btn btn-sm btn-accent">Edit</a>
            </div>
          </div>
        </div>
      {/each}
    </div>
    <h2 class="text-2xl font-bold font-lexend mb-4">Built-in</h2>
  {/if}

  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    {#each BUILTIN_TEMPLATES as tpl (tpl.slug)}
      <div class="card bg-base-200 shadow-sm hover:shadow-md transition-shadow">
        <div class="card-body">
          <h2 class="card-title text-lg">{tpl.name}</h2>
          <p class="text-sm opacity-70">{tpl.description}</p>
          <div class="card-actions justify-end mt-2">
            <a href="/templates/{tpl.file}" class="btn btn-sm btn-ghost" download>JSON</a>
            <a href="/flow/templates/edit/{tpl.slug}" class="btn btn-sm btn-ghost">Edit</a>
            <a href="/studio" class="btn btn-sm btn-accent">Open Studio</a>
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>
