import { useEffect, useState } from "react";
import { shortId } from "./format";
import { Changesets } from "./panels/Changesets";
import { LeaseMap } from "./panels/LeaseMap";
import { MergeStream } from "./panels/MergeStream";
import { useWorkspace } from "./useWorkspace";

function currentWorkspace(): string {
  const match = /^\/w\/([A-Za-z0-9_-]+)/.exec(window.location.pathname);
  return match?.[1] ?? "demo";
}

export default function App() {
  const workspace = currentWorkspace();
  const { snapshot, connection } = useWorkspace(workspace);
  const [now, setNow] = useState(() => Date.now());

  // One-second ticker keeps countdowns and relative times honest.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const stats = snapshot?.stats;

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>
            Latch <span className="workspace">/{workspace}</span>
          </h1>
          <p className="tagline">
            Agents don&rsquo;t get branches &mdash; they get leases. Overlapping
            claims are refused before editing, so conflicts can&rsquo;t happen.
          </p>
        </div>
        <div className="status" aria-live="polite">
          <span className={`dot dot-${connection}`} aria-hidden="true" />
          <span className="status-text">
            {connection === "live"
              ? "streaming"
              : connection === "connecting"
                ? "connecting…"
                : "offline — polling"}
          </span>
        </div>
      </header>

      <section className="stats" aria-label="Workspace stats">
        <Stat label="Open leases" value={stats?.openLeases ?? 0} />
        <Stat label="Active changesets" value={stats?.activeChangesets ?? 0} />
        <Stat label="Queue" value={(stats?.pendingJobs ?? 0) + (stats?.runningJobs ?? 0)} />
        <Stat label="Main" value={shortId(snapshot?.config.mainRemote ?? null)} />
      </section>

      {snapshot === null ? (
        <section className="panel" aria-busy="true">
          <h2>Waiting for workspace…</h2>
          <p className="hint">
            The Coordinator streams a snapshot as soon as it answers.
          </p>
        </section>
      ) : (
        <section className="layout">
          <Changesets
            changesets={snapshot.changesets}
            leases={snapshot.leases}
            jobs={snapshot.jobs}
          />
          <MergeStream events={snapshot.recentEvents} now={now} />
          <LeaseMap leases={snapshot.leases} now={now} />
        </section>
      )}

      <footer>
        <p>
          Submission for Cloudflare&rsquo;s Build the Next-Gen Git Platform
          challenge. Live state comes from a Durable Object over WebSocket;
          every claim, denial, verification, and merge is an event.
        </p>
      </footer>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
