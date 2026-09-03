import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ATELIER = [
  '@atelier/core',
  '@atelier/geometry',
  '@atelier/viewport',
  '@atelier/io',
  '@atelier/sim',
  '@atelier/svelte'
];

// The body model's assets live with the model, not in static/, so the package
// is self-contained and can be split out on its own. The app still serves them
// at /models: this hands them out in dev and preview, and copies them into the
// client build, which is what adapter-static ships.
const MODELS_DIR = fileURLToPath(new URL('./packages/body-model/models/', import.meta.url));

const MODEL_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.bin': 'application/octet-stream'
};

function modelFile(url: string): string | null {
  const name = /(?:^|\/)models\/([A-Za-z0-9_.-]+)$/.exec(url.split('?')[0])?.[1];
  if (!name || name.includes('..')) return null;
  const file = join(MODELS_DIR, name);
  return statSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
}

function bodyModelAssets(): Plugin {
  let ssr = false;
  const serve = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const file = req.url ? modelFile(req.url) : null;
    if (!file) return next();
    res.setHeader('Content-Type', MODEL_TYPES[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'body-model-assets',
    configResolved(config) {
      ssr = Boolean(config.build.ssr);
    },
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
    writeBundle(options) {
      // The browser fetches them, so only the client build needs them.
      if (ssr || !options.dir) return;
      const out = join(options.dir, 'models');
      mkdirSync(out, { recursive: true });
      for (const name of readdirSync(MODELS_DIR)) copyFileSync(join(MODELS_DIR, name), join(out, name));
    }
  };
}

export default defineConfig({
  plugins: [sveltekit(), bodyModelAssets()],
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
