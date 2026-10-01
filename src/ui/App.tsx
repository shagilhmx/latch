const PANELS = [
  { title: "Lease map", hint: "Live file-scope claims per agent session" },
  { title: "Changesets", hint: "Intent, scope, and merge status per change" },
  { title: "Merge stream", hint: "Integrations landing on main, in order" },
] as const;

export default function App() {
  return (
    <main>
      <header>
        <h1>Latch</h1>
        <p className="tagline">
          Agents don&rsquo;t get branches &mdash; they get leases. Overlapping
          claims are denied before editing, so conflicts can&rsquo;t happen.
        </p>
      </header>

      <section className="panels" aria-label="Workspace panels">
        {PANELS.map((panel) => (
          <article key={panel.title} className="panel">
            <h2>{panel.title}</h2>
            <p className="hint">{panel.hint}</p>
            <p className="placeholder">Connected in a later build step.</p>
          </article>
        ))}
      </section>

      <footer>
        <p>
          Submission for Cloudflare&rsquo;s Build the Next-Gen Git Platform
          challenge. Scaffold stage: Worker, Durable Object, and Assets wiring
          are live.
        </p>
      </footer>
    </main>
  );
}
