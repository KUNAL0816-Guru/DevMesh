import { useState, useEffect } from "react";
import type { Project } from "./api/types.js";
import { listProjects } from "./api/client.js";

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load projects");
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>DevMesh</h1>
        <p className="subtitle">Multi-agent AI software engineering platform</p>
      </header>

      <main className="main">
        <section className="section">
          <h2>Projects</h2>
          {loading && <p className="muted">Loading…</p>}
          {error && <p className="error">{error}</p>}
          {!loading && !error && projects.length === 0 && (
            <p className="muted">No projects yet.</p>
          )}
          {projects.map((p) => (
            <div key={p.id} className="card">
              <strong>{p.name}</strong>
              <span className="muted">
                {new Date(p.createdAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </section>
      </main>

      <footer className="footer">
        <span className="muted">DevMesh v0.1.0 — Phase 13B</span>
      </footer>
    </div>
  );
}
