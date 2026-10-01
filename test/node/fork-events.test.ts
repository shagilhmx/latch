import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENTS_QUEUE,
  PUSH_EVENT,
  subscribeForkPushes,
  subscriptionBody,
} from "../../src/integration/fork-events.ts";

/** Capturing fetch stub speaking the Cloudflare API v4 envelope. */
function fakeFetch(
  handler: (url: string, init: RequestInit) => { status?: number; result?: unknown; errors?: unknown },
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const outcome = handler(url, init ?? {});
    const body = {
      success: (outcome.status ?? 200) < 400 && outcome.errors === undefined,
      errors: outcome.errors ?? [],
      result: outcome.result ?? null,
    };
    return new Response(JSON.stringify(body), {
      status: outcome.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("subscribeForkPushes", () => {
  it("is config-gated: typed not_configured instead of a throw", async () => {
    const unconfigured = await subscribeForkPushes("ws-live.cs.abcdef12", {});
    expect(unconfigured.status).toBe("not_configured");

    const tokenOnly = await subscribeForkPushes("ws-live.cs.abcdef12", {
      apiToken: "token-without-account",
    });
    expect(tokenOnly.status).toBe("not_configured");
  });

  it("resolves the queue, then creates a repo-scoped subscription", async () => {
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.includes("/queues")
        ? { result: [{ queue_id: "q-123", name: DEFAULT_EVENTS_QUEUE }] }
        : { result: { id: "sub-9" } },
    );

    const result = await subscribeForkPushes("ws-live.cs.abcdef12", {
      accountId: "acct-1",
      apiToken: "cf-token",
      fetchImpl,
    });
    expect(result).toEqual({ status: "subscribed", subscriptionId: "sub-9", queueId: "q-123" });

    // 1. queue lookup, authenticated, by name.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/accounts/acct-1/queues?name=latch-artifacts-events");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer cf-token",
    );

    // 2. subscription body is repo-scoped (the filter wrangler cannot set).
    const body = JSON.parse(String(calls[1]?.init.body)) as Record<string, any>;
    expect(calls[1]?.url).toContain("/accounts/acct-1/event_subscriptions/subscriptions");
    expect(body.source).toEqual({
      type: "artifacts.repo",
      namespace: "latch",
      repo_name: "ws-live.cs.abcdef12",
    });
    expect(body.destination).toEqual({ type: "queues.queue", queue_id: "q-123" });
    expect(body.events).toEqual([PUSH_EVENT]);
    expect(body.enabled).toBe(true);
  });

  it("honors namespace and queue overrides", async () => {
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.includes("/queues")
        ? { result: [{ queue_id: "q-other", name: "custom-queue" }] }
        : { result: { id: "sub-1" } },
    );

    const result = await subscribeForkPushes("ws-x.cs.00000000", {
      accountId: "acct-1",
      apiToken: "cf-token",
      namespace: "my-ns",
      queueName: "custom-queue",
      fetchImpl,
    });
    expect(result.status).toBe("subscribed");
    expect(calls[0]?.url).toContain("name=custom-queue");
    const body = JSON.parse(String(calls[1]?.init.body)) as Record<string, any>;
    expect(body.source.namespace).toBe("my-ns");
  });

  it("surfaces API errors without throwing", async () => {
    const missingQueue = fakeFetch(() => ({ status: 200, result: [] }));
    const missing = await subscribeForkPushes("ws-live.cs.abcdef12", {
      accountId: "acct-1",
      apiToken: "cf-token",
      fetchImpl: missingQueue.fetchImpl,
    });
    expect(missing.status).toBe("error");
    if (missing.status === "error") expect(missing.reason).toContain("not found");

    const denied = fakeFetch((url) =>
      url.includes("/queues")
        ? { result: [{ queue_id: "q-123", name: DEFAULT_EVENTS_QUEUE }] }
        : { status: 403, errors: [{ code: 10000, message: "Authentication error" }] },
    );
    const failed = await subscribeForkPushes("ws-live.cs.abcdef12", {
      accountId: "acct-1",
      apiToken: "bad-token",
      fetchImpl: denied.fetchImpl,
    });
    expect(failed.status).toBe("error");
    if (failed.status === "error") {
      expect(failed.httpStatus).toBe(403);
      expect(failed.reason).toContain("Authentication error");
    }
  });
});

describe("subscriptionBody", () => {
  it("builds the exact repo-scoped payload", () => {
    expect(
      subscriptionBody({
        namespace: "latch",
        repoName: "ws-demo.cs.deadbeef",
        queueId: "q-1",
        events: [PUSH_EVENT],
      }),
    ).toEqual({
      name: "latch push latch/ws-demo.cs.deadbeef",
      enabled: true,
      source: { type: "artifacts.repo", namespace: "latch", repo_name: "ws-demo.cs.deadbeef" },
      destination: { type: "queues.queue", queue_id: "q-1" },
      events: ["cf.artifacts.repo.pushed"],
    });
  });
});
