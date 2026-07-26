<script lang="ts">
  import { onMount } from 'svelte';

  interface ReleaseNote {
    version: string;
    content: string;
    date: string;
  }

  let notes: ReleaseNote[] = $state([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const res = await fetch('/api/release-notes');
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      notes = Array.isArray(data) ? data : [];
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load release notes';
    }
    loading = false;
  });

  function formatDate(d: string): string {
    const date = new Date(d);
    return isNaN(date.getTime()) ? d : date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }
</script>

<svelte:head>
  <title>Changelog — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Changelog</h1>
  <p class="text-lg mb-8">
    Release notes for Seamer. New features, fixes, and improvements ship continuously —
    the studio you open today is always the latest version.
  </p>

  {#if loading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else if error}
    <div class="text-center py-12 bg-base-200 rounded-lg">
      <p class="text-lg opacity-70">Release notes are unavailable right now.</p>
      <p class="text-sm opacity-50 mt-2">{error}</p>
      <a href="/studio" class="btn btn-accent mt-4">Open Studio</a>
    </div>
  {:else if notes.length === 0}
    <div class="text-center py-12 bg-base-200 rounded-lg">
      <p class="text-lg opacity-70">No release notes published yet.</p>
    </div>
  {:else}
    <div class="space-y-6">
      {#each notes as note}
        <div class="card bg-base-200">
          <div class="card-body">
            <div class="flex items-baseline justify-between flex-wrap gap-2">
              <h2 class="card-title text-xl">v{note.version}</h2>
              <span class="text-sm opacity-60">{formatDate(note.date)}</span>
            </div>
            <div class="whitespace-pre-line text-sm leading-relaxed">{note.content}</div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
