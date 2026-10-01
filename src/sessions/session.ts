import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  subscribeForkPushes,
  type ForkPushSubscriptionConfig,
  type ForkPushSubscriptionResult,
} from "../integration/fork-events.ts";
import { sessionRepoName } from "../worker/artifacts.ts";
import type { Changeset, IntegrationJob, LeaseConflict } from "../shared/types.ts";
import type { Author, SessionRuntime } from "./runtime.ts";

export interface StartSessionOptions {
  baseUrl: string;
  workspace: string;
  agent: string;
  intent: string;
  /** File scope the agent wants to claim up front. */
  claimPaths: string[];
  /** Session fork (created by the caller — local bare clone or Artifacts fork). */
  forkRepo?: string;
  forkRemote: string;
  /** Write token for the fork, when it lives in Artifacts. */
  forkToken?: string | null;
  /** Where to place the working clone; defaults to a temp dir. */
  workDir?: string;
  runtime: SessionRuntime;
  leaseTtlSeconds?: number;
  /**
   * When set (Artifacts mode), the session fork is subscribed to
   * `cf.artifacts.repo.pushed` right after the fork is attached, so pushes
   * to it enqueue integration automatically. Config-gated: credentials are
   * read from the config (typically `process.env`), and leaving it unset —
   * or leaving the credentials empty — skips the call entirely.
   */
  subscribePushes?: ForkPushSubscriptionConfig;
}

export type StartSessionResult =
  | {
      ok: true;
      changeset: Changeset;
      workDir: string;
      baseSha: string;
      /** Result of the optional push subscription (absent when not requested). */
      pushSubscription?: ForkPushSubscriptionResult;
    }
  | { ok: false; reason: "lease_conflict"; conflicts: LeaseConflict[]; changesetId: string }
  | { ok: false; reason: string; message: string };

export interface FinishSessionResult {
  sha: string;
  touchedPaths: string[];
  ready: { status: number; job?: IntegrationJob; error?: string };
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  conflicts?: LeaseConflict[];
}

async function call(
  options: { baseUrl: string; workspace: string },
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

async function readError(response: Response): Promise<ApiErrorBody> {
  try {
    return (await response.json()) as ApiErrorBody;
  } catch {
    return {};
  }
}

/**
 * The full agent session flow, in order:
 *   1. create changeset            POST /sessions
 *   2. claim leases (all-or-nothing)  POST /changesets/:id/leases
 *   3. attach the session fork     POST /changesets/:id/fork
 *   4. prepare an isolated checkout (runtime clone of the fork)
 *
 * Returns `lease_conflict` before any work happens when the claim overlaps
 * another agent's leases — that is Latch's prevented conflict.
 */
export async function startSession(options: StartSessionOptions): Promise<StartSessionResult> {
  const api = { baseUrl: options.baseUrl, workspace: options.workspace };

  const created = await call(api, "/sessions", post({ agent: options.agent, intent: options.intent }));
  if (created.status !== 201) {
    return {
      ok: false,
      reason: "session_create_failed",
      message: `${created.status}: ${await created.text()}`,
    };
  }
  const { changeset } = (await created.json()) as { changeset: Changeset };

  const leased = await call(
    api,
    `/changesets/${changeset.id}/leases`,
    post({ paths: options.claimPaths, ttlSeconds: options.leaseTtlSeconds }),
  );
  if (leased.status !== 200) {
    const body = await readError(leased);
    if (body.error === "lease_conflict") {
      return {
        ok: false,
        reason: "lease_conflict",
        conflicts: body.conflicts ?? [],
        changesetId: changeset.id,
      };
    }
    return { ok: false, reason: body.error ?? "lease_failed", message: body.message ?? "" };
  }

  const forkRepo = options.forkRepo ?? sessionRepoName(options.workspace, changeset.id);
  const attached = await call(
    api,
    `/changesets/${changeset.id}/fork`,
    post({
      forkRepo,
      forkRemote: options.forkRemote,
      forkToken: options.forkToken,
    }),
  );
  if (attached.status !== 200) {
    return {
      ok: false,
      reason: "fork_attach_failed",
      message: `${attached.status}: ${await attached.text()}`,
    };
  }

  // Best-effort: subscribe the fork to push events so integration runs on
  // every push. Never fails the session — an unsubscribed fork still works
  // via the explicit ready() path.
  const pushSubscription =
    options.subscribePushes === undefined
      ? undefined
      : await subscribeForkPushes(forkRepo, options.subscribePushes);

  const workDir = options.workDir ?? (await mkdtemp(`${tmpdir()}/latch-session-`));
  const prepared = await options.runtime.prepare(options.forkRemote, workDir);

  return {
    ok: true,
    changeset,
    workDir: prepared.workDir,
    baseSha: prepared.baseSha,
    ...(pushSubscription !== undefined ? { pushSubscription } : {}),
  };
}

/**
 * Commit the agent's work, push it to the session fork, and ready the
 * changeset (advisory lease check; the runner re-verifies from git).
 *
 * Safe to call again after a rejection: rejected changesets keep their
 * leases and fork, so the agent fixes its work in the same `workDir` and
 * re-invokes `finishSession` — that re-readies the same changeset and a new
 * integration job is queued (pair it with `awaitIntegration`).
 */
export async function finishSession(
  options: StartSessionOptions & { changesetId: string; baseSha: string },
): Promise<FinishSessionResult> {
  const api = { baseUrl: options.baseUrl, workspace: options.workspace };
  const author: Author = { name: options.agent, email: `${options.agent}@latch.local` };

  const sha = await options.runtime.commitAll(`agent: ${options.intent}`, author);
  const touchedPaths = await options.runtime.changedPaths(options.baseSha);
  await options.runtime.push(options.forkRemote, options.forkToken);

  const ready = await call(
    api,
    `/changesets/${options.changesetId}/ready`,
    post({ ref: sha, touchedPaths }),
  );
  const body = (await ready.json().catch(() => ({}))) as {
    job?: IntegrationJob;
    error?: string;
    message?: string;
  };

  return {
    sha,
    touchedPaths,
    ready: {
      status: ready.status,
      job: body.job,
      error: body.error ?? body.message,
    },
  };
}

/** Terminal states an integration can reach for a changeset. */
export type IntegrationOutcomeStatus = "merged" | "rejected" | "aborted";

export interface IntegrationOutcome {
  status: IntegrationOutcomeStatus;
  /** Merge commit on main, when the integration succeeded. */
  mergedSha: string | null;
  /** Rejection/abort reason as recorded on the newest job, when any. */
  reason: string | null;
  job: IntegrationJob | null;
}

const INTEGRATION_TERMINAL: ReadonlySet<string> = new Set([
  "merged",
  "rejected",
  "aborted",
]);

/**
 * Wait for a changeset's integration to reach a terminal state. Call this
 * after `finishSession`: it polls the changeset detail (queued/integrating
 * are in progress) and returns the outcome the agent should react to —
 * `merged` means done, `rejected` means fix within your leases and call
 * `finishSession` again.
 */
export async function awaitIntegration(options: {
  baseUrl: string;
  workspace: string;
  changesetId: string;
  /** Default 30s; throw if integration does not finish in time. */
  timeoutMs?: number;
  /** Poll cadence, default 150ms. */
  pollMs?: number;
}): Promise<IntegrationOutcome> {
  const api = { baseUrl: options.baseUrl, workspace: options.workspace };
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const pollMs = options.pollMs ?? 150;
  let lastSeen = "unknown";

  while (Date.now() < deadline) {
    const response = await call(api, `/changesets/${options.changesetId}`);
    if (response.ok) {
      const body = (await response.json()) as {
        changeset: Changeset;
        jobs: IntegrationJob[];
      };
      const status = body.changeset.status;
      lastSeen = status;
      if (INTEGRATION_TERMINAL.has(status)) {
        const job = body.jobs[0] ?? null; // newest first
        return {
          status: status as IntegrationOutcomeStatus,
          mergedSha: job?.mergedSha ?? null,
          reason: job?.reason ?? null,
          job,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Integration for changeset ${options.changesetId} did not finish ` +
      `within ${options.timeoutMs ?? 30_000}ms (last status: ${lastSeen})`,
  );
}

/** Release everything a session holds (leases + changeset) and clean the clone. */
export async function abortSession(
  options: { baseUrl: string; workspace: string; changesetId: string; runtime: SessionRuntime },
): Promise<void> {
  await call(
    { baseUrl: options.baseUrl, workspace: options.workspace },
    `/changesets/${options.changesetId}/abort`,
    post({}),
  ).catch(() => undefined);
  await options.runtime.cleanup().catch(() => undefined);
}
