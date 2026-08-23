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
  server: {
    fs: {
      // pnpm symlinks resolve workspace packages (./packages/*) and the linked
      // ../atelier packages to real paths outside Vite's default allow list.
      allow: ['.', '../atelier']
    }
  },
  resolve: {
    // Risk R3: two three instances silently break `instanceof`.
    // svelte must also be deduped: the link:../atelier packages resolve their own
    // physical copy, and a second client runtime crashes mount (first_child_getter
    // is initialized in one copy and read in the other).
    dedupe: ['three', 'svelte']
  },
  optimizeDeps: {
    // The engine is consumed as TypeScript source (no build step), so Vite's dependency
    // optimizer must not pre-bundle it: the optimizer parses linked deps as plain JS, which
    // fails on `import type` and on `@atelier/svelte`'s `.svelte.ts` rune module. Excluding
    // them routes the packages through the normal source pipeline instead.
    exclude: ATELIER,
    // Pre-bundle late-discovered deps (dynamic imports inside the 3D scene). Without
    // this the optimizer re-runs mid-session, and modules from different optimizer
    // generations mix in one page load, crashing mount with a second svelte runtime.
    include: [
      'three',
      'three/addons/controls/OrbitControls.js',
      'three/addons/controls/TransformControls.js',
      'three/addons/environments/RoomEnvironment.js',
      'three/addons/lines/LineMaterial.js',
      'three/addons/lines/LineSegments2.js',
      'three/addons/lines/LineSegmentsGeometry.js',
      'three/addons/loaders/RGBELoader.js',
      'three/addons/postprocessing/BokehPass.js',
      'three/addons/postprocessing/EffectComposer.js',
      'three/addons/postprocessing/GTAOPass.js',
      'three/addons/postprocessing/OutputPass.js',
      'three/addons/postprocessing/RenderPass.js',
      'three/addons/postprocessing/SMAAPass.js',
      'three/examples/jsm/exporters/GLTFExporter.js',
      'three/examples/jsm/exporters/OBJExporter.js',
      'three/examples/jsm/exporters/STLExporter.js'
    ]
  },
  ssr: {
    noExternal: ['three', ...ATELIER]
  }
});
