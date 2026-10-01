import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end check of the Latch MCP server: spawn it over stdio (real
 * protocol handshake), list its tools, and drive the agent loop against a
 * stub Latch API — including the API-rejection → tool-error mapping.
 */

const ROOT = resolve(import.meta.dirname, "../..");

let api: Server;
let baseUrl = "";
let transport: StdioClientTransport;
let client: Client;
let leaseConflict = false;

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? "").join("\n");
}

beforeAll(async () => {
  // Minimal Latch API stub: snapshot, changeset creation, lease claims.
  api = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};

      if (req.method === "GET" && url.pathname === "/api/workspaces/stub/") {
        return json(res, 200, {
          name: "stub",
          config: { mainRemote: null },
          changesets: [],
          leases: [],
          jobs: [],
          recentEvents: [],
          stats: { openLeases: 0, activeChangesets: 0, pendingJobs: 0, runningJobs: 0 },
        });
      }
      if (req.method === "POST" && url.pathname === "/api/workspaces/stub/changesets") {
        return json(res, 201, {
          changeset: {
            id: "cs-mcp",
            agent: String(body["agent"] ?? ""),
            intent: String(body["intent"] ?? ""),
            status: "open",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        });
      }
      if (
        req.method === "POST" &&
        url.pathname === "/api/workspaces/stub/changesets/cs-mcp/leases"
      ) {
        if (leaseConflict) {
          return json(res, 409, {
            error: "lease_conflict",
            message: "src/mcp.ts is leased by another agent",
            conflicts: [
              { path: "src/mcp.ts", agent: "other", expiresAt: Date.now() + 60_000 },
            ],
          });
        }
        const paths = Array.isArray(body["paths"]) ? (body["paths"] as string[]) : [];
        return json(res, 200, { granted: paths, expiresAt: Date.now() + 300_000 });
      }
      return json(res, 404, { error: "not_found", message: url.pathname });
    });
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(ROOT, "src/mcp/server.ts")],
    env: {
      ...(process.env as Record<string, string>),
      LATCH_BASE_URL: baseUrl,
      LATCH_WORKSPACE: "stub",
    },
    cwd: ROOT,
  });
  client = new Client({ name: "latch-mcp-test", version: "0.0.0" });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((done) => api.close(() => done()));
});

describe("latch MCP server", () => {
  it("lists the agent-loop tools with input schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "latch_snapshot",
        "latch_create_changeset",
        "latch_claim_leases",
        "latch_heartbeat_leases",
        "latch_release_leases",
        "latch_ready",
        "latch_abort_changeset",
        "latch_events",
      ]),
    );
    const claim = tools.find((tool) => tool.name === "latch_claim_leases");
    expect(claim?.description).toContain("BEFORE editing");
    expect(claim?.inputSchema).toBeTruthy();
  });

  it("reads the workspace snapshot", async () => {
    const result = await client.callTool({ name: "latch_snapshot", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(toolText(result))).toMatchObject({ name: "stub" });
  });

  it("creates a changeset and claims leases", async () => {
    const created = await client.callTool({
      name: "latch_create_changeset",
      arguments: { agent: "mcp", intent: "drive the loop from an MCP client" },
    });
    expect(created.isError ?? false).toBe(false);
    expect(JSON.parse(toolText(created)).changeset).toMatchObject({
      id: "cs-mcp",
      agent: "mcp",
    });

    const claimed = await client.callTool({
      name: "latch_claim_leases",
      arguments: { changesetId: "cs-mcp", paths: ["src/mcp.ts"] },
    });
    expect(claimed.isError ?? false).toBe(false);
    expect(JSON.parse(toolText(claimed))).toMatchObject({ granted: ["src/mcp.ts"] });
  });

  it("maps API rejections to tool errors", async () => {
    leaseConflict = true;
    try {
      const denied = await client.callTool({
        name: "latch_claim_leases",
        arguments: { changesetId: "cs-mcp", paths: ["src/mcp.ts"] },
      });
      expect(denied.isError).toBe(true);
      expect(toolText(denied)).toContain("lease_conflict");
    } finally {
      leaseConflict = false;
    }
  });
});
