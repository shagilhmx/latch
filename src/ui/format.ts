import type { CoordinationEvent, ChangesetStatus } from "../shared/types";

/** First 8 chars of an id/sha — enough to correlate by eye. */
export function shortId(id: string | null | undefined): string {
  if (id === null || id === undefined || id.length === 0) return "—";
  return id.slice(0, 8);
}

export function timeAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** Live countdown for a lease deadline. */
export function expiresIn(expiresAt: number, now: number): string {
  const seconds = Math.round((expiresAt - now) / 1000);
  if (seconds <= 0) return "expired";
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h left`;
}

export type Tone = "ok" | "busy" | "bad" | "neutral";

export function statusTone(status: ChangesetStatus | string): Tone {
  switch (status) {
    case "merged":
      return "ok";
    case "open":
      return "neutral";
    case "queued":
    case "integrating":
      return "busy";
    case "rejected":
    case "aborted":
      return "bad";
    default:
      return "neutral";
  }
}

function listPaths(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : "some paths";
}

/** Human summary for one coordination event, shown in the merge stream. */
export function describeEvent(event: CoordinationEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const agent = String(payload["agent"] ?? "agent");
  const changeset = String(payload["changeset"] ?? "");
  const short = shortId(changeset);

  switch (event.type) {
    case "changeset.created":
      return `${agent}: ${String(payload["intent"] ?? "")}`;
    case "changeset.ready":
      return `${short} ready via ${String(payload["via"] ?? "ready")} (${listPaths(payload["paths"])})`;
    case "changeset.blocked":
      return `${short} blocked — not leased: ${listPaths(payload["violations"])}`;
    case "changeset.aborted":
      return `${short} aborted`;
    case "lease.acquired":
      return `${agent} claimed ${listPaths(payload["paths"])}`;
    case "lease.denied":
      return `${agent} was refused ${listPaths(payload["paths"])} — already leased`;
    case "lease.released":
      return `${listPaths(payload["paths"])} released`;
    case "lease.expired":
      return `${listPaths(payload["paths"])} expired`;
    case "integration.claimed":
      return `job ${String(payload["job"])} claimed → ${short}`;
    case "integration.requeued":
      return `job ${String(payload["job"])} requeued — runner went silent (attempt ${String(payload["attempt"] ?? "?")})`;
    case "integration.verified":
      return `verified ${listPaths(payload["paths"])}`;
    case "integration.merged":
      return `${short} merged into main (${shortId(String(payload["mergedSha"] ?? ""))})`;
    case "integration.rejected":
      return `${short} rejected — ${String(payload["reason"] ?? payload["violations"] ?? "see log")}`;
    case "session.forked":
      return `${short} forked ${String(payload["forkRepo"] ?? "")}`;
    case "workspace.configured":
      return `main → ${String(payload["mainRemote"] ?? "")}`;
    case "auth.denied":
      return `${String(payload["actor"] ?? "someone")} denied ${String(payload["action"] ?? "")} — ${String(payload["code"] ?? "forbidden")}`;
    case "member.joined":
      return `${String(payload["actor"] ?? "someone")} joined as ${String(payload["role"] ?? "member")}`;
    case "member.updated":
      return `${String(payload["actor"] ?? "someone")} → ${String(payload["role"] ?? "member")}`;
    case "member.removed":
      return `${String(payload["actor"] ?? "someone")} removed from workspace`;
    default:
      return event.type;
  }
}

/** Events worth showing in the stream (drops heartbeat/noise). */
export function streamable(event: CoordinationEvent): boolean {
  return event.type !== "lease.heartbeat";
}
