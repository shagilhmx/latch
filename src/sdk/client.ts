/**
 * Latch Agent SDK — a typed HTTP client for the Latch coordination API.
 *
 * Agents (or orchestrators driving agents) use this to claim scope before
 * editing, keep leases alive, submit work, and watch integration outcomes.
 * The high-level session flow (startSession/finishSession/awaitIntegration)
 * in `./session` composes these primitives.
 *
 * The client never talks to `main`: it can only reach workspace-scoped
 * coordination endpoints, mirroring the enforcement boundary.
 */
import type {
  Changeset,
  ClaimedJob,
  CoordinationEvent,
  IntegrationJob,
  LeaseConflict,
  WorkspaceSnapshot,
} from "../shared/types";

export interface ApiResponse<T> {
  status: number;
  body: T;
}

/** Error shape returned by every non-2xx API response. */
export interface ApiErrorBody {
  error?: string;
  message?: string;
  conflicts?: LeaseConflict[];
  violations?: string[];
}

export interface LatchClientOptions {
  /** Origin of the Latch worker, e.g. `https://latch.example.com`. */
  baseUrl: string;
  workspace: string;
}

export interface ClaimOptions {
  /** Lease TTL in seconds (server clamps to 5–3600). */
  ttlSeconds?: number;
}

export class LatchClient {
  readonly baseUrl: string;
  readonly workspace: string;

  constructor(options: LatchClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.workspace = options.workspace;
  }

  /** Absolute URL for a workspace-scoped path (`""` = snapshot). */
  url(path = ""): string {
    return `${this.baseUrl}/api/workspaces/${encodeURIComponent(this.workspace)}${path}`;
  }

  /** Low-level escape hatch used by every method; parses JSON bodies. */
  async request<T = Record<string, unknown>>(
    path: string,
    init?: RequestInit,
  ): Promise<ApiResponse<T>> {
    const response = await fetch(this.url(path), init);
    const text = await response.text();
    return {
      status: response.status,
      body: (text.length > 0 ? JSON.parse(text) : null) as T,
    };
  }

  private post<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ------------------------------------------------------------ reads

  snapshot(): Promise<ApiResponse<WorkspaceSnapshot>> {
    return this.request("/");
  }

  listChangesets(): Promise<ApiResponse<{ changesets: Changeset[] }>> {
    return this.request("/changesets");
  }

  changesetDetail(
    id: string,
  ): Promise<
    ApiResponse<{
      changeset: Changeset;
      leases: WorkspaceSnapshot["leases"];
      jobs: IntegrationJob[];
      events: CoordinationEvent[];
    }>
  > {
    return this.request(`/changesets/${id}`);
  }

  events(since = 0): Promise<ApiResponse<{ events: CoordinationEvent[] }>> {
    return this.request(`/events?since=${since}`);
  }

  // ----------------------------------------------------------- writes

  createChangeset(
    agent: string,
    intent: string,
  ): Promise<ApiResponse<{ changeset: Changeset } & ApiErrorBody>> {
    return this.post("/changesets", { agent, intent });
  }

  /** All-or-nothing lease claim — do this BEFORE editing anything. */
  claim(
    changesetId: string,
    paths: string[],
    options: ClaimOptions = {},
  ): Promise<ApiResponse<{ granted: string[]; expiresAt: number } & ApiErrorBody>> {
    return this.post(`/changesets/${changesetId}/leases`, {
      paths,
      ttlSeconds: options.ttlSeconds,
    });
  }

  heartbeat(
    changesetId: string,
    options: { paths?: string[]; ttlSeconds?: number } = {},
  ): Promise<ApiResponse<{ extended: string[]; expiresAt: number } & ApiErrorBody>> {
    return this.post(`/changesets/${changesetId}/heartbeat`, options);
  }

  release(
    changesetId: string,
    paths?: string[],
  ): Promise<ApiResponse<{ released: string[] } & ApiErrorBody>> {
    return this.request<{ released: string[] } & ApiErrorBody>(
      `/changesets/${changesetId}/leases`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(paths === undefined ? {} : { paths }),
      },
    );
  }

  ready(
    changesetId: string,
    ref: string,
    touchedPaths: string[],
  ): Promise<ApiResponse<{ job: IntegrationJob; changeset: Changeset } & ApiErrorBody>> {
    return this.post(`/changesets/${changesetId}/ready`, { ref, touchedPaths });
  }

  attachFork(
    changesetId: string,
    fork: { forkRepo: string; forkRemote: string; forkToken?: string | null },
  ): Promise<ApiResponse<{ changeset: Changeset } & ApiErrorBody>> {
    return this.post(`/changesets/${changesetId}/fork`, fork);
  }

  abort(
    changesetId: string,
  ): Promise<ApiResponse<{ changeset: Changeset } & ApiErrorBody>> {
    return this.post(`/changesets/${changesetId}/abort`, {});
  }

  // ------------------------------------------------------ runner side

  /** Claim the next integration job (204 when the queue is idle/busy). */
  claimNextJob(): Promise<ApiResponse<{ job: ClaimedJob } | null>> {
    return this.request("/integration/next");
  }

  verifyJob(
    seq: number,
    paths: string[],
  ): Promise<ApiResponse<{ ok: true; paths: string[] } & ApiErrorBody>> {
    return this.post(`/integration/${seq}/verify`, { paths });
  }

  reportJob(
    seq: number,
    report: { status: "merged"; mergedSha?: string } | { status: "rejected"; reason: string },
  ): Promise<ApiResponse<{ job: IntegrationJob } & ApiErrorBody>> {
    return this.post(`/integration/${seq}/result`, report);
  }

  // ------------------------------------------------------------ stream

  /**
   * Open the live snapshot stream (same messages the UI renders:
   * `{ type: "snapshot", snapshot }` on connect and after every mutation).
   */
  openStream(): WebSocket {
    const origin = this.baseUrl.replace(/^http/, "ws");
    return new WebSocket(`${origin}/api/workspaces/${encodeURIComponent(this.workspace)}/stream`);
  }
}
