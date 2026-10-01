import type { Changeset, IntegrationJob, Lease } from "../../shared/types";
import { shortId, statusTone } from "../format";

export function Changesets({
  changesets,
  leases,
  jobs,
}: {
  changesets: Changeset[];
  leases: Lease[];
  jobs: IntegrationJob[];
}) {
  const newestFirst = [...changesets].reverse();

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
            return (
              <li key={changeset.id} className={`changeset tone-${tone}`}>
                <div className="changeset-head">
                  <span className={`chip tone-${tone}`}>{changeset.status}</span>
                  <strong>{changeset.agent}</strong>
                  <span className="mono muted">{shortId(changeset.id)}</span>
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
    </article>
  );
}
