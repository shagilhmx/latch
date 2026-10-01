/**
 * Row shapes, wire mappers, and constants shared by the Coordinator's
 * storage and domain modules. Extracted from coordinator.ts so the Durable
 * Object class stays a thin routing/composition layer.
 */
import type {
  Changeset,
  ChangesetStatus,
  CoordinationEvent,
  IntegrationJob,
  JobStatus,
  Lease,
} from "../shared/types";
import { HttpProblem } from "./http";

/** Values bindable in the DO's SQLite statements. */
export type SqlParam = string | number | null;

export const DEFAULT_LEASE_TTL_SECONDS = 300;
export const MIN_LEASE_TTL_SECONDS = 5;
export const MAX_LEASE_TTL_SECONDS = 3_600;
export const MAX_RETAINED_EVENTS = 500;
export const RECENT_EVENTS_IN_SNAPSHOT = 50;
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["open", "rejected"]);

export interface ChangesetRow {
  id: string;
  agent: string;
  intent: string;
  status: string;
  fork_repo: string | null;
  fork_remote: string | null;
  fork_token: string | null;
  ref: string | null;
  created_at: number;
  updated_at: number;
}

export interface LeaseRow {
  path: string;
  changeset: string;
  acquired_at: number;
  expires_at: number;
}

export interface LeaseWithAgentRow extends LeaseRow {
  agent: string;
}

export interface ConflictRow extends LeaseRow {
  agent: string;
}

export interface JobRow {
  seq: number;
  changeset: string;
  ref: string;
  status: string;
  reason: string | null;
  merged_sha: string | null;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  attempts: number;
}

export interface EventRow {
  seq: number;
  type: string;
  payload: string;
  created_at: number;
}

export function optionalTtlSeconds(body: Record<string, unknown>): number {
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

export function toChangeset(row: ChangesetRow): Changeset {
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

export function toJob(row: JobRow): IntegrationJob {
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
    attempt: row.attempts,
  };
}

export function toLease(row: LeaseWithAgentRow): Lease {
  return {
    path: row.path,
    changeset: row.changeset,
    agent: row.agent,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

export function toEvent(row: EventRow): CoordinationEvent {
  return {
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
