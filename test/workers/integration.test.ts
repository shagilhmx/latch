import { describe, expect, it } from "vitest";
import { workspaceApi, type WorkspaceApi } from "./helpers";

async function ready(
  w: WorkspaceApi,
  changeset: string,
  ref: string,
  touchedPaths: string[],
): Promise<{ status: number; body: any }> {
  return w.post(`/changesets/${changeset}/ready`, { ref, touchedPaths });
}

function claim(w: WorkspaceApi): Promise<{ status: number; body: any }> {
  return w.get("/integration/next");
}

describe("readying a changeset", () => {
  it("rejects touched paths the changeset does not lease", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Lying agent");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/owned.ts"] });

    const result = await ready(w, cs, "abc123", ["src/owned.ts", "src/not-owned.ts"]);
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("lease_violation");
    expect(result.body.violations).toEqual(["src/not-owned.ts"]);
    expect(await w.eventTypes()).toContain("changeset.blocked");

    // Nothing was queued.
    const { body } = await w.get("/");
    expect(body.jobs).toEqual([]);
    expect(body.changesets[0].status).toBe("open");
  });

  it("queues a valid changeset and claims it", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Legit work");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/ok.ts"] });

    const result = await ready(w, cs, "deadbeef", ["src/ok.ts"]);
    expect(result.status).toBe(202);
    expect(result.body.job).toMatchObject({ changeset: cs, ref: "deadbeef", status: "pending" });
    expect(result.body.changeset.status).toBe("queued");

    const claimed = await claim(w);
    expect(claimed.status).toBe(200);
    expect(claimed.body.job).toMatchObject({
      changeset: cs,
      ref: "deadbeef",
      status: "running",
      agent: "agent-a",
      intent: "Legit work",
      workspace: w.name,
    });
    expect(await w.eventTypes()).toContain("integration.claimed");
  });

  it("refuses a second active job for the same changeset", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Double submit");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/d.ts"] });
    await ready(w, cs, "ref1", ["src/d.ts"]);

    const again = await ready(w, cs, "ref2", ["src/d.ts"]);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_queued");
  });
});

describe("integration serialization (single writer for main)", () => {
  it("claims one job at a time and resumes the queue after results", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "First in line");
    const b = await w.createChangeset("agent-b", "Second in line");
    await w.post(`/changesets/${a}/leases`, { paths: ["src/a.ts"] });
    await w.post(`/changesets/${b}/leases`, { paths: ["src/b.ts"] });
    expect((await ready(w, a, "sha-a", ["src/a.ts"])).status).toBe(202);
    expect((await ready(w, b, "sha-b", ["src/b.ts"])).status).toBe(202);

    const first = await claim(w);
    expect(first.status).toBe(200);
    expect(first.body.job.changeset).toBe(a);

    // A job is already running — nobody else may claim.
    const blocked = await claim(w);
    expect(blocked.status).toBe(204);

    const report = await w.post(`/integration/${first.body.job.seq}/result`, {
      status: "merged",
      mergedSha: "merge-1",
    });
    expect(report.status).toBe(200);

    const second = await claim(w);
    expect(second.status).toBe(200);
    expect(second.body.job.changeset).toBe(b);

    // Queue drained.
    const drained = await claim(w);
    expect(drained.status).toBe(204);
  });

  it("204s when there is nothing to do", async () => {
    const w = workspaceApi();
    const { status } = await claim(w);
    expect(status).toBe(204);
  });
});

describe("lease verification by the trusted runner", () => {
  it("accepts paths derived from git that are all leased", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Honest diff");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/honest.ts"] });
    await ready(w, cs, "sha-h", ["src/honest.ts"]);
    const claimed = await claim(w);
    expect(claimed.status).toBe(200);

    const verify = await w.post(`/integration/${claimed.body.job.seq}/verify`, {
      paths: ["src/honest.ts"],
    });
    expect(verify.status).toBe(200);
    expect(verify.body.ok).toBe(true);
    expect(await w.eventTypes()).toContain("integration.verified");
  });

  it("rejects the job when the agent pushed outside its leases", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Sneaky diff");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/sneaky.ts"] });
    await ready(w, cs, "sha-s", ["src/sneaky.ts"]);
    const claimed = await claim(w);
    expect(claimed.status).toBe(200);

    const verify = await w.post(`/integration/${claimed.body.job.seq}/verify`, {
      paths: ["src/sneaky.ts", "src/untouched-by-lease.ts"],
    });
    expect(verify.status).toBe(409);
    expect(verify.body.violations).toEqual(["src/untouched-by-lease.ts"]);

    // Job and changeset rejected in the same turn; agent keeps its own leases.
    const { body } = await w.get("/");
    expect(body.jobs[0]).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("lease violation"),
    });
    expect(body.changesets[0].status).toBe("rejected");
    expect(body.leases.map((lease: { path: string }) => lease.path)).toEqual(["src/sneaky.ts"]);
    expect(await w.eventTypes()).toContain("integration.rejected");
  });

  it("refuses verify on a job that is not running", async () => {
    const w = workspaceApi();
    const { status } = await w.post("/integration/9999/verify", { paths: ["src/x.ts"] });
    expect(status).toBe(404);
  });
});

describe("integration results", () => {
  it("merged: releases leases, records the sha, closes the changeset", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Lands cleanly");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/land.ts"] });
    await ready(w, cs, "sha-l", ["src/land.ts"]);
    const claimed = await claim(w);

    const result = await w.post(`/integration/${claimed.body.job.seq}/result`, {
      status: "merged",
      mergedSha: "merged-sha-1",
    });
    expect(result.status).toBe(200);
    expect(result.body.job).toMatchObject({ status: "merged", mergedSha: "merged-sha-1" });

    const { body } = await w.get("/");
    expect(body.changesets[0].status).toBe("merged");
    expect(body.leases).toEqual([]);
    expect(body.stats.openLeases).toBe(0);
    expect(await w.eventTypes()).toContain("integration.merged");

    // The path is immediately claimable by the next agent.
    const next = await w.createChangeset("agent-b", "Follow-up");
    const reclaim = await w.post(`/changesets/${next}/leases`, { paths: ["src/land.ts"] });
    expect(reclaim.status).toBe(200);
  });

  it("rejected: keeps leases so the agent can resolve within its scope", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Merge conflict");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/conflict.ts"] });
    await ready(w, cs, "sha-c", ["src/conflict.ts"]);
    const claimed = await claim(w);

    const result = await w.post(`/integration/${claimed.body.job.seq}/result`, {
      status: "rejected",
      reason: "merge conflict with main",
    });
    expect(result.status).toBe(200);

    const { body } = await w.get("/");
    expect(body.changesets[0].status).toBe("rejected");
    expect(body.leases.map((lease: { path: string }) => lease.path)).toEqual(["src/conflict.ts"]);

    // Rejected changesets stay active: fix, re-ready, re-queue.
    const reReady = await ready(w, cs, "sha-c-2", ["src/conflict.ts"]);
    expect(reReady.status).toBe(202);

    const reclaim = await claim(w);
    expect(reclaim.status).toBe(200);
    expect(reclaim.body.job.changeset).toBe(cs);
  });

  it("refuses results for jobs that are not running", async () => {
    const w = workspaceApi();
    const { status } = await w.post("/integration/9999/result", { status: "merged" });
    expect(status).toBe(404);
  });
});

describe("session fork attachment and push events", () => {
  it("records the fork on the changeset", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Forked session");
    const { status, body } = await w.post(`/changesets/${cs}/fork`, {
      forkRepo: "ws-demo.cs.abcd1234",
      forkRemote: "https://artifacts.example/fork.git",
    });
    expect(status).toBe(200);
    expect(body.changeset).toMatchObject({
      forkRepo: "ws-demo.cs.abcd1234",
      forkRemote: "https://artifacts.example/fork.git",
    });
    expect(await w.eventTypes()).toContain("session.forked");
  });

  it("enqueues on internal/pushed using held leases as the advisory set", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Agent pushed");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/auto.ts"] });
    await w.post(`/changesets/${cs}/fork`, {
      forkRepo: "ws-auto.cs.aaaaaaaa",
      forkRemote: "https://artifacts.example/auto.git",
    });

    const first = await w.post("/internal/pushed", {
      repoName: "ws-auto.cs.aaaaaaaa",
      ref: "f00dface00000000000000000000000000000000",
    });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ queued: true });
    expect(first.body.job).toMatchObject({ changeset: cs, status: "pending" });

    const second = await w.post("/internal/pushed", {
      repoName: "ws-auto.cs.aaaaaaaa",
      ref: "f00dface00000000000000000000000000000001",
    });
    expect(second.body).toMatchObject({ queued: false, reason: "already_queued" });

    const { body } = await w.get("/");
    expect(body.jobs).toHaveLength(1);
    expect(body.changesets[0].status).toBe("queued");
  });

  it("reports unknown and inactive repos without queueing", async () => {
    const w = workspaceApi();
    const unknown = await w.post("/internal/pushed", {
      repoName: "ws-x.cs.ffffffff",
      ref: "a".repeat(40),
    });
    expect(unknown.body).toMatchObject({ queued: false, reason: "no_matching_changeset" });

    const cs = await w.createChangeset("agent-a", "Already merged");
    await w.post(`/changesets/${cs}/fork`, {
      forkRepo: "ws-y.cs.bbbbbbbb",
      forkRemote: "https://artifacts.example/y.git",
    });
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/m.ts"] });
    await w.post(`/changesets/${cs}/ready`, { ref: "b".repeat(40), touchedPaths: ["src/m.ts"] });
    const claimed = await w.get("/integration/next");
    await w.post(`/integration/${claimed.body.job.seq}/result`, {
      status: "merged",
      mergedSha: "c".repeat(40),
    });

    const inactive = await w.post("/internal/pushed", {
      repoName: "ws-y.cs.bbbbbbbb",
      ref: "d".repeat(40),
    });
    expect(inactive.body).toMatchObject({
      queued: false,
      reason: "changeset_merged",
    });
  });
});
