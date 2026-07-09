import eslint from '@eslint/js'
import eslintPluginN from 'eslint-plugin-n'
import globals from 'globals'

export default [
  eslint.configs.recommended,
  {
    // cache-tests/tests and cache-tests/engine/lib are vendored verbatim from
    // http-tests/cache-tests — keep them lint-free so re-vendoring stays a copy.
    ignores: ['tmp*', 'benchmarks/**/*', 'cache-tests/tests/**/*', 'cache-tests/engine/lib/**/*'],
  },
  // Base config:
  {
    rules: {
      'prefer-const': [
        'error',
        {
          destructuring: 'all',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'getter-return': 'off',
      'object-shorthand': ['warn', 'properties'],
    },
  },
  // Node specific
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      n: eslintPluginN,
    },
  },
]
