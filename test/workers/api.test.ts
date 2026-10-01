import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { workspaceApi } from "./helpers";

describe("worker routing", () => {
  it("serves the SPA shell from Workers Assets", async () => {
    const response = await SELF.fetch("https://latch.test/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain("Latch");
  });

  it("returns 404 for unknown API routes", async () => {
    const response = await SELF.fetch("https://latch.test/api/nope");
    expect(response.status).toBe(404);
  });
});

describe("workspace snapshot", () => {
  it("starts empty and is labeled with the workspace name", async () => {
    const w = workspaceApi();
    const { status, body } = await w.get("/");
    expect(status).toBe(200);
    expect(body.name).toBe(w.name);
    expect(body.changesets).toEqual([]);
    expect(body.leases).toEqual([]);
    expect(body.config).toEqual({ mainRemote: null });
    expect(body.stats).toEqual({
      openLeases: 0,
      activeChangesets: 0,
      pendingJobs: 0,
      runningJobs: 0,
    });
  });

  it("stores workspace configuration", async () => {
    const w = workspaceApi();
    const { status } = await w.put("/workspace", { mainRemote: "/tmp/latch-e2e/main.git" });
    expect(status).toBe(200);
    const { body } = await w.get("/");
    expect(body.config.mainRemote).toBe("/tmp/latch-e2e/main.git");
  });

  it("lists changesets with their lifecycle fields", async () => {
    const w = workspaceApi();
    const id = await w.createChangeset("agent-a", "Rename the config loader");
    const { body } = await w.get("/changesets");
    expect(body.changesets).toHaveLength(1);
    expect(body.changesets[0]).toMatchObject({
      id,
      agent: "agent-a",
      intent: "Rename the config loader",
      status: "open",
      forkRemote: null,
      ref: null,
    });
  });

  it("rejects malformed bodies with 400", async () => {
    const w = workspaceApi();
    const { status, body } = await w.post("/changesets", { agent: 42 });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_field");
  });

  it("404s unknown routes inside the workspace", async () => {
    const w = workspaceApi();
    const { status } = await w.get("/does-not-exist");
    expect(status).toBe(404);
  });
});
