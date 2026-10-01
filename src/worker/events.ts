import { runnerHeaders } from "../shared/runner-token.ts";
import { parseSessionRepo } from "./artifacts";

/** Shape of a `cf.artifacts.repo.pushed` event (see Artifacts event docs). */
export interface ArtifactsPushEvent {
  type?: string;
  source?: { type?: string; namespace?: string; repoName?: string };
  payload?: { ref?: string; after?: string; before?: string };
}

export type PushEventResult = "forwarded" | "ignored" | "invalid";

/**
 * Handles one event-subscription message. Pushes to session forks are
 * forwarded to the owning workspace's Coordinator, which enqueues the
 * integration job. Pushes to the workspace `main` repo (our own merge
 * commits) and foreign repos are ignored — they are the output of the
 * integration job, not its input.
 */
export async function handleArtifactsEvent(
  raw: unknown,
  env: Env,
): Promise<PushEventResult> {
  if (typeof raw !== "object" || raw === null) return "invalid";

  const event = raw as ArtifactsPushEvent;
  if (event.type !== "cf.artifacts.repo.pushed") return "ignored";

  const repoName = event.source?.repoName;
  if (typeof repoName !== "string" || repoName.length === 0) return "invalid";

  const parsed = parseSessionRepo(repoName);
  if (parsed === null) return "ignored";

  const ref = event.payload?.after ?? event.payload?.ref;
  if (typeof ref !== "string" || ref.length === 0) return "invalid";

  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName(parsed.workspace));
  // Durable Object stub fetches require an absolute URL; the origin is
  // decorative (the stub routes it to the object regardless of host).
  const target = new URL(
    `/api/workspaces/${encodeURIComponent(parsed.workspace)}/internal/pushed`,
    "https://coordinator.latch.internal",
  );
  const response = await coordinator.fetch(target.toString(), {
      method: "POST",
      // The queue consumer is a system caller: when a RUNNER_TOKEN is
      // configured it must present it, just like the integration runner.
      headers: { "content-type": "application/json", ...runnerHeaders(env.RUNNER_TOKEN) },
      body: JSON.stringify({ repoName, ref }),
    },
  );

  if (!response.ok) {
    throw new Error(`Coordinator rejected push event with status ${response.status}`);
  }
  return "forwarded";
}
