import { useEffect, useState, type FormEvent } from "react";
import type { LeaseConflict } from "../../shared/types";
import { api, apiMessage } from "../api";
import { shortId } from "../format";

interface ClaimProps {
  workspace: string;
  /** False when the visitor cannot write (GitHub mode, signed out). */
  canAct: boolean;
  /** Identity still loading — keep the form visible but inert. */
  authLoading: boolean;
  /** Prefilled agent name (the signed-in login, or `dev`). */
  defaultAgent: string;
  signInHref: string;
}

type ClaimState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string; conflicts?: LeaseConflict[] };

function parsePaths(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

/**
 * The human entry point into Latch: open a changeset and claim its file
 * scope in one step (POST /changesets, then POST …/leases). A conflicting
 * claim is refused server-side and rendered here — that refusal *is* the
 * product: the overlap never becomes a merge conflict.
 */
export function Claim({
  workspace,
  canAct,
  authLoading,
  defaultAgent,
  signInHref,
}: ClaimProps) {
  const root = `/api/workspaces/${encodeURIComponent(workspace)}`;
  const [agent, setAgent] = useState(defaultAgent);
  const [intent, setIntent] = useState("");
  const [paths, setPaths] = useState("");
  const [state, setState] = useState<ClaimState>({ kind: "idle" });

  // The identity may resolve after mount — prefill the agent name then,
  // but never clobber what the user already typed.
  useEffect(() => {
    setAgent((current) => (current.trim().length === 0 ? defaultAgent : current));
  }, [defaultAgent]);

  if (!canAct) {
    return (
      <article className="panel panel-wide" aria-label="Claim scope">
        <h2>
          Claim scope <span className="count">sign in to act</span>
        </h2>
        <p className="hint">
          {authLoading
            ? "Checking identity…"
            : "Reading is public, but claiming leases needs an identity. "}
          {!authLoading && (
            <a className="signin" href={signInHref}>
              Sign in with GitHub
            </a>
          )}
        </p>
      </article>
    );
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const claimedPaths = parsePaths(paths);
    if (agent.trim().length === 0 || intent.trim().length === 0) {
      setState({ kind: "error", message: "Agent and intent are required" });
      return;
    }

    setState({ kind: "busy" });
    const created = await api<{ changeset?: { id: string } }>(`${root}/changesets`, {
      method: "POST",
      body: JSON.stringify({ agent: agent.trim(), intent: intent.trim() }),
    });
    const changesetId = created.body?.changeset?.id;
    if (created.status !== 201 || changesetId === undefined) {
      setState({ kind: "error", message: apiMessage(created) });
      return;
    }

    if (claimedPaths.length > 0) {
      const leased = await api<{ conflicts?: LeaseConflict[] }>(
        `${root}/changesets/${encodeURIComponent(changesetId)}/leases`,
        { method: "POST", body: JSON.stringify({ paths: claimedPaths }) },
      );
      if (leased.status !== 200) {
        // Leave nothing half-open: roll the empty changeset back.
        await api(`${root}/changesets/${encodeURIComponent(changesetId)}/abort`, {
          method: "POST",
          body: JSON.stringify({}),
        }).catch(() => undefined);
        setState({
          kind: "error",
          message: apiMessage(leased),
          conflicts: leased.body?.conflicts,
        });
        return;
      }
    }

    setIntent("");
    setPaths("");
    setState({
      kind: "ok",
      message:
        claimedPaths.length > 0
          ? `Claimed ${claimedPaths.length} path${claimedPaths.length === 1 ? "" : "s"} on ${shortId(changesetId)}`
          : `Changeset ${shortId(changesetId)} opened (no paths claimed)`,
    });
  }

  return (
    <article className="panel panel-wide" aria-label="Claim scope">
      <h2>
        Claim scope <span className="count">changeset + leases in one step</span>
      </h2>
      <p className="hint">
        Overlapping claims are refused here, before any editing happens.
      </p>
      <form className="form-grid" onSubmit={(event) => void submit(event)}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="claim-agent">Agent</label>
            <input
              id="claim-agent"
              name="agent"
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div className="field field-grow">
            <label htmlFor="claim-intent">Intent</label>
            <input
              id="claim-intent"
              name="intent"
              placeholder="What this session will change"
              value={intent}
              onChange={(event) => setIntent(event.target.value)}
              autoComplete="off"
              required
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field field-grow">
            <label htmlFor="claim-paths">Paths to lease</label>
            <input
              id="claim-paths"
              name="paths"
              placeholder="src/auth.ts src/api/  (comma or space separated)"
              value={paths}
              onChange={(event) => setPaths(event.target.value)}
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn" disabled={state.kind === "busy"}>
            {state.kind === "busy" ? "Claiming…" : "Claim scope"}
          </button>
        </div>
      </form>
      {state.kind === "ok" && (
        <p className="form-msg ok" role="status">
          {state.message}
        </p>
      )}
      {state.kind === "error" && (
        <div className="form-msg error">
          <p>{state.message}</p>
          {state.conflicts !== undefined && state.conflicts.length > 0 && (
            <ul className="conflicts">
              {state.conflicts.map((conflict) => (
                <li key={conflict.path}>
                  <code>{conflict.path}</code> is leased by {conflict.agent} until{" "}
                  {new Date(conflict.expiresAt).toLocaleTimeString()}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}
