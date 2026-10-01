/** Lifecycle of a changeset: an agent's unit of concurrent work. */
export type ChangesetStatus =
  | "open"
  | "queued"
  | "integrating"
  | "merged"
  | "rejected"
  | "aborted";

export type JobStatus = "pending" | "running" | "merged" | "rejected";

export interface Changeset {
  id: string;
  agent: string;
  intent: string;
  status: ChangesetStatus;
  forkRepo: string | null;
  forkRemote: string | null;
  ref: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Lease {
  path: string;
  changeset: string;
  agent: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface LeaseConflict {
  path: string;
  changeset: string;
  agent: string;
  expiresAt: number;
}

export interface IntegrationJob {
  seq: number;
  changeset: string;
  ref: string;
  status: JobStatus;
  reason: string | null;
  mergedSha: string | null;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Times this job has been claimed (1 = first run); see JOB_TIMEOUT_MS. */
  attempt: number;
}

/** A job enriched with everything the runner needs to do the merge. */
export interface ClaimedJob extends IntegrationJob {
  workspace: string;
  mainRemote: string | null;
  forkRemote: string | null;
  /** Write token for the session fork (never exposed in snapshots). */
  forkToken: string | null;
  agent: string;
  intent: string;
}

export interface CoordinationEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface WorkspaceConfig {
  mainRemote: string | null;
}

export interface WorkspaceSnapshot {
  name: string;
  config: WorkspaceConfig;
  changesets: Changeset[];
  leases: Lease[];
  jobs: IntegrationJob[];
  recentEvents: CoordinationEvent[];
  stats: {
    openLeases: number;
    activeChangesets: number;
    pendingJobs: number;
    runningJobs: number;
  };
}

/** Messages pushed over the live-update WebSocket. */
export type WireMessage =
  | { type: "snapshot"; snapshot: WorkspaceSnapshot }
  | { type: "pong"; at: number };

export interface ApiError {
  error: string;
  message: string;
  conflicts?: LeaseConflict[];
  violations?: string[];
}
