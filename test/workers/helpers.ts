import { SELF, env, runInDurableObject } from "cloudflare:test";
import { RUNNER_TOKEN_HEADER } from "../../src/shared/runner-token.ts";

const BASE = "https://latch.test";

/** Matches the RUNNER_TOKEN binding injected in vitest.config.ts. */
export const RUNNER_TOKEN = "test-runner-token";

let counter = 0;

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

/**
 * Bound API client for one workspace. Each call to `workspaceApi()` with no
 * name creates a unique workspace — and therefore a unique Coordinator
 * Durable Object — so tests never share lease or queue state (the Workers
 * test pool does not roll storage back between tests).
 */
export interface WorkspaceApi {
  name: string;
  get<T = any>(suffix: string): Promise<ApiResponse<T>>;
  post<T = any>(suffix: string, body: unknown): Promise<ApiResponse<T>>;
  put<T = any>(suffix: string, body: unknown): Promise<ApiResponse<T>>;
  del<T = any>(suffix: string, body?: unknown): Promise<ApiResponse<T>>;
  createChangeset(agent: string, intent: string): Promise<string>;
  eventTypes(): Promise<string[]>;
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiResponse<T>> {
  // Every system route requires the runner token; attaching it here keeps
  // tests focused on their own behavior (runner-auth.test.ts covers it).
  const headers = new Headers(init?.headers);
  headers.set(RUNNER_TOKEN_HEADER, RUNNER_TOKEN);
  const response = await SELF.fetch(`${BASE}${path}`, { ...init, headers });
  const text = await response.text();
  return {
    status: response.status,
    body: (text.length > 0 ? (JSON.parse(text) as T) : null) as T,
  };
}

export function workspaceApi(name?: string): WorkspaceApi {
  const workspace = name ?? `ws-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
  const root = `/api/workspaces/${encodeURIComponent(workspace)}`;

  const get = <T,>(suffix: string) => request<T>(`${root}${suffix}`);
  const send = <T,>(method: string, suffix: string, body?: unknown) =>
    request<T>(`${root}${suffix}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });

  return {
    name: workspace,
    get,
    post: (suffix, body) => send("POST", suffix, body),
    put: (suffix, body) => send("PUT", suffix, body),
    del: (suffix, body) => send("DELETE", suffix, body),
    async createChangeset(agent, intent) {
      const { status, body } = await send<any>("POST", "/changesets", { agent, intent });
      if (status !== 201) {
        throw new Error(`createChangeset failed: ${status} ${JSON.stringify(body)}`);
      }
      return body.changeset.id as string;
    },
    async eventTypes() {
      const { body } = await get<any>("/events");
      return (body.events as Array<{ type: string }>).map((event) => event.type);
    },
  };
}

/** Backdates every lease in a workspace — used to test lazy expiry. */
export async function backdateLeases(workspace: string, expiresAt: number): Promise<void> {
  const namespace = env.COORDINATOR;
  const stub = namespace.get(namespace.idFromName(workspace));
  await runInDurableObject(stub, async (coordinator) => {
    coordinator.state.storage.sql.exec("UPDATE leases SET expires_at = ?", expiresAt);
  });
}

/**
 * Backdates the running job's `started_at` — used to test stale-job
 * recovery (requeue past JOB_TIMEOUT_MS, attempt cap).
 */
export async function backdateRunningJob(workspace: string, startedAt: number): Promise<void> {
  const namespace = env.COORDINATOR;
  const stub = namespace.get(namespace.idFromName(workspace));
  await runInDurableObject(stub, async (coordinator) => {
    coordinator.state.storage.sql.exec(
      "UPDATE jobs SET started_at = ? WHERE status = 'running'",
      startedAt,
    );
  });
}
