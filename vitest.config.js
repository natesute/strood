const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
});
