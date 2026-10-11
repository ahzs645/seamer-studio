import adapter from '@sveltejs/adapter-static';
import nodeAdapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: process.env.SEAMER_SERVER === '1' ? nodeAdapter({ out: 'server-build' }) : adapter({
      fallback: '404.html'
    }),
    paths: {
      base: process.env.BASE_PATH ?? '',
      relative: false
    },
    alias: {
      $lib: './src/lib',
      '$lib/*': './src/lib/*'
    }
  }
};

export default config;
