/** Result of running one command inside a session checkout. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PreparedCheckout {
  /** Directory containing the session's isolated clone of the fork. */
  workDir: string;
  /** HEAD at prepare time — the base for changed-path computation. */
  baseSha: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface Author {
  name: string;
  email: string;
}

/**
 * A session runtime owns the isolated checkout an agent works in and the
 * git operations that move its work to the session fork.
 *
 * - `local` (src/sessions/local.ts): filesystem clones + child-process git.
 *   Fully exercised by tests and the demo.
 * - `sandbox` (src/sessions/sandbox.ts): a container-backed Durable Object
 *   (deployed config only) — the same interface over `container.exec`.
 */
export interface SessionRuntime {
  readonly kind: "local" | "sandbox";
  /** Clone the session fork fresh into `workDir` and report its HEAD. */
  prepare(forkRemote: string, workDir: string): Promise<PreparedCheckout>;
  /** Run one command inside the checkout. */
  run(argv: string[], options?: RunOptions): Promise<CommandResult>;
  /** Files changed in the checkout since `baseSha` (committed state). */
  changedPaths(baseSha: string): Promise<string[]>;
  /** Commit everything in the checkout; resolves to the new HEAD sha. */
  commitAll(message: string, author?: Author): Promise<string>;
  /** Push HEAD to the session fork's default branch. */
  push(forkRemote: string, token?: string | null): Promise<void>;
  /** Drop any resources (local scratch dirs, container state). */
  cleanup(): Promise<void>;
}
