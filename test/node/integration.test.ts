import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionRepoName } from "../../src/worker/artifacts.ts";
import { runOnce } from "../../src/integration/runner.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKSPACE = "e2e";

let dir: string;
let base: string;
let mainRemote: string;
let server: ReturnType<typeof spawn> | null = null;
const serverLog: string[] = [];

interface ApiResponse<T = any> {
  status: number;
  body: T;
}

async function api<T = any>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const response = await fetch(`${base}/api/workspaces/${WORKSPACE}${path}`, init);
  const text = await response.text();
  try {
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
  } catch {
    throw new Error(
      `Non-JSON response for ${init?.method ?? "GET"} ${path}: ${response.status} ` +
        `${response.headers.get("content-type")} :: ${text.slice(0, 200)}`,
    );
  }
}

function post(path: string, body: unknown) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const IDENTITY = ["-c", "user.name=E2E", "-c", "user.email=e2e@latch.local"];

function git(args: string[], cwd?: string): string {
  return execFileSync("git", [...IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(repoDir: string, relative: string, content: string): void {
  const path = join(repoDir, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** Clone main.git, commit `edit` on a new branch-less tip, push to `remotePath`. */
function sessionWork(
  name: string,
  remotePath: string,
  edit: { file: string; content: string },
): { workDir: string; sha: string } {
  const workDir = join(dir, name);
  git(["clone", "--quiet", remotePath, workDir]);
  write(workDir, edit.file, edit.content);
  git(["add", "-A"], workDir);
  git(["commit", "--quiet", "-m", `agent: edit ${edit.file}`], workDir);
  git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], workDir);
  return { workDir, sha: git(["rev-parse", "HEAD"], workDir) };
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/workspaces/${WORKSPACE}`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not become ready:\n${serverLog.join("\n")}`);
}

beforeAll(async () => {
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    throw new Error("dist/ missing — run `npm run build` before the e2e test");
  }

  dir = mkdtempSync(join(tmpdir(), "latch-e2e-"));
  mainRemote = join(dir, "main.git");

  // Seed the workspace repo: a bare `main` with three files.
  git(["init", "--bare", "--initial-branch=main", mainRemote]);
  const seed = join(dir, "seed");
  git(["clone", "--quiet", mainRemote, seed]);
  write(seed, "README.md", "# Latch e2e seed\n");
  write(seed, "src/app.ts", "export const version = 1;\n");
  write(seed, "src/conflict.ts", "line one\nline two\n");
  git(["add", "-A"], seed);
  git(["commit", "--quiet", "-m", "seed"], seed);
  git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], seed);

  // Boot wrangler dev against an isolated DO persist dir.
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      join(ROOT, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--port",
      String(port),
      "--persist-to",
      join(dir, "state"),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  server.stdout?.on("data", (chunk: Buffer) => serverLog.push(chunk.toString()));
  server.stderr?.on("data", (chunk: Buffer) => serverLog.push(chunk.toString()));

  await waitForServer(90_000);

  const configured = await api("/workspace", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainRemote }),
  });
  expect(configured.status).toBe(200);
}, 120_000);

afterAll(async () => {
  if (server !== null) {
    const exited = new Promise((r) => server?.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe("integration runner against a real git workspace", () => {
  it("merges a leased session into main with provenance trailers", async () => {
    const created = await post("/sessions", {
      agent: "ada",
      intent: "Update the app entry point",
    });
    expect(created.status).toBe(201);
    const changesetId = created.body.changeset.id as string;

    const leased = await post(`/changesets/${changesetId}/leases`, { paths: ["src/app.ts"] });
    expect(leased.status).toBe(200);

    // Session fork: bare clone of main, one agent commit on top.
    const forkRemote = join(dir, "fork1.git");
    git(["clone", "--bare", "--quiet", mainRemote, forkRemote]);
    const sess = sessionWork("sess1", forkRemote, {
      file: "src/app.ts",
      content: "export const version = 2;\n",
    });

    const attached = await post(`/changesets/${changesetId}/fork`, {
      forkRepo: sessionRepoName(WORKSPACE, changesetId),
      forkRemote,
    });
    expect(attached.status).toBe(200);

    const ready = await post(`/changesets/${changesetId}/ready`, {
      ref: sess.sha,
      touchedPaths: ["src/app.ts"],
    });
    expect(ready.status).toBe(202);

    const outcome = await runOnce({ baseUrl: base, workspace: WORKSPACE });
    expect(outcome.status).toBe("merged");
    if (outcome.status !== "merged") return;
    expect(outcome.paths).toEqual(["src/app.ts"]);

    // Main actually moved, with Latch trailers on the merge commit.
    const message = git(["--git-dir", mainRemote, "log", "-1", "--format=%B"]);
    expect(message).toContain(`Latch-Changeset: ${changesetId}`);
    expect(message).toContain("Latch-Agent: ada");
    expect(message).toContain("Intent: Update the app entry point");
    expect(message).toContain("Lease-Paths: src/app.ts");

    // Queue state and leases are clean.
    const snapshot = await api("/");
    expect(snapshot.body.changesets[0].status).toBe("merged");
    expect(snapshot.body.leases).toEqual([]);
    expect(snapshot.body.jobs[0]).toMatchObject({ status: "merged" });
  });

  it("rejects a session whose git diff escapes its leases (verify)", async () => {
    const before = git(["--git-dir", mainRemote, "log", "-1", "--format=%H"]);

    const created = await post("/sessions", {
      agent: "mallory",
      intent: "Touch files I never claimed",
    });
    const changesetId = created.body.changeset.id as string;
    await post(`/changesets/${changesetId}/leases`, { paths: ["src/other.ts"] });

    const forkRemote = join(dir, "fork2.git");
    git(["clone", "--bare", "--quiet", mainRemote, forkRemote]);
    // The agent lies in `touchedPaths` but its actual commit edits README.md.
    const sess = sessionWork("sess2", forkRemote, {
      file: "README.md",
      content: "# Latch e2e seed\n\nsmuggled change\n",
    });

    await post(`/changesets/${changesetId}/fork`, {
      forkRepo: sessionRepoName(WORKSPACE, changesetId),
      forkRemote,
    });
    const ready = await post(`/changesets/${changesetId}/ready`, {
      ref: sess.sha,
      touchedPaths: ["src/other.ts"],
    });
    expect(ready.status).toBe(202);

    const outcome = await runOnce({ baseUrl: base, workspace: WORKSPACE });
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.reason).toContain("outside its leases");
    expect(outcome.reason).toContain("README.md");

    // main is untouched; the changeset keeps its leases to fix the work.
    const after = git(["--git-dir", mainRemote, "log", "-1", "--format=%H"]);
    expect(after).toBe(before);

    const snapshot = await api("/");
    expect(snapshot.body.changesets[1].status).toBe("rejected");
    expect(snapshot.body.leases.map((lease: { path: string }) => lease.path)).toEqual([
      "src/other.ts",
    ]);
  });

  it("reports merge conflicts back to the agent instead of forcing main", async () => {
    const before = git(["--git-dir", mainRemote, "log", "-1", "--format=%H"]);

    const created = await post("/sessions", {
      agent: "grace",
      intent: "Rewrite the conflict fixture",
    });
    const changesetId = created.body.changeset.id as string;
    await post(`/changesets/${changesetId}/leases`, { paths: ["src/conflict.ts"] });

    const forkRemote = join(dir, "fork3.git");
    git(["clone", "--bare", "--quiet", mainRemote, forkRemote]);
    const sess = sessionWork("sess3", forkRemote, {
      file: "src/conflict.ts",
      content: "line one (agent edit)\nline two\n",
    });

    // main moves underneath the session — same line, different content.
    const mainWork = join(dir, "mainwork");
    git(["clone", "--quiet", mainRemote, mainWork]);
    write(mainWork, "src/conflict.ts", "line one (human edit)\nline two\n");
    git(["add", "-A"], mainWork);
    git(["commit", "--quiet", "-m", "human: edit conflict fixture"], mainWork);
    git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], mainWork);

    await post(`/changesets/${changesetId}/fork`, {
      forkRepo: sessionRepoName(WORKSPACE, changesetId),
      forkRemote,
    });
    const ready = await post(`/changesets/${changesetId}/ready`, {
      ref: sess.sha,
      touchedPaths: ["src/conflict.ts"],
    });
    expect(ready.status).toBe(202);

    const outcome = await runOnce({ baseUrl: base, workspace: WORKSPACE });
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.reason).toContain("merge conflict");
    expect(outcome.reason).toContain("src/conflict.ts");

    // The human commit is still the tip; the agent's session did not land.
    const after = git(["--git-dir", mainRemote, "log", "-1", "--format=%H"]);
    expect(after).not.toBe(before);
    const mergedLog = git(["--git-dir", mainRemote, "log", "--format=%s", "-3"]);
    expect(mergedLog).toContain("human: edit conflict fixture");
    expect(mergedLog).not.toContain("agent: edit src/conflict.ts");

    // Leases retained so the agent can resolve within its scope (and test 2's
    // violated lease is still held by its rejected changeset).
    const snapshot = await api("/");
    expect(snapshot.body.changesets[2].status).toBe("rejected");
    const heldPaths = snapshot.body.leases.map((lease: { path: string }) => lease.path);
    expect(heldPaths).toContain("src/conflict.ts");
    expect(heldPaths).toContain("src/other.ts");
  });
});
