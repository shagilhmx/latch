/**
 * Authorization policy for workspace actions — pure functions, unit-tested
 * across both modes without HTTP.
 *
 * Model (mirrors a public GitHub repository):
 *  - **read** is open to everyone (the live UI is a public monitor).
 *  - **write** (changesets, leases, ready, abort, fork, sessions) requires
 *    an authenticated actor who is a workspace member. The FIRST actor to
 *    touch an empty workspace bootstraps as its owner.
 *  - **owner** (workspace config, member management) additionally requires
 *    the `owner` role.
 *
 * Modes:
 *  - `github` — production: actor comes from the signed session cookie;
 *    anonymous requests are refused with 401 before any state changes.
 *  - `dev`    — local/test: no `AUTH_SECRET` configured, every request is
 *    attributed to the built-in `dev` actor (or a dev-switched identity),
 *    so the demo and the test suite run accountless.
 *
 * The file also holds runner authorization (`authorizeRunner`): the
 * integration and internal routes are a *system* surface with no user
 * actor, so they are gated by a shared secret instead — see below.
 */
import { tokenEquals } from "../shared/runner-token.ts";

export type AuthMode = "github" | "dev";
export type Role = "read" | "write" | "owner";
export type Action = "read" | "write" | "owner";

export interface Actor {
  id: string;
  login: string;
  avatarUrl?: string;
}

export const DEV_ACTOR: Actor = { id: "dev", login: "dev" };

export function authMode(env: { AUTH_SECRET?: string | undefined }): AuthMode {
  return env.AUTH_SECRET !== undefined && env.AUTH_SECRET.length > 0 ? "github" : "dev";
}

const ROLE_RANK: Record<Role, number> = { read: 0, write: 1, owner: 2 };

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export type AuthzResult =
  | { allowed: true; bootstrapOwner: boolean }
  | { allowed: false; status: 401 | 403; code: string; message: string };

/**
 * Decide whether `actor` may perform `action` on a workspace where they
 * hold `memberRole` (null = not a member) among `memberCount` members.
 * `memberCount === 0` means a brand-new workspace: the first write/owner
 * action bootstraps the actor as owner.
 */
export function authorize(input: {
  mode: AuthMode;
  actor: Actor | null;
  action: Action;
  memberRole: Role | null;
  memberCount: number;
}): AuthzResult {
  const { mode, actor, action, memberRole, memberCount } = input;

  if (action === "read") return { allowed: true, bootstrapOwner: false };

  if (actor === null) {
    if (mode === "dev") {
      // Dev mode never has anonymous actors; be defensive anyway.
      return { allowed: true, bootstrapOwner: memberCount === 0 };
    }
    return {
      allowed: false,
      status: 401,
      code: "auth_required",
      message: "Sign in to make changes (GET /api/auth/login)",
    };
  }

  // Brand-new workspace: whoever acts first owns it.
  if (memberCount === 0) return { allowed: true, bootstrapOwner: true };

  if (memberRole === null) {
    return {
      allowed: false,
      status: 403,
      code: "member_required",
      message: `User "${actor.login}" is not a member of this workspace; ask an owner to add them (PUT /members)`,
    };
  }

  const needed: Role = action === "owner" ? "owner" : "write";
  if (!roleAtLeast(memberRole, needed)) {
    return {
      allowed: false,
      status: 403,
      code: action === "owner" ? "owner_required" : "write_required",
      message:
        action === "owner"
          ? `User "${actor.login}" has role ${memberRole}; owner required`
          : `User "${actor.login}" has role ${memberRole}; write access required`,
    };
  }

  return { allowed: true, bootstrapOwner: false };
}

// ------------------------------------------------------------ runner auth

export interface RunnerEnv {
  RUNNER_TOKEN?: string | undefined;
  AUTH_SECRET?: string | undefined;
}

export type RunnerAuthzResult =
  | { allowed: true }
  | { allowed: false; status: 401 | 503; code: string; message: string };

/**
 * Authorization for the trusted system routes (`/integration/*`,
 * `/internal/*`). A claim response carries the session fork's write token
 * and verify/result gate merges into `main`, so these routes must never be
 * reachable anonymously in production — even though they intentionally skip
 * *user* authz (a runner is not a user).
 *
 * Policy, mirroring the modes above:
 *  - `RUNNER_TOKEN` configured   → the request must present it (compared
 *    in constant time), in either mode.
 *  - not configured + dev mode   → open, so the demo and the test suite run
 *    accountless.
 *  - not configured + github mode → fail closed (503): a deployed worker
 *    with session auth must not expose the queue until a token exists.
 *
 * `providedToken` is the raw `x-latch-runner-token` header value (null when
 * absent); keeping it a plain argument keeps this function pure and
 * unit-testable without HTTP.
 */
export async function authorizeRunner(
  env: RunnerEnv,
  providedToken: string | null,
): Promise<RunnerAuthzResult> {
  const configured = typeof env.RUNNER_TOKEN === "string" ? env.RUNNER_TOKEN.trim() : "";

  if (configured.length === 0) {
    if (authMode(env) === "dev") return { allowed: true };
    return {
      allowed: false,
      status: 503,
      code: "runner_token_not_configured",
      message:
        "Runner routes are disabled: set the RUNNER_TOKEN secret on the worker " +
        "and pass it to the integration runner (--runner-token).",
    };
  }

  if (providedToken === null) {
    return {
      allowed: false,
      status: 401,
      code: "runner_auth_required",
      message: "Missing x-latch-runner-token header on a runner-only route",
    };
  }
  if (!(await tokenEquals(providedToken, configured))) {
    return {
      allowed: false,
      status: 401,
      code: "runner_auth_invalid",
      message: "Invalid runner token",
    };
  }
  return { allowed: true };
}
