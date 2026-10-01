import {
  ArtifactError,
  createSessionFork,
  ensureWorkspaceRepo,
  importWorkspaceRepo,
  validateWorkspaceName,
  workspaceRepoExists,
  workspaceRepoName,
} from "./artifacts";
import { handleAuth, resolveActor } from "./auth";
import { HttpProblem, apiError, json, readBody, requireString } from "./http";

const WORKSPACE_ROUTE = /^\/api\/workspaces\/([^/]+)(\/.*)?$/;

function coordinatorFor(env: Env, workspace: string): DurableObjectStub {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(workspace));
}

/**
 * Identity header for the Coordinator: resolved from the session cookie by
 * the Worker and OVERWRITTEN on every forwarded request, so a client can
 * never forge `x-latch-user` by sending it directly.
 *
 * Other caller headers (content-type, `x-latch-runner-token`, …) are
 * preserved — the Coordinator validates anything it trusts from them.
 */
async function actorHeaders(
  request: Request,
  env: Env,
  base?: HeadersInit,
): Promise<Headers> {
  const headers = base === undefined ? new Headers(request.headers) : new Headers(base);
  headers.delete("x-latch-user");
  const { actor } = await resolveActor(request, env);
  if (actor !== null) {
    headers.set("x-latch-user", JSON.stringify(actor));
  }
  return headers;
}

/** Same guarantee as `actorHeaders`, but for whole forwarded requests. */
async function withActor(request: Request, env: Env): Promise<Request> {
  const headers = await actorHeaders(request, env);
  // Read the body ONCE at the edge: constructing a derived Request moves the
  // stream without consuming it, and workerd raises an uncaught TypeError
  // ("Can't read from request stream after response has been sent") when the
  // outer response completes. The Coordinator receives it as a plain string.
  const body = request.body === null ? null : await request.text();
  const method = request.method.toUpperCase();
  const withBody = body !== null && method !== "GET" && method !== "HEAD";
  return new Request(request.url, {
    method,
    headers,
    ...(withBody ? { body } : {}),
  });
}

async function forwardToCoordinator(
  request: Request,
  env: Env,
  workspace: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(request.url);
  const target = `${url.origin}/api/workspaces/${encodeURIComponent(workspace)}${path}`;
  const headers = await actorHeaders(request, env, init?.headers);
  return coordinatorFor(env, workspace).fetch(target, { ...init, headers });
}

function postJson(path: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function requireArtifacts(env: Env): Artifacts | Response {
  const artifacts = env.ARTIFACTS;
  if (artifacts === undefined) {
    return apiError(
      503,
      "artifacts_unavailable",
      "Artifacts binding not loaded. Deploy with `wrangler deploy -c wrangler.deploy.jsonc` " +
        "(Artifacts is remote-only; local dev runs without it).",
    );
  }
  return artifacts;
}

/**
 * PUT /api/workspaces/:ws/setup — get-or-create (or import) the workspace
 * repository that holds `main`, and record its remote in the Coordinator so
 * the integration runner knows where to push.
 */
async function setupWorkspace(request: Request, env: Env, workspace: string): Promise<Response> {
  try {
    validateWorkspaceName(workspace);
  } catch (error) {
    return apiError(400, (error as ArtifactError).code, (error as Error).message);
  }

  const artifacts = requireArtifacts(env);
  if (artifacts instanceof Response) return artifacts;

  try {
    const body = await readBody(request).catch(() => ({}) as Record<string, unknown>);
    const importUrl =
      typeof body["importUrl"] === "string" && body["importUrl"].length > 0
        ? body["importUrl"]
        : null;

    const result =
      importUrl !== null && !(await workspaceRepoExists(artifacts, workspace))
        ? await importWorkspaceRepo(artifacts, workspace, importUrl)
        : await ensureWorkspaceRepo(artifacts, workspace);

    const configResponse = await forwardToCoordinator(request, env, workspace, "/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mainRemote: result.remote }),
    });
    if (!configResponse.ok) {
      throw new HttpProblem(
        502,
        "coordinator_error",
        `Coordinator rejected workspace config (${configResponse.status})`,
      );
    }

    return json({ workspace, ...result }, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof HttpProblem) {
      return apiError(error.status, error.code, error.message, error.extra);
    }
    return apiError(502, "artifacts_error", (error as Error).message);
  }
}

/**
 * POST /api/workspaces/:ws/sessions — create a changeset and, when Artifacts
 * is available, its isolated session fork (the write-token boundary). In
 * local mode (no binding) the changeset is created and the session runtime
 * owns a filesystem fork instead — `mode` in the response says which.
 */
async function createSession(request: Request, env: Env, workspace: string): Promise<Response> {
  try {
    validateWorkspaceName(workspace);
  } catch (error) {
    return apiError(400, (error as ArtifactError).code, (error as Error).message);
  }

  try {
    const body = await readBody(request);
    const agent = requireString(body, "agent");
    const intent = requireString(body, "intent");

    const changesetResponse = await forwardToCoordinator(
      request,
      env,
      workspace,
      "/changesets",
      postJson("/changesets", { agent, intent }),
    );
    if (!changesetResponse.ok) {
      const text = await changesetResponse.text();
      return new Response(text, {
        status: changesetResponse.status,
        headers: { "content-type": "application/json" },
      });
    }
    const { changeset } = (await changesetResponse.json()) as { changeset: { id: string } };

    const artifacts = env.ARTIFACTS;
    if (artifacts === undefined) {
      return json({ mode: "local", changeset, fork: null, token: null }, 201);
    }

    let fork;
    try {
      fork = await createSessionFork(artifacts, workspace, changeset.id);
    } catch (error) {
      // Roll the changeset back so a failed fork never leaves dead state.
      await forwardToCoordinator(
        request,
        env,
        workspace,
        `/changesets/${changeset.id}/abort`,
        postJson("/changesets", {}),
      ).catch(() => undefined);
      throw error;
    }

    const attachResponse = await forwardToCoordinator(
      request,
      env,
      workspace,
      `/changesets/${changeset.id}/fork`,
      postJson("/changesets", {
        forkRepo: fork.repo,
        forkRemote: fork.remote,
        forkToken: fork.token,
      }),
    );
    if (!attachResponse.ok) {
      throw new HttpProblem(
        502,
        "coordinator_error",
        `Coordinator rejected fork attachment (${attachResponse.status})`,
      );
    }
    const { changeset: updated } = (await attachResponse.json()) as {
      changeset: unknown;
    };

    return json({ mode: "artifacts", changeset: updated, fork, token: fork.token }, 201);
  } catch (error) {
    if (error instanceof HttpProblem) {
      return apiError(error.status, error.code, error.message, error.extra);
    }
    return apiError(502, "artifacts_error", (error as Error).message);
  }
}

/**
 * RPC routes into the per-changeset AgentSandbox Durable Object (deployed
 * config only — the container binding does not exist locally).
 */
async function agentRoute(
  request: Request,
  env: Env,
  changesetId: string,
  action: string,
): Promise<Response> {
  const namespace = env.AGENT_SANDBOX;
  if (namespace === undefined) {
    return apiError(
      503,
      "sandbox_unavailable",
      "Agent sandboxes require the deployed config: " +
        "`wrangler deploy -c wrangler.deploy.jsonc` with Docker available.",
    );
  }

  const stub = namespace.get(namespace.idFromName(changesetId));
  const method = request.method.toUpperCase();
  const requirePost = method === "POST";

  switch (action) {
    case "checkout": {
      if (!requirePost) return apiError(405, "method_not_allowed", "POST required");
      const body = await readBody(request);
      const token = typeof body["token"] === "string" ? body["token"] : null;
      return json(await stub.checkout(requireString(body, "remote"), token));
    }
    case "start": {
      if (!requirePost) return apiError(405, "method_not_allowed", "POST required");
      const body = await readBody(request);
      const state = await stub.startAgentTask(requireString(body, "prompt"));
      return json({ state });
    }
    case "status":
      return json(await stub.status());
    case "diff":
      return new Response(await stub.readDiff(), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    case "push": {
      if (!requirePost) return apiError(405, "method_not_allowed", "POST required");
      const body = await readBody(request);
      const authorRaw = body["author"];
      const author =
        typeof authorRaw === "object" && authorRaw !== null
          ? {
              name: String((authorRaw as { name?: unknown }).name ?? "agent"),
              email: String((authorRaw as { email?: unknown }).email ?? "agent@latch.local"),
            }
          : { name: "agent", email: "agent@latch.local" };
      const token = typeof body["token"] === "string" ? body["token"] : null;
      return json(
        await stub.pushChanges(
          requireString(body, "remote"),
          token,
          requireString(body, "message"),
          author,
        ),
      );
    }
    case "dispose": {
      if (!requirePost) return apiError(405, "method_not_allowed", "POST required");
      await stub.dispose();
      return json({ disposed: true });
    }
    default:
      return apiError(404, "not_found", `Unknown agent action ${action}`);
  }
}

/** API router: workspace-owned routes handled here, the rest by the DO. */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const authResponse = await handleAuth(request, env);
  if (authResponse !== null) return authResponse;

  const url = new URL(request.url);
  const match = WORKSPACE_ROUTE.exec(url.pathname);
  if (match === null) {
    return apiError(404, "not_found", "Unknown API route");
  }

  const workspace = decodeURIComponent(match[1] ?? "");
  const segments = (match[2] ?? "/").split("/").filter((segment) => segment.length > 0);
  const method = request.method.toUpperCase();

  try {
    if (segments[0] === "setup" && segments.length === 1 && (method === "PUT" || method === "POST")) {
      return await setupWorkspace(request, env, workspace);
    }
    if (segments[0] === "sessions" && segments.length === 1 && method === "POST") {
      return await createSession(request, env, workspace);
    }
    if (
      segments[0] === "sessions" &&
      segments.length === 4 &&
      segments[2] === "agent"
    ) {
      return await agentRoute(request, env, segments[1] ?? "", segments[3] ?? "");
    }
    // WebSocket upgrades must be forwarded as the ORIGINAL request —
    // reconstructing it drops the upgrade state (and the stream route does
    // not require an actor).
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return await coordinatorFor(env, workspace).fetch(request);
    }
    return await coordinatorFor(env, workspace).fetch(await withActor(request, env));
  } catch (error) {
    if (error instanceof HttpProblem) {
      return apiError(error.status, error.code, error.message, error.extra);
    }
    return apiError(500, "internal", (error as Error).message);
  }
}

export { workspaceRepoName };
