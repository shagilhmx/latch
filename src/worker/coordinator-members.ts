/**
 * Workspace membership management. The route layer authorizes these as
 * owner-level actions before the handlers run; here we validate input and
 * protect the last owner from demotion/removal (lockout prevention).
 */
import type { Role } from "./authz";
import { HttpProblem, json, readBody, requireString } from "./http";
import type { CoordinatorStore } from "./coordinator-store";

const VALID_ROLES: ReadonlySet<string> = new Set(["read", "write", "owner"]);

function serialize(store: CoordinatorStore): { members: unknown[] } {
  return {
    members: store.members().map((row) => ({
      userId: row.user_id,
      login: row.login,
      role: row.role,
      addedAt: row.added_at,
    })),
  };
}

export function listMembers(store: CoordinatorStore): Response {
  return json(serialize(store));
}

export function putMember(store: CoordinatorStore, request: Request): Promise<Response> {
  return (async () => {
    const body = await readBody(request);
    const userId = requireString(body, "userId");
    const login = requireString(body, "login");
    const role = requireString(body, "role");
    if (!VALID_ROLES.has(role)) {
      throw new HttpProblem(400, "invalid_field", `"role" must be read, write, or owner`);
    }

    const current = store.getMember(userId);
    const owners = store.members().filter((row) => row.role === "owner");
    const demotingLastOwner =
      current?.role === "owner" &&
      role !== "owner" &&
      owners.length === 1 &&
      owners[0]?.user_id === userId;
    if (demotingLastOwner) {
      throw new HttpProblem(409, "last_owner", "Cannot demote the workspace's last owner");
    }

    store.upsertMember({ id: userId, login }, role as Role);
    store.emit("member.updated", { actor: login, role, workspace: store.workspaceName() });
    return json(serialize(store));
  })();
}

export function deleteMember(store: CoordinatorStore, userId: string): Response {
  const current = store.getMember(userId);
  if (current === undefined) {
    throw new HttpProblem(404, "member_not_found", `No member ${userId}`);
  }
  const owners = store.members().filter((row) => row.role === "owner");
  if (current.role === "owner" && owners.length === 1 && owners[0]?.user_id === userId) {
    throw new HttpProblem(409, "last_owner", "Cannot remove the workspace's last owner");
  }

  store.removeMember(userId);
  store.emit("member.removed", { actor: current.login });
  return json(serialize(store));
}
