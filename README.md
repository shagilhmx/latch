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
so jobs run strictly one at a time. A runner that dies mid-job can't wedge
the queue: a `running` job older than five minutes is requeued for the next
poller — up to three claims — after which it is rejected back to its agent.
Verify/result reports echo the claim's attempt, so a zombie runner from a
superseded claim is refused (`409 stale_attempt`). The trusted runner (a
real git process)
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
line of defense is physical: agents cannot push `main` at all. The third
gates the trusted surface itself: `/integration/*` and `/internal/*` carry no
user identity, so they require the shared `RUNNER_TOKEN` secret in the
`x-latch-runner-token` header (compared in constant time). Production fails
closed (503) until the secret is set; dev mode without a token stays open so
the demo and test suite run accountless.

## Quickstart

```sh
npm install
npm run check      # typecheck + lint + full test suite (126 tests, workers + node)
npm run dev        # vite watch + wrangler dev → http://localhost:8787
npm run demo       # build + scripted 3-agent demo (see below)
npm run test:e2e   # Playwright browser tests against wrangler dev
npm run mcp        # Latch MCP server for AI clients (stdio; see below)
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

### MCP server

Any MCP client (Claude Code, Cursor, …) gets the agent loop as tools —
`latch_snapshot`, `latch_changeset_detail`, `latch_create_changeset`,
`latch_claim_leases`, `latch_heartbeat_leases`, `latch_release_leases`,
`latch_ready`, `latch_abort_changeset`, `latch_events`:

```sh
LATCH_BASE_URL=http://localhost:8787 LATCH_WORKSPACE=demo npm run mcp
# production: add LATCH_RUNNER_TOKEN=… if you also use runner tools upstream
```

Stdio transport — stdout carries the protocol, diagnostics go to stderr.
Writes are authorized exactly like any other API client (session cookie in
GitHub mode, dev identity locally). Implementation in
[`src/mcp/server.ts`](src/mcp/server.ts), exercised end-to-end over the real
MCP protocol in `test/node/mcp.test.ts`.

### API reference

`GET /api/openapi.json` serves an OpenAPI 3.1 description of every
coordination endpoint (claim/heartbeat/release/ready, integration queue,
events, WebSocket stream), generated-checked against the routes in
[`src/worker/openapi.ts`](src/worker/openapi.ts). Point any OpenAPI viewer
or client generator at it.

### Deploy

**Live preview (deployed):** https://latch.latch-lab.workers.dev — the
Coordinator Durable Object, queue consumer, SPA, and GitHub-mode auth run
in production; `npm run live` drives a 15-check end-to-end run against it
(sign a session with `LATCH_SESSION_SECRET`, arm the runner gate with
`LATCH_RUNNER_TOKEN`, then: fail-closed runner 401s, claim → ready →
runner merge → WebSocket push). The preview is worker-only because **Artifacts and
Containers require the Workers Paid plan** (the account-level gate the
competition rules already imply) — once upgraded, the full config
deploys as-is.

```sh
npx wrangler login              # OAuth (includes artifacts:write, containers:write)
# wrangler.deploy.jsonc: AI_GATEWAY_ACCOUNT_ID, GITHUB_CLIENT_ID vars
npx wrangler secret put AUTH_SECRET          # e.g. openssl rand -hex 32 | …
npx wrangler secret put RUNNER_TOKEN        # gates /integration + /internal (openssl rand -hex 32)
npx wrangler secret put GITHUB_CLIENT_SECRET # from the GitHub OAuth app
npx wrangler secret put AI_GATEWAY_TOKEN     # AI Gateway token for agent runs
npm run deploy                 # build + worker + container image push
```

One-time account setup (what actually works with wrangler 4.146):

- **workers.dev subdomain** — `PUT /accounts/:id/workers/subdomain`, or open
  the Workers page in the dashboard once.
- **Queue** — `npx wrangler queues create latch-artifacts-events`.
- **Artifacts namespace** — created from the dashboard (Storage &
  databases → Artifacts) or the REST API; there is no wrangler create
  command. Requires Workers Paid.
- **Push-event subscription** — account-wide: `wrangler queues subscription
  create latch-artifacts-events --source artifacts.repo --events
  cf.artifacts.repo.pushed`. Repo pushes need one more step: the API's
  filter (`source.namespace` + `source.repo_name`) can't be set by wrangler,
  and session forks are created dynamically — so Latch subscribes each fork
  individually: pass `subscribePushes` to `startSession()` (the session
  subscribes its own fork), or run
  `node scripts/subscribe-fork.ts ws-<workspace>.cs.<8hex>`. Both are
  config-gated on `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` and
  no-op with a typed `not_configured` result when unset.

The local config (`wrangler.jsonc`) runs accountless: the coordinator,
queue, runner, and UI all work in `wrangler dev`; with no Artifacts
binding, session forking falls back to local git and the
agent-execution route answers `503`.

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
6. **Trust but verify** (~60 s) — `npm run check` (126 tests: overlap
   matrix, atomicity, expiry, serialization, violations, property-based
   lease algebra, claim-storm/single-writer stress, runner auth, real-git
   merge/reject/conflict scenarios) and `npm run demo` end-to-end green.

## Authentication & workspaces

Two modes, decided by whether `AUTH_SECRET` is set:

- **Dev mode** (local, tests — no secrets): every request is attributed to
  a built-in `dev` identity; `POST /api/auth/dev {login}` switches identity
  (the UI shows a `dev` chip). This keeps the demo and suite accountless.
- **GitHub mode** (deployed): `GET /api/auth/login` → GitHub OAuth → signed
  HttpOnly session cookie (HMAC-SHA256, 30 days). Anonymous requests can
  read (the UI is a public monitor) but every mutation is refused with 401
  before any state changes.

Workspace roles mirror a public repository: **read** is open, **write**
(claims, readiness, sessions) is for members, and **owner** covers
configuration and membership (`PUT/DELETE /members`, last-owner protected).
The first actor to touch a brand-new workspace bootstraps as its owner;
owners add collaborators with `{userId, login, role}`. Denials surface in
the live stream as `auth.denied` events, and the API layer overwrites the
identity header on every request — clients cannot forge it.

The UI gates its action panels on the same identity: the claim form,
per-changeset abort, and member management are live for the dev identity
and signed-in users, and replaced by a sign-in prompt otherwise — the
server authorizes every action regardless.

Deploy secrets: `AUTH_SECRET` (required — fail-closed), `RUNNER_TOKEN`
(required for runner routes — also fail-closed), `GITHUB_CLIENT_SECRET`,
and the `GITHUB_CLIENT_ID` var. Runners and the queue consumer receive the
token via `--runner-token`/`LATCH_RUNNER_TOKEN` (the CLI and SDK both send
`x-latch-runner-token`).

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/worker/coordinator.ts` | `Coordinator` Durable Object — lease authority, single-writer queue, event log |
| `src/worker/{api,artifacts,events,http}.ts` | REST routes, Artifacts naming, queue consumer → integration, HTTP helpers |
| `src/integration/{runner,git,cli}.ts` | Trusted integration runner: git-side verify → `--no-ff` merge → push |
| `src/sessions/{runtime,local,session,sandbox,outbound}.ts` | Session orchestration; local git runtime + `AgentSandbox` container runtime |
| `src/sdk/` | Agent SDK: typed HTTP client + session orchestration re-exports |
| `src/mcp/` | Latch MCP server (stdio): the agent loop as MCP tools |
| `src/integration/fork-events.ts` | Per-fork push-subscription helper (repo-scoped event filter) |
| `src/worker/auth{,z}.ts` | Session cookies, GitHub OAuth, authorization policy |
| `src/ui/` | React SPA (lease map, changesets, merge stream) with WebSocket store |
| `container/` | `Dockerfile` (integration runner) + `Agent.Dockerfile` (agent CLI image) |
| `scripts/demo.ts` | The 3-agent scripted demo |
| `test/workers/`, `test/node/` | 126 tests: unit + DO behavior in workerd, property/stress suites, MCP protocol, real `wrangler dev` in node |
| `test/e2e/` | 7 Playwright flows against `wrangler dev` (streaming, WS push, auth, UI claim/abort, members, responsive) |
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
- ✅ Step 8 — verification: typecheck + lint + 97 tests + browser checks green
- ✅ Step 9 — submission package: run instructions, demo outline, CI workflow
- ✅ Hardening pass — coordinator split into modules, ESLint in `check`, directory lease claims, rejection→fix→retry flow
- ✅ Agent SDK + OpenAPI at `/api/openapi.json`
- ✅ Auth: GitHub OAuth, signed sessions, workspace roles, dev bypass
- ✅ Playwright E2E (5 flows) wired into CI alongside tests and the demo
- ✅ Live deploy: worker preview at latch.latch-lab.workers.dev — 15-point
  live e2e green (fail-closed 401, cookie auth, DO claim/queue/merge,
  WebSocket push); Artifacts + container deploy unlocks with Workers Paid
- ✅ Improvements pass — runner auth (`RUNNER_TOKEN`, fail-closed),
  stale-job recovery + zombie-report guard, per-fork push subscriptions,
  UI actions (claim/abort/members with sign-in gating), MCP server,
  property + stress suites (126 tests total, e2e 7 flows)

## License

MIT — see [LICENSE](LICENSE).
