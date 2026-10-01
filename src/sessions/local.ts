import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { bearer, git } from "../integration/git.ts";
import type { Author, CommandResult, PreparedCheckout, RunOptions, SessionRuntime } from "./runtime.ts";

/**
 * Local session runtime: filesystem clones and child-process git. This is
 * the path the demo and every test exercise; the deployed path swaps in
 * `AgentSandbox` (src/sessions/sandbox.ts) behind the same interface.
 */
export class LocalSessionRuntime implements SessionRuntime {
  readonly kind = "local" as const;
  private workDir: string | null = null;

  async prepare(forkRemote: string, workDir: string): Promise<PreparedCheckout> {
    await rm(workDir, { recursive: true, force: true });
    await git(["clone", "--quiet", forkRemote, workDir]);
    const baseSha = await git(["rev-parse", "HEAD"], { cwd: workDir });
    this.workDir = workDir;
    return { workDir, baseSha };
  }

  async run(argv: string[], options: RunOptions = {}): Promise<CommandResult> {
    const [command, ...rest] = argv;
    if (command === undefined) {
      return { exitCode: 127, stdout: "", stderr: "empty command" };
    }
    return new Promise((resolve) => {
      execFile(
        command,
        rest,
        {
          cwd: options.cwd ?? this.workDir ?? undefined,
          env: { ...process.env, ...options.env },
          timeout: options.timeoutMs ?? 300_000,
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error !== null && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : error !== null
                ? 1
                : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
    });
  }

  async changedPaths(baseSha: string): Promise<string[]> {
    const dir = this.requireWorkDir();
    const diff = await git(["diff", "--name-only", `${baseSha}..HEAD`], { cwd: dir });
    return diff
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async commitAll(message: string, author?: Author): Promise<string> {
    const dir = this.requireWorkDir();
    await git(["add", "-A"], { cwd: dir });
    const staged = await git(["diff", "--cached", "--name-only"], { cwd: dir });
    if (staged.length === 0) {
      return git(["rev-parse", "HEAD"], { cwd: dir });
    }
    await git(["commit", "--quiet", "-m", message], {
      cwd: dir,
      author,
    });
    return git(["rev-parse", "HEAD"], { cwd: dir });
  }

  async push(forkRemote: string, token?: string | null): Promise<void> {
    const dir = this.requireWorkDir();
    await git(["push", "--quiet", forkRemote, "HEAD:refs/heads/main"], {
      cwd: dir,
      authHeader: bearer(token),
    });
  }

  async cleanup(): Promise<void> {
    if (this.workDir !== null) {
      await rm(this.workDir, { recursive: true, force: true });
      this.workDir = null;
    }
  }

  private requireWorkDir(): string {
    if (this.workDir === null) {
      throw new Error("Session runtime not prepared — call prepare() first");
    }
    return this.workDir;
  }
}
