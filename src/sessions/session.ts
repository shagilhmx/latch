import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
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
}

export type StartSessionResult =
  | { ok: true; changeset: Changeset; workDir: string; baseSha: string }
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

  const attached = await call(
    api,
    `/changesets/${changeset.id}/fork`,
    post({
      forkRepo: options.forkRepo ?? sessionRepoName(options.workspace, changeset.id),
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

  const workDir = options.workDir ?? (await mkdtemp(`${tmpdir()}/latch-session-`));
  const prepared = await options.runtime.prepare(options.forkRemote, workDir);

  return { ok: true, changeset, workDir: prepared.workDir, baseSha: prepared.baseSha };
}

/**
 * Commit the agent's work, push it to the session fork, and ready the
 * changeset (advisory lease check; the runner re-verifies from git).
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
