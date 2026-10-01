/**
 * Storage + query layer for the Coordinator Durable Object.
 *
 * Owns the SQLite schema, the low-level sql/exec helpers, the event log
 * (with hibernation-aware dirty tracking), and the read-only queries shared
 * by the domain modules in coordinator-{leases,changesets,jobs}.ts.
 *
 * One instance exists per workspace: Durable Objects are single-threaded
 * per instance, so every statement below is serialized by construction —
 * that property is the foundation of Latch's single-writer guarantee.
 */
import type { Changeset, WorkspaceConfig, WorkspaceSnapshot } from "../shared/types";
import { HttpProblem } from "./http";
import {
  MAX_RETAINED_EVENTS,
  RECENT_EVENTS_IN_SNAPSHOT,
  toChangeset,
  toEvent,
  toJob,
  toLease,
  type ChangesetRow,
  type EventRow,
  type JobRow,
  type LeaseRow,
  type LeaseWithAgentRow,
  type SqlParam,
} from "./coordinator-types";

export class CoordinatorStore {
  readonly state: DurableObjectState;
  readonly env: Env;

  /** Set by fetch() from the request path; labels snapshots/broadcasts. */
  workspace = "workspace";

  /** True when a request mutated state; fetch() broadcasts and resets. */
  dirty = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
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
        fork_token TEXT,
        ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Upgrade guard for databases created before fork_token existed.
    try {
      this.state.storage.sql.exec("ALTER TABLE changesets ADD COLUMN fork_token TEXT");
    } catch {
      // Column already present.
    }
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

  // ---------------------------------------------------------------- basics

  sql<T>(query: string, ...params: SqlParam[]): T[] {
    const rows = this.state.storage.sql.exec(query, ...params).toArray();
    return rows as unknown as T[];
  }

  exec(query: string, ...params: SqlParam[]): void {
    this.state.storage.sql.exec(query, ...params);
  }

  emit(type: string, payload: Record<string, unknown>): void {
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

  workspaceName(): string {
    return this.workspace;
  }

  config(): WorkspaceConfig {
    const rows = this.sql<{ main_remote: string | null }>(
      "SELECT main_remote FROM workspace WHERE key = 'config'",
    );
    return { mainRemote: rows[0]?.main_remote ?? null };
  }

  // ------------------------------------------------------------- changesets

  /** Raw rows, oldest first. */
  changesetRows(): ChangesetRow[] {
    return this.sql<ChangesetRow>("SELECT * FROM changesets ORDER BY created_at ASC");
  }

  getChangesetRow(id: string): ChangesetRow {
    const rows = this.sql<ChangesetRow>("SELECT * FROM changesets WHERE id = ?", id);
    const row = rows[0];
    if (row === undefined) {
      throw new HttpProblem(404, "changeset_not_found", `No changeset ${id}`);
    }
    return row;
  }

  requireChangeset(id: string): Changeset {
    return toChangeset(this.getChangesetRow(id));
  }

  // ------------------------------------------------------------------- jobs

  getJobRow(seq: number): JobRow | undefined {
    return this.sql<JobRow>("SELECT * FROM jobs WHERE seq = ?", seq)[0];
  }

  /** Fetch a job and assert it is in the expected state (409 otherwise). */
  requireJob(seq: number, expectedStatus: string): JobRow {
    const row = this.getJobRow(seq);
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

  // --------------------------------------------------------------- snapshot

  snapshot(): WorkspaceSnapshot {
    const changesets = this.changesetRows().map(toChangeset);
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

  /** Helper for sweep-style queries over raw lease rows. */
  leaseRowsWhere(query: string, ...params: SqlParam[]): LeaseRow[] {
    return this.sql<LeaseRow>(query, ...params);
  }
}
