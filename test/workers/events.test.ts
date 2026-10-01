import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sessionRepoName } from "../../src/worker/artifacts";
import { handleArtifactsEvent } from "../../src/worker/events";
import { workspaceApi } from "./helpers";

function pushEvent(repoName: string, after = "cafebabe00000000000000000000000000000000") {
  return {
    type: "cf.artifacts.repo.pushed",
    source: { type: "artifacts", namespace: "latch", repoName },
    payload: { ref: "refs/heads/main", before: "0".repeat(40), after },
  };
}

describe("handleArtifactsEvent", () => {
  it("forwards a session-fork push and enqueues integration", async () => {
    const w = workspaceApi();
    const changesetId = await w.createChangeset("agent-a", "Pushed work");
    await w.post(`/changesets/${changesetId}/leases`, { paths: ["src/pushed.ts"] });
    const forkRepo = sessionRepoName(w.name, changesetId);
    await w.post(`/changesets/${changesetId}/fork`, {
      forkRepo,
      forkRemote: "https://artifacts.example/session.git",
    });

    const result = await handleArtifactsEvent(pushEvent(forkRepo), env);
    expect(result).toBe("forwarded");

    const { body } = await w.get("/");
    expect(body.changesets[0]).toMatchObject({ status: "queued", forkRepo });
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({ status: "pending" });

    const ready = body.recentEvents.find(
      (event: { type: string }) => event.type === "changeset.ready",
    );
    expect(ready.payload.via).toBe("push");
    expect(ready.payload.paths).toEqual(["src/pushed.ts"]);
  });

  it("does not enqueue twice while a job is already active", async () => {
    const w = workspaceApi();
    const changesetId = await w.createChangeset("agent-a", "Double push");
    const forkRepo = sessionRepoName(w.name, changesetId);
    await w.post(`/changesets/${changesetId}/fork`, {
      forkRepo,
      forkRemote: "https://artifacts.example/session.git",
    });

    await handleArtifactsEvent(pushEvent(forkRepo), env);
    const second = await handleArtifactsEvent(pushEvent(forkRepo), env);

    expect(second).toBe("forwarded");
    const { body } = await w.get("/");
    expect(body.jobs).toHaveLength(1);
  });

  it("ignores pushes to the workspace main repo (our own merges)", async () => {
    const w = workspaceApi();
    const result = await handleArtifactsEvent(pushEvent(`ws-${w.name}`), env);
    expect(result).toBe("ignored");
  });

  it("ignores non-push events and foreign repos", async () => {
    expect(await handleArtifactsEvent({ type: "cf.artifacts.repo.created" }, env)).toBe("ignored");
    expect(await handleArtifactsEvent(pushEvent("unrelated-repo"), env)).toBe("ignored");
    expect(await handleArtifactsEvent("not an object", env)).toBe("invalid");
  });

  it("flags pushes without a resolvable ref", async () => {
    const w = workspaceApi();
    const event = {
      ...pushEvent(sessionRepoName(w.name, "deadbeef-0000-0000-0000-000000000000")),
      payload: { ref: "" },
    };
    expect(await handleArtifactsEvent(event, env)).toBe("invalid");
  });

  it("ignores pushes whose changeset is unknown to the workspace", async () => {
    const w = workspaceApi();
    const orphan = sessionRepoName(w.name, "feedface-0000-0000-0000-000000000000");
    const result = await handleArtifactsEvent(pushEvent(orphan), env);
    expect(result).toBe("forwarded"); // Coordinator answers; it just queues nothing
    const { body } = await w.get("/");
    expect(body.jobs).toEqual([]);
  });
});
