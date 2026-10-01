import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

const REPO_DIR = "/workspace/repo";
const TASK_DIR = "/workspace/task";
const EVENTS_PATH = `${TASK_DIR}/stdout.log`;
const STDERR_PATH = `${TASK_DIR}/stderr.log`;
const EXIT_CODE_PATH = `${TASK_DIR}/exit-code`;
const PID_PATH = `${TASK_DIR}/pid`;
const BASE_SHA_KEY = "baseSha";
const TASK_KEY = "task";
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const TASK_CHECK_INTERVAL_MS = 60 * 1000;

const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const TRUST_ENV = {
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
};

// Runs the agent in its own process group, recording pid and exit code.
const TASK_SCRIPT = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
	"$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

const TASK_RUNNING_SCRIPT = `read -r pid boot <"$1" &&
	[ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] &&
	kill -0 "$pid"`;

export type AgentTaskStatus =
  | { state: "none" }
  | { state: "running" }
  | { state: "lost" }
  | { state: "succeeded"; result: string }
  | { state: "failed"; error: string };

/**
 * One container per agent session (the deployed, container-backed session
 * runtime — plan steps 4/5). The checkout lives at /workspace/repo; the
 * container only reaches the Latch Artifacts host, GitHub, and the AI
 * Gateway (see src/sessions/outbound.ts).
 *
 * Local dev and tests use LocalSessionRuntime instead; this class is bound
 * only in wrangler.deploy.jsonc.
 */
export class AgentSandbox extends DurableObject<Env> {
  private readonly container: Container;
  private readonly files: Files;
  private setup: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const container = ctx.container;
    if (!container) {
      throw new Error("The container binding is not configured");
    }
    this.container = container;
    this.files = new Files(container);

    if (container.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  /** Clone the session fork fresh; records the base sha for diffing. */
  async checkout(remote: string, token: string | null): Promise<{ baseSha: string }> {
    await this.startSandbox();
    await this.files.remove(REPO_DIR, { recursive: true, force: true }).catch(() => undefined);

    await this.run(
      ["git", "clone", "--depth", "1", "--", remote, REPO_DIR],
      "/workspace",
      token !== null && token.length > 0
        ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` }
        : {},
    );

    const baseSha = await this.run(["git", "rev-parse", "HEAD"], REPO_DIR, {});
    await this.ctx.storage.kv.put(BASE_SHA_KEY, baseSha.stdout.trim());
    return { baseSha: baseSha.stdout.trim() };
  }

  /** Start one agent task in the background; returns "started" | "busy". */
  async startAgentTask(prompt: string): Promise<"started" | "busy"> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.startSandbox();

      if ((await this.taskStatus()).state === "running") {
        return "busy" as const;
      }

      await this.files.remove(TASK_DIR, { recursive: true, force: true });
      await this.files.mkdir(TASK_DIR);

      await this.container.exec(
        ["/bin/sh", "-c", TASK_SCRIPT, "agent", TASK_DIR, ...this.agentCommand(prompt)],
        {
          cwd: REPO_DIR,
          env: { ...TRUST_ENV, ...this.agentEnv() },
          stdout: "ignore",
          stderr: "ignore",
        },
      );

      this.ctx.storage.kv.put(TASK_KEY, "started");
      await this.ctx.storage.setAlarm(Date.now() + TASK_CHECK_INTERVAL_MS);
      return "started" as const;
    });
  }

  async alarm(): Promise<void> {
    if (!this.container.running) return;
    if ((await this.taskStatus()).state === "running") {
      await this.ctx.storage.setAlarm(Date.now() + TASK_CHECK_INTERVAL_MS);
      return;
    }
    this.ctx.storage.kv.delete(TASK_KEY);
  }

  async status(): Promise<AgentTaskStatus> {
    if (!this.container.running) {
      return this.ctx.storage.kv.get(TASK_KEY) === undefined
        ? { state: "none" }
        : { state: "lost" };
    }
    return this.taskStatus();
  }

  /** Uncommitted changes since checkout, as a git diff. */
  async readDiff(): Promise<string> {
    await this.startSandbox();
    const result = await this.run(
      ["/bin/sh", "-c", "git add --intent-to-add . && git diff"],
      REPO_DIR,
      {},
    );
    return result.stdout;
  }

  /** Commit everything, push to the session fork, report touched paths. */
  async pushChanges(
    remote: string,
    token: string | null,
    message: string,
    author: { name: string; email: string },
  ): Promise<{ sha: string; touchedPaths: string[] }> {
    await this.startSandbox();

    await this.run(["git", "add", "-A"], REPO_DIR, {});
    const staged = await this.run(["diff", "--cached", "--name-only"], REPO_DIR, {});
    if (staged.stdout.trim().length === 0) {
      const sha = await this.run(["rev-parse", "HEAD"], REPO_DIR, {});
      return { sha: sha.stdout.trim(), touchedPaths: [] };
    }

    await this.run(
      ["git", "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message],
      REPO_DIR,
      {},
    );

    const baseSha = (await this.ctx.storage.kv.get(BASE_SHA_KEY)) ?? "HEAD";
    const changed = await this.run(
      ["git", "diff", "--name-only", `${baseSha}..HEAD`],
      REPO_DIR,
      {},
    );
    const touchedPaths = changed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const pushEnv: Record<string, string> =
      token !== null && token.length > 0
        ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` }
        : {};
    await this.run(["push", "--quiet", remote, "HEAD:refs/heads/main"], REPO_DIR, pushEnv);

    const sha = await this.run(["rev-parse", "HEAD"], REPO_DIR, {});
    return { sha: sha.stdout.trim(), touchedPaths };
  }

  /** Stop and drop the container for this session. */
  async dispose(): Promise<void> {
    await this.container.destroy().catch(() => undefined);
    this.ctx.storage.kv.delete(TASK_KEY);
    this.ctx.storage.kv.delete(BASE_SHA_KEY);
  }

  // ------------------------------------------------------------- internals

  private agentCommand(prompt: string): string[] {
    return [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--model",
      this.env.MODEL,
      "--",
      prompt,
    ];
  }

  private agentEnv(): Record<string, string> {
    return {
      ANTHROPIC_BASE_URL: `https://gateway.ai.cloudflare.com/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/anthropic`,
      ANTHROPIC_API_KEY: "provided-by-worker",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      IS_SANDBOX: "1",
    };
  }

  private async startSandbox(): Promise<void> {
    if (this.setup === undefined || !this.container.running) {
      this.setup = this.setUpSandbox().catch((error: unknown) => {
        this.setup = undefined;
        throw error;
      });
    }
    await this.setup;
  }

  private async setUpSandbox(): Promise<void> {
    if (!this.container.running) {
      this.ctx.storage.kv.delete(TASK_KEY);
      this.container.start({
        image: this.container.images.agent,
        instance: "standard-1",
        enableInternet: false,
      });
    }

    try {
      await this.container.interceptOutboundHttps("*", this.ctx.exports.Outbound);
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    } catch (error) {
      await this.container.destroy().catch(() => undefined);
      throw error;
    }
  }

  private async taskStatus(): Promise<AgentTaskStatus> {
    const exitCode = await this.readOptionalText(EXIT_CODE_PATH);
    if (exitCode !== undefined) {
      return this.outcome(Number.parseInt(exitCode, 10));
    }

    const pid = await this.readOptionalText(PID_PATH);
    if (pid === undefined) {
      return this.ctx.storage.kv.get(TASK_KEY) === undefined
        ? { state: "none" }
        : { state: "running" };
    }

    const probe = await this.run(
      ["/bin/sh", "-c", TASK_RUNNING_SCRIPT, "probe", PID_PATH],
      "/",
      {},
    );
    if (probe.exitCode === 0) {
      return { state: "running" };
    }

    const lateExitCode = await this.readOptionalText(EXIT_CODE_PATH);
    if (lateExitCode !== undefined) {
      return this.outcome(Number.parseInt(lateExitCode, 10));
    }
    return { state: "lost" };
  }

  private async outcome(exitCode: number): Promise<AgentTaskStatus> {
    const text = await this.readOptionalText(EVENTS_PATH);
    if (text !== undefined) {
      for (const line of text.split("\n")) {
        const parsed = safeParse(line);
        if (
          parsed !== undefined &&
          (parsed as { type?: string }).type === "result" &&
          typeof (parsed as { is_error?: unknown }).is_error === "boolean"
        ) {
          if ((parsed as { is_error: boolean }).is_error) {
            return {
              state: "failed",
              error: String((parsed as { result?: string }).result ?? "agent error"),
            };
          }
          return {
            state: "succeeded",
            result: String((parsed as { result?: string }).result ?? ""),
          };
        }
      }
    }

    const stderr = (await this.readOptionalText(STDERR_PATH)) ?? "";
    return {
      state: "failed",
      error: `agent exited with ${exitCode}: ${stderr.slice(-2000)}`,
    };
  }

  private async readOptionalText(path: string): Promise<string | undefined> {
    try {
      return await (await this.files.readFile(path)).text();
    } catch (error) {
      if (SandboxFileError.is(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async run(
    command: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const process = await this.container.exec(command, { cwd, env });
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
