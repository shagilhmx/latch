/**
 * Per-fork push subscription: make a session fork's pushes reach Latch.
 *
 * `cf.artifacts.repo.pushed` events flow to the events queue only for repos
 * covered by an event subscription — and a `artifacts.repo` subscription is
 * REPO-SCOPED: the API requires `source.namespace` + `source.repo_name`.
 * Session forks are created dynamically, so one account-level subscription
 * cannot cover them (and `wrangler queues subscription create --source
 * artifacts.repo` exposes no flag for the filter at all). This helper
 * subscribes ONE fork repo right after it exists, so its pushes are
 * delivered to the queue consumer → `POST /internal/pushed` → integration.
 *
 * Config-gated: needs `CLOUDFLARE_API_TOKEN` (Queues + Artifacts read) and
 * `CLOUDFLARE_ACCOUNT_ID`. Unconfigured → a typed `not_configured` result,
 * never a throw — local dev and the test suite run without any of it.
 */
export const DEFAULT_EVENTS_QUEUE = "latch-artifacts-events";
export const DEFAULT_ARTIFACTS_NAMESPACE = "latch";
export const PUSH_EVENT = "cf.artifacts.repo.pushed";
const API_BASE = "https://api.cloudflare.com/client/v4";

export interface ForkPushSubscriptionConfig {
  accountId?: string | null;
  apiToken?: string | null;
  /** Artifacts namespace holding the session forks (default `latch`). */
  namespace?: string;
  /** Events queue receiving the pushes (default `latch-artifacts-events`). */
  queueName?: string;
  /** Override for tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export type ForkPushSubscriptionResult =
  | { status: "subscribed"; subscriptionId: string; queueId: string }
  | { status: "not_configured"; reason: string }
  | { status: "error"; httpStatus: number; reason: string };

interface ApiEnvelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

/** The exact POST body for one fork's subscription (exported for tests). */
export function subscriptionBody(input: {
  namespace: string;
  repoName: string;
  queueId: string;
  events: string[];
}): Record<string, unknown> {
  return {
    name: `latch push ${input.namespace}/${input.repoName}`,
    enabled: true,
    source: {
      type: "artifacts.repo",
      namespace: input.namespace,
      repo_name: input.repoName,
    },
    destination: { type: "queues.queue", queue_id: input.queueId },
    events: input.events,
  };
}

async function api<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ ok: true; result: T } | { ok: false; httpStatus: number; reason: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    return { ok: false, httpStatus: 0, reason: (error as Error).message };
  }
  let body: ApiEnvelope<T> = {};
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    // Non-JSON error page; fall through to the status-based message.
  }
  if (!response.ok || body.success === false) {
    const detail =
      body.errors?.map((e) => e.message ?? String(e.code ?? "")).filter((m) => m.length > 0) ??
      [];
    return {
      ok: false,
      httpStatus: response.status,
      reason: detail.length > 0 ? detail.join("; ") : `HTTP ${response.status}`,
    };
  }
  return { ok: true, result: body.result as T };
}

/**
 * Subscribe one session fork repo to the events queue so its pushes are
 * delivered (and integration runs automatically). Idempotent-ish: creating
 * the same subscription twice is rejected by the API as a duplicate, which
 * surfaces as `error` — callers can treat that as already-subscribed.
 */
export async function subscribeForkPushes(
  repoName: string,
  config: ForkPushSubscriptionConfig = {},
): Promise<ForkPushSubscriptionResult> {
  const apiToken = config.apiToken?.trim() ?? "";
  const accountId = config.accountId?.trim() ?? "";
  if (apiToken.length === 0 || accountId.length === 0) {
    return {
      status: "not_configured",
      reason:
        "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to subscribe session forks to push events",
    };
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const base = (config.baseUrl ?? API_BASE).replace(/\/$/, "");
  const queueName = config.queueName ?? DEFAULT_EVENTS_QUEUE;
  const namespace = config.namespace ?? DEFAULT_ARTIFACTS_NAMESPACE;
  const headers = {
    authorization: `Bearer ${apiToken}`,
    "content-type": "application/json",
  };

  // 1. Resolve the queue id (subscriptions address queues by id).
  const queues = await api<Array<{ queue_id: string; name: string }>>(
    fetchImpl,
    `${base}/accounts/${encodeURIComponent(accountId)}/queues?name=${encodeURIComponent(queueName)}`,
    { method: "GET", headers },
  );
  if (!queues.ok) {
    return { status: "error", httpStatus: queues.httpStatus, reason: `queue lookup: ${queues.reason}` };
  }
  const queue = queues.result.find((q) => q.name === queueName) ?? queues.result[0];
  if (queue === undefined) {
    return {
      status: "error",
      httpStatus: 404,
      reason: `Queue "${queueName}" not found — create it: npx wrangler queues create ${queueName}`,
    };
  }

  // 2. Create the repo-scoped subscription.
  const created = await api<{ id: string }>(
    fetchImpl,
    `${base}/accounts/${encodeURIComponent(accountId)}/event_subscriptions/subscriptions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(
        subscriptionBody({ namespace, repoName, queueId: queue.queue_id, events: [PUSH_EVENT] }),
      ),
    },
  );
  if (!created.ok) {
    return {
      status: "error",
      httpStatus: created.httpStatus,
      reason: `subscription create: ${created.reason}`,
    };
  }

  return { status: "subscribed", subscriptionId: created.result.id, queueId: queue.queue_id };
}
