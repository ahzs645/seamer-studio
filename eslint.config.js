import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.svelte-kit/**',
      'build/**',
      'node_modules/**',
      'static/**',
      '**/*.svelte',
      'src/lib/sim/webgpu/shaders.ts',
      'packages/cloth-sim/src/webgpu/shaders.ts'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-case-declarations': 'off',
      'no-empty': 'off',
      'no-undef': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'off'
    }
  }
);
