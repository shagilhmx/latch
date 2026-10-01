/**
 * Latch Agent SDK.
 *
 * Two levels of API:
 *
 * 1. `LatchClient` — typed HTTP client for every coordination endpoint
 *    (claim/heartbeat/release/ready/abort, snapshots, events, the
 *    integration queue, and the live WebSocket stream).
 *
 * 2. The session orchestrator (`startSession` → `finishSession` →
 *    `awaitIntegration` → `abortSession`), which drives the full agent
 *    loop against a `SessionRuntime` (local git or a sandbox container).
 *
 * Example:
 * ```ts
 * import { LatchClient, startSession, awaitIntegration } from "latch/sdk";
 *
 * const client = new LatchClient({ baseUrl, workspace: "demo" });
 * const { changeset } = await client.createChangeset("ada", "Rename loader");
 * await client.claim(changeset.id, ["src/"]);        // directory claim
 * // …edit only inside your leases…
 * await client.ready(changeset.id, sha, touchedPaths);
 * ```
 */
export {
  LatchClient,
  type ApiErrorBody,
  type ApiResponse,
  type ClaimOptions,
  type LatchClientOptions,
} from "./client";

export {
  abortSession,
  awaitIntegration,
  finishSession,
  startSession,
  type FinishSessionResult,
  type IntegrationOutcome,
  type IntegrationOutcomeStatus,
  type StartSessionOptions,
  type StartSessionResult,
} from "../sessions/session.ts";

export type { SessionRuntime, Author } from "../sessions/runtime.ts";
export { LocalSessionRuntime } from "../sessions/local.ts";
