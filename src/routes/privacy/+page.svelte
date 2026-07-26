<script lang="ts">
</script>

<svelte:head>
  <title>Privacy Policy — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">Privacy Policy</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      Seamer is a local-first application. The short version: your patterns and your
      measurements stay on your device, and we don't operate user accounts.
    </p>

    <h2 class="text-2xl font-bold mt-8">What we store, and where</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>
        <strong>Patterns</strong> — saved in your browser's IndexedDB on your device.
        They are never uploaded unless you explicitly export a file and share it yourself.
      </li>
      <li>
        <strong>Settings and preferences</strong> — editor preferences (units, grid, autosave
        settings, view options) are stored in your browser's localStorage.
      </li>
      <li>
        <strong>Body measurements</strong> — measurements you enter to drive the 3D avatar are
        part of the pattern data and stay in local storage with the rest of the pattern.
      </li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">No accounts, no tracking</h2>
    <p>
      Seamer does not require sign-up, login, or any personal information. We do not use
      advertising trackers or sell data — there is no data to sell, because it never leaves
      your browser.
    </p>

    <h2 class="text-2xl font-bold mt-8">Offline use</h2>
    <p>
      Seamer installs a service worker so the studio works offline. Cached application files
      are stored by your browser as part of normal PWA operation.
    </p>

    <h2 class="text-2xl font-bold mt-8">Deleting your data</h2>
    <p>
      Because everything is local, you are in full control. Deleting a pattern in the studio
      removes it from IndexedDB. Clearing your browser's site data for Seamer removes
      everything — patterns, settings, and cached files. We recommend exporting
      <code>.seamer.json</code> backups of work you care about before clearing browser data.
    </p>

    <h2 class="text-2xl font-bold mt-8">Changes to this policy</h2>
    <p>
      If Seamer ever adds optional online features, this policy will be updated first and
      any data sharing will be opt-in.
    </p>

    <p class="mt-8 text-sm opacity-60">Last updated: June 2026</p>
  </div>
</div>
