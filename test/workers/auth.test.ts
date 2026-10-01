import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, verifySession } from "../../src/worker/auth";
import { DEV_ACTOR, authorize, roleAtLeast } from "../../src/worker/authz";
import { workspaceApi } from "./helpers";

const BASE = "https://latch.test";

async function devLogin(login: string): Promise<string> {
  const response = await SELF.fetch(`${BASE}/api/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie);
  expect(match).not.toBeNull();
  return `${SESSION_COOKIE}=${match?.[1] ?? ""}`;
}

function get(path: string, cookie?: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, cookie !== undefined ? { headers: { cookie } } : undefined);
}

function send(
  method: string,
  path: string,
  body: unknown,
  extra: { cookie?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(extra.cookie !== undefined ? { cookie: extra.cookie } : {}),
      ...(extra.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

describe("session cookies", () => {
  it("round-trips an actor", async () => {
    const value = await signSession({ id: "gh:1", login: "ada", avatarUrl: "a.png" }, "secret");
    const actor = await verifySession(value, "secret");
    expect(actor).toEqual({ id: "gh:1", login: "ada", avatarUrl: "a.png" });
  });

  it("rejects tampered, wrong-secret, and expired sessions", async () => {
    const value = await signSession({ id: "gh:1", login: "ada" }, "secret");
    const [version, payload, signature] = value.split(".");

    // Flip a character in the payload.
    const tampered = `${version}.${(payload ?? "").replace(/^./, (c) => (c === "a" ? "b" : "a"))}.${signature}`;
    expect(await verifySession(tampered, "secret")).toBeNull();
    expect(await verifySession(value, "other-secret")).toBeNull();
    expect(await verifySession(`${version}.$$.${signature}`, "secret")).toBeNull();

    const stale = await signSession({ id: "gh:1", login: "ada" }, "secret", Date.now() - 31 * 86_400_000);
    expect(await verifySession(stale, "secret")).toBeNull();
    expect(await verifySession(undefined, "secret")).toBeNull();
    expect(await verifySession("", "secret")).toBeNull();
  });
});

describe("auth routes in dev mode", () => {
  it("defaults to the dev identity", async () => {
    const response = await get("/api/auth/me");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mode: string; user: { login: string } };
    expect(body.mode).toBe("dev");
    expect(body.user.login).toBe("dev");
  });

  it("switches identity via cookie and clears it on logout", async () => {
    const cookie = await devLogin("alice");
    const asAlice = (await (await get("/api/auth/me", cookie)).json()) as { user: { login: string } };
    expect(asAlice.user.login).toBe("alice");

    const logout = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie") ?? "").toContain(`${SESSION_COOKIE}=;`);

    const after = (await (await get("/api/auth/me")).json()) as { user: { login: string } };
    expect(after.user.login).toBe("dev");
  });
});

describe("workspace membership enforcement", () => {
  it("bootstraps the first actor as owner", async () => {
    const w = workspaceApi();
    const configured = await w.put("/workspace", { mainRemote: "/tmp/x.git" });
    expect(configured.status).toBe(200);

    const members = await w.get("/members");
    expect(members.body.members).toEqual([
      expect.objectContaining({ userId: "dev", login: "dev", role: "owner" }),
    ]);
  });

  it("ignores client-forged identity headers", async () => {
    const w = workspaceApi();
    const created = await send("POST", `/api/workspaces/${w.name}/changesets`, {
      agent: "mallory",
      intent: "Forge identity",
    }, { headers: { "x-latch-user": JSON.stringify({ id: "evil", login: "mallory" }) } });
    expect(created.status).toBe(201);

    const members = await w.get("/members");
    expect(members.body.members).toEqual([
      expect.objectContaining({ userId: "dev", login: "dev" }),
    ]);
    expect(members.body.members.some((m: { login: string }) => m.login === "mallory")).toBe(false);
  });

  it("refuses non-members write, allows them after being added, still refuses owner actions", async () => {
    const w = workspaceApi();
    await w.put("/workspace", { mainRemote: "/tmp/x.git" }); // dev bootstraps owner
    const alice = await devLogin("alice");

    // Not a member yet → 403, and the denial lands in the event stream.
    const denied = await send("POST", `/api/workspaces/${w.name}/changesets`, {
      agent: "alice",
      intent: "Hello?",
    }, { cookie: alice });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("member_required");
    expect(await w.eventTypes()).toContain("auth.denied");

    // Owner adds alice with write role.
    const added = await w.put("/members", { userId: "dev:alice", login: "alice", role: "write" });
    expect(added.status).toBe(200);

    // Now writes work…
    const allowed = await send("POST", `/api/workspaces/${w.name}/changesets`, {
      agent: "alice",
      intent: "Real work",
    }, { cookie: alice });
    expect(allowed.status).toBe(201);

    // …but owner-level actions are still refused.
    const config = await send("PUT", `/api/workspaces/${w.name}/workspace`, {
      mainRemote: "/tmp/evil.git",
    }, { cookie: alice });
    expect(config.status).toBe(403);
    expect(((await config.json()) as { error: string }).error).toBe("owner_required");

    const memberEdit = await send("PUT", `/api/workspaces/${w.name}/members`, {
      userId: "dev:mallory",
      login: "mallory",
      role: "owner",
    }, { cookie: alice });
    expect(memberEdit.status).toBe(403);
  });

  it("protects the last owner from demotion and removes members cleanly", async () => {
    const w = workspaceApi();
    await w.put("/workspace", { mainRemote: "/tmp/x.git" });
    await w.put("/members", { userId: "dev:alice", login: "alice", role: "write" });

    const demote = await w.put("/members", { userId: "dev", login: "dev", role: "write" });
    expect(demote.status).toBe(409);

    const remove = await w.del("/members/dev:alice");
    expect(remove.status).toBe(200);
    expect(remove.body.members).toHaveLength(1);

    const removed = await w.del("/members/dev:alice");
    expect(removed.status).toBe(404);
  });

  it("keeps reads open to anonymous visitors", async () => {
    const w = workspaceApi();
    await w.createChangeset("agent-a", "Public work");
    const snapshot = await get(`/api/workspaces/${w.name}/`);
    expect(snapshot.status).toBe(200);
    const members = await get(`/api/workspaces/${w.name}/members`);
    expect(members.status).toBe(200);
  });
});

describe("authorization policy (github-mode matrix)", () => {
  it("refuses anonymous mutations but allows reads", () => {
    const base = { mode: "github" as const, actor: null, memberRole: null, memberCount: 0 };
    expect(authorize({ ...base, action: "read" })).toEqual({ allowed: true, bootstrapOwner: false });
    expect(authorize({ ...base, action: "write" })).toMatchObject({
      allowed: false,
      status: 401,
      code: "auth_required",
    });
    expect(authorize({ ...base, action: "owner" })).toMatchObject({ status: 401 });
  });

  it("bootstraps the first actor on an empty workspace", () => {
    const result = authorize({
      mode: "github",
      actor: { id: "gh:1", login: "ada" },
      action: "owner",
      memberRole: null,
      memberCount: 0,
    });
    expect(result).toEqual({ allowed: true, bootstrapOwner: true });
  });

  it("enforces membership and roles once the workspace has members", () => {
    const actor = { id: "gh:2", login: "grace" };
    expect(
      authorize({ mode: "github", actor, action: "write", memberRole: null, memberCount: 2 }),
    ).toMatchObject({ allowed: false, status: 403, code: "member_required" });
    expect(
      authorize({ mode: "github", actor, action: "write", memberRole: "read", memberCount: 2 }),
    ).toMatchObject({ allowed: false, status: 403, code: "write_required" });
    expect(
      authorize({ mode: "github", actor, action: "owner", memberRole: "write", memberCount: 2 }),
    ).toMatchObject({ allowed: false, status: 403, code: "owner_required" });
    expect(
      authorize({ mode: "github", actor, action: "write", memberRole: "write", memberCount: 2 }),
    ).toEqual({ allowed: true, bootstrapOwner: false });
    expect(
      authorize({ mode: "github", actor, action: "owner", memberRole: "owner", memberCount: 2 }),
    ).toEqual({ allowed: true, bootstrapOwner: false });
  });

  it("ranks roles", () => {
    expect(roleAtLeast("owner", "write")).toBe(true);
    expect(roleAtLeast("write", "owner")).toBe(false);
    expect(roleAtLeast("read", "read")).toBe(true);
    expect(DEV_ACTOR.login).toBe("dev");
  });
});
