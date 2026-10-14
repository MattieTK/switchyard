import { defineConfig } from "vitest/config";

// Slow tests that run real vinext and cf builds. No Cloudflare login needed.
export default defineConfig({
  test: {
    include: ["tests/fixtures/**/*.fixture.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
