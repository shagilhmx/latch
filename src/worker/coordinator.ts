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
 *
 * The class is deliberately thin: storage lives in coordinator-store.ts and
 * domain handlers in coordinator-{leases,changesets,jobs}.ts; this file wires
 * HTTP routes and the hibernated WebSocket stream to those modules.
 */
import type { WireMessage } from "../shared/types";
import {
  abortChangeset,
  attachFork,
  configureWorkspace,
  createChangeset,
  getChangesetDetail,
  listChangesets,
} from "./coordinator-changesets";
import {
  claimNextJob,
  markReady,
  pushedByEvent,
  reportJob,
  verifyJob,
} from "./coordinator-jobs";
import { acquireLeases, heartbeat, releaseLeases, sweepExpired } from "./coordinator-leases";
import { CoordinatorStore } from "./coordinator-store";
import { toEvent, type EventRow } from "./coordinator-types";
import { HttpProblem, apiError, json } from "./http";

export class Coordinator extends CoordinatorStore {
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
    const expired = sweepExpired(this);

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
      if (method === "PUT") return configureWorkspace(this, request);
    }

    if (segments[0] === "changesets") {
      if (segments.length === 1 && method === "POST") return createChangeset(this, request);
      if (segments.length === 1 && method === "GET") {
        return json({ changesets: listChangesets(this) });
      }
      if (segments.length >= 2) {
        const id = segments[1] ?? "";
        const action = segments[2];

        if (segments.length === 2 && method === "GET") return getChangesetDetail(this, id);
        if (action === "leases" && segments.length === 3 && method === "POST") {
          return acquireLeases(this, request, id);
        }
        if (action === "leases" && segments.length === 3 && method === "DELETE") {
          return releaseLeases(this, request, id);
        }
        if (action === "heartbeat" && segments.length === 3 && method === "POST") {
          return heartbeat(this, request, id);
        }
        if (action === "ready" && segments.length === 3 && method === "POST") {
          return markReady(this, request, id);
        }
        if (action === "abort" && segments.length === 3 && method === "POST") {
          return abortChangeset(this, id);
        }
        if (action === "fork" && segments.length === 3 && method === "POST") {
          return attachFork(this, request, id);
        }
      }
    }

    if (
      segments[0] === "internal" &&
      segments[1] === "pushed" &&
      segments.length === 2 &&
      method === "POST"
    ) {
      return pushedByEvent(this, request);
    }

    if (segments[0] === "integration") {
      if (segments[1] === "next" && segments.length === 2 && method === "GET") {
        return claimNextJob(this);
      }
      if (segments.length === 3 && segments[1] !== undefined) {
        const seq = Number(segments[1]);
        if (!Number.isInteger(seq)) {
          throw new HttpProblem(400, "invalid_field", "Job seq must be an integer");
        }
        if (segments[2] === "verify" && method === "POST") return verifyJob(this, request, seq);
        if (segments[2] === "result" && method === "POST") return reportJob(this, request, seq);
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

  // ------------------------------------------------------------- websocket

  private openStream(_request: Request): Response {
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
