import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("scaffold wiring", () => {
  it("serves the SPA shell from Workers Assets", async () => {
    const response = await SELF.fetch("https://latch.test/");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain("Latch");
  });

  it("routes workspace API calls to the Coordinator Durable Object", async () => {
    const response = await SELF.fetch(
      "https://latch.test/api/workspaces/demo",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, workspace: "demo" });
  });

  it("returns 404 for unknown API routes", async () => {
    const response = await SELF.fetch("https://latch.test/api/nope");

    expect(response.status).toBe(404);
  });
});
