import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Artifacts bindings otherwise force a remote proxy session, which
            // needs CLOUDFLARE_API_TOKEN; tests must run fully locally.
            remoteBindings: false,
            // Configure a RUNNER_TOKEN so the test pool exercises the strict
            // runner-auth path (helpers send it on every system request).
            // Local dev and the demo keep no token → those paths stay open.
            miniflare: { bindings: { RUNNER_TOKEN: "test-runner-token" } },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "node",
          include: ["test/node/**/*.test.ts"],
          environment: "node",
          // The git e2e boots wrangler dev and runs real git merges.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
