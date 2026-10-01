/**
 * Lease domain: acquire (all-or-nothing with conflict refusal), release,
 * heartbeat, and the lazy expiry sweep that runs at the start of every
 * request so conflict checks always see live leases only.
 *
 * Every function takes the store explicitly; the Durable Object class in
 * coordinator.ts wires them to HTTP routes.
 */
import { normalizePaths } from "../shared/paths";
import type { LeaseConflict } from "../shared/types";
import { HttpProblem, json, readBody, requireStringArray } from "./http";
import {
  ACTIVE_STATUSES,
  optionalTtlSeconds,
  type ConflictRow,
  type LeaseRow,
} from "./coordinator-types";
import type { CoordinatorStore } from "./coordinator-store";

/**
 * Lazily releases expired leases. Called at the start of every request so
 * conflict checks always run against live leases only.
 */
export function sweepExpired(store: CoordinatorStore): number {
  const now = Date.now();
  const expired = store.sql<LeaseRow>(
    "SELECT path, changeset, acquired_at, expires_at FROM leases WHERE expires_at <= ?",
    now,
  );
  if (expired.length === 0) return 0;

  store.exec("DELETE FROM leases WHERE expires_at <= ?", now);

  const byChangeset = new Map<string, string[]>();
  for (const row of expired) {
    const paths = byChangeset.get(row.changeset) ?? [];
    paths.push(row.path);
    byChangeset.set(row.changeset, paths);
  }
  for (const [changeset, paths] of byChangeset) {
    store.emit("lease.expired", { changeset, paths: paths.sort(), at: now });
  }
  return expired.length;
}

export function acquireLeases(
  store: CoordinatorStore,
  request: Request,
  changesetId: string,
): Promise<Response> {
  return (async () => {
    const body = await readBody(request);
    const changeset = store.requireChangeset(changesetId);

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
      store
        .sql<ConflictRow>(
          `SELECT l.path, l.changeset, l.acquired_at, l.expires_at, c.agent
           FROM leases l JOIN changesets c ON c.id = l.changeset
           WHERE l.path = ? AND l.changeset <> ?`,
          path,
          changesetId,
        )
        .map((row) => ({
          path: row.path,
          changeset: row.changeset,
          agent: row.agent,
          expiresAt: row.expires_at,
        })),
    );

    if (conflicts.length > 0) {
      store.emit("lease.denied", {
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
      store.exec(
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

    store.emit("lease.acquired", {
      changeset: changesetId,
      agent: changeset.agent,
      paths,
      expiresAt,
      ttlSeconds,
    });

    return json({ granted: paths, expiresAt });
  })();
}

export function releaseLeases(
  store: CoordinatorStore,
  request: Request,
  changesetId: string,
): Promise<Response> {
  return (async () => {
    const body = await readBody(request).catch(() => ({}) as Record<string, unknown>);
    store.requireChangeset(changesetId);

    let filter: string[] | null = null;
    if (Array.isArray(body["paths"])) {
      try {
        filter = normalizePaths(body["paths"] as string[]);
      } catch (error) {
        throw new HttpProblem(400, "invalid_path", (error as Error).message);
      }
    }

    const held = store
      .sql<{ path: string }>(
        "SELECT path FROM leases WHERE changeset = ? ORDER BY path ASC",
        changesetId,
      )
      .map((row) => row.path);

    const released =
      filter === null ? held : held.filter((path) => filter !== null && filter.includes(path));

    if (filter === null) {
      store.exec("DELETE FROM leases WHERE changeset = ?", changesetId);
    } else if (filter.length > 0) {
      store.exec(
        `DELETE FROM leases WHERE changeset = ? AND path IN (${filter.map(() => "?").join(",")})`,
        changesetId,
        ...filter,
      );
    }

    if (released.length > 0) {
      store.emit("lease.released", { changeset: changesetId, paths: released });
    }

    return json({ released });
  })();
}

export function heartbeat(
  store: CoordinatorStore,
  request: Request,
  changesetId: string,
): Promise<Response> {
  return (async () => {
    const body = await readBody(request).catch(() => ({}) as Record<string, unknown>);
    store.requireChangeset(changesetId);
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
      store.exec("UPDATE leases SET expires_at = ? WHERE changeset = ?", expiresAt, changesetId);
      updated = store
        .sql<{ path: string }>(
          "SELECT path FROM leases WHERE changeset = ? ORDER BY path ASC",
          changesetId,
        )
        .map((row) => row.path);
    } else {
      if (filter.length === 0) return json({ extended: [], expiresAt });
      store.exec(
        `UPDATE leases SET expires_at = ? WHERE changeset = ? AND path IN (${filter
          .map(() => "?")
          .join(",")})`,
        expiresAt,
        changesetId,
        ...filter,
      );
      updated = filter.filter(
        (path) =>
          store.sql<{ path: string }>(
            "SELECT path FROM leases WHERE changeset = ? AND path = ?",
            changesetId,
            path,
          ).length > 0,
      );
    }

    if (updated.length === 0) {
      throw new HttpProblem(404, "no_leases", `Changeset ${changesetId} holds no such leases`);
    }

    store.emit("lease.heartbeat", { changeset: changesetId, paths: updated, expiresAt });
    return json({ extended: updated, expiresAt });
  })();
}
