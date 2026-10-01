import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { workspaceApi, type WorkspaceApi } from "./helpers";

async function connect(w: WorkspaceApi): Promise<WebSocket> {
  const response = await SELF.fetch(`https://latch.test/api/workspaces/${encodeURIComponent(w.name)}/stream`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).not.toBeNull();
  socket?.accept();
  return socket as WebSocket;
}

function nextMessage(socket: WebSocket, timeoutMs = 3_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WS message")),
      timeoutMs,
    );
    socket.addEventListener(
      "message",
      (event: MessageEvent) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)));
      },
      { once: true },
    );
  });
}

describe("live workspace stream", () => {
  it("pushes a snapshot on connect", async () => {
    const w = workspaceApi();
    const socket = await connect(w);
    const message = await nextMessage(socket);
    expect(message.type).toBe("snapshot");
    expect(message.snapshot.name).toBe(w.name);
    expect(message.snapshot.changesets).toEqual([]);
    socket.close();
  });

  it("broadcasts a fresh snapshot after every mutation", async () => {
    const w = workspaceApi();
    const socket = await connect(w);
    await nextMessage(socket); // initial snapshot

    const pending = nextMessage(socket);
    await w.createChangeset("agent-a", "Live update");
    const message = await pending;

    expect(message.type).toBe("snapshot");
    expect(message.snapshot.changesets).toHaveLength(1);
    expect(message.snapshot.changesets[0].agent).toBe("agent-a");
    socket.close();
  });

  it("answers ping with pong", async () => {
    const w = workspaceApi();
    const socket = await connect(w);
    await nextMessage(socket);

    const pending = nextMessage(socket);
    socket.send("ping");
    const message = await pending;
    expect(message.type).toBe("pong");
    expect(typeof message.at).toBe("number");
    socket.close();
  });

  it("denials reach the stream too, so the UI can show prevented conflicts", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "Holder");
    const b = await w.createChangeset("agent-b", "Contender");
    await w.post(`/changesets/${a}/leases`, { paths: ["src/live-conflict.ts"] });

    const socket = await connect(w);
    await nextMessage(socket);

    const pending = nextMessage(socket);
    const denied = await w.post(`/changesets/${b}/leases`, {
      paths: ["src/live-conflict.ts"],
    });
    expect(denied.status).toBe(409);

    const message = await pending;
    expect(message.type).toBe("snapshot");
    expect(
      message.snapshot.recentEvents.some(
        (event: { type: string }) => event.type === "lease.denied",
      ),
    ).toBe(true);
    socket.close();
  });
});
