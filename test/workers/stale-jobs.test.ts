import { describe, expect, it } from "vitest";
import { JOB_TIMEOUT_MS, MAX_JOB_ATTEMPTS } from "../../src/worker/coordinator-jobs.ts";
import { backdateRunningJob, workspaceApi, type WorkspaceApi } from "./helpers";

/**
 * Stale-job recovery: a runner that dies mid-job must not wedge the
 * integration queue. Past JOB_TIMEOUT_MS the job is requeued for the next
 * poller; after MAX_JOB_ATTEMPTS claims it is rejected back to the agent.
 */

async function queuedChangeset(w: WorkspaceApi, path: string): Promise<string> {
  const cs = await w.createChangeset("agent-a", "Work in progress");
  await w.post(`/changesets/${cs}/leases`, { paths: [path] });
  const ready = await w.post(`/changesets/${cs}/ready`, { ref: "sha-1", touchedPaths: [path] });
  expect(ready.status).toBe(202);
  return cs;
}

async function claim(w: WorkspaceApi): Promise<{ status: number; body: any }> {
  return w.get("/integration/next");
}

/** Age the running job past JOB_TIMEOUT_MS. */
async function ageRunningJob(w: WorkspaceApi): Promise<void> {
  await backdateRunningJob(w.name, Date.now() - JOB_TIMEOUT_MS - 1_000);
}

describe("stale job recovery", () => {
  it("keeps a fresh running job claimed (no premature requeue)", async () => {
    const w = workspaceApi();
    await queuedChangeset(w, "src/fresh.ts");

    const first = await claim(w);
    expect(first.status).toBe(200);
    expect(first.body.job.attempt).toBe(1);

    const again = await claim(w);
    expect(again.status).toBe(204);
    expect(await w.eventTypes()).not.toContain("integration.requeued");
  });

  it("requeues a job whose runner went silent and re-claims it", async () => {
    const w = workspaceApi();
    const cs = await queuedChangeset(w, "src/stale.ts");
    const first = await claim(w);
    expect(first.status).toBe(200);

    await ageRunningJob(w);

    const reclaimed = await claim(w);
    expect(reclaimed.status).toBe(200);
    expect(reclaimed.body.job.seq).toBe(first.body.job.seq);
    expect(reclaimed.body.job.changeset).toBe(cs);
    expect(reclaimed.body.job.attempt).toBe(2);
    expect(await w.eventTypes()).toContain("integration.requeued");

    // The job is running again — nobody else may claim it.
    expect((await claim(w)).status).toBe(204);
  });

  it("rejects the job after MAX_JOB_ATTEMPTS stale claims, keeping leases", async () => {
    const w = workspaceApi();
    const cs = await queuedChangeset(w, "src/doomed.ts");

    // Claim + stale-requeue until the attempt cap is reached.
    const attempts: number[] = [];
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i += 1) {
      const claimed = await claim(w);
      expect(claimed.status).toBe(200);
      attempts.push(claimed.body.job.attempt);
      await ageRunningJob(w);
    }
    expect(attempts).toEqual([1, 2, 3]);

    // Next poll: the third attempt is stale too, so the job is given up on.
    const final = await claim(w);
    expect(final.status).toBe(204);

    const { body } = await w.get("/");
    const job = body.jobs.find((j: { changeset: string }) => j.changeset === cs);
    expect(job.status).toBe("rejected");
    expect(job.reason).toMatch(/timed out after 3 attempts/);

    const changeset = body.changesets.find((c: { id: string }) => c.id === cs);
    expect(changeset.status).toBe("rejected");

    // Rejection semantics: the agent keeps its leases to retry in scope.
    expect(body.leases.map((l: { changeset: string }) => l.changeset)).toEqual([cs]);
    expect(await w.eventTypes()).toContain("integration.rejected");
  });

  it("refuses verify/result reports issued from a previous claim", async () => {
    const w = workspaceApi();
    const cs = await queuedChangeset(w, "src/race.ts");
    const first = await claim(w);
    expect(first.status).toBe(200);
    expect(first.body.job.changeset).toBe(cs);
    expect(first.body.job.attempt).toBe(1);

    await ageRunningJob(w);
    const second = await claim(w);
    expect(second.status).toBe(200);
    expect(second.body.job.attempt).toBe(2);

    // The zombie runner reports against its original claim.
    const staleVerify = await w.post(`/integration/${first.body.job.seq}/verify`, {
      paths: ["src/race.ts"],
      attempt: 1,
    });
    expect(staleVerify.status).toBe(409);
    expect(staleVerify.body.error).toBe("stale_attempt");

    const staleReport = await w.post(`/integration/${first.body.job.seq}/result`, {
      status: "merged",
      mergedSha: "zombie",
      attempt: 1,
    });
    expect(staleReport.status).toBe(409);
    expect(staleReport.body.error).toBe("stale_attempt");

    // The current claim's report is accepted.
    const currentVerify = await w.post(`/integration/${second.body.job.seq}/verify`, {
      paths: ["src/race.ts"],
      attempt: 2,
    });
    expect(currentVerify.status).toBe(200);
    expect(currentVerify.body.ok).toBe(true);
  });
});
