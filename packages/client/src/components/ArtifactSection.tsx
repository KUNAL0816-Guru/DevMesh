import { useState, useEffect, useCallback } from "react";
import type { Artifact } from "../api/types.js";
import { getPipelineArtifacts } from "../api/client.js";
import { previewArtifactPayload } from "../utils/format.js";

interface Props {
  runId: string;
  /** Bumped by the parent when SSE events indicate a refresh is warranted. */
  refreshToken: number;
}

export default function ArtifactSection({ runId, refreshToken }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await getPipelineArtifacts(runId);
      setArtifacts(list);
      setError(null);
      // Keep the selection valid after a refresh (it may have disappeared).
      setSelectedId((prev) => {
        if (prev === null) return null;
        return list.some((a) => a.id === prev) ? prev : null;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load artifacts");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load, refreshToken]);

  const selected = artifacts.find((a) => a.id === selectedId) ?? null;

  return (
    <section className="artifact-section">
      <h3>Artifacts ({artifacts.length})</h3>

      {loading && <p className="muted">Loading artifacts…</p>}
      {!loading && error && <p className="error">{error}</p>}
      {!loading && !error && artifacts.length === 0 && (
        <p className="muted">No artifacts recorded for this pipeline run.</p>
      )}

      {artifacts.length > 0 && (
        <div className="artifact-layout">
          <ul className="artifact-list">
            {artifacts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className={`artifact-row${a.id === selectedId ? " artifact-row--active" : ""}`}
                  onClick={() => setSelectedId(a.id === selectedId ? null : a.id)}
                >
                  <span className={`artifact-kind artifact-kind--${a.kind}`}>{a.kind}</span>
                  <span className="artifact-id mono">{a.id.slice(0, 8)}</span>
                  <span className="artifact-producer">{a.producedBy}</span>
                  {a.taskId && <span className="artifact-task mono" title={a.taskId}>task {a.taskId.slice(0, 8)}</span>}
                  <span className="artifact-time muted mono">
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <div className="artifact-preview">
              <div className="artifact-preview-header">
                <span className={`artifact-kind artifact-kind--${selected.kind}`}>
                  {selected.kind}
                </span>
                <span className="mono">{selected.id}</span>
                <span className="muted">produced by {selected.producedBy}</span>
                {selected.taskId && (
                  <span className="muted mono" title={selected.taskId}>task {selected.taskId.slice(0, 8)}</span>
                )}
                <span className="muted mono">{new Date(selected.createdAt).toLocaleString()}</span>
              </div>
              <ArtifactPayloadView artifact={selected} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ArtifactPayloadView({ artifact }: { artifact: Artifact }) {
  const preview = previewArtifactPayload(artifact.payload);
  if (!preview.renderable) {
    return <p className="muted">No content recorded for this artifact.</p>;
  }
  return (
    <pre className="artifact-preview-pre">
      <code>{preview.text}</code>
    </pre>
  );
}