import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E against a real `wrangler dev` instance (separate port and
 * persist dir, so it never collides with `npm run dev`, the demo, or the
 * vitest suites).
 */
export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  // One shared workspace server; tests must not race each other.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI === "true" ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8790",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "npm run build && npx wrangler dev --port 8790 --persist-to /tmp/latch-e2e-state",
    url: "http://127.0.0.1:8790",
    reuseExistingServer: process.env.CI !== "true",
    timeout: 120_000,
  },
});
