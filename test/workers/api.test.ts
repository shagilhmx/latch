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

  it("serves the OpenAPI description of the coordination API", async () => {
    const response = await SELF.fetch("https://latch.test/api/openapi.json");
    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toContain(
      "/api/workspaces/{workspace}/changesets/{id}/leases",
    );
    expect(Object.keys(spec.paths)).toContain(
      "/api/workspaces/{workspace}/integration/{seq}/verify",
    );
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(["Changeset", "Lease", "Job", "WorkspaceSnapshot"]),
    );
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

describe("session and setup routes", () => {
  it("creates a changeset in local mode when Artifacts is not bound", async () => {
    const w = workspaceApi();
    const { status, body } = await w.post("/sessions", {
      agent: "agent-local",
      intent: "Local-mode session",
    });
    expect(status).toBe(201);
    expect(body.mode).toBe("local");
    expect(body.fork).toBeNull();
    expect(body.token).toBeNull();
    expect(body.changeset).toMatchObject({ agent: "agent-local", status: "open" });

    const snapshot = await w.get("/");
    expect(snapshot.body.changesets).toHaveLength(1);
  });

  it("explains that setup needs the deploy config when Artifacts is absent", async () => {
    const w = workspaceApi();
    const { status, body } = await w.put("/setup", {});
    expect(status).toBe(503);
    expect(body.error).toBe("artifacts_unavailable");
    expect(body.message).toContain("wrangler.deploy.jsonc");
  });

  it("rejects invalid session input", async () => {
    const w = workspaceApi();
    const { status } = await w.post("/sessions", { agent: "agent-a" });
    expect(status).toBe(400);
  });

  it("rejects invalid workspace names on artifacts-backed routes", async () => {
    const response = await SELF.fetch(
      "https://latch.test/api/workspaces/bad.name/setup",
      { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_workspace");
  });

  it("returns 503 for agent sandbox routes without the container binding", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Needs a container");
    const { status, body } = await w.post(`/sessions/${cs}/agent/start`, {
      prompt: "rename the helper",
    });
    expect(status).toBe(503);
    expect(body.error).toBe("sandbox_unavailable");
    expect(body.message).toContain("wrangler.deploy.jsonc");
  });
});
