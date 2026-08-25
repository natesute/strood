const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    // Anchor discovery to this checkout's unit tests: without this, vitest
    // sweeps vendored tests under .claude/worktrees/*/node_modules and the
    // playwright specs, and fails on all of them.
    include: ['tests/**/*.test.js'],
    exclude: ['**/node_modules/**', '**/.claude/**', 'tests/e2e/**'],
  },
});
