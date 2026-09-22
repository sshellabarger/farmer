// Test-only helper for A2's tests.
//
// Every A2 test file mocks '../src/middleware/rbac.js' inline (vi.mock calls
// must be hoistable, so the factory is duplicated per file rather than
// shared here) with a version of `authenticate` that also projects
// `assigned_market_ids` onto `request.authUser`. On this branch rbac.ts
// (owned by A1) still builds authUser with only { id, name, role, phone } —
// `assigned_market_ids` lands with A1's Phase 2 rbac.ts change, which this
// branch doesn't have yet. A2's routes and market-scope.ts already read
// `assigned_market_ids` structurally (see market-scope.ts), so mocking here
// matches the contracted post-merge behaviour without editing rbac.ts.
// Real end-to-end coverage of assigned_market_ids arrives with A1's branch
// (see tests/rbac.test.ts there).

/** Bearer token understood only by the mocked `authenticate` (`test:<userId>`). */
export function tokenFor(userId: string): string {
  return `test:${userId}`;
}
