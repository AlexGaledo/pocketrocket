import { defineConfig } from 'vitest/config';

// Windows needs more headroom than the 5s default. Opening a file-backed Db runs every migration in its own
// committed transaction, and each commit is an fsync (FlushFileBuffers), which is many times slower on Windows,
// most of all on a CI runner with test files running in parallel. Process spawns (git, node) are slow there too.
// Uncontended these tests take ~0.5-1s on Windows; on the release runner they hit 5s. This is headroom, not a retry.
const slowFs = process.platform === 'win32';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: slowFs ? 30_000 : 5_000,
    hookTimeout: slowFs ? 30_000 : 10_000,
  },
});
