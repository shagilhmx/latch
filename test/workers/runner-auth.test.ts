import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RUNNER_TOKEN_HEADER } from "../../src/shared/runner-token.ts";
import { authorizeRunner } from "../../src/worker/authz.ts";
import { RUNNER_TOKEN, workspaceApi } from "./helpers";

const BASE = "https://latch.test";

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await SELF.fetch(`${BASE}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

function withToken(token: string): Record<string, string> {
  return { [RUNNER_TOKEN_HEADER]: token };
}

describe("runner-only routes require RUNNER_TOKEN", () => {
  it("rejects a claim without the token", async () => {
    const result = await call("/api/workspaces/ws-auth/integration/next");
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("runner_auth_required");
  });

  it("rejects a wrong token", async () => {
    const result = await call("/api/workspaces/ws-auth/integration/next", {
      headers: withToken("not-the-token"),
    });
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("runner_auth_invalid");
  });

  it("accepts the configured token", async () => {
    const result = await call("/api/workspaces/ws-auth/integration/next", {
      headers: withToken(RUNNER_TOKEN),
    });
    expect(result.status).toBe(204);
  });

  it("guards /internal/pushed as well", async () => {
    const body = JSON.stringify({ repoName: "latch/ws--cs-1", ref: "refs/heads/main" });
    const denied = await call("/api/workspaces/ws-auth/internal/pushed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(denied.status).toBe(401);
    expect(denied.body.error).toBe("runner_auth_required");

    const allowed = await call("/api/workspaces/ws-auth/internal/pushed", {
      method: "POST",
      headers: { "content-type": "application/json", ...withToken(RUNNER_TOKEN) },
      body,
    });
    expect(allowed.status).toBe(202);
    expect(allowed.body.queued).toBe(false);
  });

  it("leaves user-facing routes untouched", async () => {
    const w = workspaceApi();
    // Reads are open without any runner token…
    const snapshot = await call(`/api/workspaces/${encodeURIComponent(w.name)}/`);
    expect(snapshot.status).toBe(200);
    // …and user writes are still gated by user authz (dev mode), not the
    // runner header.
    const created = await w.createChangeset("agent-a", "Auth boundary");
    expect(created).toBeTruthy();
  });
});

describe("authorizeRunner policy", () => {
  it("stays open in dev mode with no token configured", async () => {
    expect(await authorizeRunner({}, null)).toEqual({ allowed: true });
    expect(await authorizeRunner({}, "anything")).toEqual({ allowed: true });
  });

  it("fails closed in github mode when no token is configured", async () => {
    const result = await authorizeRunner({ AUTH_SECRET: "s3cret" }, null);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(503);
      expect(result.code).toBe("runner_token_not_configured");
    }
  });

  it("enforces the token whenever one is configured", async () => {
    const env = { RUNNER_TOKEN: "prod-token" };
    expect(await authorizeRunner(env, "prod-token")).toEqual({ allowed: true });

    const missing = await authorizeRunner(env, null);
    expect(missing.allowed).toBe(false);
    if (!missing.allowed) expect(missing.status).toBe(401);

    const wrong = await authorizeRunner(env, "prod-token-x");
    expect(wrong.allowed).toBe(false);
    if (!wrong.allowed) expect(wrong.code).toBe("runner_auth_invalid");
  });

  it("ignores a whitespace-only configuration (treated as unset)", async () => {
    expect(await authorizeRunner({ RUNNER_TOKEN: "   " }, "   ")).toEqual({ allowed: true });
    const blank = await authorizeRunner({ AUTH_SECRET: "s3cret", RUNNER_TOKEN: "   " }, null);
    expect(blank.allowed).toBe(false);
  });
});
