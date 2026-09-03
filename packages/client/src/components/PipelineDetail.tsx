import { useState, useEffect } from "react";
import type { PipelineRun, TaskCard, Project } from "../api/types.js";
import { getPipeline, getPipelineTasks, getProject } from "../api/client.js";
import TaskList from "./TaskList.js";
import TaskGraph from "./TaskGraph.js";

interface Props {
  runId: string;
  onBack: () => void;
}

export default function PipelineDetail({ runId, onBack }: Props) {
  const [pipeline, setPipeline] = useState<PipelineRun | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [pipe, taskList] = await Promise.all([
          getPipeline(runId),
          getPipelineTasks(runId),
        ]);
        if (cancelled) return;
        setPipeline(pipe);
        setTasks(taskList);

        const proj = await getProject(pipe.projectId);
        if (cancelled) return;
        setProject(proj);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load pipeline");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [runId]);

  if (loading) return <p className="muted">Loading pipeline…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!pipeline) return <p className="error">Pipeline run not found.</p>;

  return (
    <div>
      <button className="btn-back" onClick={onBack}>
        ← Back to pipelines
      </button>

      <h2>Pipeline Run</h2>

      <div className="run-summary">
        <div className="run-summary-grid">
          <div className="run-field">
            <span className="run-label">Run ID</span>
            <span className="run-value mono">{pipeline.id}</span>
          </div>
          {project && (
            <div className="run-field">
              <span className="run-label">Project</span>
              <span className="run-value">{project.name}</span>
            </div>
          )}
          <div className="run-field">
            <span className="run-label">Status</span>
            <span className={`status-badge status-badge--${pipeline.status}`}>
              {pipeline.status}
            </span>
          </div>
          <div className="run-field">
            <span className="run-label">Goal</span>
            <span className="run-value">{pipeline.goal}</span>
          </div>
          <div className="run-field">
            <span className="run-label">Created</span>
            <span className="run-value">
              {new Date(pipeline.createdAt).toLocaleString()}
            </span>
          </div>
          {pipeline.finishedAt && (
            <div className="run-field">
              <span className="run-label">Finished</span>
              <span className="run-value">
                {new Date(pipeline.finishedAt).toLocaleString()}
              </span>
            </div>
          )}
          {pipeline.durationMs != null && (
            <div className="run-field">
              <span className="run-label">Duration</span>
              <span className="run-value">
                {(pipeline.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
          )}
          {pipeline.errorMessage && (
            <div className="run-field">
              <span className="run-label">Error</span>
              <span className="run-value error">{pipeline.errorMessage}</span>
            </div>
          )}
        </div>
      </div>

      {tasks.length > 0 && (
        <>
          <h3>Dependency Graph</h3>
          <TaskGraph tasks={tasks} />

          <h3>Tasks ({tasks.length})</h3>
          <TaskList tasks={tasks} />
        </>
      )}

      {tasks.length === 0 && (
        <p className="muted" style={{ marginTop: "1rem" }}>
          No tasks recorded for this pipeline run.
        </p>
      )}
    </div>
  );
}
