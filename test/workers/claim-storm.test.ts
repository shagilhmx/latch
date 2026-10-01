import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { leasesOverlap } from "../../src/shared/paths.ts";
import { workspaceApi } from "./helpers";

/**
 * Stress properties: bursts of agents hammering the lease table and the
 * integration queue, with randomized operation orders (fast-check seeds make
 * every failure reproducible).
 *
 * The headline invariant is the single-writer guarantee: no matter how
 * claims, reports, and observations interleave, at most one job is ever
 * `running`, and the storm ends with every job merged and every lease gone.
 */

describe("claim storm (shared lease table)", () => {
  const AGENTS = 6;
  const PATHS = ["src/", "src/a.ts", "src/b.ts", "lib/", "lib/x.ts", "README.md", "docs/"];

  it("never grants overlapping scope to a burst of competing agents", async () => {
    const w = workspaceApi();
    const ids: string[] = [];
    for (let i = 0; i < AGENTS; i += 1) {
      ids.push(await w.createChangeset(`agent-${i}`, `burst ${i}`));
    }

    // 40 randomized claims across the pool (mix of file and directory paths).
    const program = fc.sample(
      fc.array(
        fc.record({
          who: fc.nat({ max: AGENTS - 1 }),
          paths: fc.uniqueArray(fc.constantFrom(...PATHS), { minLength: 1, maxLength: 2 }),
        }),
        { minLength: 40, maxLength: 40 },
      ),
      { seed: 20261002, numRuns: 1 },
    )[0];
    expect(program).toBeDefined();

    let granted = 0;
    let refused = 0;
    for (const op of program ?? []) {
      const changeset = ids[op.who];
      if (changeset === undefined) continue;
      const response = await w.post<any>(`/changesets/${changeset}/leases`, {
        paths: op.paths,
        ttlSeconds: 60,
      });

      if (response.status === 200) {
        granted += 1;
        expect(response.body.granted).toEqual([...op.paths].sort());
      } else {
        refused += 1;
        // Every denial names at least one live conflicting holder.
        expect(response.status).toBe(409);
        expect(response.body.conflicts.length).toBeGreaterThan(0);
      }

      // The invariant re-checked after every single claim in the storm.
      const snapshot = await w.get<{ leases: Array<{ path: string; changeset: string }> }>("/");
      const leases = snapshot.body.leases;
      for (let i = 0; i < leases.length; i += 1) {
        for (let j = i + 1; j < leases.length; j += 1) {
          const a = leases[i];
          const b = leases[j];
          if (a === undefined || b === undefined || a.changeset === b.changeset) continue;
          expect(leasesOverlap(a.path, b.path)).toBe(false);
        }
      }
    }

    // The storm actually exercised both outcomes, and the table holds a
    // coherent set of claims.
    expect(granted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);

    // Full recovery: releasing everything frees the whole pool again.
    for (const changeset of ids) {
      await w.del(`/changesets/${changeset}/leases`, {});
    }
    const drained = await w.get<{ leases: unknown[] }>("/");
    expect(drained.body.leases).toEqual([]);
    const reclaim = await w.post<any>(`/changesets/${ids[0]}/leases`, {
      paths: ["src/", "README.md"],
      ttlSeconds: 60,
    });
    expect(reclaim.status).toBe(200);
  }, 120_000);
});

describe("queue storm (single writer for main)", () => {
  const JOBS = 4;

  it("holds the single-writer guarantee across randomized claim/report orders", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("claim" as const, "report" as const, "observe" as const), {
          minLength: 12,
          maxLength: 30,
        }),
        async (ops) => {
          const w = workspaceApi();

          // Four changesets, each with its own scope, all ready to integrate.
          for (let i = 0; i < JOBS; i += 1) {
            const changeset = await w.createChangeset(`bot-${i}`, `burst ${i}`);
            await w.post(`/changesets/${changeset}/leases`, { paths: [`src/burst-${i}.ts`] });
            const ready = await w.post(`/changesets/${changeset}/ready`, {
              ref: `sha-${i}`,
              touchedPaths: [`src/burst-${i}.ts`],
            });
            expect(ready.status).toBe(202);
          }

          let current: { seq: number; attempt: number } | null = null;

          for (const op of ops) {
            if (op === "claim") {
              const response = await w.get<any>("/integration/next");
              if (current === null) {
                if (response.status === 200) {
                  current = { seq: response.body.job.seq, attempt: response.body.job.attempt };
                  expect(response.body.job.attempt).toBeGreaterThanOrEqual(1);
                } else {
                  expect(response.status).toBe(204);
                }
              } else {
                // A job is already running — the queue must refuse.
                expect(response.status).toBe(204);
              }
            } else if (op === "report" && current !== null) {
              const response = await w.post<any>(`/integration/${current.seq}/result`, {
                status: "merged",
                mergedSha: `sha-${current.seq}`,
                attempt: current.attempt,
              });
              expect(response.status).toBe(200);
              current = null;
            } else {
              // Observation: never more than one running job, ever.
              const snapshot = await w.get<{ jobs: Array<{ status: string }> }>("/");
              const running = snapshot.body.jobs.filter((job) => job.status === "running");
              expect(running.length).toBeLessThanOrEqual(1);
            }
          }

          // Drain whatever is left: the storm always reaches quiescence.
          // First settle the in-flight claim (an all-"claim" program never
          // reported it), then work the queue to empty.
          if (current !== null) {
            const settled = await w.post(`/integration/${current.seq}/result`, {
              status: "merged",
              mergedSha: `sha-${current.seq}`,
              attempt: current.attempt,
            });
            expect(settled.status).toBe(200);
            current = null;
          }
          for (;;) {
            const claim = await w.get<any>("/integration/next");
            if (claim.status !== 200) break;
            const job = claim.body.job as { seq: number; attempt: number };
            const report = await w.post(`/integration/${job.seq}/result`, {
              status: "merged",
              mergedSha: `sha-${job.seq}`,
              attempt: job.attempt,
            });
            expect(report.status).toBe(200);
          }

          // Terminal invariants: everything merged, nothing running, and
          // merged jobs released every lease they held.
          const final = await w.get<{
            jobs: Array<{ status: string }>;
            leases: unknown[];
            stats: { runningJobs: number; pendingJobs: number };
          }>("/");
          expect(final.body.jobs).toHaveLength(JOBS);
          expect(final.body.jobs.every((job) => job.status === "merged")).toBe(true);
          expect(final.body.stats.runningJobs).toBe(0);
          expect(final.body.stats.pendingJobs).toBe(0);
          expect(final.body.leases).toEqual([]);
        },
      ),
      { numRuns: 5 },
    );
  }, 180_000);
});
