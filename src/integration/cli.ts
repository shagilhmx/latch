import { runOnce, type RunnerOptions } from "./runner.ts";

interface CliOptions extends RunnerOptions {
  once: boolean;
  intervalMs: number;
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const base = argValue(argv, "--base") ?? process.env["LATCH_BASE_URL"] ?? "http://127.0.0.1:8787";
  const workspace =
    argValue(argv, "--workspace") ?? process.env["LATCH_WORKSPACE"] ?? "default";
  const interval = Number(argValue(argv, "--interval") ?? "2000");
  return {
    baseUrl: base.replace(/\/$/, ""),
    workspace,
    workspaceToken: argValue(argv, "--token") ?? process.env["LATCH_WORKSPACE_TOKEN"],
    keepWorkdir: argv.includes("--keep-workdir"),
    once: argv.includes("--once"),
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval : 2000,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(`[latch-integration] polling ${options.baseUrl} (workspace: ${options.workspace})`);

  for (;;) {
    const outcome = await runOnce(options);

    if (outcome.status === "idle") {
      if (options.once) return;
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
      continue;
    }

    if (outcome.status === "merged") {
      console.log(
        `[latch-integration] job ${outcome.seq} merged ${outcome.sha} (${outcome.paths.length} files)`,
      );
    } else {
      console.log(`[latch-integration] job ${outcome.seq} rejected: ${outcome.reason}`);
    }

    if (options.once) return;
  }
}

main().catch((error: unknown) => {
  console.error("[latch-integration] fatal:", error);
  process.exitCode = 1;
});
