import { normalizePath, normalizePaths } from "../shared/paths";
import type {
  Changeset,
  ChangesetStatus,
  ClaimedJob,
  CoordinationEvent,
  IntegrationJob,
  JobStatus,
  Lease,
  LeaseConflict,
  WorkspaceConfig,
  WorkspaceSnapshot,
  WireMessage,
} from "../shared/types";
import {
  HttpProblem,
  apiError,
  json,
  readBody,
  requireString,
  requireStringArray,
} from "./http";

/** Values bindable in the DO's SQLite statements. */
type SqlParam = string | number | null;

const DEFAULT_LEASE_TTL_SECONDS = 300;
const MIN_LEASE_TTL_SECONDS = 5;
const MAX_LEASE_TTL_SECONDS = 3_600;
const MAX_RETAINED_EVENTS = 500;
const RECENT_EVENTS_IN_SNAPSHOT = 50;
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["open", "rejected"]);

interface ChangesetRow {
  id: string;
  agent: string;
  intent: string;
  status: string;
  fork_repo: string | null;
  fork_remote: string | null;
  ref: string | null;
  created_at: number;
  updated_at: number;
}

interface LeaseRow {
  path: string;
  changeset: string;
  acquired_at: number;
  expires_at: number;
}

interface LeaseWithAgentRow extends LeaseRow {
  agent: string;
}

interface ConflictRow extends LeaseRow {
  agent: string;
}

interface JobRow {
  seq: number;
  changeset: string;
  ref: string;
  status: string;
  reason: string | null;
  merged_sha: string | null;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface EventRow {
  seq: number;
  type: string;
  payload: string;
  created_at: number;
}

function optionalTtlSeconds(body: Record<string, unknown>): number {
  const value = body["ttlSeconds"];
  if (value === undefined) return DEFAULT_LEASE_TTL_SECONDS;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpProblem(400, "invalid_field", `"ttlSeconds" must be a number`);
  }
  const ttl = Math.floor(value);
  if (ttl < MIN_LEASE_TTL_SECONDS || ttl > MAX_LEASE_TTL_SECONDS) {
    throw new HttpProblem(
      400,
      "invalid_field",
      `"ttlSeconds" must be between ${MIN_LEASE_TTL_SECONDS} and ${MAX_LEASE_TTL_SECONDS}`,
    );
  }
  return ttl;
}

function toChangeset(row: ChangesetRow): Changeset {
  return {
    id: row.id,
    agent: row.agent,
    intent: row.intent,
    status: row.status as ChangesetStatus,
    forkRepo: row.fork_repo,
    forkRemote: row.fork_remote,
    ref: row.ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toJob(row: JobRow): IntegrationJob {
  return {
    seq: row.seq,
    changeset: row.changeset,
    ref: row.ref,
    status: row.status as JobStatus,
    reason: row.reason,
    mergedSha: row.merged_sha,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toLease(row: LeaseWithAgentRow): Lease {
  return {
    path: row.path,
    changeset: row.changeset,
    agent: row.agent,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

function toEvent(row: EventRow): CoordinationEvent {
  return {
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

/**
 * Workspace Coordinator — the authoritative lease keeper.
 *
 * One Durable Object per workspace; SQLite-backed (single-threaded per
 * instance, so lease checks and job claiming are serialized by construction).
 *
 * Enforcement model: agents hold leases here *before* editing. Code reaches
 * `main` only through the integration queue: the trusted integration runner
 * derives the changed paths from git itself and re-verifies them against this
 * table (`POST /integration/:seq/verify`) before any merge happens.
 */
export class Coordinator {
  private dirty = false;

  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {
    state.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  // ---------------------------------------------------------------- schema

  private migrate(): void {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace (
        key TEXT PRIMARY KEY,
        main_remote TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS changesets (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        intent TEXT NOT NULL,
        status TEXT NOT NULL,
        fork_repo TEXT,
        fork_remote TEXT,
        ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        path TEXT PRIMARY KEY,
        changeset TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    this.state.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_leases_changeset ON leases (changeset);
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        changeset TEXT NOT NULL,
        ref TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        merged_sha TEXT,
        enqueued_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  private sql<T>(query: string, ...params: SqlParam[]): T[] {
    const rows = this.state.storage.sql.exec(query, ...params).toArray();
    return rows as unknown as T[];
  }

  private exec(query: string, ...params: SqlParam[]): void {
    this.state.storage.sql.exec(query, ...params);
  }

  // --------------------------------------------------------------- events

  private emit(type: string, payload: Record<string, unknown>): void {
    this.exec(
      "INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)",
      type,
      JSON.stringify(payload),
      Date.now(),
    );
    this.exec(
      `DELETE FROM events WHERE seq NOT IN (
         SELECT seq FROM events ORDER BY seq DESC LIMIT ?
       )`,
      MAX_RETAINED_EVENTS,
    );
    this.dirty = true;
  }

  // ----------------------------------------------------------------- HTTP

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/api\/workspaces\/([^/]+)(\/.*)?$/.exec(url.pathname);

    if (match === null) {
      return apiError(404, "not_found", "Unknown Coordinator route");
    }

    const subpath = match[2] ?? "/";
    this.workspace = decodeURIComponent(match[1] ?? "workspace");

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (subpath === "/stream") return this.openStream(request);
      return apiError(404, "not_found", "WebSocket available only at /stream");
    }

    this.dirty = false;
    const expired = this.sweepExpired();

    let response: Response;
    try {
      response = await this.route(request, subpath, url);
    } catch (error) {
      if (error instanceof HttpProblem) {
        response = apiError(error.status, error.code, error.message, error.extra);
      } else if (error instanceof Error) {
        response = apiError(400, "bad_request", error.message);
      } else {
        response = apiError(500, "internal", "Unexpected error");
      }
    }

    if (this.dirty || expired > 0) {
      this.broadcast();
      this.dirty = false;
    }

    return response;
  }

  private async route(request: Request, subpath: string, url: URL): Promise<Response> {
    const method = request.method.toUpperCase();
    const segments = subpath.split("/").filter((s) => s.length > 0);

    if (method === "GET" && segments.length === 0) return json(this.snapshot());

    if (segments[0] === "workspace") {
      if (method === "PUT") {
        const body = await readBody(request);
        const mainRemote = requireString(body, "mainRemote");
        this.exec(
          `INSERT INTO workspace (key, main_remote, updated_at) VALUES ('config', ?, ?)
           ON CONFLICT(key) DO UPDATE SET main_remote = excluded.main_remote, updated_at = excluded.updated_at`,
          mainRemote,
          Date.now(),
        );
        this.emit("workspace.configured", { mainRemote });
        return json(this.config());
      }
    }

    if (segments[0] === "changesets") {
      if (segments.length === 1 && method === "POST") return this.createChangeset(request);
      if (segments.length === 1 && method === "GET") {
        return json({ changesets: this.listChangesets() });
      }
      if (segments.length >= 2) {
        const id = segments[1] ?? "";
        const action = segments[2];

        if (segments.length === 2 && method === "GET") return this.getChangesetDetail(id);
        if (action === "leases" && segments.length === 3 && method === "POST") {
          return this.acquireLeases(request, id);
        }
        if (action === "leases" && segments.length === 3 && method === "DELETE") {
          return this.releaseLeases(request, id);
        }
        if (action === "heartbeat" && segments.length === 3 && method === "POST") {
          return this.heartbeat(request, id);
        }
        if (action === "ready" && segments.length === 3 && method === "POST") {
          return this.markReady(request, id);
        }
        if (action === "abort" && segments.length === 3 && method === "POST") {
          return this.abortChangeset(id);
        }
        if (action === "fork" && segments.length === 3 && method === "POST") {
          return this.attachFork(request, id);
        }
      }
    }

    if (
      segments[0] === "internal" &&
      segments[1] === "pushed" &&
      segments.length === 2 &&
      method === "POST"
    ) {
      return this.pushedByEvent(request);
    }

    if (segments[0] === "integration") {
      if (segments[1] === "next" && segments.length === 2 && method === "GET") {
        return this.claimNextJob();
      }
      if (segments.length === 3 && segments[1] !== undefined) {
        const seq = Number(segments[1]);
        if (!Number.isInteger(seq)) {
          throw new HttpProblem(400, "invalid_field", "Job seq must be an integer");
        }
        if (segments[2] === "verify" && method === "POST") return this.verifyJob(request, seq);
        if (segments[2] === "result" && method === "POST") return this.reportJob(request, seq);
      }
    }

    if (segments[0] === "events" && segments.length === 1 && method === "GET") {
      const since = Number(url.searchParams.get("since") ?? "0");
      const events = this.sql<EventRow>(
        "SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT 200",
        Number.isFinite(since) ? since : 0,
      );
      return json({ events: events.map(toEvent) });
    }

    throw new HttpProblem(404, "not_found", `No route for ${method} ${subpath}`);
  }

  // ----------------------------------------------------------- changesets

  private async createChangeset(request: Request): Promise<Response> {
    const body = await readBody(request);
    const agent = requireString(body, "agent");
    const intent = requireString(body, "intent");
    const now = Date.now();
    const id = crypto.randomUUID();
    const forkRepo = typeof body["forkRepo"] === "string" ? body["forkRepo"] : null;
    const forkRemote = typeof body["forkRemote"] === "string" ? body["forkRemote"] : null;

    this.exec(
      `INSERT INTO changesets (id, agent, intent, status, fork_repo, fork_remote, ref, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, NULL, ?, ?)`,
      id,
      agent,
      intent,
      forkRepo,
      forkRemote,
      now,
      now,
    );
    this.emit("changeset.created", { changeset: id, agent, intent });

    return json({ changeset: this.requireChangeset(id) }, 201);
  }

  private listChangesets(): Changeset[] {
    return this.sql<ChangesetRow>("SELECT * FROM changesets ORDER BY created_at ASC").map(
      toChangeset,
    );
  }

  private getChangesetRow(id: string): ChangesetRow {
    const rows = this.sql<ChangesetRow>("SELECT * FROM changesets WHERE id = ?", id);
    const row = rows[0];
    if (row === undefined) {
      throw new HttpProblem(404, "changeset_not_found", `No changeset ${id}`);
    }
    return row;
  }

  private requireChangeset(id: string): Changeset {
    return toChangeset(this.getChangesetRow(id));
  }

  private getChangesetDetail(id: string): Response {
    const changeset = this.requireChangeset(id);
    const leases = this.sql<LeaseWithAgentRow>(
      `SELECT l.*, c.agent AS agent FROM leases l
       JOIN changesets c ON c.id = l.changeset
       WHERE l.changeset = ? ORDER BY l.path ASC`,
      id,
    ).map(toLease);
    const jobs = this.sql<JobRow>(
      "SELECT * FROM jobs WHERE changeset = ? ORDER BY seq DESC",
      id,
    ).map(toJob);
    const events = this.sql<EventRow>(
      "SELECT * FROM events WHERE payload LIKE ? ORDER BY seq DESC LIMIT 100",
      `%${id}%`,
    ).map(toEvent);
    return json({ changeset, leases, jobs, events });
  }

  // --------------------------------------------------------------- leases

  private acquireLeases(request: Request, changesetId: string): Promise<Response> {
    return (async () => {
      const body = await readBody(request);
      const changeset = this.requireChangeset(changesetId);

      if (!ACTIVE_STATUSES.has(changeset.status)) {
        throw new HttpProblem(
          409,
          "changeset_not_active",
          `Changeset is ${changeset.status}; leases can only change while open or rejected`,
        );
      }

      let paths: string[];
      try {
        paths = normalizePaths(requireStringArray(body, "paths"));
      } catch (error) {
        throw new HttpProblem(400, "invalid_path", (error as Error).message);
      }

      const ttlSeconds = optionalTtlSeconds(body);
      const now = Date.now();
      const expiresAt = now + ttlSeconds * 1_000;

      const conflicts: LeaseConflict[] = paths.flatMap((path) =>
        this.sql<ConflictRow>(
          `SELECT l.path, l.changeset, l.acquired_at, l.expires_at, c.agent
           FROM leases l JOIN changesets c ON c.id = l.changeset
           WHERE l.path = ? AND l.changeset <> ?`,
          path,
          changesetId,
        ).map((row) => ({
          path: row.path,
          changeset: row.changeset,
          agent: row.agent,
          expiresAt: row.expires_at,
        })),
      );

      if (conflicts.length > 0) {
        this.emit("lease.denied", {
          changeset: changesetId,
          agent: changeset.agent,
          paths,
          conflicts,
        });
        throw new HttpProblem(
          409,
          "lease_conflict",
          `Paths already leased by other changesets: ${conflicts
            .map((c) => c.path)
            .join(", ")}`,
          { conflicts },
        );
      }

      for (const path of paths) {
        this.exec(
          `INSERT INTO leases (path, changeset, acquired_at, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             changeset = excluded.changeset,
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at`,
          path,
          changesetId,
          now,
          expiresAt,
        );
      }

      this.emit("lease.acquired", {
        changeset: changesetId,
        agent: changeset.agent,
        paths,
        expiresAt,
        ttlSeconds,
      });

      return json({ granted: paths, expiresAt });
    })();
  }

  private releaseLeases(request: Request, changesetId: string): Promise<Response> {
    return (async () => {
      const body = await readBody(request).catch(() => ({}) as Record<string, unknown>);
      this.requireChangeset(changesetId);

      let filter: string[] | null = null;
      if (Array.isArray(body["paths"])) {
        try {
          filter = normalizePaths(body["paths"] as string[]);
        } catch (error) {
          throw new HttpProblem(400, "invalid_path", (error as Error).message);
        }
      }

      const held = this.sql<{ path: string }>(
        "SELECT path FROM leases WHERE changeset = ? ORDER BY path ASC",
        changesetId,
      ).map((row) => row.path);

      const released =
        filter === null
          ? held
          : held.filter((path) => filter !== null && filter.includes(path));

      if (filter === null) {
        this.exec("DELETE FROM leases WHERE changeset = ?", changesetId);
      } else if (filter.length > 0) {
        this.exec(
          `DELETE FROM leases WHERE changeset = ? AND path IN (${filter.map(() => "?").join(",")})`,
          changesetId,
          ...filter,
        );
      }

      if (released.length > 0) {
        this.emit("lease.released", { changeset: changesetId, paths: released });
      }

      return json({ released });
    })();
  }

  private heartbeat(request: Request, changesetId: string): Promise<Response> {
    return (async () => {
      const body = await readBody(request).catch(() => ({}) as Record<string, unknown>);
      this.requireChangeset(changesetId);
      const ttlSeconds = optionalTtlSeconds(body);
      const expiresAt = Date.now() + ttlSeconds * 1_000;

      let filter: string[] | null = null;
      if (Array.isArray(body["paths"])) {
        try {
          filter = normalizePaths(body["paths"] as string[]);
        } catch (error) {
          throw new HttpProblem(400, "invalid_path", (error as Error).message);
        }
      }

      let updated: string[];
      if (filter === null) {
        this.exec("UPDATE leases SET expires_at = ? WHERE changeset = ?", expiresAt, changesetId);
        updated = this.sql<{ path: string }>(
          "SELECT path FROM leases WHERE changeset = ? ORDER BY path ASC",
          changesetId,
        ).map((row) => row.path);
      } else {
        if (filter.length === 0) return json({ extended: [], expiresAt });
        this.exec(
          `UPDATE leases SET expires_at = ? WHERE changeset = ? AND path IN (${filter
            .map(() => "?")
            .join(",")})`,
          expiresAt,
          changesetId,
          ...filter,
        );
        updated = filter.filter((path) =>
          this.sql<{ path: string }>(
            "SELECT path FROM leases WHERE changeset = ? AND path = ?",
            changesetId,
            path,
          ).length > 0,
        );
      }

      if (updated.length === 0) {
        throw new HttpProblem(404, "no_leases", `Changeset ${changesetId} holds no such leases`);
      }

      this.emit("lease.heartbeat", { changeset: changesetId, paths: updated, expiresAt });
      return json({ extended: updated, expiresAt });
    })();
  }

  /**
   * Lazily releases expired leases. Called at the start of every request so
   * conflict checks always run against live leases only.
   */
  private sweepExpired(): number {
    const now = Date.now();
    const expired = this.sql<LeaseRow>(
      "SELECT path, changeset, acquired_at, expires_at FROM leases WHERE expires_at <= ?",
      now,
    );
    if (expired.length === 0) return 0;

    this.exec("DELETE FROM leases WHERE expires_at <= ?", now);

    const byChangeset = new Map<string, string[]>();
    for (const row of expired) {
      const paths = byChangeset.get(row.changeset) ?? [];
      paths.push(row.path);
      byChangeset.set(row.changeset, paths);
    }
    for (const [changeset, paths] of byChangeset) {
      this.emit("lease.expired", { changeset, paths: paths.sort(), at: now });
    }
    return expired.length;
  }

  // -------------------------------------------------- ready / integration

  private markReady(request: Request, changesetId: string): Promise<Response> {
    return (async () => {
      const body = await readBody(request);
      const changeset = this.requireChangeset(changesetId);

      const activeJob = this.sql<{ seq: number }>(
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
      const job = this.enqueueJob(changeset.id, ref, touched, "ready");
      return json({ job: toJob(job), changeset: this.requireChangeset(changesetId) }, 202);
    })();
  }

  /**
   * Shared enqueue core for the ready endpoint and the push-event consumer.
   * The advisory lease check runs only when `paths` is provided; event-driven
   * pushes fall through to the runner's authoritative verify instead.
   */
  private enqueueJob(
    changesetId: string,
    ref: string,
    paths: string[] | null,
    via: string,
  ): JobRow {
    if (paths !== null) {
      const violations = paths.filter((path) => {
        const rows = this.sql<{ changeset: string }>(
          "SELECT changeset FROM leases WHERE path = ?",
          path,
        );
        return rows[0]?.changeset !== changesetId;
      });
      if (violations.length > 0) {
        this.emit("changeset.blocked", { changeset: changesetId, violations });
        throw new HttpProblem(
          409,
          "lease_violation",
          `Not leased by this changeset: ${violations.join(", ")}`,
          { violations },
        );
      }
    }

    const now = Date.now();
    this.exec(
      "UPDATE changesets SET status = 'queued', ref = ?, updated_at = ? WHERE id = ?",
      ref,
      now,
      changesetId,
    );
    this.exec(
      "INSERT INTO jobs (changeset, ref, status, enqueued_at) VALUES (?, ?, 'pending', ?)",
      changesetId,
      ref,
      now,
    );
    this.emit("changeset.ready", { changeset: changesetId, ref, paths, via });

    const job = this.sql<JobRow>(
      "SELECT * FROM jobs WHERE changeset = ? ORDER BY seq DESC LIMIT 1",
      changesetId,
    )[0];
    if (job === undefined) {
      throw new HttpProblem(500, "internal", "Job insert did not persist");
    }
    return job;
  }

  /** Records the Artifacts session fork created for a changeset. */
  private attachFork(request: Request, changesetId: string): Promise<Response> {
    return (async () => {
      const body = await readBody(request);
      const forkRepo = requireString(body, "forkRepo");
      const forkRemote = requireString(body, "forkRemote");
      this.requireChangeset(changesetId);
      this.exec(
        "UPDATE changesets SET fork_repo = ?, fork_remote = ?, updated_at = ? WHERE id = ?",
        forkRepo,
        forkRemote,
        Date.now(),
        changesetId,
      );
      this.emit("session.forked", { changeset: changesetId, forkRepo });
      return json({ changeset: this.requireChangeset(changesetId) });
    })();
  }

  /**
   * Called by the queue consumer when an agent pushes to its session fork:
   * enqueues integration automatically, using the changeset's held leases as
   * the advisory path set (the runner's verify stays authoritative).
   */
  private pushedByEvent(request: Request): Promise<Response> {
    return (async () => {
      const body = await readBody(request);
      const repoName = requireString(body, "repoName");
      const ref = requireString(body, "ref");

      const rows = this.sql<ChangesetRow>(
        "SELECT * FROM changesets WHERE fork_repo = ? ORDER BY created_at DESC LIMIT 1",
        repoName,
      );
      const changeset = rows[0];
      if (changeset === undefined) {
        return json({ queued: false, reason: "no_matching_changeset" }, 202);
      }
      const activeJob = this.sql<{ seq: number }>(
        "SELECT seq FROM jobs WHERE changeset = ? AND status IN ('pending', 'running') LIMIT 1",
        changeset.id,
      );
      if (activeJob.length > 0) {
        return json({ queued: false, reason: "already_queued" }, 202);
      }
      if (!ACTIVE_STATUSES.has(changeset.status)) {
        return json({ queued: false, reason: `changeset_${changeset.status}` }, 202);
      }

      const held = this.sql<{ path: string }>(
        "SELECT path FROM leases WHERE changeset = ? ORDER BY path ASC",
        changeset.id,
      ).map((row) => row.path);

      const job = this.enqueueJob(changeset.id, ref, held.length > 0 ? held : null, "push");
      return json({ queued: true, job: toJob(job) }, 202);
    })();
  }

  private abortChangeset(changesetId: string): Promise<Response> {
    return (async () => {
      const changeset = this.requireChangeset(changesetId);
      if (changeset.status === "merged" || changeset.status === "aborted") {
        throw new HttpProblem(409, "changeset_not_active", `Changeset is ${changeset.status}`);
      }
      const now = Date.now();
      this.exec(
        "UPDATE jobs SET status = 'rejected', reason = 'aborted', finished_at = ? WHERE changeset = ? AND status IN ('pending', 'running')",
        now,
        changesetId,
      );
      this.exec("UPDATE changesets SET status = 'aborted', updated_at = ? WHERE id = ?", now, changesetId);
      const held = this.sql<{ path: string }>(
        "SELECT path FROM leases WHERE changeset = ?",
        changesetId,
      ).map((row) => row.path);
      this.exec("DELETE FROM leases WHERE changeset = ?", changesetId);
      this.emit("changeset.aborted", { changeset: changesetId, releasedPaths: held });
      return json({ changeset: this.requireChangeset(changesetId) });
    })();
  }

  /**
   * Claim the next integration job. The Durable Object processes requests one
   * at a time and this method performs no awaits between its statements, so at
   * most one job can ever be `running` — this is the single-writer guarantee
   * for `main`.
   */
  private claimNextJob(): Promise<Response> {
    return (async () => {
      const running = this.sql<{ seq: number }>(
        "SELECT seq FROM jobs WHERE status = 'running' LIMIT 1",
      );
      if (running.length > 0) return new Response(null, { status: 204 });

      const next = this.sql<JobRow>(
        "SELECT * FROM jobs WHERE status = 'pending' ORDER BY seq ASC LIMIT 1",
      )[0];
      if (next === undefined) return new Response(null, { status: 204 });

      const now = Date.now();
      this.exec("UPDATE jobs SET status = 'running', started_at = ? WHERE seq = ?", now, next.seq);
      this.exec(
        "UPDATE changesets SET status = 'integrating', updated_at = ? WHERE id = ?",
        now,
        next.changeset,
      );
      this.emit("integration.claimed", { job: next.seq, changeset: next.changeset, ref: next.ref });

      const changeset = this.requireChangeset(next.changeset);
      const config = this.config();
      const claimed: ClaimedJob = {
        ...toJob({ ...next, status: "running", started_at: now }),
        workspace: this.workspaceName(),
        mainRemote: config.mainRemote,
        forkRemote: changeset.forkRemote,
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
  private verifyJob(request: Request, seq: number): Promise<Response> {
    return (async () => {
      const body = await readBody(request);
      const job = this.requireJob(seq, "running");
      let paths: string[];
      try {
        paths = normalizePaths(requireStringArray(body, "paths"));
      } catch (error) {
        throw new HttpProblem(400, "invalid_path", (error as Error).message);
      }

      const violations = paths.filter((path) => {
        const rows = this.sql<{ changeset: string }>(
          "SELECT changeset FROM leases WHERE path = ?",
          path,
        );
        return rows[0]?.changeset !== job.changeset;
      });

      if (violations.length > 0) {
        const now = Date.now();
        this.exec(
          "UPDATE jobs SET status = 'rejected', reason = ?, finished_at = ? WHERE seq = ?",
          `lease violation: ${violations.join(", ")}`,
          now,
          seq,
        );
        this.exec(
          "UPDATE changesets SET status = 'rejected', updated_at = ? WHERE id = ?",
          now,
          job.changeset,
        );
        this.emit("integration.rejected", {
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

      this.emit("integration.verified", { job: seq, changeset: job.changeset, paths });
      return json({ ok: true, paths });
    })();
  }

  private requireJob(seq: number, expectedStatus: string): JobRow {
    const rows = this.sql<JobRow>("SELECT * FROM jobs WHERE seq = ?", seq);
    const row = rows[0];
    if (row === undefined) {
      throw new HttpProblem(404, "job_not_found", `No integration job ${seq}`);
    }
    if (row.status !== expectedStatus) {
      throw new HttpProblem(
        409,
        "job_state",
        `Job ${seq} is ${row.status}; expected ${expectedStatus}`,
      );
    }
    return row;
  }

  private reportJob(request: Request, seq: number): Promise<Response> {
    return (async () => {
      const body = await readBody(request);
      const status = requireString(body, "status");
      const job = this.requireJob(seq, "running");
      const now = Date.now();

      if (status === "merged") {
        const mergedSha =
          typeof body["mergedSha"] === "string" ? (body["mergedSha"] as string) : null;
        this.exec(
          "UPDATE jobs SET status = 'merged', merged_sha = ?, finished_at = ? WHERE seq = ?",
          mergedSha,
          now,
          seq,
        );
        this.exec(
          "UPDATE changesets SET status = 'merged', updated_at = ? WHERE id = ?",
          now,
          job.changeset,
        );
        const held = this.sql<{ path: string }>(
          "SELECT path FROM leases WHERE changeset = ? ORDER BY path ASC",
          job.changeset,
        ).map((row) => row.path);
        this.exec("DELETE FROM leases WHERE changeset = ?", job.changeset);
        this.emit("integration.merged", {
          job: seq,
          changeset: job.changeset,
          mergedSha,
          releasedPaths: held,
        });
        return json({ job: toJob(this.requireJob(seq, "merged")) });
      }

      if (status === "rejected") {
        const reason = requireString(body, "reason");
        this.exec(
          "UPDATE jobs SET status = 'rejected', reason = ?, finished_at = ? WHERE seq = ?",
          reason,
          now,
          seq,
        );
        this.exec(
          "UPDATE changesets SET status = 'rejected', updated_at = ? WHERE id = ?",
          now,
          job.changeset,
        );
        // Leases are intentionally KEPT on rejection: the agent still owns its
        // scope and must resolve the conflict within it.
        this.emit("integration.rejected", { job: seq, changeset: job.changeset, reason });
        return json({ job: toJob(this.requireJob(seq, "rejected")) });
      }

      throw new HttpProblem(400, "invalid_field", `"status" must be "merged" or "rejected"`);
    })();
  }

  // ------------------------------------------------------------- snapshot

  /**
   * The workspace name is carried in every request path (the Worker resolves
   * the DO via `idFromName`), captured at the top of `fetch` so snapshots and
   * broadcasts can label themselves.
   */
  private workspaceName(): string {
    return this.workspace;
  }

  private workspace = "workspace";

  private config(): WorkspaceConfig {
    const rows = this.sql<{ main_remote: string | null }>(
      "SELECT main_remote FROM workspace WHERE key = 'config'",
    );
    return { mainRemote: rows[0]?.main_remote ?? null };
  }

  private snapshot(): WorkspaceSnapshot {
    const changesets = this.listChangesets();
    const leases = this.sql<LeaseWithAgentRow>(
      `SELECT l.path, l.changeset, l.acquired_at, l.expires_at, c.agent
       FROM leases l JOIN changesets c ON c.id = l.changeset
       ORDER BY l.path ASC`,
    ).map(toLease);
    const jobs = this.sql<JobRow>("SELECT * FROM jobs ORDER BY seq DESC LIMIT 50").map(toJob);
    const recentEvents = this.sql<EventRow>(
      "SELECT * FROM events ORDER BY seq DESC LIMIT ?",
      RECENT_EVENTS_IN_SNAPSHOT,
    ).map(toEvent);
    const active = changesets.filter(
      (c) => c.status === "open" || c.status === "queued" || c.status === "integrating",
    ).length;
    const pendingJobs = jobs.filter((j) => j.status === "pending").length;
    const runningJobs = jobs.filter((j) => j.status === "running").length;

    return {
      name: this.workspaceName(),
      config: this.config(),
      changesets,
      leases,
      jobs,
      recentEvents,
      stats: {
        openLeases: leases.length,
        activeChangesets: active,
        pendingJobs,
        runningJobs,
      },
    };
  }

  // ------------------------------------------------------------- websocket

  private openStream(request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.send(
      JSON.stringify({ type: "snapshot", snapshot: this.snapshot() } satisfies WireMessage),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const text = typeof message === "string" ? message : "";
    if (text === "ping") {
      socket.send(JSON.stringify({ type: "pong", at: Date.now() } satisfies WireMessage));
      return;
    }
    socket.send(
      JSON.stringify({ type: "snapshot", snapshot: this.snapshot() } satisfies WireMessage),
    );
  }

  private broadcast(): void {
    const message = JSON.stringify({
      type: "snapshot",
      snapshot: this.snapshot(),
    } satisfies WireMessage);

    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // Socket may have closed between iteration and send; the hibernation
        // API cleans it up.
      }
    }
  }
}
