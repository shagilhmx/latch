import { describe, expect, it } from "vitest";
import {
  describeEvent,
  expiresIn,
  shortId,
  statusTone,
  streamable,
  timeAgo,
} from "../../src/ui/format";

const NOW = 1_700_000_000_000;

describe("shortId", () => {
  it("truncates, tolerates null, and keeps short values intact", () => {
    expect(shortId("deadbeef-1234-5678")).toBe("deadbeef");
    expect(shortId(null)).toBe("—");
    expect(shortId("")).toBe("—");
    expect(shortId("abc")).toBe("abc");
  });
});

describe("timeAgo / expiresIn", () => {
  it("formats relative time", () => {
    expect(timeAgo(NOW - 1_000, NOW)).toBe("just now");
    expect(timeAgo(NOW - 42_000, NOW)).toBe("42s ago");
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(timeAgo(NOW - 120 * 60_000, NOW)).toBe("2h ago");
  });

  it("counts down lease deadlines and flags expiry", () => {
    expect(expiresIn(NOW + 30_000, NOW)).toBe("30s left");
    expect(expiresIn(NOW + 5 * 60_000, NOW)).toBe("5m left");
    expect(expiresIn(NOW - 1_000, NOW)).toBe("expired");
  });
});

describe("statusTone", () => {
  it("maps lifecycle states to visual tones", () => {
    expect(statusTone("merged")).toBe("ok");
    expect(statusTone("open")).toBe("neutral");
    expect(statusTone("queued")).toBe("busy");
    expect(statusTone("integrating")).toBe("busy");
    expect(statusTone("rejected")).toBe("bad");
    expect(statusTone("aborted")).toBe("bad");
  });
});

describe("describeEvent", () => {
  it("summarizes the events the demo narrative depends on", () => {
    expect(
      describeEvent({
        seq: 1,
        type: "lease.denied",
        createdAt: NOW,
        payload: {
          agent: "dennis",
          paths: ["src/util.ts"],
          conflicts: [{ path: "src/util.ts", agent: "linus" }],
        },
      }),
    ).toBe("dennis was refused src/util.ts — already leased");

    expect(
      describeEvent({
        seq: 2,
        type: "integration.merged",
        createdAt: NOW,
        payload: { changeset: "deadbeef-0000", mergedSha: "12345678abcd" },
      }),
    ).toBe("deadbeef merged into main (12345678)");

    expect(
      describeEvent({
        seq: 3,
        type: "integration.rejected",
        createdAt: NOW,
        payload: { changeset: "deadbeef-0000", reason: "merge conflict: src/x.ts" },
      }),
    ).toBe("deadbeef rejected — merge conflict: src/x.ts");

    expect(
      describeEvent({
        seq: 4,
        type: "changeset.ready",
        createdAt: NOW,
        payload: { changeset: "cafebabe-0000", via: "push", paths: ["src/a.ts"] },
      }),
    ).toBe("cafebabe ready via push (src/a.ts)");
  });
});

describe("streamable", () => {
  it("drops heartbeat noise from the stream", () => {
    expect(
      streamable({ seq: 1, type: "lease.heartbeat", createdAt: NOW, payload: {} }),
    ).toBe(false);
    expect(
      streamable({ seq: 2, type: "lease.acquired", createdAt: NOW, payload: {} }),
    ).toBe(true);
  });
});

describe("auth and membership events", () => {
  it("summarizes denials and membership changes for the stream", () => {
    expect(
      describeEvent({
        seq: 1,
        type: "auth.denied",
        createdAt: NOW,
        payload: { actor: "grace", action: "owner", code: "owner_required" },
      }),
    ).toBe("grace denied owner — owner_required");

    expect(
      describeEvent({
        seq: 2,
        type: "member.joined",
        createdAt: NOW,
        payload: { actor: "ada", role: "owner", via: "bootstrap" },
      }),
    ).toBe("ada joined as owner");

    expect(
      describeEvent({
        seq: 3,
        type: "member.updated",
        createdAt: NOW,
        payload: { actor: "linus", role: "write" },
      }),
    ).toBe("linus → write");

    expect(
      describeEvent({
        seq: 4,
        type: "member.removed",
        createdAt: NOW,
        payload: { actor: "mallory" },
      }),
    ).toBe("mallory removed from workspace");
  });
});
