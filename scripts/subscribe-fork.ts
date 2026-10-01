/**
 * Subscribe one session fork repo to Latch's push-events queue, so pushes
 * to that fork are delivered to `POST /internal/pushed` and integration
 * runs automatically.
 *
 *   CLOUDFLARE_API_TOKEN=<token with Queues + Artifacts read> \
 *   CLOUDFLARE_ACCOUNT_ID=<account id> \
 *   node scripts/subscribe-fork.ts <repoName> [--namespace latch] [--queue latch-artifacts-events]
 *
 * Example repo name: `ws-live.cs.1a2b3c4d` (see sessionRepoName()).
 *
 * Normally you don't run this by hand: pass `subscribePushes` to
 * startSession() and the fork is subscribed when the session starts.
 */
import {
  DEFAULT_ARTIFACTS_NAMESPACE,
  DEFAULT_EVENTS_QUEUE,
  subscribeForkPushes,
} from "../src/integration/fork-events.ts";

const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const repoName = args.find((arg) => !arg.startsWith("--"));
  if (repoName === undefined || repoName.length === 0) {
    console.error("Usage: node scripts/subscribe-fork.ts <repoName> [--namespace ns] [--queue name]");
    process.exitCode = 1;
    return;
  }

  const result = await subscribeForkPushes(repoName, {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? null,
    namespace: argValue("--namespace") ?? DEFAULT_ARTIFACTS_NAMESPACE,
    queueName: argValue("--queue") ?? DEFAULT_EVENTS_QUEUE,
  });

  switch (result.status) {
    case "subscribed":
      console.log(
        `[fork-events] subscribed ${repoName} → queue ${result.queueId} (subscription ${result.subscriptionId})`,
      );
      return;
    case "not_configured":
      console.error(`[fork-events] skipped: ${result.reason}`);
      process.exitCode = 1;
      return;
    case "error":
      console.error(`[fork-events] failed (${result.httpStatus}): ${result.reason}`);
      process.exitCode = 1;
      return;
  }
}

main().catch((error: unknown) => {
  console.error("[fork-events] fatal:", error);
  process.exitCode = 1;
});
