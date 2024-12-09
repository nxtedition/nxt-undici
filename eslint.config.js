import eslint from '@eslint/js'
import eslintPluginN from 'eslint-plugin-n'
import globals from 'globals'

export default [
  eslint.configs.recommended,
  {
    ignores: ['tmp*', 'benchmarks/**/*'],
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
