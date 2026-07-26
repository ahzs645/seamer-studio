import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      // Temporary compatibility route for the concurrently migrated 3D scene. It resolves straight
      // to the package source without retaining a second app copy of patternGeometry.
      '$lib/utils/patternGeometry': './packages/pattern-model/src/utils/patternGeometry.ts',
      $lib: './src/lib',
      '$lib/*': './src/lib/*'
    }
  }
};

export default config;
