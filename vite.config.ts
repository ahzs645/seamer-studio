import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const ATELIER = [
  '@atelier/core',
  '@atelier/geometry',
  '@atelier/viewport',
  '@atelier/io',
  '@atelier/sim',
  '@atelier/svelte'
];

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    // Risk R3: two three instances silently break `instanceof`.
    dedupe: ['three']
  },
  optimizeDeps: {
    // The engine is consumed as TypeScript source (no build step), so Vite's dependency
    // optimizer must not pre-bundle it: the optimizer parses linked deps as plain JS, which
    // fails on `import type` and on `@atelier/svelte`'s `.svelte.ts` rune module. Excluding
    // them routes the packages through the normal source pipeline instead.
    exclude: ATELIER
  },
  ssr: {
    noExternal: ['three', ...ATELIER]
  }
});
