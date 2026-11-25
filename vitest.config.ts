import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only this checkout's tests; .claude/worktrees holds old copies of the repo.
    include: ['tests/**/*.test.ts'],
    env: { NODE_ENV: 'test', ALLOW_REAL_SENDS: 'false' },
  },
});
