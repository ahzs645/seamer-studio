<script lang="ts">
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import '../app.css';
  import { onMount } from 'svelte';
  import { setAvatarAssetsBase } from '@seamer/avatar/assets';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import { applyStoredTheme } from '$lib/utils/theme';

  let { children } = $props();
  const studioRoot = `${base}/studio`;
  const isStudio = $derived(
    $page.url.pathname === studioRoot || $page.url.pathname.startsWith(`${studioRoot}/`)
  );

  setAvatarAssetsBase(`${base}/models`);

  onMount(() => {
    applyStoredTheme();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(`${base}/service-worker.js`).catch(() => {});
    }
  });
</script>

<div
  class="relative w-full min-h-screen flex flex-col bg-base-100"
  class:max-w-screen-2xl={!isStudio}
  class:mx-auto={!isStudio}
>
  {#if !isStudio}
    <AppHeader />
  {/if}
  <main class="flex-1">
    {@render children()}
  </main>
  {#if !isStudio}
    <footer class="footer footer-center p-10 bg-base-200 text-base-content rounded">
      <nav class="grid grid-flow-col gap-4">
        <a href="{base}/about" class="link link-hover">About</a>
        <a href="{base}/software" class="link link-hover">Software</a>
        <a href="{base}/docs" class="link link-hover">Docs</a>
        <a href="{base}/pricing" class="link link-hover">Pricing</a>
        <a href="{base}/faq" class="link link-hover">FAQ</a>
        <a href="{base}/changelog" class="link link-hover">Changelog</a>
        <a href="{base}/support-seamer" class="link link-hover">Support</a>
      </nav>
      <nav class="grid grid-flow-col gap-4 text-sm opacity-70">
        <a href="{base}/privacy" class="link link-hover">Privacy</a>
        <a href="{base}/terms" class="link link-hover">Terms</a>
      </nav>
      <aside>
        <p>&copy; {new Date().getFullYear()} Seamer. All rights reserved.</p>
      </aside>
    </footer>
  {/if}
</div>
