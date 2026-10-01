import { WorkerEntrypoint } from "cloudflare:workers";

const GATEWAY_HOST = "gateway.ai.cloudflare.com";

/**
 * Egress control for agent containers: HTTPS only, and only to
 *   - the AI Gateway path for this account (Claude Code's model traffic,
 *     with the gateway token injected here so it never enters the sandbox),
 *   - github.com (public clones in local-shaped flows),
 *   - *.artifacts.cloudflare.net (session-fork clone/push).
 * Everything else gets a 403 — the container cannot npm-install or browse.
 */
export class Outbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.protocol !== "https:") {
      return new Response("Plain HTTP is not allowed from this sandbox\n", { status: 403 });
    }

    const gatewayPath = `/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}`;
    if (
      url.hostname === GATEWAY_HOST &&
      (url.pathname === gatewayPath || url.pathname.startsWith(`${gatewayPath}/`))
    ) {
      const headers = new Headers(request.headers);
      headers.delete("x-api-key");
      headers.set("cf-aig-authorization", `Bearer ${this.env.AI_GATEWAY_TOKEN}`);
      return fetch(new Request(request, { headers }));
    }

    if (url.hostname === "github.com" || url.hostname.endsWith(".artifacts.cloudflare.net")) {
      return fetch(request);
    }

    return new Response(`${url.hostname} is not reachable from this sandbox\n`, {
      status: 403,
    });
  }
}
