/**
 * Live end-to-end check against a DEPLOYED Latch worker.
 *
 *   LATCH_SESSION_SECRET=<worker AUTH_SECRET> \
 *   LATCH_RUNNER_TOKEN=<worker RUNNER_TOKEN> node scripts/live.ts [baseUrl]
 *
 * Signs a session cookie locally (same HMAC scheme as src/worker/auth.ts),
 * injects it into every fetch, and drives the full coordination loop
 * against the real Durable Object: configure workspace → claim → edit →
 * ready → runner verify → merge — plus the anonymous 401 fail-closed check
 * and a WebSocket push proof.
 *
 * `mainRemote` points at a local bare repo: the *runner* runs here, the
 * *authority* runs in Cloudflare's Durable Object.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce } from "../src/integration/runner.ts";
import { signSession } from "../src/worker/auth.ts";
import { LatchClient } from "../src/sdk/index.ts";
import { LocalSessionRuntime } from "../src/sessions/local.ts";
import {
  awaitIntegration,
  finishSession,
  startSession,
} from "../src/sessions/session.ts";

const baseUrl = (process.argv[2] ?? "https://latch.latch-lab.workers.dev").replace(/\/$/, "");
const secret = process.env.LATCH_SESSION_SECRET ?? "";
if (secret.length === 0) {
  throw new Error("Set LATCH_SESSION_SECRET to the worker's AUTH_SECRET");
}
const WORKSPACE = "live";

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`[live]   ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`[live]   ✗ ${label}`);
  }
}

const IDENTITY = ["-c", "user.name=Live", "-c", "user.email=live@latch.local"];
function git(args: string[], cwd?: string): string {
  return execFileSync("git", [...IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function main(): Promise<void> {
  const api = (path: string, init?: RequestInit) =>
    fetch(`${baseUrl}/api/workspaces/${WORKSPACE}${path}`, init);

  // ------------------------------------------------- anonymous gate
  const me = (await (await fetch(`${baseUrl}/api/auth/me`)).json()) as {
    mode: string;
    user: unknown;
  };
  check(me.mode === "github", "deployed worker runs in github (fail-closed) mode");
  check(me.user === null, "anonymous visitor is unauthenticated");

  const anon = await fetch(`${baseUrl}/api/workspaces/${WORKSPACE}/changesets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "anon", intent: "should be refused" }),
  });
  check(anon.status === 401, "anonymous mutation refused with 401 auth_required");

  // ------------------------------------------------- authenticate
  const session = await signSession({ id: "dev:live", login: "live" }, secret);
  const cookie = `latch_session=${encodeURIComponent(session)}`;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has("cookie")) headers.set("cookie", cookie);
    return init !== undefined
      ? realFetch(input, { ...init, headers })
      : realFetch(input, { headers });
  }) as typeof fetch;

  const authedMe = (await (await fetch(`${baseUrl}/api/auth/me`)).json()) as {
    user: { login: string } | null;
  };
  check(authedMe.user?.login === "live", "signed session cookie authenticates");

  // ------------------------------------------------- seed main (local git)
  const dir = mkdtempSync(join(tmpdir(), "latch-live-"));
  const mainRemote = join(dir, "main.git");
  git(["init", "--bare", "--initial-branch=main", mainRemote]);
  const seed = join(dir, "seed");
  git(["clone", "--quiet", mainRemote, seed]);
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "README.md"), "# Live e2e seed\n");
  writeFileSync(join(seed, "src", "index.ts"), "export const version = 1;\n");
  git(["add", "-A"], seed);
  git(["commit", "--quiet", "-m", "seed"], seed);
  git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], seed);

  const configured = await api("/workspace", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainRemote }),
  });
  check(configured.status === 200, "workspace configured through the live Durable Object");

  const members = (await (await api("/members")).json()) as { members: { login: string }[] };
  check(
    members.members.some((m) => m.login === "live"),
    "first actor bootstrapped as workspace owner",
  );

  // ------------------------------------------------- session loop
  const forkRemote = join(dir, "fork.git");
  git(["clone", "--bare", "--quiet", mainRemote, forkRemote]);
  const runtime = new LocalSessionRuntime();
  const started = await startSession({
    baseUrl,
    workspace: WORKSPACE,
    agent: "live-agent",
    intent: "Live deployment e2e",
    claimPaths: ["src/index.ts"],
    forkRemote,
    runtime,
  });
  check(started.ok, "startSession claimed src/index.ts via the live API");
  if (!started.ok) throw new Error(`startSession failed: ${JSON.stringify(started)}`);

  await runtime.run(
    ["sh", "-c", "printf 'export const version = 2;\\n' > src/index.ts"],
    { cwd: started.workDir },
  );
  const finished = await finishSession({
    baseUrl,
    workspace: WORKSPACE,
    agent: "live-agent",
    intent: "Live deployment e2e",
    claimPaths: ["src/index.ts"],
    forkRemote,
    runtime,
    changesetId: started.changeset.id,
    baseSha: started.baseSha,
  });
  check(finished.ready.status === 202, "finishSession queued integration (202)");

  const waiting = awaitIntegration({
    baseUrl,
    workspace: WORKSPACE,
    changesetId: started.changeset.id,
    timeoutMs: 30_000,
  });
  const outcome = await runOnce({
    baseUrl,
    workspace: WORKSPACE,
    runnerToken: process.env.LATCH_RUNNER_TOKEN ?? null,
  });
  check(outcome.status === "merged", "runner merged the session into main");
  const verdict = await waiting;
  check(verdict.status === "merged", "awaitIntegration reported the merged verdict");

  const log = git(["--git-dir", mainRemote, "log", "-1", "--format=%B"]);
  check(log.includes("Latch-Agent: live-agent"), "merge commit carries Latch trailers");
  check(
    git(["--git-dir", mainRemote, "show", "HEAD:src/index.ts"]).includes("version = 2"),
    "main contains the agent's edit",
  );

  // ------------------------------------------------- WebSocket push
  const client = new LatchClient({ baseUrl, workspace: WORKSPACE });
  const socket = client.openStream();
  const pushed = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("stream timeout")), 10_000);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        snapshot?: { changesets: { agent: string }[] };
      };
      if (
        message.type === "snapshot" &&
        (message.snapshot?.changesets ?? []).some((c) => c.agent === "stream-proof")
      ) {
        clearTimeout(timer);
        resolvePromise(true);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectPromise(new Error("stream error"));
    });
    void (async () => {
      await client.createChangeset("stream-proof", "Pushed over wss");
    })();
  }).catch(() => false);
  socket.close();
  check(pushed === true, "live WebSocket pushed an out-of-band mutation");

  await runtime.cleanup();
  console.log(`\n[live] ${passed} checks passed, ${failed} failed — ${failed === 0 ? "LIVE PASS" : "LIVE FAIL"}`);
  if (failed > 0) process.exitCode = 1;
}

void main();
