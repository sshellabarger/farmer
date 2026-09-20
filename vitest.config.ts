import { defineConfig } from 'vitest/config';

// Only tests/ runs. archive/ holds retired v1 tests kept for reference; they
// import modules that no longer exist and must never be collected.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['archive/**', 'node_modules/**', 'web/**', 'dist/**'],
  },
});
