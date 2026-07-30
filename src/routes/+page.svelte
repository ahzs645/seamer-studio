<script lang="ts">
  import { base } from '$app/paths';
  import type { PatternSummary } from '@seamer/pattern-model';
  import { onMount } from 'svelte';
  import { listPatterns } from '$lib/stores/localDB';

  let patterns: PatternSummary[] = $state([]);
  let loading = $state(true);

  onMount(async () => {
    try {
      const stored = await listPatterns();
      patterns = stored.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        is3d: p.enable3d,
        thumbnailUrl: p.thumbnailUrl ?? null,
        updatedAt: new Date().toISOString(),
        ownerUserId: 'local',
        organizationId: null,
        organization: null,
        owner: { id: 'local', firstName: 'You', lastName: null, email: '', image: null }
      }));
    } catch (e) {
      console.error('Failed to load patterns:', e);
    }
    loading = false;
  });
</script>

<div class="hero min-h-[50vh] bg-base-200">
  <div class="hero-content text-center">
    <div class="max-w-2xl">
      <h1 class="text-5xl font-bold font-lexend">Seamer</h1>
      <p class="py-6 text-lg">
        Free digital pattern drafting software. Design parametric garment patterns
        with precision, visualize in 3D on customizable avatars, and share with your team.
      </p>
      <div class="flex gap-4 justify-center">
        <a href="{base}/studio" class="btn btn-accent btn-lg">Open Studio</a>
        <a href="{base}/software" class="btn btn-outline btn-lg">Learn More</a>
      </div>
    </div>
  </div>
</div>

<div class="px-4 py-8 max-w-6xl mx-auto">
  <h2 class="text-2xl font-bold mb-6">Your Patterns</h2>

  {#if loading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else if patterns.length === 0}
    <div class="text-center py-12 bg-base-200 rounded-lg">
      <p class="text-lg opacity-70">No patterns yet. Start creating!</p>
      <a href="{base}/studio" class="btn btn-accent mt-4">Create New Pattern</a>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each patterns as p}
        <div class="card bg-base-200 shadow-sm hover:shadow-md transition-shadow">
          {#if p.thumbnailUrl}
            <figure class="bg-base-100 max-h-40 overflow-hidden">
              <img src={p.thumbnailUrl} alt="Preview of {p.name}" class="w-full object-cover" />
            </figure>
          {/if}
          <div class="card-body">
            <h3 class="card-title text-lg">{p.name}</h3>
            <p class="text-sm opacity-70">{p.description || 'No description'}</p>
            <div class="card-actions justify-end mt-2">
              <a href="{base}/studio/{p.id}" class="btn btn-sm btn-accent">Open</a>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<div class="px-4 py-8 max-w-6xl mx-auto">
  <h2 class="text-2xl font-bold mb-6">Features</h2>
  <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
    <div class="card bg-base-300">
      <div class="card-body">
        <h3 class="card-title">2D Pattern Drafting</h3>
        <p>Precise point-and-path pattern drafting with constraints, curves, and seam allowances.</p>
      </div>
    </div>
    <div class="card bg-base-300">
      <div class="card-body">
        <h3 class="card-title">3D Visualization</h3>
        <p>See your patterns draped on a customizable 3D human avatar in real-time.</p>
      </div>
    </div>
    <div class="card bg-base-300">
      <div class="card-body">
        <h3 class="card-title">Parametric Sizing</h3>
        <p>Body-measurement-driven sizing with grading profiles for multi-size output.</p>
      </div>
    </div>
  </div>
</div>
