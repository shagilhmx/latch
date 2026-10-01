# Latch

**Lease-based concurrency for agent teams.** Agents don't get branches — they
get *leases*. Before an agent touches anything it claims file scope from a
workspace coordinator; overlapping claims are denied **before editing**, so
conflicts mostly can't happen. Code only reaches `main` through a serialized,
lease-verified integration step.

A submission for Cloudflare's
[Build the Next-Gen Git Platform challenge](https://www.cloudflare.com/git-competition/)
(submit by October 14, 2026).

## Status

Build step 1 — scaffold:

- ✅ Workers project (`wrangler.jsonc`) with Workers Assets serving the SPA
- ✅ `Coordinator` Durable Object (SQLite-backed, routing + health only)
- ✅ Vite + React UI shell (`src/ui`), strict TypeScript (split worker/UI configs)
- ✅ Vitest wiring via `@cloudflare/vitest-pool-workers`, smoke tests
- ⬜ Step 2: Coordinator schema + lease acquire/release/heartbeat/expiry + tests
- ⬜ Step 3: Artifacts wiring (workspace repo, session forks, pushed events)
- ⬜ Step 4: integration job (lease-verified merge into `main`)
- ⬜ Step 5: session sandboxes with agent runners
- ⬜ Step 6: live UI (lease heatmap, merge stream)
- ⬜ Step 7: scripted 3-agent demo
- ⬜ Step 8: verification pass
- ⬜ Step 9: submission package (video, run instructions)

## Architecture (target)

```
┌─ Worker (API + static UI)
│   ├─ Durable Object "Coordinator" (per workspace)
│   │    SQLite: leases, changesets, integration queue, event log
│   │    WebSocket broadcast → live UI
│   ├─ Event subscription: artifacts.repo.pushed → integration queue
│   └─ REST: workspaces, changesets, lease acquire/release/heartbeat
│
├─ Artifacts namespace
│    workspace repo (main) ← only integration job pushes here
│    └─ fork: session/<id> ← agent pushes here (write token, fork only)
│
└─ Sandbox SDK container (real git + agent CLI)
     ├─ session sandbox: clone fork, run agent, push to fork
     └─ integration sandbox: fetch main + branch, lease check, merge, push main
         (serialized by Coordinator — single writer on main)
```

**Enforcement boundary:** Artifacts tokens are repo-scoped, not ref-scoped, and
Artifacts has no pre-receive hooks. So agents only ever hold tokens to their own
session fork; the platform owns `main`. Agents physically cannot bypass leases.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/worker/index.ts` | Worker entry: API routing → Coordinator DO, SPA fallback → Assets |
| `src/worker/coordinator.ts` | `Coordinator` Durable Object (lease authority; schema lands in step 2) |
| `src/ui/` | React app (own `tsconfig.json` with DOM libs) |
| `test/` | Vitest suites running in the Workers runtime |
| `wrangler.jsonc` | Bindings: `ASSETS`, `COORDINATOR` (SQLite DO) + migrations |

## Scripts

```sh
npm install
npm run typecheck   # wrangler types + tsc (worker and UI configs)
npm test            # builds the SPA, then runs Vitest in workerd
npm run check       # typecheck + test
npm run dev         # vite build --watch + wrangler dev (http://localhost:8787)
npm run deploy      # build + wrangler deploy
```

## Prerequisites

- Node 20+
- A Cloudflare account on the **Workers Paid** plan with **Artifacts** enabled
  (required by the competition rules; Artifacts billing starts Oct 14, 2026)
- Authenticated Wrangler: `npx wrangler login` or `CLOUDFLARE_API_TOKEN`

## License

MIT — see [LICENSE](LICENSE).
