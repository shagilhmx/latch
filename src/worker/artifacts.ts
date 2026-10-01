/**
 * Cloudflare Artifacts naming + operations.
 *
 * Naming (all within the `latch` Artifacts namespace):
 *   workspace repo:  ws-<workspace>
 *   session fork:    ws-<workspace>.cs.<first 8 hex of changeset id>
 *
 * The `.cs.` marker is how a `cf.artifacts.repo.pushed` event is mapped back
 * to a workspace and changeset without any external database.
 */

export const SESSION_MARKER = ".cs.";
const SESSION_PREFIX_LENGTH = 8;
const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9_-]{2,48}$/;
const TOKEN_TTL_SECONDS = 3_600;

export class ArtifactError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

export function validateWorkspaceName(name: string): void {
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw new ArtifactError(
      "invalid_workspace",
      `Workspace name must match ${WORKSPACE_NAME_PATTERN} (got ${JSON.stringify(name)})`,
    );
  }
}

export function workspaceRepoName(workspace: string): string {
  return `ws-${workspace}`;
}

export function sessionRepoName(workspace: string, changesetId: string): string {
  const prefix = changesetId.replaceAll("-", "").slice(0, SESSION_PREFIX_LENGTH);
  return `${workspaceRepoName(workspace)}${SESSION_MARKER}${prefix}`;
}

export function parseSessionRepo(
  repoName: string,
): { workspace: string; changesetPrefix: string } | null {
  const match = /^ws-(.+)\.cs\.([0-9a-f]{8})$/.exec(repoName);
  if (match === null) return null;
  return { workspace: match[1] ?? "", changesetPrefix: match[2] ?? "" };
}

export interface EnsuredRepo {
  created: boolean;
  repo: string;
  remote: string;
  defaultBranch: string;
  token: string | null;
  expiresAt: string | null;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = String((error as { code?: unknown }).code ?? "");
  const message = String((error as { message?: unknown }).message ?? "");
  return code === "NOT_FOUND" || /not[\s_-]?found/i.test(message);
}

function disposeRepo(repo: { [Symbol.dispose]?: () => void }): void {
  repo[Symbol.dispose]?.();
}

export async function workspaceRepoExists(artifacts: Artifacts, workspace: string): Promise<boolean> {
  try {
    const repo = await artifacts.get(workspaceRepoName(workspace));
    disposeRepo(repo as unknown as { [Symbol.dispose]?: () => void });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Get-or-create the workspace repository that holds `main`. */
export async function ensureWorkspaceRepo(
  artifacts: Artifacts,
  workspace: string,
): Promise<EnsuredRepo> {
  validateWorkspaceName(workspace);
  const name = workspaceRepoName(workspace);

  try {
    const repo = await artifacts.get(name);
    try {
      const info = await repo.info();
      const token = await repo.createToken("write", TOKEN_TTL_SECONDS);
      return {
        created: false,
        repo: name,
        remote: info.remote,
        defaultBranch: info.defaultBranch,
        token: token.plaintext,
        expiresAt: token.expiresAt,
      };
    } finally {
      disposeRepo(repo as unknown as { [Symbol.dispose]?: () => void });
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const created = await artifacts.create(name, {
    description: `Latch workspace "${workspace}" (main lives here)`,
    readOnly: false,
    setDefaultBranch: "main",
  });
  return {
    created: true,
    repo: name,
    remote: created.remote,
    defaultBranch: created.defaultBranch,
    token: created.token ?? null,
    expiresAt: (created as { expiresAt?: string }).expiresAt ?? null,
  };
}

/** Import an existing Git remote as the workspace repository. */
export async function importWorkspaceRepo(
  artifacts: Artifacts,
  workspace: string,
  sourceUrl: string,
): Promise<EnsuredRepo> {
  validateWorkspaceName(workspace);
  const name = workspaceRepoName(workspace);
  const imported = await artifacts.import({
    source: { url: sourceUrl },
    target: { name },
  });
  return {
    created: true,
    repo: name,
    remote: imported.remote,
    defaultBranch: imported.defaultBranch,
    token: imported.token ?? null,
    expiresAt: (imported as { expiresAt?: string }).expiresAt ?? null,
  };
}

export interface SessionFork {
  repo: string;
  remote: string;
  defaultBranch: string;
  token: string | null;
}

/**
 * Fork the workspace repository into an isolated per-session repo. This is
 * the enforcement boundary: the session's write token only works here, never
 * against `main`.
 */
export async function createSessionFork(
  artifacts: Artifacts,
  workspace: string,
  changesetId: string,
): Promise<SessionFork> {
  validateWorkspaceName(workspace);
  const sourceName = workspaceRepoName(workspace);
  const forkName = sessionRepoName(workspace, changesetId);

  const source = await artifacts.get(sourceName);
  try {
    const forked = await source.fork(forkName, {
      description: `Session fork for changeset ${changesetId}`,
      readOnly: false,
    });
    return {
      repo: forked.name,
      remote: forked.remote,
      defaultBranch: forked.defaultBranch,
      token: forked.token ?? null,
    };
  } finally {
    disposeRepo(source as unknown as { [Symbol.dispose]?: () => void });
  }
}
