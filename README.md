# Latch

**Lease-based concurrency for agent teams.** Agents don't get branches — they
get *leases*. Before an agent touches a file it claims path scope from a
workspace coordinator; overlapping claims are denied **before any editing
happens**, so most conflicts can't occur. The few that still slip through are
caught by a trusted integration step that derives changed paths from git
itself and re-verifies them against live leases before anything reaches
`main`.

A submission for Cloudflare's
[Build the Next-Gen Git Platform challenge](https://www.cloudflare.com/git-competition/)
(submit by October 14, 2026).

```
linus claims src/config.ts + src/util.ts   → granted
ada    claims src/config.ts (parallel)     → REFUSED: held by linus
ada    re-scopes to src/index.ts           → granted → merged ✓
mallory claims src/other.ts, edits README  → rejected by git-side verify ✗
```

That is the whole product in four lines — and it is exactly what
`npm run demo` executes.

## How it works

**1. Claim before you edit.** Each workspace has one `Coordinator` Durable
Object (SQLite, single-threaded per workspace) that owns a `leases` table.
Agents acquire path leases atomically — all paths or none — before editing.
A claim that overlaps a live lease is refused with the holder's identity, so
the agent can re-scope instead of colliding later. Leases heartbeat, expire
lazily on every request, and release on merge.

**2. Agents only ever hold tokens to their own fork.** Artifacts tokens are
repo-scoped, not ref-scoped, and Artifacts has no pre-receive hooks — so the
platform never hands an agent a token that can reach `main`. Session forks
are named `ws-<workspace>.cs.<changeset>`; the `.cs.` marker maps pushed
events back to a changeset with no external database.

**3. One serialized writer for `main`.** Readiness enqueues an integration
job; the `Coordinator`'s claim loop has no `await`s between claim and lease,
so jobs run strictly one at a time. The trusted runner (a real git process)
clones `main`, fetches the fork HEAD, runs `git diff --name-only <merge-base>`
— paths git itself derived, not agent-declared — and POSTs them back to
`POST /integration/:seq/verify`. Any path outside the job's live leases
rejects the job *and* the changeset before a merge is attempted.

**4. Merge with provenance.** Clean jobs merge `--no-ff` on `main` with
trailers (`Latch-Changeset`, `Latch-Agent`, `Latch-Ref`, `Intent`,
`Lease-Paths`) and push. Merge conflicts are reported back to the agent as an
escalation — the runner never forces `main`.

**Enforcement boundary:** lease checks in the UI are advisory; the
authoritative check runs in the runner against git-derived paths. The second
line of defense is physical: agents cannot push `main` at all.

## Quickstart

```sh
npm install
npm run check      # typecheck + full test suite (66 tests, workers + node)
npm run dev        # vite watch + wrangler dev → http://localhost:8787
npm run demo       # build + scripted 3-agent demo (see below)
```

The demo seeds a temp workspace, boots `wrangler dev`, and runs three agent
sessions concurrently with 12 assertions: two merges land, one claim is
refused up front, one smuggled edit is rejected by git-side verification,
`main` stays clean, and leases end in the expected state. Watch it live at
the URL it prints — the UI streams every claim, denial, and merge over
WebSocket.

```sh
npm run integration   # real-wrangler integration tests against a temp git remote
npm test              # vitest run (workers pool + node)
npm run typecheck     # wrangler types + tsc (worker and UI configs)
```

### Agent SDK

Real agent frameworks integrate through the SDK in [`src/sdk/`](src/sdk/):

```ts
import { LatchClient, startSession, finishSession, awaitIntegration } from "latch/sdk";

// Low-level: one client per workspace.
const client = new LatchClient({ baseUrl, workspace: "demo" });
const { changeset } = await client.createChangeset("ada", "Rename loader");
await client.claim(changeset.id, ["src/"]);        // directory claim
await client.heartbeat(changeset.id);              // keep it alive

// High-level: the full agent loop over a SessionRuntime.
const started = await startSession({ baseUrl, workspace: "demo", agent: "ada", … });
const first = await finishSession({ …, changesetId: started.changeset.id, baseSha: started.baseSha });
const verdict = await awaitIntegration({ baseUrl, workspace: "demo", changesetId: started.changeset.id });
if (verdict.status === "rejected") {
  // leases are still yours — fix inside your scope and call finishSession again
}
```

### API reference

`GET /api/openapi.json` serves an OpenAPI 3.1 description of every
coordination endpoint (claim/heartbeat/release/ready, integration queue,
events, WebSocket stream), generated-checked against the routes in
[`src/worker/openapi.ts`](src/worker/openapi.ts). Point any OpenAPI viewer
or client generator at it.

### Deploy

```sh
npx wrangler login
# edit wrangler.deploy.jsonc: account id, gateway vars
npx wrangler secret put AI_GATEWAY_TOKEN
npm run deploy        # wrangler deploy -c wrangler.deploy.jsonc
```

Deploy needs Docker (the `AgentSandbox` container image) and a Workers Paid
plan with Artifacts enabled. The local config (`wrangler.jsonc`) runs
accountless: the coordinator, queue, runner, and UI all work in
`wrangler dev`; with no Artifacts binding, session forking falls back to
local git and the agent-execution route answers `503`.

## Demo video outline (5–10 min)

1. **The problem** (~45 s) — parallel agents + branch-per-agent = merge
   conflicts, duplicate work, "who owns this file?" Latch moves the lock to
   *before* the edit.
2. **Claim before edit** (~90 s) — `npm run demo` side by side with the UI:
   linus's claim lights up the lease map; ada's overlapping claim is refused
   in the merge stream *before* she touches anything.
3. **Re-scope and merge** (~90 s) — ada claims a free file, both agents work
   concurrently, jobs serialize through the single writer, merges land with
   `Lease-Paths` trailers shown in `git log`.
4. **The hostile agent** (~90 s) — mallory claims one file honestly, edits
   another, and lies about `touchedPaths` at readiness. The runner derives
   paths from git, verify rejects the job, `git log` proves `main` untouched,
   her lease is still held so she can fix and retry.
5. **Architecture** (~90 s) — Coordinator DO (leases/queue/events over one
   SQLite), Artifacts fork naming, why agents physically can't push `main`,
   hibernated WebSocket → live UI.
6. **Trust but verify** (~60 s) — `npm run check` (66 tests: overlap matrix,
   atomicity, expiry, serialization, violations, real-git merge/reject/conflict
   scenarios) and `npm run demo` end-to-end green.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/worker/coordinator.ts` | `Coordinator` Durable Object — lease authority, single-writer queue, event log |
| `src/worker/{api,artifacts,events,http}.ts` | REST routes, Artifacts naming, queue consumer → integration, HTTP helpers |
| `src/integration/{runner,git,cli}.ts` | Trusted integration runner: git-side verify → `--no-ff` merge → push |
| `src/sessions/{runtime,local,session,sandbox,outbound}.ts` | Session orchestration; local git runtime + `AgentSandbox` container runtime |
| `src/sdk/` | Agent SDK: typed HTTP client + session orchestration re-exports |
| `src/ui/` | React SPA (lease map, changesets, merge stream) with WebSocket store |
| `container/` | `Dockerfile` (integration runner) + `Agent.Dockerfile` (agent CLI image) |
| `scripts/demo.ts` | The 3-agent scripted demo |
| `test/workers/`, `test/node/` | 66 tests: unit + DO behavior in workerd, real `wrangler dev` in node |
| `wrangler.jsonc` | Local config (accountless: DO + assets + queue) |
| `wrangler.deploy.jsonc` | Deploy config (adds `ARTIFACTS`, `AGENT_SANDBOX` container, gateway) |

## Status

- ✅ Step 1 — scaffold: Workers project, DO, Vite/React UI shell, vitest wiring
- ✅ Step 2 — coordinator schema: atomic leases, heartbeat, expiry, queue, events
- ✅ Step 3 — Artifacts wiring: workspace repos, session forks, pushed events
- ✅ Step 4 — integration runner: git-derived path verify + serialized merges
- ✅ Step 5 — session runtimes: local git + AgentSandbox container + orchestrator
- ✅ Step 6 — live UI: WebSocket store, lease map, changesets, merge stream
- ✅ Step 7 — scripted 3-agent demo (12/12 assertions)
- ✅ Step 8 — verification: typecheck + 66 tests + browser checks green
- ✅ Step 9 — submission package: run instructions, demo outline, CI workflow

## License

MIT — see [LICENSE](LICENSE).
