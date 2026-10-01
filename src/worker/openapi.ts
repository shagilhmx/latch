/**
 * OpenAPI 3.1 description of the Latch coordination API, served at
 * `GET /api/openapi.json`. Kept as a typed object (not YAML) so it is
 * bundle-checked by `tsc` alongside the routes it documents.
 */
export const openapiSpec: Record<string, unknown> = {
  openapi: "3.1.0",
  info: {
    title: "Latch API",
    version: "0.2.0",
    description:
      "Lease-based concurrency for agent teams. Agents claim file-path " +
      "leases from a per-workspace Durable Object **before** editing; " +
      "overlapping claims are refused up front. Code reaches `main` only " +
      "through the serialized integration queue, whose runner re-verifies " +
      "git-derived paths against live leases.",
    license: { name: "MIT", identifier: "MIT" },
  },
  servers: [{ url: "/", description: "This deployment" }],
  tags: [
    { name: "workspace", description: "Configuration and snapshots" },
    { name: "changesets", description: "Agent work units" },
    { name: "leases", description: "Path-scope claims" },
    { name: "integration", description: "Trusted runner queue (single writer for main)" },
    { name: "events", description: "Event log and live stream" },
    { name: "sessions", description: "Session creation and agent execution" },
  ],
  paths: {
    "/api/workspaces/{workspace}": {
      get: {
        tags: ["workspace"],
        summary: "Workspace snapshot",
        description:
          "Changesets, live leases, recent jobs, recent events, and stats. " +
          "This is the payload the UI streams over the WebSocket.",
        operationId: "getSnapshot",
        parameters: [{ $ref: "#/components/parameters/workspace" }],
        responses: {
          200: {
            description: "Snapshot",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WorkspaceSnapshot" } } },
          },
        },
      },
    },
    "/api/workspaces/{workspace}/workspace": {
      put: {
        tags: ["workspace"],
        summary: "Configure the workspace main remote",
        operationId: "configureWorkspace",
        parameters: [{ $ref: "#/components/parameters/workspace" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["mainRemote"],
                properties: { mainRemote: { type: "string", description: "Git remote URL of main" } },
              },
            },
          },
        },
        responses: { 200: { description: "Stored configuration" } },
      },
    },
    "/api/workspaces/{workspace}/changesets": {
      get: {
        tags: ["changesets"],
        summary: "List changesets",
        operationId: "listChangesets",
        parameters: [{ $ref: "#/components/parameters/workspace" }],
        responses: {
          200: {
            description: "Changesets (chronological)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { changesets: { type: "array", items: { $ref: "#/components/schemas/Changeset" } } },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["changesets"],
        summary: "Create a changeset (agent work unit)",
        operationId: "createChangeset",
        parameters: [{ $ref: "#/components/parameters/workspace" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["agent", "intent"],
                properties: {
                  agent: { type: "string" },
                  intent: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { changeset: { $ref: "#/components/schemas/Changeset" } },
                },
              },
            },
          },
          400: { $ref: "#/components/responses/BadRequest" },
        },
      },
    },
    "/api/workspaces/{workspace}/changesets/{id}": {
      get: {
        tags: ["changesets"],
        summary: "Changeset detail (leases, jobs, events)",
        operationId: "getChangeset",
        parameters: [
          { $ref: "#/components/parameters/workspace" },
          { $ref: "#/components/parameters/changesetId" },
        ],
        responses: {
          200: { description: "Detail" },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/workspaces/{workspace}/changesets/{id}/leases": {
      post: {
        tags: ["leases"],
        summary: "Claim leases (all-or-nothing)",
        description:
          "Claims file paths (or directory subtrees with a trailing slash, " +
          "e.g. `src/`) for the changeset. Any overlap with a live lease " +
          "held by another changeset refuses the whole claim with 409 and " +
          "the holder's identity — before any editing happens.",
        operationId: "claimLeases",
        parameters: [
          { $ref: "#/components/parameters/workspace" },
          { $ref: "#/components/parameters/changesetId" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["paths"],
                properties: {
                  paths: {
                    type: "array",
                    items: { type: "string" },
                    examples: [["src/", "README.md"]],
                  },
                  ttlSeconds: { type: "integer", minimum: 5, maximum: 3600, default: 300 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Granted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    granted: { type: "array", items: { type: "string" } },
                    expiresAt: { type: "integer" },
                  },
                },
              },
            },
          },
          409: { $ref: "#/components/responses/Conflict" },
        },
      },
      delete: {
        tags: ["leases"],
        summary: "Release leases (all, or a filter)",
        operationId: "releaseLeases",
        parameters: [
          { $ref: "#/components/parameters/workspace" },
          { $ref: "#/components/parameters/changesetId" },
        ],
        responses: { 200: { description: "Released" } },
      },
    },
    "/api/workspaces/{workspace}/changesets/{id}/heartbeat": {
      post: {
        tags: ["leases"],
        summary: "Extend lease deadlines",
        operationId: "heartbeat",
        parameters: [
          { $ref: "#/components/parameters/workspace" },
          { $ref: "#/components/parameters/changesetId" },
        ],
        responses: {
          200: { description: "Extended" },
          404: { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/workspaces/{workspace}/changesets/{id}/ready": {
      post: {
        tags: ["changesets"],
        summary: "Submit work for integration",
        description:
          "Queues an integration job after an advisory check that every " +
          "touched path is covered by this changeset's leases. The " +
          "authoritative check runs again in verify() against paths " +
          "derived from git itself. Safe to call again after a rejection " +
          "(rejected changesets keep their leases and fork).",
        operationId: "markReady",
        parameters: [
          { $ref: "#/components/parameters/workspace" },
          { $ref: "#/components/parameters/changesetId" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ref", "touchedPaths"],
                properties: {
                  ref: { type: "string", description: "Fork commit SHA" },
                  touchedPaths: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: {
          202: { description: "Queued" },
          409: { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/workspaces/{workspace}/changesets/{id}/abort": {
      post: {
        tags: ["changesets"],
        summary: "Abort a changeset and release its leases",
        operationId: "abortChangeset",
        parameters: [
          { $ref: "#/components/parameters/workspace" },
          { $ref: "#/components/parameters/changesetId" },
        ],
        responses: { 200: { description: "Aborted" } },
      },
    },
    "/api/workspaces/{workspace}/changesets/{id}/fork": {
      post: {
        tags: ["changesets"],
        summary: "Attach the session fork (Artifacts repo or local remote)",
        operationId: "attachFork",
        parameters: [
          { $ref: "#/components/parameters/workspace" },
          { $ref: "#/components/parameters/changesetId" },
        ],
        responses: { 200: { description: "Attached" } },
      },
    },
    "/api/workspaces/{workspace}/events": {
      get: {
        tags: ["events"],
        summary: "Poll the event log",
        operationId: "listEvents",
        parameters: [
          { $ref: "#/components/parameters/workspace" },
          { name: "since", in: "query", schema: { type: "integer" }, description: "Return events after this seq" },
        ],
        responses: { 200: { description: "Events" } },
      },
    },
    "/api/workspaces/{workspace}/stream": {
      get: {
        tags: ["events"],
        summary: "Live snapshot stream (WebSocket)",
        description:
          "Upgrade to WebSocket. Server pushes `{type:\"snapshot\",snapshot}` " +
          "on connect and after every mutation; send `ping` for `{type:\"pong\"}`. " +
          "Hibernation-aware: sockets survive DO eviction.",
        operationId: "openStream",
        parameters: [{ $ref: "#/components/parameters/workspace" }],
        responses: { 101: { description: "Switching Protocols" } },
      },
    },
    "/api/workspaces/{workspace}/integration/next": {
      get: {
        tags: ["integration"],
        summary: "Claim the next integration job (runner only)",
        description:
          "Returns 204 when a job is running or none is pending — this " +
          "endpoint is the single-writer gate for `main`.",
        operationId: "claimNextJob",
        parameters: [{ $ref: "#/components/parameters/workspace" }],
        responses: {
          200: { description: "Claimed job with fork credentials" },
          204: { description: "Idle / busy" },
        },
      },
    },
    "/api/workspaces/{workspace}/integration/{seq}/verify": {
      post: {
        tags: ["integration"],
        summary: "Authoritative lease verification (runner only)",
        description:
          "Posts paths derived from `git diff --name-only <merge-base>` — " +
          "not agent-declared. Any path outside the job's live leases " +
          "rejects job AND changeset in the same turn (leases kept).",
        operationId: "verifyJob",
        parameters: [
          { $ref: "#/components/parameters/workspace" },
          { name: "seq", in: "path", required: true, schema: { type: "integer" } },
        ],
        responses: {
          200: { description: "Verified" },
          409: { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/workspaces/{workspace}/integration/{seq}/result": {
      post: {
        tags: ["integration"],
        summary: "Report the integration result (runner only)",
        description:
          "`merged` releases the changeset's leases; `rejected` keeps them " +
          "so the agent can fix within its scope and re-ready.",
        operationId: "reportJob",
        parameters: [
          { $ref: "#/components/parameters/workspace" },
          { name: "seq", in: "path", required: true, schema: { type: "integer" } },
        ],
        responses: { 200: { description: "Recorded" }, 409: { $ref: "#/components/responses/Conflict" } },
      },
    },
    "/api/workspaces/{workspace}/sessions": {
      post: {
        tags: ["sessions"],
        summary: "Create a session (changeset + leases + fork in one call)",
        description:
          "Local mode (no Artifacts binding): prepares a local fork. With " +
          "Artifacts bound: creates an Artifacts session fork whose write " +
          "token is scoped to that fork only.",
        operationId: "createSession",
        parameters: [{ $ref: "#/components/parameters/workspace" }],
        responses: { 201: { description: "Session created" }, 503: { description: "Artifacts not configured" } },
      },
    },
    "/api/workspaces/{workspace}/setup": {
      put: {
        tags: ["workspace"],
        summary: "Provision the workspace repo (Artifacts mode)",
        operationId: "setupWorkspace",
        parameters: [{ $ref: "#/components/parameters/workspace" }],
        responses: { 200: { description: "Provisioned" } },
      },
    },
  },
  components: {
    parameters: {
      workspace: {
        name: "workspace",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9_-]{2,48}$" },
        description: "Workspace name; one Coordinator Durable Object per workspace",
      },
      changesetId: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
    },
    responses: {
      BadRequest: { description: "400 invalid_request" },
      NotFound: { description: "404 not_found" },
      Conflict: {
        description: "409 lease_conflict / lease_violation / state errors",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiError" },
          },
        },
      },
    },
    schemas: {
      ApiError: {
        type: "object",
        required: ["error", "message"],
        properties: {
          error: { type: "string", examples: ["lease_conflict"] },
          message: { type: "string" },
          conflicts: { type: "array", items: { $ref: "#/components/schemas/LeaseConflict" } },
          violations: { type: "array", items: { type: "string" } },
        },
      },
      Changeset: {
        type: "object",
        required: ["id", "agent", "intent", "status"],
        properties: {
          id: { type: "string", format: "uuid" },
          agent: { type: "string" },
          intent: { type: "string" },
          status: {
            type: "string",
            enum: ["open", "queued", "integrating", "merged", "rejected", "aborted"],
          },
          forkRepo: { type: ["string", "null"] },
          forkRemote: { type: ["string", "null"] },
          ref: { type: ["string", "null"] },
          createdAt: { type: "integer" },
          updatedAt: { type: "integer" },
        },
      },
      Lease: {
        type: "object",
        required: ["path", "changeset", "agent"],
        properties: {
          path: {
            type: "string",
            description: "File path, or directory claim with trailing slash (`src/`)",
          },
          changeset: { type: "string" },
          agent: { type: "string" },
          acquiredAt: { type: "integer" },
          expiresAt: { type: "integer" },
        },
      },
      LeaseConflict: {
        type: "object",
        required: ["path", "changeset", "agent"],
        properties: {
          path: { type: "string" },
          changeset: { type: "string" },
          agent: { type: "string" },
          expiresAt: { type: "integer" },
        },
      },
      Job: {
        type: "object",
        required: ["seq", "changeset", "ref", "status"],
        properties: {
          seq: { type: "integer" },
          changeset: { type: "string" },
          ref: { type: "string" },
          status: { type: "string", enum: ["pending", "running", "merged", "rejected"] },
          reason: { type: ["string", "null"] },
          mergedSha: { type: ["string", "null"] },
          enqueuedAt: { type: "integer" },
          startedAt: { type: ["integer", "null"] },
          finishedAt: { type: ["integer", "null"] },
        },
      },
      Event: {
        type: "object",
        required: ["seq", "type", "payload", "createdAt"],
        properties: {
          seq: { type: "integer" },
          type: { type: "string", examples: ["lease.acquired", "lease.denied", "integration.merged"] },
          payload: { type: "object" },
          createdAt: { type: "integer" },
        },
      },
      WorkspaceSnapshot: {
        type: "object",
        required: ["name", "changesets", "leases", "jobs", "stats"],
        properties: {
          name: { type: "string" },
          config: { type: "object", properties: { mainRemote: { type: ["string", "null"] } } },
          changesets: { type: "array", items: { $ref: "#/components/schemas/Changeset" } },
          leases: { type: "array", items: { $ref: "#/components/schemas/Lease" } },
          jobs: { type: "array", items: { $ref: "#/components/schemas/Job" } },
          recentEvents: { type: "array", items: { $ref: "#/components/schemas/Event" } },
          stats: { type: "object" },
        },
      },
    },
  },
};
