import type { ClaimedJob } from "../shared/types.ts";
import { bearer, git } from "./git.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunnerOptions {
  /** Coordinator origin, e.g. http://127.0.0.1:8787 */
  baseUrl: string;
  /** Workspace whose integration queue this runner drains. */
  workspace: string;
  /** Artifacts write token for the workspace (main) repo, if remote. */
  workspaceToken?: string | null;
  /** Keep the scratch clone around for debugging. */
  keepWorkdir?: boolean;
}

export type RunOutcome =
  | { status: "idle" }
  | { status: "merged"; seq: number; sha: string; paths: string[] }
  | { status: "rejected"; seq: number; reason: string };

async function call(
  options: RunnerOptions,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const origin = options.baseUrl.replace(/\/$/, "");
  return fetch(
    `${origin}/api/workspaces/${encodeURIComponent(options.workspace)}${path}`,
    init,
  );
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function buildMergeMessage(job: ClaimedJob, paths: string[]): string {
  const shortId = job.changeset.slice(0, 8);
  return [
    `Merge ${shortId} from ${job.agent}: ${job.intent}`,
    "",
    `Latch-Changeset: ${job.changeset}`,
    `Latch-Agent: ${job.agent}`,
    `Latch-Ref: ${job.ref}`,
    `Intent: ${job.intent}`,
    `Lease-Paths: ${paths.join(", ")}`,
  ].join("\n");
}

/**
 * Claim one job and integrate it:
 *   1. clone main, fetch the session fork
 *   2. derive changed paths from git itself (merge-base..session)
 *   3. POST /integration/:seq/verify — the Coordinator rejects jobs whose
 *      paths escape the changeset's leases
 *   4. merge --no-ff with Latch trailers, push to main
 *   5. POST /integration/:seq/result (merged | rejected)
 *
 * The Coordinator only ever has one `running` job per workspace, so `main`
 * has a single writer by construction.
 */
export async function runOnce(options: RunnerOptions): Promise<RunOutcome> {
  const claim = await call(options, "/integration/next");
  if (claim.status === 204) return { status: "idle" };
  if (!claim.ok) {
    throw new Error(`claim failed: ${claim.status} ${await claim.text()}`);
  }
  const { job } = (await claim.json()) as { job: ClaimedJob };
  return integrate(job, options);
}

async function report(
  job: ClaimedJob,
  options: RunnerOptions,
  result: { status: "merged"; mergedSha: string } | { status: "rejected"; reason: string },
): Promise<void> {
  const response = await call(
    options,
    `/integration/${job.seq}/result`,
    post(result),
  );
  if (!response.ok) {
    throw new Error(`result report failed: ${response.status} ${await response.text()}`);
  }
}

async function integrate(job: ClaimedJob, options: RunnerOptions): Promise<RunOutcome> {
  if (job.mainRemote === null || job.forkRemote === null) {
    const reason = "workspace or session remote missing (run setup, or seed local remotes)";
    await report(job, options, { status: "rejected", reason });
    return { status: "rejected", seq: job.seq, reason };
  }

  const workdir = await mkdtemp(join(tmpdir(), "latch-"));
  const repo = join(workdir, "repo");

  try {
    // 1. Clone main (the workspace repo).
    await git(["clone", "--quiet", job.mainRemote, repo], {
      authHeader: bearer(options.workspaceToken),
    });

    // 2. Fetch the session fork's tip. Session runners push to the fork's
    //    default branch, so HEAD is the changeset's commit.
    await git(["fetch", "--quiet", job.forkRemote, "HEAD"], {
      cwd: repo,
      authHeader: bearer(job.forkToken),
    });

    // 3. Derive what the agent actually changed — trusted, git-side.
    const base = await git(["merge-base", "HEAD", "FETCH_HEAD"], { cwd: repo });
    const changed = (
      await git(["diff", "--name-only", base, "FETCH_HEAD"], { cwd: repo })
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (changed.length === 0) {
      const ancestor = await git(
        ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"],
        { cwd: repo },
      ).then(
        () => true,
        () => false,
      );
      if (ancestor) {
        // Session tip already in main (double delivery) — treat as merged.
        const sha = await git(["rev-parse", "HEAD"], { cwd: repo });
        await report(job, options, { status: "merged", mergedSha: sha });
        return { status: "merged", seq: job.seq, sha, paths: [] };
      }
      const reason = "session ref has no file changes";
      await report(job, options, { status: "rejected", reason });
      return { status: "rejected", seq: job.seq, reason };
    }

    // 4. Authoritative lease verification (rejects the job server-side on 409).
    const verify = await call(
      options,
      `/integration/${job.seq}/verify`,
      post({ paths: changed }),
    );
    if (verify.status === 409) {
      const body = (await verify.json()) as { message?: string };
      const reason = body.message ?? "lease violation";
      return { status: "rejected", seq: job.seq, reason };
    }
    if (!verify.ok) {
      throw new Error(`verify failed: ${verify.status} ${await verify.text()}`);
    }

    // 5. Merge with provenance trailers.
    try {
      await git(
        ["merge", "--quiet", "--no-ff", "FETCH_HEAD", "-m", buildMergeMessage(job, changed)],
        { cwd: repo },
      );
    } catch {
      const conflicts = (
        await git(["diff", "--name-only", "--diff-filter=U"], { cwd: repo }).catch(() => "")
      )
        .split("\n")
        .filter((line) => line.length > 0);
      await git(["merge", "--abort"], { cwd: repo }).catch(() => undefined);
      const reason = `merge conflict: ${conflicts.join(", ") || "unknown files"}`;
      await report(job, options, { status: "rejected", reason });
      return { status: "rejected", seq: job.seq, reason };
    }

    // 6. Push main, then confirm.
    await git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], {
      cwd: repo,
      authHeader: bearer(options.workspaceToken),
    });
    const sha = await git(["rev-parse", "HEAD"], { cwd: repo });

    await report(job, options, { status: "merged", mergedSha: sha });
    return { status: "merged", seq: job.seq, sha, paths: changed };
  } catch (error) {
    const reason = `runner error: ${(error as Error).message}`;
    await report(job, options, { status: "rejected", reason }).catch(() => undefined);
    return { status: "rejected", seq: job.seq, reason };
  } finally {
    if (options.keepWorkdir !== true) {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}
