import { describe, expect, it } from "vitest";
import {
  InvalidPathError,
  leaseCovers,
  leasesOverlap,
  normalizePath,
  normalizePaths,
} from "../../src/shared/paths";
import { workspaceApi } from "./helpers";

describe("directory claim path helpers", () => {
  it("normalizes directory claims with their trailing slash", () => {
    expect(normalizePath("src/")).toBe("src/");
    expect(normalizePath("./src/")).toBe("src/");
    expect(normalizePath("/src/")).toBe("src/");
    expect(normalizePath("src\\components\\")).toBe("src/components/");
    expect(normalizePaths(["src/", "src/b.ts", "src/"])).toEqual(["src/", "src/b.ts"]);
  });

  it("still rejects traversal, empty, and doubled-slash forms", () => {
    expect(() => normalizePath("../secrets")).toThrow(InvalidPathError);
    expect(() => normalizePath("src//x.ts")).toThrow(InvalidPathError);
    expect(() => normalizePath("/")).toThrow(InvalidPathError);
    expect(() => normalizePath("src/./")).toThrow(InvalidPathError);
    expect(() => normalizePath("src/../..")).toThrow(InvalidPathError);
  });

  it("covers files by exact match and directories by subtree", () => {
    expect(leaseCovers("src/a.ts", "src/a.ts")).toBe(true);
    expect(leaseCovers("src/a.ts", "src/b.ts")).toBe(false);
    expect(leaseCovers("src/", "src/a.ts")).toBe(true);
    expect(leaseCovers("src/", "src/deep/nested/b.ts")).toBe(true);
    expect(leaseCovers("src/", "src")).toBe(false); // a file literally named `src`
    expect(leaseCovers("src/", "other.ts")).toBe(false);
  });

  it("computes overlap between any mix of file and directory leases", () => {
    expect(leasesOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(leasesOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(leasesOverlap("src/", "src/a.ts")).toBe(true);
    expect(leasesOverlap("src/a.ts", "src/")).toBe(true);
    expect(leasesOverlap("src/", "src/deep/")).toBe(true);
    expect(leasesOverlap("src/deep/", "src/")).toBe(true);
    expect(leasesOverlap("src/", "docs/")).toBe(false);
    expect(leasesOverlap("docs/a.ts", "src/")).toBe(false);
  });
});

describe("directory lease acquisition", () => {
  it("grants a directory claim and reports it with its trailing slash", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Owns all of src");

    const acquire = await w.post(`/changesets/${cs}/leases`, { paths: ["src/"] });
    expect(acquire.status).toBe(200);
    expect(acquire.body.granted).toEqual(["src/"]);

    const { body } = await w.get("/");
    expect(body.leases).toHaveLength(1);
    expect(body.leases[0].path).toBe("src/");
  });

  it("denies a file claim under a held directory and names the directory", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "Directory holder");
    const b = await w.createChangeset("agent-b", "Wants a file inside");
    await w.post(`/changesets/${a}/leases`, { paths: ["src/"] });

    const denied = await w.post(`/changesets/${b}/leases`, { paths: ["src/config.ts"] });
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe("lease_conflict");
    expect(denied.body.conflicts).toEqual([
      expect.objectContaining({ path: "src/", changeset: a, agent: "agent-a" }),
    ]);
    expect(await w.eventTypes()).toContain("lease.denied");
  });

  it("denies a nested directory claim overlapping a held directory", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "Top-level");
    const b = await w.createChangeset("agent-b", "Nested");
    await w.post(`/changesets/${a}/leases`, { paths: ["src/"] });

    const denied = await w.post(`/changesets/${b}/leases`, { paths: ["src/components/"] });
    expect(denied.status).toBe(409);

    // …and the reverse direction: file-directory held, directory requested.
    const c = await w.createChangeset("agent-c", "Third party");
    const deniedUp = await w.post(`/changesets/${c}/leases`, { paths: ["src/components/"] });
    expect(deniedUp.status).toBe(409);
  });

  it("denies a directory claim that contains a held file", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "File holder");
    const b = await w.createChangeset("agent-b", "Wants the directory");
    await w.post(`/changesets/${a}/leases`, { paths: ["src/config.ts"] });

    const denied = await w.post(`/changesets/${b}/leases`, { paths: ["src/"] });
    expect(denied.status).toBe(409);
    expect(denied.body.conflicts).toEqual([
      expect.objectContaining({ path: "src/config.ts", agent: "agent-a" }),
    ]);
  });

  it("grants disjoint directory and file claims", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "src owner");
    const b = await w.createChangeset("agent-b", "docs owner");
    expect((await w.post(`/changesets/${a}/leases`, { paths: ["src/"] })).status).toBe(200);

    const granted = await w.post(`/changesets/${b}/leases`, {
      paths: ["docs/", "README.md"],
    });
    expect(granted.status).toBe(200);
    expect(granted.body.granted).toEqual(["README.md", "docs/"]);
  });

  it("lets the holder claim inside its own directory without self-conflict", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Directory plus file");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/"] });

    const inside = await w.post(`/changesets/${cs}/leases`, { paths: ["src/config.ts"] });
    expect(inside.status).toBe(200);

    const { body } = await w.get("/");
    expect(body.leases.map((l: { path: string }) => l.path)).toEqual(["src/", "src/config.ts"]);
  });

  it("releases a directory lease via filtered release", async () => {
    const w = workspaceApi();
    const a = await w.createChangeset("agent-a", "Releaser");
    const b = await w.createChangeset("agent-b", "Successor");
    await w.post(`/changesets/${a}/leases`, { paths: ["src/", "docs/"] });

    const released = await w.del(`/changesets/${a}/leases`, { paths: ["src/"] });
    expect(released.body.released).toEqual(["src/"]);

    // The directory is free for another agent; docs/ stays with a.
    expect((await w.post(`/changesets/${b}/leases`, { paths: ["src/"] })).status).toBe(200);
    const denied = await w.post(`/changesets/${b}/leases`, { paths: ["docs/"] });
    expect(denied.status).toBe(409);
  });
});

describe("directory lease coverage at readiness and verify", () => {
  it("accepts ready when every touched path is covered by a directory lease", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Deep work");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/"] });

    const result = await w.post(`/changesets/${cs}/ready`, {
      ref: "cafe1234",
      touchedPaths: ["src/deep/nested/new.ts"],
    });
    expect(result.status).toBe(202);
    expect(await w.eventTypes()).toContain("changeset.ready");
  });

  it("blocks ready for paths outside every held lease", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Escapist");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/"] });

    const result = await w.post(`/changesets/${cs}/ready`, {
      ref: "cafe1234",
      touchedPaths: ["src/ok.ts", "README.md"],
    });
    expect(result.status).toBe(409);
    expect(result.body.violations).toEqual(["README.md"]);
  });

  it("verifies git-derived paths against directory leases", async () => {
    const w = workspaceApi();
    const cs = await w.createChangeset("agent-a", "Runner input");
    await w.post(`/changesets/${cs}/leases`, { paths: ["src/"] });
    await w.post(`/changesets/${cs}/ready`, {
      ref: "feedbeef",
      touchedPaths: ["src/a.ts"],
    });

    const claimed = await w.get("/integration/next");
    expect(claimed.status).toBe(200);
    const seq = claimed.body.job.seq;

    // Paths git derived under the directory pass the authoritative check…
    const verified = await w.post(`/integration/${seq}/verify`, {
      paths: ["src/a.ts", "src/generated/deep.ts"],
    });
    expect(verified.status).toBe(200);
    expect(verified.body.ok).toBe(true);

    // …and a path outside every held lease rejects job + changeset.
    const violated = await w.post(`/integration/${seq}/verify`, {
      paths: ["src/a.ts", "README.md"],
    });
    expect(violated.status).toBe(409);
    expect(violated.body.violations).toEqual(["README.md"]);

    const { body } = await w.get("/");
    expect(body.jobs[0]).toMatchObject({ status: "rejected" });
    expect(body.changesets[0].status).toBe("rejected");
    // Leases are kept on rejection — the agent still owns src/.
    expect(body.leases.map((l: { path: string }) => l.path)).toEqual(["src/"]);
  });
});
