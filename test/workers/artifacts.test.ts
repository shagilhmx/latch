import { describe, expect, it, vi } from "vitest";
import {
  ArtifactError,
  createSessionFork,
  ensureWorkspaceRepo,
  parseSessionRepo,
  sessionRepoName,
  validateWorkspaceName,
  workspaceRepoExists,
  workspaceRepoName,
} from "../../src/worker/artifacts";

function fakeArtifacts(overrides: Record<string, unknown> = {}): Artifacts {
  return {
    create: () => {
      throw new Error("create not expected");
    },
    get: () => {
      throw Object.assign(new Error("Repo not found"), { code: "NOT_FOUND" });
    },
    ...overrides,
  } as unknown as Artifacts;
}

describe("repository naming", () => {
  it("round-trips a session repo name back to workspace and changeset", () => {
    const id = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    const name = sessionRepoName("demo", id);
    expect(name).toBe("ws-demo.cs.a1b2c3d4");
    expect(parseSessionRepo(name)).toEqual({ workspace: "demo", changesetPrefix: "a1b2c3d4" });
  });

  it("ignores the workspace main repo and foreign repos", () => {
    expect(parseSessionRepo(workspaceRepoName("demo"))).toBeNull();
    expect(parseSessionRepo("some-other-repo")).toBeNull();
    expect(parseSessionRepo("ws-x.cs.tooshort")).toBeNull();
  });

  it("rejects workspace names that could forge repo names", () => {
    for (const bad of ["a", "has space", "dots.cs.allowed", "", "x".repeat(49)]) {
      expect(() => validateWorkspaceName(bad)).toThrow(ArtifactError);
    }
    expect(() => validateWorkspaceName("ok_Name-123")).not.toThrow();
  });
});

describe("ensureWorkspaceRepo", () => {
  it("creates the workspace repo when it does not exist", async () => {
    const create = vi.fn().mockResolvedValue({
      name: "ws-demo",
      remote: "https://artifacts.example/ws-demo.git",
      defaultBranch: "main",
      token: "art_v1_initial",
    });
    const artifacts = fakeArtifacts({ create });

    const result = await ensureWorkspaceRepo(artifacts, "demo");
    expect(create).toHaveBeenCalledWith("ws-demo", expect.objectContaining({ readOnly: false }));
    expect(result).toMatchObject({
      created: true,
      repo: "ws-demo",
      remote: "https://artifacts.example/ws-demo.git",
      defaultBranch: "main",
      token: "art_v1_initial",
    });
  });

  it("reuses an existing repo and mints a fresh write token", async () => {
    const createToken = vi.fn().mockResolvedValue({
      plaintext: "art_v1_fresh",
      expiresAt: "2026-10-02T00:00:00.000Z",
    });
    const info = vi.fn().mockResolvedValue({
      remote: "https://artifacts.example/ws-demo.git",
      defaultBranch: "main",
    });
    const get = vi.fn().mockResolvedValue({ info, createToken });
    const create = vi.fn();
    const artifacts = fakeArtifacts({ get, create });

    const result = await ensureWorkspaceRepo(artifacts, "demo");
    expect(create).not.toHaveBeenCalled();
    expect(createToken).toHaveBeenCalledWith("write", 3600);
    expect(result).toMatchObject({
      created: false,
      token: "art_v1_fresh",
      remote: "https://artifacts.example/ws-demo.git",
    });
  });

  it("rethrows errors that are not not-found", async () => {
    const get = vi.fn().mockRejectedValue(new Error("boom"));
    const create = vi.fn();
    const artifacts = fakeArtifacts({ get, create });

    await expect(ensureWorkspaceRepo(artifacts, "demo")).rejects.toThrow("boom");
    expect(create).not.toHaveBeenCalled();
  });

  it("reports existence without creating anything", async () => {
    const exists = await workspaceRepoExists(fakeArtifacts(), "demo");
    expect(exists).toBe(false);

    const present = await workspaceRepoExists(
      fakeArtifacts({ get: vi.fn().mockResolvedValue({}) }),
      "demo",
    );
    expect(present).toBe(true);
  });
});

describe("createSessionFork", () => {
  it("forks the workspace repo into an isolated session repo", async () => {
    const fork = vi.fn().mockResolvedValue({
      name: "ws-demo.cs.deadbeef",
      remote: "https://artifacts.example/ws-demo.cs.deadbeef.git",
      defaultBranch: "main",
      token: "art_v1_fork",
    });
    const get = vi.fn().mockResolvedValue({ fork });
    const artifacts = fakeArtifacts({ get });

    const result = await createSessionFork(artifacts, "demo", "deadbeef-0000-0000-0000-000000000000");
    expect(get).toHaveBeenCalledWith("ws-demo");
    expect(fork).toHaveBeenCalledWith(
      "ws-demo.cs.deadbeef",
      expect.objectContaining({ readOnly: false }),
    );
    expect(result).toMatchObject({
      repo: "ws-demo.cs.deadbeef",
      token: "art_v1_fork",
      remote: "https://artifacts.example/ws-demo.cs.deadbeef.git",
    });
  });
});
