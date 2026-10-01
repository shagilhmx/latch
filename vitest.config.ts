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
