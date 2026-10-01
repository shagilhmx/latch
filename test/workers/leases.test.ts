import { describe, expect, it } from "vitest";
import { backdateLeases, workspaceApi } from "./helpers";

describe("lease acquisition", () => {
  it("grants a lease and reports it in the snapshot", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Touch config loader");

    const acquire = await w.post(`/changesets/${cs}/leases`, { paths: ["src/config.ts"] });
    expect(acquire.status).toBe(200);
    expect(acquire.body.granted).toEqual(["src/config.ts"]);
    expect(acquire.body.expiresAt).toBeGreaterThan(Date.now());

    const { body } = await w.get("/");
    expect(body.leases).toHaveLength(1);
    expect(body.leases[0]).toMatchObject({
      path: "src/config.ts",
      changeset: cs,
      agent: "agent-a",
    });
    expect(body.stats.openLeases).toBe(1);
  });

  it("denies an overlapping claim and names the holder", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "Owns config");
    const b = await w.createChangeset("agent-b", "Wants config too");
    await w.post(`/changesets/${a}/leases`, { paths: ["src/config.ts"] });

    const denied = await w.post(`/changesets/${b}/leases`, { paths: ["src/config.ts"] });
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe("lease_conflict");
    expect(denied.body.conflicts).toEqual([
      expect.objectContaining({ path: "src/config.ts", changeset: a, agent: "agent-a" }),
    ]);
    expect(await w.eventTypes()).toContain("lease.denied");

    // B holds nothing at all.
    const { body } = await w.get("/");
    expect(body.leases.filter((lease: { changeset: string }) => lease.changeset === b)).toEqual([]);
  });

  it("is all-or-nothing across a multi-path claim", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "Holder");
    const b = await w.createChangeset("agent-b", "Claimer");
    await w.post(`/changesets/${a}/leases`, { paths: ["src/shared.ts"] });

    const denied = await w.post(`/changesets/${b}/leases`, {
      paths: ["src/shared.ts", "src/free.ts"],
    });
    expect(denied.status).toBe(409);

    const { body } = await w.get("/");
    const bLeases = body.leases.filter((lease: { changeset: string }) => lease.changeset === b);
    expect(bLeases).toEqual([]);
    expect(body.leases.some((lease: { path: string }) => lease.path === "src/free.ts")).toBe(false);
  });

  it("refreshes its own lease instead of self-conflicting", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Re-claim");
    const first = await w.post(`/changesets/${cs}/leases`, {
      paths: ["src/one.ts"],
      ttlSeconds: 60,
    });
    expect(first.status).toBe(200);

    const second = await w.post(`/changesets/${cs}/leases`, {
      paths: ["src/one.ts"],
      ttlSeconds: 600,
    });
    expect(second.status).toBe(200);
    expect(second.body.expiresAt).toBeGreaterThan(first.body.expiresAt);

    const { body } = await w.get("/");
    expect(body.leases).toHaveLength(1);
  });

  it("normalizes and de-duplicates requested paths", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Messy paths");
    const { status, body } = await w.post(`/changesets/${cs}/leases`, {
      paths: ["./src/a.ts", "src/a.ts", "/src/a.ts", "src\\b.ts"],
    });
    expect(status).toBe(200);
    expect(body.granted).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("rejects path traversal attempts", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Tricky");
    const { status, body } = await w.post(`/changesets/${cs}/leases`, {
      paths: ["../secrets.txt"],
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_path");
  });

  it("rejects claims on inactive changesets", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Done");
    const abort = await w.post(`/changesets/${cs}/abort`, {});
    expect(abort.status).toBe(200);
    expect(abort.body.changeset.status).toBe("aborted");

    const { status } = await w.post(`/changesets/${cs}/leases`, { paths: ["src/x.ts"] });
    expect(status).toBe(409);
  });
});

describe("lease release and expiry", () => {
  it("releases all leases so another changeset can claim them", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "Releaser");
    const b = await w.createChangeset("agent-b", "Waiter");
    await w.post(`/changesets/${a}/leases`, { paths: ["src/handoff.ts"] });

    const released = await w.del(`/changesets/${a}/leases`, {});
    expect(released.status).toBe(200);
    expect(released.body.released).toEqual(["src/handoff.ts"]);

    const acquired = await w.post(`/changesets/${b}/leases`, { paths: ["src/handoff.ts"] });
    expect(acquired.status).toBe(200);
  });

  it("releases only the named paths when a filter is given", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Partial release");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/x.ts", "src/y.ts"] });

    const released = await w.del(`/changesets/${cs}/leases`, { paths: ["src/x.ts"] });
    expect(released.body.released).toEqual(["src/x.ts"]);

    const { body } = await w.get("/");
    expect(body.leases.map((lease: { path: string }) => lease.path)).toEqual(["src/y.ts"]);
  });

  it("lazily expires stale leases so others can claim", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "Slowpoke");
    const b = await w.createChangeset("agent-b", "Fast mover");
    await w.post(`/changesets/${a}/leases`, { paths: ["src/stale.ts"], ttlSeconds: 60 });

    await backdateLeases(w.name, Date.now() - 1_000);

    const acquired = await w.post(`/changesets/${b}/leases`, { paths: ["src/stale.ts"] });
    expect(acquired.status).toBe(200);
    expect(await w.eventTypes()).toContain("lease.expired");

    const { body } = await w.get("/");
    expect(body.leases).toHaveLength(1);
    expect(body.leases[0].changeset).toBe(b);
  });

  it("extends lease deadlines on heartbeat", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Heartbeater");
    const initial = await w.post(`/changesets/${cs}/leases`, {
      paths: ["src/live.ts"],
      ttlSeconds: 60,
    });

    const beat = await w.post(`/changesets/${cs}/heartbeat`, { ttlSeconds: 600 });
    expect(beat.status).toBe(200);
    expect(beat.body.extended).toEqual(["src/live.ts"]);
    expect(beat.body.expiresAt).toBeGreaterThan(initial.body.expiresAt);
    expect(await w.eventTypes()).toContain("lease.heartbeat");
  });

  it("404s heartbeat when the changeset holds nothing", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Empty handed");
    const { status } = await w.post(`/changesets/${cs}/heartbeat`, {});
    expect(status).toBe(404);
  });
});
