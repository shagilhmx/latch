import type { CoordinationEvent } from "../../shared/types";
import { describeEvent, streamable, timeAgo } from "../format";

export function MergeStream({
  events,
  now,
}: {
  events: CoordinationEvent[];
  now: number;
}) {
  const stream = events.filter(streamable).slice(0, 24);

  return (
    <article className="panel" aria-label="Merge stream">
      <h2>
        Merge stream <span className="count">live feed</span>
      </h2>
      {stream.length === 0 ? (
        <p className="hint">
          Claims, queue movement, verifications, and merges appear here the
          moment the Coordinator mutates.
        </p>
      ) : (
        <ol className="stream">
          {stream.map((event) => (
            <li key={event.seq} className={`stream-item kind-${kindOf(event)}`}>
              <span className="mono muted">#{event.seq}</span>
              <span className="stream-text">{describeEvent(event)}</span>
              <span className="stream-time muted">{timeAgo(event.createdAt, now)}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function kindOf(event: CoordinationEvent): string {
  if (event.type.startsWith("integration.merged")) return "merged";
  if (event.type.startsWith("integration.rejected")) return "rejected";
  if (event.type.startsWith("lease.denied")) return "denied";
  if (event.type.startsWith("integration")) return "integration";
  if (event.type.startsWith("lease")) return "lease";
  return "changeset";
}
