import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Artifacts bindings otherwise force a remote proxy session, which needs
      // CLOUDFLARE_API_TOKEN; tests must run fully locally.
      remoteBindings: false,
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
