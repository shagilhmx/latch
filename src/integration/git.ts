import { execFile } from "node:child_process";

/** Thrown when a git command exits non-zero. */
export class GitError extends Error {
  args: string[];
  stderr: string;

  constructor(args: string[], stderr: string) {
    super(`git ${args.join(" ")} failed: ${stderr}`);
    this.name = "GitError";
    this.args = args;
    this.stderr = stderr;
  }
}

export interface GitOptions {
  cwd?: string;
  /** `Authorization: Bearer <token>` extraHeader for Artifacts git remotes. */
  authHeader?: string;
  env?: Record<string, string>;
  /** Overrides the default Latch Integration identity for this command. */
  author?: { name: string; email: string };
}

/** Run git, returning trimmed stdout. Erasable-syntax-only (runs under Node type stripping). */
export function git(args: string[], options: GitOptions = {}): Promise<string> {
  const author = options.author;
  const fullArgs = [
    "-c",
    `user.name=${author?.name ?? "Latch Integration"}`,
    "-c",
    `user.email=${author?.email ?? "integration@latch.local"}`,
    ...(options.authHeader !== undefined ? ["-c", `http.extraHeader=${options.authHeader}`] : []),
    ...args,
  ];

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      fullArgs,
      {
        cwd: options.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitError(args, (stderr || error.message).trim()));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** Filesystem or git URL remotes don't need (and may reject) auth headers. */
export function bearer(token: string | null | undefined): string | undefined {
  return token !== null && token !== undefined && token.length > 0
    ? `Authorization: Bearer ${token}`
    : undefined;
}
