import { handleApi } from "./api";
import { handleArtifactsEvent } from "./events";
import { Coordinator } from "./coordinator";

export { Coordinator };

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    return env.ASSETS.fetch(request);
  },

  /** Consumer for the `latch-artifacts-events` queue (event subscriptions). */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleArtifactsEvent(message.body, env);
        message.ack();
      } catch (error) {
        console.error("Failed to handle Artifacts event", error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
