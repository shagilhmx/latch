/**
 * Changeset lifecycle handlers: workspace configuration, creation, detail,
 * session-fork attachment, and abort (which releases held leases).
 *
 * Extracted from coordinator.ts; functions take the store explicitly.
 */
import type { Changeset } from "../shared/types";
import { HttpProblem, json, readBody, requireString } from "./http";
import {
  toChangeset,
  toEvent,
  toJob,
  toLease,
  type EventRow,
  type JobRow,
  type LeaseWithAgentRow,
} from "./coordinator-types";
import type { CoordinatorStore } from "./coordinator-store";

/** PUT /workspace — records the main remote for this workspace. */
export function configureWorkspace(
  store: CoordinatorStore,
  request: Request,
): Promise<Response> {
  return (async () => {
    const body = await readBody(request);
    const mainRemote = requireString(body, "mainRemote");
    store.exec(
      `INSERT INTO workspace (key, main_remote, updated_at) VALUES ('config', ?, ?)
       ON CONFLICT(key) DO UPDATE SET main_remote = excluded.main_remote, updated_at = excluded.updated_at`,
      mainRemote,
      Date.now(),
    );
    store.emit("workspace.configured", { mainRemote });
    return json(store.config());
  })();
}

export function createChangeset(store: CoordinatorStore, request: Request): Promise<Response> {
  return (async () => {
    const body = await readBody(request);
    const agent = requireString(body, "agent");
    const intent = requireString(body, "intent");
    const now = Date.now();
    const id = crypto.randomUUID();
    const forkRepo = typeof body["forkRepo"] === "string" ? body["forkRepo"] : null;
    const forkRemote = typeof body["forkRemote"] === "string" ? body["forkRemote"] : null;

    store.exec(
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
    store.emit("changeset.created", { changeset: id, agent, intent });

    return json({ changeset: store.requireChangeset(id) }, 201);
  })();
}

export function listChangesets(store: CoordinatorStore): Changeset[] {
  return store.changesetRows().map(toChangeset);
}

export function getChangesetDetail(store: CoordinatorStore, id: string): Response {
  const changeset = store.requireChangeset(id);
  const leases = store
    .sql<LeaseWithAgentRow>(
      `SELECT l.*, c.agent AS agent FROM leases l
       JOIN changesets c ON c.id = l.changeset
       WHERE l.changeset = ? ORDER BY l.path ASC`,
      id,
    )
    .map(toLease);
  const jobs = store
    .sql<JobRow>("SELECT * FROM jobs WHERE changeset = ? ORDER BY seq DESC", id)
    .map(toJob);
  const events = store
    .sql<EventRow>(
      "SELECT * FROM events WHERE payload LIKE ? ORDER BY seq DESC LIMIT 100",
      `%${id}%`,
    )
    .map(toEvent);
  return json({ changeset, leases, jobs, events });
}

/** Records the Artifacts session fork created for a changeset. */
export function attachFork(
  store: CoordinatorStore,
  request: Request,
  changesetId: string,
): Promise<Response> {
  return (async () => {
    const body = await readBody(request);
    const forkRepo = requireString(body, "forkRepo");
    const forkRemote = requireString(body, "forkRemote");
    const forkToken =
      typeof body["forkToken"] === "string" && body["forkToken"].length > 0
        ? body["forkToken"]
        : null;
    store.requireChangeset(changesetId);
    store.exec(
      "UPDATE changesets SET fork_repo = ?, fork_remote = ?, fork_token = ?, updated_at = ? WHERE id = ?",
      forkRepo,
      forkRemote,
      forkToken,
      Date.now(),
      changesetId,
    );
    store.emit("session.forked", { changeset: changesetId, forkRepo });
    return json({ changeset: store.requireChangeset(changesetId) });
  })();
}

export function abortChangeset(
  store: CoordinatorStore,
  request: Request,
  changesetId: string,
): Promise<Response> {
  return (async () => {
    // Abort carries no payload, but callers forward one anyway — drain it so
    // workerd doesn't raise "Can't read from request stream after response
    // has been sent" when the response completes.
    await request.body?.cancel().catch(() => undefined);
    const changeset = store.requireChangeset(changesetId);
    if (changeset.status === "merged" || changeset.status === "aborted") {
      throw new HttpProblem(409, "changeset_not_active", `Changeset is ${changeset.status}`);
    }
    const now = Date.now();
    store.exec(
      "UPDATE jobs SET status = 'rejected', reason = 'aborted', finished_at = ? WHERE changeset = ? AND status IN ('pending', 'running')",
      now,
      changesetId,
    );
    store.exec("UPDATE changesets SET status = 'aborted', updated_at = ? WHERE id = ?", now, changesetId);
    const held = store
      .sql<{ path: string }>("SELECT path FROM leases WHERE changeset = ?", changesetId)
      .map((row) => row.path);
    store.exec("DELETE FROM leases WHERE changeset = ?", changesetId);
    store.emit("changeset.aborted", { changeset: changesetId, releasedPaths: held });
    return json({ changeset: store.requireChangeset(changesetId) });
  })();
}
