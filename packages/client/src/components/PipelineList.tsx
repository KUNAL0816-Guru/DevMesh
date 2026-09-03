import { useState, useEffect } from "react";
import type { PipelineRun, Project } from "../api/types.js";
import { listProjects, listProjectPipelines } from "../api/client.js";

interface Props {
  onSelect: (runId: string) => void;
}

export default function PipelineList({ onSelect }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const projs = await listProjects();
        if (cancelled) return;
        setProjects(projs);

        const allRuns: PipelineRun[] = [];
        for (const p of projs) {
          const runsForProject = await listProjectPipelines(p.id);
          allRuns.push(...runsForProject);
        }
        if (cancelled) return;
        setRuns(allRuns);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load pipelines");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <p className="muted">Loading pipelines…</p>;
  if (error) return <p className="error">{error}</p>;
  if (projects.length === 0) return <p className="muted">No projects yet.</p>;
  if (runs.length === 0) return <p className="muted">No pipeline runs found.</p>;

  return (
    <div>
      <h2>Pipeline Runs</h2>
      {runs.map((run) => {
        const project = projects.find((p) => p.id === run.projectId);
        return (
          <div
            key={run.id}
            className="card card--clickable"
            onClick={() => onSelect(run.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(run.id);
              }
            }}
          >
            <div className="card-body">
              <div className="card-title">
                <span className={`status-badge status-badge--${run.status}`}>
                  {run.status}
                </span>
                <strong>{run.goal.slice(0, 80)}</strong>
              </div>
              <div className="card-meta">
                <span className="muted">Run {run.id.slice(0, 8)}</span>
                {project && <span className="muted">{project.name}</span>}
                <span className="muted">
                  {new Date(run.createdAt).toLocaleString()}
                </span>
                {run.durationMs != null && (
                  <span className="muted">{(run.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>
              {run.errorMessage && (
                <p className="error" style={{ marginTop: "0.25rem", fontSize: "0.8rem" }}>
                  {run.errorMessage.slice(0, 120)}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
