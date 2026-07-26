import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Standalone config for unit tests of pure modules (command bus, geometry, mutators). We resolve the
// `$lib` alias ourselves instead of loading the full SvelteKit plugin, so tests run fast in Node.
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.{test,spec}.ts',
      'packages/avatar/src/**/*.test.ts',
      'packages/cloth-sim/src/**/*.test.ts',
      'packages/pattern-model/src/editor.test.ts',
      'packages/pattern-model/src/commands/**/*.test.ts',
      'packages/pattern-model/src/solver/**/*.test.ts',
      'packages/pattern-model/src/utils/arcParametric.test.ts',
      'packages/pattern-model/src/utils/linkedPaths.test.ts',
      'packages/pattern-model/src/utils/patternImport.test.ts',
      'packages/pattern-model/src/utils/pieceSymmetry.test.ts'
    ]
  }
});
