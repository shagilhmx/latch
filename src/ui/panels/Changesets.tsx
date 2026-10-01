import { useState } from "react";
import type { Changeset, IntegrationJob, Lease } from "../../shared/types";
import { api, apiMessage } from "../api";
import { shortId, statusTone } from "../format";

const ABLE_STATUSES = new Set(["open", "queued", "integrating", "rejected"]);

export function Changesets({
  workspace,
  changesets,
  leases,
  jobs,
  canAct,
}: {
  workspace: string;
  changesets: Changeset[];
  leases: Lease[];
  jobs: IntegrationJob[];
  canAct: boolean;
}) {
  const root = `/api/workspaces/${encodeURIComponent(workspace)}`;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const newestFirst = [...changesets].reverse();

  async function abort(changesetId: string): Promise<void> {
    setBusyId(changesetId);
    setError(null);
    const response = await api(
      `${root}/changesets/${encodeURIComponent(changesetId)}/abort`,
      { method: "POST", body: JSON.stringify({}) },
    );
    if (response.status !== 200) setError(apiMessage(response));
    setBusyId(null);
  }

  return (
    <article className="panel" aria-label="Changesets">
      <h2>
        Changesets <span className="count">{changesets.length} total</span>
      </h2>
      {changesets.length === 0 ? (
        <p className="hint">
          Each agent session opens a changeset: intent, claimed scope, and its
          path to main.
        </p>
      ) : (
        <ul className="changeset-list">
          {newestFirst.map((changeset) => {
            const held = leases.filter((lease) => lease.changeset === changeset.id);
            const job = jobs.find(
              (candidate) => candidate.changeset === changeset.id,
            );
            const tone = statusTone(changeset.status);
            const abortable = canAct && ABLE_STATUSES.has(changeset.status);
            return (
              <li key={changeset.id} className={`changeset tone-${tone}`}>
                <div className="changeset-head">
                  <span className={`chip tone-${tone}`}>{changeset.status}</span>
                  <strong>{changeset.agent}</strong>
                  <span className="mono muted">{shortId(changeset.id)}</span>
                  {abortable && (
                    <button
                      type="button"
                      className="btn btn-danger btn-small changeset-abort"
                      aria-label={`Abort changeset ${shortId(changeset.id)}`}
                      disabled={busyId === changeset.id}
                      onClick={() => void abort(changeset.id)}
                    >
                      {busyId === changeset.id ? "Aborting…" : "Abort"}
                    </button>
                  )}
                </div>
                <p className="intent">{changeset.intent}</p>
                <p className="meta">
                  {held.length > 0 ? (
                    <span>
                      leases: {held.map((lease) => lease.path).join(", ")}
                    </span>
                  ) : (
                    <span className="muted">no leases held</span>
                  )}
                  {job !== undefined && (
                    <span className="muted">
                      {" · "}
                      job #{job.seq} {job.status}
                      {job.attempt > 1 ? ` (attempt ${job.attempt})` : ""}
                      {job.mergedSha !== null ? ` (${shortId(job.mergedSha)})` : ""}
                      {job.reason !== null ? ` — ${job.reason}` : ""}
                    </span>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {error !== null && <p className="form-msg error">{error}</p>}
    </article>
  );
}
