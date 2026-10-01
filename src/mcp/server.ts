/**
 * Latch MCP server — exposes the coordination API to MCP clients (Claude
 * Code, Cursor, …) over stdio, backed by the Agent SDK's LatchClient.
 *
 *   LATCH_BASE_URL=http://127.0.0.1:8787 \
 *   LATCH_WORKSPACE=demo \
 *   [LATCH_RUNNER_TOKEN=…] npm run mcp
 *
 * Tools mirror the agent loop: open a changeset → claim leases → work →
 * ready → (the trusted runner integrates) → read the outcome. Writes are
 * authorized exactly like any other API client — in production the session
 * cookie/OAuth identity applies, in dev mode the built-in dev actor does.
 *
 * Note: stdout carries the MCP protocol; all diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ApiResponse } from "../sdk/client.ts";
import { LatchClient } from "../sdk/client.ts";

const baseUrl = process.env.LATCH_BASE_URL ?? "http://127.0.0.1:8787";
const workspace = process.env.LATCH_WORKSPACE ?? "default";

const client = new LatchClient({
  baseUrl,
  workspace,
  runnerToken: process.env.LATCH_RUNNER_TOKEN ?? null,
});

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(body: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Run one SDK call, mapping API failures and transport errors to results. */
async function guard(call: () => Promise<ApiResponse<unknown>>): Promise<ToolResult> {
  try {
    const response = await call();
    return response.status >= 200 && response.status < 300
      ? text(response.body)
      : text(`HTTP ${response.status}: ${JSON.stringify(response.body)}`, true);
  } catch (error) {
    return text(`${baseUrl} unreachable: ${(error as Error).message}`, true);
  }
}

const server = new McpServer({ name: "latch", version: "0.2.0" });

server.registerTool(
  "latch_snapshot",
  {
    title: "Workspace snapshot",
    description:
      "Full workspace state: changesets, live leases, integration jobs, recent events, " +
      "and stats. Read this before claiming to see who holds what.",
  },
  async () => guard(() => client.snapshot()),
);

server.registerTool(
  "latch_changeset_detail",
  {
    title: "Changeset detail",
    description: "One changeset with its leases, jobs, and event history.",
    inputSchema: { changesetId: z.string().describe("Changeset UUID") },
  },
  async ({ changesetId }) => guard(() => client.changesetDetail(changesetId)),
);

server.registerTool(
  "latch_create_changeset",
  {
    title: "Create changeset",
    description: "Open a changeset: the unit of concurrent work for one agent session.",
    inputSchema: {
      agent: z.string().describe("Agent name (who is working)"),
      intent: z.string().describe("What this session will change"),
    },
  },
  async ({ agent, intent }) => guard(() => client.createChangeset(agent, intent)),
);

server.registerTool(
  "latch_claim_leases",
  {
    title: "Claim leases",
    description:
      "All-or-nothing claim of file-path leases for a changeset. Call BEFORE editing. " +
      "Overlapping claims are refused with 409 and the conflicting leases listed.",
    inputSchema: {
      changesetId: z.string(),
      paths: z
        .array(z.string())
        .describe("Paths or directory prefixes (trailing slash), e.g. ['src/auth.ts']"),
      ttlSeconds: z.number().min(5).max(3600).optional().describe("Lease TTL, default 300"),
    },
  },
  async ({ changesetId, paths, ttlSeconds }) =>
    guard(() => client.claim(changesetId, paths, ttlSeconds !== undefined ? { ttlSeconds } : {})),
);

server.registerTool(
  "latch_heartbeat_leases",
  {
    title: "Extend leases",
    description: "Push lease deadlines forward while work continues.",
    inputSchema: {
      changesetId: z.string(),
      paths: z.array(z.string()).optional().describe("Subset; defaults to every held path"),
      ttlSeconds: z.number().min(5).max(3600).optional(),
    },
  },
  async ({ changesetId, paths, ttlSeconds }) =>
    guard(() =>
      client.heartbeat(changesetId, {
        ...(paths !== undefined ? { paths } : {}),
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      }),
    ),
);

server.registerTool(
  "latch_release_leases",
  {
    title: "Release leases",
    description: "Give leased paths back early (aborting work you will not finish).",
    inputSchema: {
      changesetId: z.string(),
      paths: z.array(z.string()).optional().describe("Subset; defaults to every held path"),
    },
  },
  async ({ changesetId, paths }) => guard(() => client.release(changesetId, paths)),
);

server.registerTool(
  "latch_ready",
  {
    title: "Ready for integration",
    description:
      "Queue the changeset for the integration runner: the ref (commit sha) to merge and " +
      "the paths the commit touched. The runner re-verifies them against live leases " +
      "using git itself before anything merges.",
    inputSchema: {
      changesetId: z.string(),
      ref: z.string().describe("Commit sha to integrate"),
      touchedPaths: z.array(z.string()).describe("Paths the commit changed"),
    },
  },
  async ({ changesetId, ref, touchedPaths }) =>
    guard(() => client.ready(changesetId, ref, touchedPaths)),
);

server.registerTool(
  "latch_abort_changeset",
  {
    title: "Abort changeset",
    description:
      "Close a changeset, cancel any queued job, and release all of its leases.",
    inputSchema: { changesetId: z.string() },
  },
  async ({ changesetId }) => guard(() => client.abort(changesetId)),
);

server.registerTool(
  "latch_events",
  {
    title: "Event log",
    description: "Coordination events after the given seq (claims, denials, merges).",
    inputSchema: {
      since: z.number().optional().describe("Return events after this seq (default 0)"),
    },
  },
  async ({ since }) => guard(() => client.events(since ?? 0)),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[latch-mcp] serving workspace "${workspace}" at ${baseUrl}`);
}

main().catch((error: unknown) => {
  console.error("[latch-mcp] fatal:", error);
  process.exitCode = 1;
});
