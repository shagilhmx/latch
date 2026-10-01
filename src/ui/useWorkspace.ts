import { useEffect, useState } from "react";
import type { WorkspaceSnapshot, WireMessage } from "../shared/types";

export type Connection = "connecting" | "live" | "offline";

export interface WorkspaceView {
  snapshot: WorkspaceSnapshot | null;
  connection: Connection;
}

const RETRY_MS = 4_000;
const POLL_MS = 2_000;
const PING_MS = 25_000;

/**
 * Live workspace state: WebSocket stream with a polling fallback and
 * automatic reconnect. The Coordinator pushes a full snapshot on every
 * mutation, so the store is just "latest snapshot wins".
 */
export function useWorkspace(workspace: string): WorkspaceView {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const root = `/api/workspaces/${encodeURIComponent(workspace)}`;

    async function pull(): Promise<void> {
      try {
        const response = await fetch(`${root}/`);
        if (!response.ok) return;
        const data = (await response.json()) as WorkspaceSnapshot;
        if (!disposed && typeof data.leases === "object") {
          setSnapshot(data);
          setConnection((current) => (current === "live" ? current : "offline"));
        }
      } catch {
        // Server briefly unavailable — keep polling.
      }
    }

    function startPolling(): void {
      if (pollTimer === undefined) {
        pollTimer = setInterval(() => void pull(), POLL_MS);
      }
    }

    function stopPolling(): void {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    }

    function connect(): void {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}${root}/stream`);

      socket.addEventListener("open", () => {
        if (disposed) return;
        setConnection("live");
        stopPolling();
        pingTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
        }, PING_MS);
      });

      socket.addEventListener("message", (event: MessageEvent) => {
        if (disposed) return;
        try {
          const message = JSON.parse(String(event.data)) as WireMessage;
          if (message.type === "snapshot") {
            setSnapshot(message.snapshot);
            setConnection("live");
          }
        } catch {
          // Ignore malformed frames; the next snapshot heals the view.
        }
      });

      socket.addEventListener("close", () => {
        if (disposed) return;
        if (pingTimer !== undefined) clearInterval(pingTimer);
        setConnection("offline");
        startPolling();
        retryTimer = setTimeout(connect, RETRY_MS);
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    }

    void pull();
    connect();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (pingTimer !== undefined) clearInterval(pingTimer);
      stopPolling();
      socket?.close();
    };
  }, [workspace]);

  return { snapshot, connection };
}
