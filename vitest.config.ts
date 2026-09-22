import { defineConfig } from 'vitest/config';

// Only tests/ runs. archive/ holds retired v1 tests kept for reference; they
// import modules that no longer exist and must never be collected.
//
// tests/setup/test-mode.ts runs before every test file's imports and pins the
// console providers (SPEC §7.3), so no test can reach voip.ms or Resend
// whatever a developer keeps in .env.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['archive/**', 'node_modules/**', 'web/**', 'dist/**'],
    setupFiles: ['tests/setup/test-mode.ts'],
  },
});
