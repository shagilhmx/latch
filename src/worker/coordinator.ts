/**
 * Coordinator Durable Object — the authoritative lease keeper for a workspace.
 *
 * Scaffold status: routing + health only. Build step 2 adds the SQLite schema
 * (leases, changesets, integration queue, event log), lease acquire/release/
 * heartbeat/expiry logic, and WebSocket broadcast for the live UI.
 */
export class Coordinator {
  // Build step 2: the SQLite schema (leases, changesets, integration_queue,
  // events) will be created here via `state.blockConcurrencyWhile(...)`.
  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/api\/workspaces\/([A-Za-z0-9_-]+)$/.exec(url.pathname);

    if (request.method === "GET" && match !== null) {
      return Response.json({
        ok: true,
        workspace: match[1] ?? "default",
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
