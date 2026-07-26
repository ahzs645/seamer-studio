<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import AppHeader from '$lib/components/AppHeader.svelte';

  let { children } = $props();

  onMount(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    }
  });
</script>

<div class="relative w-full min-h-screen flex flex-col max-w-screen-2xl mx-auto bg-base-100">
  <AppHeader />
  <main class="flex-1">
    {@render children()}
  </main>
  <footer class="footer footer-center p-10 bg-base-200 text-base-content rounded">
    <nav class="grid grid-flow-col gap-4">
      <a href="/about" class="link link-hover">About</a>
      <a href="/software" class="link link-hover">Software</a>
      <a href="/docs" class="link link-hover">Docs</a>
      <a href="/pricing" class="link link-hover">Pricing</a>
      <a href="/faq" class="link link-hover">FAQ</a>
      <a href="/changelog" class="link link-hover">Changelog</a>
      <a href="/support-seamer" class="link link-hover">Support</a>
    </nav>
    <nav class="grid grid-flow-col gap-4 text-sm opacity-70">
      <a href="/privacy" class="link link-hover">Privacy</a>
      <a href="/terms" class="link link-hover">Terms</a>
    </nav>
    <aside>
      <p>&copy; {new Date().getFullYear()} Seamer. All rights reserved.</p>
    </aside>
  </footer>
</div>
