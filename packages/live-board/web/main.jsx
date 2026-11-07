import {
  Activity,
  ArrowUpRight,
  CheckCheck,
  ChevronRight,
  Flag,
  Layers,
  LayoutGrid,
  Menu,
  Plus,
  Radio,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const blank = { projects: [], events: [], seenAt: null };
const colors = ["sage", "peach", "lavender", "blue"];
async function sessionToken() {
  const response = await fetch("/api/session");
  if (!response.ok) throw new Error(`Unable to connect to the local server (${response.status}).`);
  const session = await response.json();
  if (typeof session.token !== "string" || !session.token)
    throw new Error("The local server returned an invalid session.");
  return session.token;
}
function when(date) {
  return date ? new Date(date).toLocaleString() : "Not observed yet";
}
function Link({ href, children, ...props }) {
  return /^https?:\/\//.test(href || "") ? (
    <a {...props} href={href} target="_blank" rel="noreferrer">
      {children} <ArrowUpRight size={16} />
    </a>
  ) : (
    <span {...props}>{children}</span>
  );
}
function Pill({ children, tone = "green" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
function App() {
  const [data, setData] = useState(blank),
    [page, setPage] = useState("overview"),
    [query, setQuery] = useState("");
  const [connected, setConnected] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  const [adding, setAdding] = useState(false),
    [source, setSource] = useState(""),
    [busy, setBusy] = useState(false),
    [mobile, setMobile] = useState(false);
  const token = useRef(""),
    dialog = useRef(null),
    addButton = useRef(null);
  useEffect(() => {
    let alive = true;
    sessionToken()
      .then((value) => {
        if (alive) token.current = value;
      })
      .catch(() => {
        if (alive) setError("Unable to connect to the local server.");
      });
    const stream = new EventSource("/api/events");
    stream.onmessage = (e) => {
      setData(JSON.parse(e.data));
      setConnected(true);
      setLoaded(true);
    };
    stream.onerror = () => setConnected(false);
    return () => {
      alive = false;
      stream.close();
    };
  }, []);
  useEffect(() => {
    if (adding) dialog.current?.showModal();
    else dialog.current?.close();
  }, [adding]);
  async function action(path, body = {}) {
    setBusy(true);
    setError("");
    try {
      if (!token.current) token.current = await sessionToken();
      const send = () =>
        fetch(`/api/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Tracker-Token": token.current },
          body: JSON.stringify(body),
        });
      let response = await send();
      // A restarted server rejects the old token before performing any mutation.
      // Renew and retry once; never replay failed writes for other status codes.
      if (response.status === 403) {
        token.current = await sessionToken();
        response = await send();
      }
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `Request failed (${response.status})`);
      }
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const attention = data.projects.flatMap((p) =>
    p.attention.map((a) => ({ ...a, project: p.name, projectId: p.id })),
  );
  const selected = data.projects.find((p) => p.id === page);
  const projects = data.projects.filter((p) =>
    `${p.name} ${p.plan?.description || ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  const newEvents = data.events.filter((e) => !data.seenAt || e.at > data.seenAt);
  const title =
    selected?.name ||
    {
      overview: "Your work, in view.",
      attention: "A moment of your attention",
      activity: "The story so far",
    }[page] ||
    "Your work, in view.";
  const go = (id) => {
    setPage(id);
    setMobile(false);
  };
  function events(items) {
    return (
      <div className="event-list">
        {items.length ? (
          items.map((e) => (
            <div className="event-item" key={e.id}>
              <span className="event-dot">
                <Activity size={18} />
              </span>
              <div className="event-copy">
                <strong>
                  <Link href={e.source}>{e.title}</Link>
                </strong>
                <span className="event-project">
                  {data.projects.find((p) => p.id === e.project)?.name || "Archived project"}
                </span>
                <time>{when(e.at)}</time>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-inline">
            No changes recorded yet. New observations will appear here.
          </div>
        )}
      </div>
    );
  }
  function needs(items) {
    return (
      <div className="attention-list">
        {items.length ? (
          items.map((a) => (
            <div className="attention-item" key={`${a.projectId}-${a.type}-${a.id}`}>
              <span className="attention-icon">
                <Flag size={20} />
              </span>
              <div className="attention-copy">
                <span className="eyebrow-row">
                  {a.project} · {a.type}
                </span>
                <strong>
                  <Link href={a.source}>{a.title}</Link>
                </strong>
                <span className="attention-description">
                  {a.detail || "Review this item in the tracking plan."}
                </span>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-inline">No items need attention in the current observations.</div>
        )}
      </div>
    );
  }
  return (
    <div className={`app ${mobile ? "mobile-open" : ""}`}>
      <aside className={`sidebar ${mobile ? "open" : ""}`} aria-label="Workspace navigation">
        <button type="button" className="brand-button" onClick={() => go("overview")}>
          <span className="brand">
            <span className="brand-mark">
              <span />
              <span />
              <span />
            </span>
            orbit<span className="brand-period">.</span>
          </span>
        </button>
        <div className="workspace-switch">
          <span className="workspace-icon">L</span>
          <span>
            Local workspace<small>Your projects, together</small>
          </span>
        </div>
        <div className="sidebar-label">WORKSPACE</div>
        {[
          ["overview", LayoutGrid, "Overview"],
          ["attention", Flag, "Needs you"],
          ["activity", Activity, "Activity"],
        ].map(([id, Icon, label]) => (
          <button
            type="button"
            key={id}
            className={`nav-item ${page === id ? "active" : ""}`}
            onClick={() => go(id)}
          >
            <Icon size={20} />
            {label}
            {id === "attention" && attention.length > 0 && (
              <span className="count-badge">{attention.length}</span>
            )}
          </button>
        ))}
        <div className="sidebar-label projects-label">YOUR PROJECTS</div>
        {data.projects.map((p, i) => (
          <button
            type="button"
            key={p.id}
            className={`nav-project ${page === p.id ? "active" : ""}`}
            onClick={() => go(p.id)}
          >
            <span className={`mini-dot ${colors[i % 4]}`} />
            <span>{p.name}</span>
          </button>
        ))}
        <button type="button" className="add-project-link" onClick={() => setAdding(true)}>
          <Plus size={18} />
          Track a project
        </button>
        <div className="sidebar-bottom">
          <div className="connection-status">
            <span className="connection-icon">
              <Radio size={20} />
            </span>
            <span>
              {connected ? "Live connection" : "Reconnecting…"}
              <small>Stored on this computer</small>
            </span>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              type="button"
              className="icon-button mobile-menu"
              aria-label="Toggle navigation"
              onClick={() => setMobile(!mobile)}
            >
              <Menu size={24} />
            </button>
            <Layers size={18} />
            <span>Workspace</span>
            <ChevronRight size={16} />
            <span className="breadcrumb-current">{selected ? "Project" : page}</span>
          </div>
          <label className="live-search">
            <Search size={20} />
            <input
              aria-label="Search projects"
              placeholder="Find a project…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage("overview");
              }}
            />
          </label>
        </header>
        <main>
          {!connected && (
            <div className="notice" role="status">
              {loaded
                ? "Connection interrupted. Displaying the last received state; reconnecting automatically."
                : "Connecting to your local tracker…"}
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={20} />
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="date-label">YOUR WORKSPACE, AT A GLANCE</div>
              <h1>{title}</h1>
              <p>
                {selected?.plan?.description ||
                  "A clear plan. A shared picture. Everything moving forward."}
              </p>
            </div>
            <div className="heading-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy || data.refreshing}
                onClick={() => action("refresh")}
                aria-label="Refresh sources"
              >
                <RefreshCw size={20} />
                {data.refreshing ? "Refreshing…" : "Refresh"}
              </button>
              <button
                type="button"
                ref={addButton}
                className="button primary"
                onClick={() => setAdding(true)}
                aria-label="Track a project"
              >
                <Plus size={20} />
                Track a project
              </button>
            </div>
          </div>
          {page === "overview" && (
            <>
              <div className="summary-strip">
                {[
                  [Layers, data.projects.length, "projects tracked"],
                  [Flag, attention.length, "need your attention"],
                  [
                    CheckCheck,
                    data.projects.reduce((s, p) => s + p.completed, 0),
                    "units complete",
                  ],
                ].map(([Icon, value, label]) => (
                  <div className="summary-item" key={label}>
                    <span className="summary-icon">
                      <Icon size={24} />
                    </span>
                    <span>
                      <strong>{value.toString().padStart(2, "0")}</strong>
                      <span className="summary-caption">{label}</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="section-heading">
                <h2>
                  Projects <span className="section-count">{projects.length}</span>
                </h2>
                <span className="muted">Plans define progress · sources provide evidence</span>
              </div>
              {!data.projects.length ? (
                <div className="empty-state">
                  <Layers size={40} />
                  <h2>A clearer view starts with one project.</h2>
                  <p>
                    Connect a GitHub tracking issue with a versioned tracking plan. Bring two,
                    three, or your whole portfolio into view.
                  </p>
                  <button type="button" className="button primary" onClick={() => setAdding(true)}>
                    <Plus size={20} />
                    Connect your first project
                  </button>
                  <p>
                    Local plans work too: <code>project-watch add ./plan.json</code>
                  </p>
                </div>
              ) : (
                <div className="project-grid">
                  {projects.map((p, i) => (
                    <button
                      type="button"
                      className={`project-card card-${colors[i % 4]}`}
                      key={p.id}
                      onClick={() => go(p.id)}
                    >
                      <div className="project-card-top">
                        <span className={`project-glyph ${colors[i % 4]}`}>
                          <Layers size={22} />
                        </span>
                        <span className="project-card-repo">
                          {p.kind === "issue"
                            ? new URL(p.source).pathname.split("/").slice(1, 3).join(" / ")
                            : "Local tracking plan"}
                        </span>
                        <ArrowUpRight size={20} />
                      </div>
                      <h3>{p.name}</h3>
                      <p>{p.plan?.description || "Waiting for a valid tracking plan"}</p>
                      <div className="progress-information">
                        <strong>
                          {p.total ? Math.round((p.completed / p.total) * 100) : "—"}
                          <span>{p.total ? "%" : ""}</span>
                        </strong>
                        <div className="completed-label">
                          {p.completed} of {p.total} units complete
                        </div>
                      </div>
                      <div className="progress-track">
                        <span
                          className="progress-fill"
                          style={{ width: `${p.total ? (p.completed / p.total) * 100 : 0}%` }}
                        />
                      </div>
                      <div className="project-current">
                        <span className="tiny-label">IN FOCUS</span>
                        <span>
                          {p.units.find((u) => u.status === "active")?.title ||
                            p.units.find((u) => u.canStart)?.title ||
                            "Review the plan"}
                        </span>
                      </div>
                      <div className="project-card-footer">
                        <Pill tone={p.stale ? "amber" : p.attention.length ? "purple" : "green"}>
                          {p.stale
                            ? "Source needs attention"
                            : p.attention.length
                              ? `${p.attention.length} decisions / approvals`
                              : "Up to date"}
                        </Pill>
                        <span className="agent-count">
                          {p.tasks.filter((t) => t.status === "running" && !t.stale).length} active
                          agents
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div className="lower-grid">
                <section>
                  <div className="section-heading">
                    <h2>
                      <Flag size={20} />A moment of your attention
                    </h2>
                    <button type="button" className="text-button" onClick={() => go("attention")}>
                      View all →
                    </button>
                  </div>
                  {needs(attention.slice(0, 4))}
                </section>
                <section>
                  <div className="section-heading">
                    <h2>While you were away</h2>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => action("seen")}
                    >
                      Mark seen
                    </button>
                  </div>
                  {events(newEvents.slice(0, 5))}
                </section>
              </div>
            </>
          )}
          {page === "attention" && (
            <>
              {needs(attention)}
              <p className="muted">
                Approvals are recorded in the source plan with evidence. This board never grants
                permission to start work.
              </p>
            </>
          )}
          {page === "activity" && (
            <>
              <div className="section-heading">
                <h2>Recorded changes</h2>
                <button type="button" className="button secondary" onClick={() => action("seen")}>
                  Mark seen
                </button>
              </div>
              {events(data.events)}
            </>
          )}
          {selected && (
            <>
              <div className="project-subheader">
                <Link href={selected.source}>Open source plan</Link>
                <span className="source-health">
                  Last successful observation: {when(selected.observedAt)}
                </span>
              </div>
              {selected.error && (
                <div className="notice error">
                  <strong>Source unavailable or invalid.</strong>
                  <p>{selected.error}</p>
                  <p>The last valid plan is retained. Fix the source and refresh.</p>
                </div>
              )}
              {selected.stale && !selected.error && (
                <div className="notice">
                  This source has not been observed recently. Refresh before relying on this status.
                </div>
              )}
              <div className="section-heading">
                <h2>The plan</h2>
                <span>
                  {selected.completed} of {selected.total} units complete
                </span>
              </div>
              <div className="live-plan">
                {selected.units.map((u) => (
                  <article className="unit" key={u.id}>
                    <div className="unit-heading">
                      <h3>{u.title}</h3>
                      <Pill
                        tone={
                          u.status === "blocked" ? "amber" : u.status === "done" ? "green" : "blue"
                        }
                      >
                        {u.status}
                      </Pill>
                    </div>
                    <p>{u.outcome || "No outcome described."}</p>
                    <div className="unit-meta">
                      <span>
                        Approval: <strong>{u.approval}</strong>
                      </span>
                      <span>
                        Dependencies:{" "}
                        <strong>{u.dependenciesSatisfied ? "satisfied" : "waiting"}</strong>
                      </span>
                      {u.canStart && !selected.stale && <Pill>Ready to start</Pill>}
                    </div>
                    {u.dependsOn.length > 0 && <p>Depends on: {u.dependsOn.join(", ")}</p>}
                    {u.verification && (
                      <p>
                        <strong>Verification:</strong> {u.verification}
                      </p>
                    )}
                    <div className="evidence-links">
                      {u.approvalEvidence && (
                        <Link href={u.approvalEvidence}>Approval evidence</Link>
                      )}
                      {u.evidence.map((url, i) => (
                        <Link href={url} key={url}>
                          Evidence {i + 1}
                        </Link>
                      ))}
                    </div>
                    {u.prs.map((url) => {
                      const pr = selected.prs[url];
                      return (
                        <div className="pr-observation" key={url}>
                          <Link href={url}>{pr?.title || url}</Link>
                          <div>
                            {pr
                              ? `${pr.state} · checks ${pr.checks.state} · ${pr.conflicting ? "has conflicts" : pr.conflicting === false ? "no conflicts reported" : "conflicts unknown"}`
                              : "Not observed"}
                          </div>
                          {selected.prErrors[url] && (
                            <div role="status" className="error-text">
                              Observation failed; retained status may be stale.{" "}
                              {selected.prErrors[url]}
                            </div>
                          )}
                          {pr && <small>Observed {when(pr.takenAt)}</small>}
                        </div>
                      );
                    })}
                  </article>
                ))}
              </div>
              <section className="live-section">
                <div className="section-heading">
                  <h2>Decisions & scope</h2>
                </div>
                {needs(attention.filter((a) => a.projectId === selected.id))}
              </section>
              <section className="live-section">
                <div className="section-heading">
                  <h2>Agent reports</h2>
                </div>
                <div className="live-plan">
                  {selected.tasks.length ? (
                    selected.tasks.map((t) => (
                      <article className="unit" key={t.id}>
                        <div className="unit-heading">
                          <h3>
                            {t.agent} · {t.unit}
                          </h3>
                          <Pill tone={t.stale || t.status === "failed" ? "amber" : "green"}>
                            {t.stale ? "Heartbeat expired" : t.status}
                          </Pill>
                        </div>
                        <p>{t.message}</p>
                        <div className="evidence-links">
                          {t.evidence.map((url, i) => (
                            <Link href={url} key={url}>
                              Evidence {i + 1}
                            </Link>
                          ))}
                        </div>
                        <small>Reported {when(t.observedAt)}</small>
                      </article>
                    ))
                  ) : (
                    <div className="empty-inline">
                      No agent reports yet. Agents can publish progress with{" "}
                      <code>task-report put --file report.json</code>.
                    </div>
                  )}
                </div>
              </section>
              <section className="live-section">
                <div className="section-heading">
                  <h2>Project activity</h2>
                </div>
                {events(data.events.filter((e) => e.project === selected.id))}
              </section>
              <div className="remove-row">
                <p>Removing a project only stops local tracking. Its source stays intact.</p>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={async () => {
                    if (await action("remove", { id: selected.id })) go("overview");
                  }}
                >
                  Stop tracking this project
                </button>
              </div>
            </>
          )}
          <footer className="page-footer">
            <span>
              <span className="footer-dot" />
              Local workspace · {connected ? "Receiving live updates" : "Connection interrupted"}
            </span>
            <span>Clear plans. Visible progress.</span>
          </footer>
        </main>
      </div>
      <dialog
        ref={dialog}
        className="tracker-dialog"
        onCancel={() => setAdding(false)}
        onClose={() => {
          setAdding(false);
          addButton.current?.focus();
        }}
      >
        <form
          className="modal-body"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await action("projects", { source })) {
              setAdding(false);
              setSource("");
              setPage("overview");
            }
          }}
        >
          <button
            type="button"
            className="dialog-close icon-button"
            aria-label="Close dialog"
            onClick={() => setAdding(false)}
          >
            <X size={24} />
          </button>
          <h2>Bring a project into view.</h2>
          <p>
            Connect its GitHub tracking issue. We’ll follow the plan, linked PRs, and agent reports
            together.
          </p>
          <label htmlFor="source">GitHub issue URL</label>
          <input
            id="source"
            type="url"
            required
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="https://github.com/owner/repo/issues/123"
          />
          <p className="modal-note">
            The issue must contain one version 1 <code>tracking-plan</code> block. Private
            repositories use your local GitHub credentials.
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? "Connecting…" : "Track project"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
