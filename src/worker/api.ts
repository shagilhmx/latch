import {
  ArtifactError,
  createSessionFork,
  ensureWorkspaceRepo,
  importWorkspaceRepo,
  validateWorkspaceName,
  workspaceRepoExists,
  workspaceRepoName,
} from "./artifacts";
import { HttpProblem, apiError, json, readBody, requireString } from "./http";

const WORKSPACE_ROUTE = /^\/api\/workspaces\/([^/]+)(\/.*)?$/;

function coordinatorFor(env: Env, workspace: string): DurableObjectStub {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(workspace));
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
  return coordinatorFor(env, workspace).fetch(target, init);
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

/** API router: workspace-owned routes handled here, the rest by the DO. */
export async function handleApi(request: Request, env: Env): Promise<Response> {
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
    return await coordinatorFor(env, workspace).fetch(request);
  } catch (error) {
    if (error instanceof HttpProblem) {
      return apiError(error.status, error.code, error.message, error.extra);
    }
    return apiError(500, "internal", (error as Error).message);
  }
}

export { workspaceRepoName };
