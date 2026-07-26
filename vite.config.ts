import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    dedupe: ['three']
  },
  ssr: {
    noExternal: ['three']
  }
});
