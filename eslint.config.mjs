export default [
  {
    ignores: ['dist/**', 'test-results/**', 'public/**', 'songs/**', '.claude/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      complexity: ['error', { max: 20 }],
    },
  },
];
