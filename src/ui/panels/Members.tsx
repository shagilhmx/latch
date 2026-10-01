import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, apiMessage } from "../api";

interface Member {
  userId: string;
  login: string;
  role: string;
  addedAt: number;
}

interface MembersProps {
  workspace: string;
  /** False when the visitor cannot write (GitHub mode, signed out). */
  canAct: boolean;
  authLoading: boolean;
  signInHref: string;
}

type FormState = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string };

const ROLES = ["read", "write", "owner"] as const;

/**
 * Workspace membership: who may act, and with which role. Reads are public
 * (like the rest of the monitor); every mutation is authorized server-side
 * as an owner action, and the API's answer — including last-owner
 * protection — is rendered inline.
 */
export function Members({ workspace, canAct, authLoading, signInHref }: MembersProps) {
  const root = `/api/workspaces/${encodeURIComponent(workspace)}`;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [userId, setUserId] = useState("");
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<string>("write");
  const [state, setState] = useState<FormState>({ kind: "idle" });

  const load = useCallback(async (): Promise<void> => {
    const response = await api<{ members?: Member[] }>(`${root}/members`);
    if (Array.isArray(response.body?.members)) setMembers(response.body.members);
  }, [root]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (userId.trim().length === 0 || login.trim().length === 0) {
      setState({ kind: "error", message: "User ID and login are required" });
      return;
    }
    setState({ kind: "busy" });
    const response = await api<{ members?: Member[] }>(`${root}/members`, {
      method: "PUT",
      body: JSON.stringify({ userId: userId.trim(), login: login.trim(), role }),
    });
    if (response.status !== 200) {
      setState({ kind: "error", message: apiMessage(response) });
      return;
    }
    if (Array.isArray(response.body?.members)) setMembers(response.body.members);
    setUserId("");
    setLogin("");
    setState({ kind: "idle" });
  }

  async function remove(member: Member): Promise<void> {
    setState({ kind: "busy" });
    const response = await api<{ members?: Member[] }>(
      `${root}/members/${encodeURIComponent(member.userId)}`,
      { method: "DELETE" },
    );
    if (response.status !== 200) {
      setState({ kind: "error", message: apiMessage(response) });
      return;
    }
    if (Array.isArray(response.body?.members)) setMembers(response.body.members);
    setState({ kind: "idle" });
  }

  return (
    <article className="panel panel-wide" aria-label="Members">
      <h2>
        Members <span className="count">{members?.length ?? 0} with access</span>
      </h2>

      {members === null ? (
        <p className="hint">Loading members…</p>
      ) : members.length === 0 ? (
        <p className="hint">
          No members yet. The first identity to write to this workspace becomes
          its owner.
        </p>
      ) : (
        <ul className="member-list">
          {members.map((member) => (
            <li key={member.userId} className="member">
              <span className="member-login">{member.login}</span>
              <span className={`chip tone-${member.role === "owner" ? "ok" : "neutral"}`}>
                {member.role}
              </span>
              <span className="mono muted">{member.userId}</span>
              {canAct && (
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  onClick={() => void remove(member)}
                  disabled={state.kind === "busy"}
                  aria-label={`Remove ${member.login}`}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canAct ? (
        <form className="form-grid" onSubmit={(event) => void add(event)}>
          <div className="form-row">
            <div className="field">
              <label htmlFor="member-id">User ID</label>
              <input
                id="member-id"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                placeholder="github id or dev"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="member-login">Login</label>
              <input
                id="member-login"
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                placeholder="octocat"
                autoComplete="off"
              />
            </div>
            <div className="field field-narrow">
              <label htmlFor="member-role">Role</label>
              <select
                id="member-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {ROLES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn" disabled={state.kind === "busy"}>
              {state.kind === "busy" ? "Saving…" : "Add member"}
            </button>
          </div>
          {state.kind === "error" && <p className="form-msg error">{state.message}</p>}
        </form>
      ) : (
        <p className="hint">
          {authLoading
            ? "Checking identity…"
            : "Changing membership needs an identity. "}
          {!authLoading && (
            <a className="signin" href={signInHref}>
              Sign in with GitHub
            </a>
          )}
        </p>
      )}
    </article>
  );
}
