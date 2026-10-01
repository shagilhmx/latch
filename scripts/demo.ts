/**
 * Latch demo — `npm run demo`.
 *
 * Seeds a temp workspace, boots wrangler dev, runs three agent sessions
 * concurrently:
 *   linus    claims src/config.ts + src/util.ts        -> merges cleanly
 *   ada      claims src/config.ts (already held)       -> REFUSED at claim
 *            re-scopes to src/index.ts                 -> merges
 *   mallory  claims src/other.ts but edits README.md   -> rejected by the
 *            runner's git-side lease verification (main untouched)
 *
 * The live UI at the printed URL shows every claim, denial, and merge as it
 * happens.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runOnce } from "../src/integration/runner.ts";
import { LocalSessionRuntime } from "../src/sessions/local.ts";
import {
  abortSession,
  finishSession,
  startSession,
  type StartSessionOptions,
} from "../src/sessions/session.ts";

const ROOT = resolve(import.meta.dirname, "..");
const WORKSPACE = "demo";

let passed = 0;
let failed = 0;

function log(agent: string, message: string, mark = "  "): void {
  console.log(`[latch-demo] ${agent.padEnd(8)} ${mark} ${message}`);
}

function check(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`[latch-demo]   ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`[latch-demo]   ✗ ${label}`);
  }
}

const IDENTITY = ["-c", "user.name=Demo", "-c", "user.email=demo@latch.local"];

function git(args: string[], cwd?: string): string {
  return execFileSync("git", [...IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function freePort(): Promise<number> {
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function api<T = any>(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}/api/workspaces/${WORKSPACE}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

async function waitForServer(base: string, server: ChildProcess, logLines: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`wrangler dev exited early:\n${logLines.join("")}`);
    }
    try {
      const response = await fetch(`${base}/api/workspaces/${WORKSPACE}`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(400);
  }
  throw new Error(`wrangler dev did not become ready:\n${logLines.join("")}`);
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    throw new Error("dist/ missing — run `npm run build` first (or use `npm run demo`)");
  }

  const dir = mkdtempSync(join(tmpdir(), "latch-demo-"));
  const mainRemote = join(dir, "main.git");
  const forksDir = join(dir, "forks");
  mkdirSync(forksDir);

  // ---------------------------------------------------------------- seed
  log("seed", `workspace in ${dir}`);
  git(["init", "--bare", "--initial-branch=main", mainRemote]);
  const seed = join(dir, "seed");
  git(["clone", "--quiet", mainRemote, seed]);
  writeFileSync(join(seed, "README.md"), "# Demo project\n\nShared code for the Latch demo.\n");
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "src", "config.ts"), "export const config = { retries: 3 };\n");
  writeFileSync(join(seed, "src", "index.ts"), "export const version = 1;\n");
  writeFileSync(join(seed, "src", "util.ts"), "export const noop = () => {};\n");
  writeFileSync(join(seed, "src", "other.ts"), "export const untouched = true;\n");
  git(["add", "-A"], seed);
  git(["commit", "--quiet", "-m", "seed"], seed);
  git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], seed);

  // ---------------------------------------------------------------- boot
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const serverLog: string[] = [];
  log("server", `starting wrangler dev on ${base} — watch the UI at ${base}/`);
  const server = spawn(
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

  try {
    await waitForServer(base, server, serverLog, 90_000);
    await api(base, "/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mainRemote }),
    });

    // ------------------------------------------------------------- agents
    const session = (
      agent: string,
      intent: string,
      claimPaths: string[],
      forkName: string,
    ): StartSessionOptions & { forkRemote: string } => {
      const forkRemote = join(forksDir, `${forkName}.git`);
      git(["clone", "--bare", "--quiet", mainRemote, forkRemote]);
      return {
        baseUrl: base,
        workspace: WORKSPACE,
        agent,
        intent,
        claimPaths,
        forkRemote,
        runtime: new LocalSessionRuntime(),
      };
    };

    // linus claims first — config + util are now HIS.
    const linus = session("linus", "Extract shared config loader", ["src/config.ts", "src/util.ts"], "linus");
    const linusStart = await startSession(linus);
    check(linusStart.ok, "linus claims src/config.ts + src/util.ts — granted");
    if (!linusStart.ok) throw new Error(`linus failed to start: ${JSON.stringify(linusStart)}`);

    // ada wants the SAME file in parallel — refused before any editing.
    const ada = session("ada", "Rename the config loader", ["src/config.ts"], "ada");
    const adaBlocked = await startSession(ada);
    check(!adaBlocked.ok, "ada claims src/config.ts in parallel — REFUSED");
    if (!adaBlocked.ok && "conflicts" in adaBlocked) {
      log("ada", `refused: ${adaBlocked.conflicts.map((c) => `${c.path} (held by ${c.agent})`).join(", ")}`, "✗");
      await abortSession({
        baseUrl: base,
        workspace: WORKSPACE,
        changesetId: adaBlocked.changesetId,
        runtime: new LocalSessionRuntime(),
      });
    }

    // ada re-scopes to a free file and proceeds.
    const adaRetry = session("ada", "Rename the index entry", ["src/index.ts"], "ada2");
    const adaStart = await startSession(adaRetry);
    check(adaStart.ok, "ada re-scopes to src/index.ts — granted");
    if (!adaStart.ok) throw new Error(`ada failed to start: ${JSON.stringify(adaStart)}`);

    // mallory claims one file honestly…
    const mallory = session("mallory", "Improve the README", ["src/other.ts"], "mallory");
    const malloryStart = await startSession(mallory);
    check(malloryStart.ok, "mallory claims src/other.ts — granted");
    if (!malloryStart.ok) throw new Error(`mallory failed to start: ${JSON.stringify(malloryStart)}`);

    // ------------------------------------------------------- agents work
    log("all", "working concurrently…");
    await Promise.all([
      (async () => {
        await linus.runtime.run(
          ["sh", "-c", "printf 'export const config = { retries: 5, source: \"shared\" };\\n' > src/config.ts && printf 'export const noop = () => undefined;\\nexport const pick = <T,>(v: T[]) => v[0];\\n' > src/util.ts"],
          { cwd: linusStart.workDir },
        );
        const done = await finishSession({
          ...linus,
          changesetId: linusStart.changeset.id,
          baseSha: linusStart.baseSha,
        });
        log("linus", `pushed ${done.sha.slice(0, 8)} (${done.touchedPaths.join(", ")}) → ready`, "→");
      })(),
      (async () => {
        await sleep(150);
        await adaRetry.runtime.run(
          ["sh", "-c", "printf 'export const version = 2;\\n' > src/index.ts"],
          { cwd: adaStart.workDir },
        );
        const done = await finishSession({
          ...adaRetry,
          changesetId: adaStart.changeset.id,
          baseSha: adaStart.baseSha,
        });
        log("ada", `pushed ${done.sha.slice(0, 8)} (${done.touchedPaths.join(", ")}) → ready`, "→");
      })(),
      (async () => {
        await sleep(300);
        // mallory edits a file she never leased, then LIES about touchedPaths
        // at readiness — the deep layer (git-side verify) is what catches her.
        await mallory.runtime.run(["sh", "-c", "printf '\\nA smuggled change.\\n' >> README.md"], {
          cwd: malloryStart.workDir,
        });
        const author = { name: "mallory", email: "mallory@latch.local" };
        await mallory.runtime.commitAll("agent: improve the README (really)", author);
        const sha = await mallory.runtime.commitAll("noop", author); // no-op, returns HEAD
        await mallory.runtime.push(mallory.forkRemote);
        const ready = await api(base, `/changesets/${malloryStart.changeset.id}/ready`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref: sha, touchedPaths: ["src/other.ts"] }),
        });
        log("mallory", `pushed ${sha.slice(0, 8)} claiming src/other.ts only`, "→");
        check(ready.status === 202, "mallory's readiness gate accepts her claimed scope");
      })(),
    ]);

    // -------------------------------------------------------- integration
    log("runner", "draining the integration queue (single writer for main)…");
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const outcome = await runOnce({ baseUrl: base, workspace: WORKSPACE });
      if (outcome.status === "idle") break;
      await sleep(200);
      if (outcome.status === "merged") {
        outcomes.push(`merged ${outcome.sha.slice(0, 8)}`);
        log("runner", `job ${outcome.seq} MERGED (${outcome.paths.join(", ")})`, "✓");
      } else {
        outcomes.push(`rejected: ${outcome.reason}`);
        log("runner", `job ${outcome.seq} REJECTED — ${outcome.reason}`, "✗");
      }
    }

    // ------------------------------------------------------------- report
    const snapshot = await api(base, "/");
    const byAgent = new Map(
      snapshot.body.changesets.map((c: any) => [`${c.agent}:${c.intent}`, c.status as string]),
    );
    const mainLog = git(["--git-dir", mainRemote, "log", "--format=%h %s", "-5"]);

    console.log("\n[latch-demo] ---------- final state ----------");
    console.log(`[latch-demo] main history:\n${mainLog.split("\n").map((l) => `[latch-demo]   ${l}`).join("\n")}`);
    const trailers = git(["--git-dir", mainRemote, "log", "-1", "--format=%B"]);
    console.log(`[latch-demo] latest merge commit:\n${trailers.split("\n").map((l) => `[latch-demo]   ${l}`).join("\n")}`);

    check(byAgent.get("linus:Extract shared config loader") === "merged", "linus's work merged into main");
    check(byAgent.get("ada:Rename the index entry") === "merged", "ada's re-scoped work merged into main");
    check(
      byAgent.get("mallory:Improve the README") === "rejected",
      "mallory's dishonest changeset rejected, never merged",
    );
    check(
      !git(["--git-dir", mainRemote, "show", "HEAD:README.md"]).includes("smuggled"),
      "smuggled README change is NOT in main",
    );
    check(
      snapshot.body.leases.every((l: any) => l.agent === "mallory" && l.path === "src/other.ts"),
      "merged leases released; mallory keeps hers (rejection lets her retry)",
    );
    check(outcomes.filter((o) => o.startsWith("merged")).length === 2, "exactly two merges landed");
    check(outcomes.filter((o) => o.startsWith("rejected")).length === 1, "exactly one integration rejected");

    console.log(
      `\n[latch-demo] ${passed} checks passed, ${failed} failed — ${
        failed === 0 ? "DEMO PASS" : "DEMO FAIL"
      }`,
    );
    if (failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`[latch-demo] fatal: ${(error as Error).message}`);
    if (serverLog.length > 0) {
      console.error(`[latch-demo] ---- wrangler log tail ----\n${serverLog.slice(-20).join("")}`);
    }
    process.exitCode = 1;
  } finally {
    server.kill("SIGTERM");
    await sleep(1_500);
    if (server.exitCode === null) server.kill("SIGKILL");
    if (process.exitCode !== 1) rmSync(dir, { recursive: true, force: true });
    else console.log(`[latch-demo] keeping ${dir} for inspection`);
  }
}

void main();
