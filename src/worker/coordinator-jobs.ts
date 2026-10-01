/**
 * Integration queue: readiness (markReady/enqueue), the push-event consumer,
 * and the runner-facing job lifecycle (claim → verify → result).
 *
 * The single-writer guarantee lives here: claimNextJob performs no awaits
 * between its statements and a Durable Object handles one request at a
 * time, so at most one job is ever `running` — the serialization point for
 * every writer of `main`.
 */
import { normalizePaths } from "../shared/paths";
import type { ClaimedJob } from "../shared/types";
import { HttpProblem, json, readBody, requireString, requireStringArray } from "./http";
import { ACTIVE_STATUSES, toJob, type ChangesetRow, type JobRow } from "./coordinator-types";
import type { CoordinatorStore } from "./coordinator-store";

export function markReady(
  store: CoordinatorStore,
  request: Request,
  changesetId: string,
): Promise<Response> {
  return (async () => {
    const body = await readBody(request);
    const changeset = store.requireChangeset(changesetId);

    const activeJob = store.sql<{ seq: number }>(
      "SELECT seq FROM jobs WHERE changeset = ? AND status IN ('pending', 'running') LIMIT 1",
      changesetId,
    );
    if (activeJob.length > 0) {
      throw new HttpProblem(
        409,
        "already_queued",
        `Changeset ${changesetId} already has an active job`,
      );
    }

    if (!ACTIVE_STATUSES.has(changeset.status)) {
      throw new HttpProblem(
        409,
        "changeset_not_active",
        `Changeset is ${changeset.status}; only open or rejected changesets can become ready`,
      );
    }

    const ref = requireString(body, "ref");
    let touched: string[];
    try {
      touched = normalizePaths(requireStringArray(body, "touchedPaths"));
    } catch (error) {
      throw new HttpProblem(400, "invalid_path", (error as Error).message);
    }

    // Early advisory check against claimed leases. The authoritative check
    // runs again in verifyJob() against paths derived from git itself.
    const job = enqueueJob(store, changeset.id, ref, touched, "ready");
    return json({ job: toJob(job), changeset: store.requireChangeset(changesetId) }, 202);
  })();
}

/**
 * Shared enqueue core for the ready endpoint and the push-event consumer.
 * The advisory lease check runs only when `paths` is provided; event-driven
 * pushes fall through to the runner's authoritative verify instead.
 */
export function enqueueJob(
  store: CoordinatorStore,
  changesetId: string,
  ref: string,
  paths: string[] | null,
  via: string,
): JobRow {
  if (paths !== null) {
    const violations = paths.filter((path) => {
      const rows = store.sql<{ changeset: string }>(
        "SELECT changeset FROM leases WHERE path = ?",
        path,
      );
      return rows[0]?.changeset !== changesetId;
    });
    if (violations.length > 0) {
      store.emit("changeset.blocked", { changeset: changesetId, violations });
      throw new HttpProblem(
        409,
        "lease_violation",
        `Not leased by this changeset: ${violations.join(", ")}`,
        { violations },
      );
    }
  }

  const now = Date.now();
  store.exec(
    "UPDATE changesets SET status = 'queued', ref = ?, updated_at = ? WHERE id = ?",
    ref,
    now,
    changesetId,
  );
  store.exec(
    "INSERT INTO jobs (changeset, ref, status, enqueued_at) VALUES (?, ?, 'pending', ?)",
    changesetId,
    ref,
    now,
  );
  store.emit("changeset.ready", { changeset: changesetId, ref, paths, via });

  const job = store.sql<JobRow>(
    "SELECT * FROM jobs WHERE changeset = ? ORDER BY seq DESC LIMIT 1",
    changesetId,
  )[0];
  if (job === undefined) {
    throw new HttpProblem(500, "internal", "Job insert did not persist");
  }
  return job;
}

/**
 * Called by the queue consumer when an agent pushes to its session fork:
 * enqueues integration automatically, using the changeset's held leases as
 * the advisory path set (the runner's verify stays authoritative).
 */
export function pushedByEvent(store: CoordinatorStore, request: Request): Promise<Response> {
  return (async () => {
    const body = await readBody(request);
    const repoName = requireString(body, "repoName");
    const ref = requireString(body, "ref");

    const rows = store.sql<ChangesetRow>(
      "SELECT * FROM changesets WHERE fork_repo = ? ORDER BY created_at DESC LIMIT 1",
      repoName,
    );
    const changeset = rows[0];
    if (changeset === undefined) {
      return json({ queued: false, reason: "no_matching_changeset" }, 202);
    }
    const activeJob = store.sql<{ seq: number }>(
      "SELECT seq FROM jobs WHERE changeset = ? AND status IN ('pending', 'running') LIMIT 1",
      changeset.id,
    );
    if (activeJob.length > 0) {
      return json({ queued: false, reason: "already_queued" }, 202);
    }
    if (!ACTIVE_STATUSES.has(changeset.status)) {
      return json({ queued: false, reason: `changeset_${changeset.status}` }, 202);
    }

    const held = store
      .sql<{ path: string }>("SELECT path FROM leases WHERE changeset = ? ORDER BY path ASC", changeset.id)
      .map((row) => row.path);

    const job = enqueueJob(store, changeset.id, ref, held.length > 0 ? held : null, "push");
    return json({ queued: true, job: toJob(job) }, 202);
  })();
}

/**
 * Claim the next integration job. The Durable Object processes requests one
 * at a time and this method performs no awaits between its statements, so at
 * most one job can ever be `running` — this is the single-writer guarantee
 * for `main`.
 */
export function claimNextJob(store: CoordinatorStore): Promise<Response> {
  return (async () => {
    const running = store.sql<{ seq: number }>(
      "SELECT seq FROM jobs WHERE status = 'running' LIMIT 1",
    );
    if (running.length > 0) return new Response(null, { status: 204 });

    const next = store.sql<JobRow>(
      "SELECT * FROM jobs WHERE status = 'pending' ORDER BY seq ASC LIMIT 1",
    )[0];
    if (next === undefined) return new Response(null, { status: 204 });

    const now = Date.now();
    store.exec("UPDATE jobs SET status = 'running', started_at = ? WHERE seq = ?", now, next.seq);
    store.exec(
      "UPDATE changesets SET status = 'integrating', updated_at = ? WHERE id = ?",
      now,
      next.changeset,
    );
    store.emit("integration.claimed", { job: next.seq, changeset: next.changeset, ref: next.ref });

    const changeset = store.getChangesetRow(next.changeset);
    const config = store.config();
    const claimed: ClaimedJob = {
      ...toJob({ ...next, status: "running", started_at: now }),
      workspace: store.workspaceName(),
      mainRemote: config.mainRemote,
      forkRemote: changeset.fork_remote,
      forkToken: changeset.fork_token,
      agent: changeset.agent,
      intent: changeset.intent,
    };
    return json({ job: claimed });
  })();
}

/**
 * Authoritative lease verification, run by the trusted integration runner
 * with paths it derived from `git diff` itself — an agent cannot under-
 * report what it changed. On success the job stays running; on failure the
 * job and changeset are rejected in the same turn.
 */
export function verifyJob(
  store: CoordinatorStore,
  request: Request,
  seq: number,
): Promise<Response> {
  return (async () => {
    const body = await readBody(request);
    const job = store.requireJob(seq, "running");
    let paths: string[];
    try {
      paths = normalizePaths(requireStringArray(body, "paths"));
    } catch (error) {
      throw new HttpProblem(400, "invalid_path", (error as Error).message);
    }

    const violations = paths.filter((path) => {
      const rows = store.sql<{ changeset: string }>(
        "SELECT changeset FROM leases WHERE path = ?",
        path,
      );
      return rows[0]?.changeset !== job.changeset;
    });

    if (violations.length > 0) {
      const now = Date.now();
      store.exec(
        "UPDATE jobs SET status = 'rejected', reason = ?, finished_at = ? WHERE seq = ?",
        `lease violation: ${violations.join(", ")}`,
        now,
        seq,
      );
      store.exec(
        "UPDATE changesets SET status = 'rejected', updated_at = ? WHERE id = ?",
        now,
        job.changeset,
      );
      store.emit("integration.rejected", {
        job: seq,
        changeset: job.changeset,
        reason: "lease_violation",
        violations,
      });
      throw new HttpProblem(
        409,
        "lease_violation",
        `Agent pushed paths outside its leases: ${violations.join(", ")}`,
        { violations },
      );
    }

    store.emit("integration.verified", { job: seq, changeset: job.changeset, paths });
    return json({ ok: true, paths });
  })();
}

export function reportJob(
  store: CoordinatorStore,
  request: Request,
  seq: number,
): Promise<Response> {
  return (async () => {
    const body = await readBody(request);
    const status = requireString(body, "status");
    const job = store.requireJob(seq, "running");
    const now = Date.now();

    if (status === "merged") {
      const mergedSha =
        typeof body["mergedSha"] === "string" ? (body["mergedSha"] as string) : null;
      store.exec(
        "UPDATE jobs SET status = 'merged', merged_sha = ?, finished_at = ? WHERE seq = ?",
        mergedSha,
        now,
        seq,
      );
      store.exec("UPDATE changesets SET status = 'merged', updated_at = ? WHERE id = ?", now, job.changeset);
      const held = store
        .sql<{ path: string }>(
          "SELECT path FROM leases WHERE changeset = ? ORDER BY path ASC",
          job.changeset,
        )
        .map((row) => row.path);
      store.exec("DELETE FROM leases WHERE changeset = ?", job.changeset);
      store.emit("integration.merged", {
        job: seq,
        changeset: job.changeset,
        mergedSha,
        releasedPaths: held,
      });
      return json({ job: toJob(store.requireJob(seq, "merged")) });
    }

    if (status === "rejected") {
      const reason = requireString(body, "reason");
      store.exec(
        "UPDATE jobs SET status = 'rejected', reason = ?, finished_at = ? WHERE seq = ?",
        reason,
        now,
        seq,
      );
      store.exec("UPDATE changesets SET status = 'rejected', updated_at = ? WHERE id = ?", now, job.changeset);
      // Leases are intentionally KEPT on rejection: the agent still owns its
      // scope and must resolve the conflict within it.
      store.emit("integration.rejected", { job: seq, changeset: job.changeset, reason });
      return json({ job: toJob(store.requireJob(seq, "rejected")) });
    }

    throw new HttpProblem(400, "invalid_field", `"status" must be "merged" or "rejected"`);
  })();
}
