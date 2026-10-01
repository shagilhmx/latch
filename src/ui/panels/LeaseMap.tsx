import type { Lease } from "../../shared/types";
import { expiresIn, shortId } from "../format";

export function LeaseMap({ leases, now }: { leases: Lease[]; now: number }) {
  return (
    <article className="panel panel-wide" aria-label="Lease map">
      <h2>
        Lease map <span className="count">{leases.length} held</span>
      </h2>
      {leases.length === 0 ? (
        <p className="hint">
          No active leases. Agents claim file scope before editing — overlapping
          claims are refused here, before any work happens.
        </p>
      ) : (
        <table className="grid-table">
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Agent</th>
              <th scope="col">Changeset</th>
              <th scope="col">Deadline</th>
            </tr>
          </thead>
          <tbody>
            {leases.map((lease) => {
              const expired = lease.expiresAt <= now;
              return (
                <tr key={lease.path} className={expired ? "row-expired" : undefined}>
                  <td>
                    <code>{lease.path}</code>
                  </td>
                  <td>{lease.agent}</td>
                  <td>
                    <span className="mono">{shortId(lease.changeset)}</span>
                  </td>
                  <td className={expired ? "tone-bad" : "tone-muted"}>
                    {expiresIn(lease.expiresAt, now)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </article>
  );
}
