import { useHashRoute } from "./hooks/useHashRoute.js";
import PipelineList from "./components/PipelineList.js";
import PipelineDetail from "./components/PipelineDetail.js";

export default function App() {
  const [route, openPipeline, goBack] = useHashRoute();

  return (
    <div className="app">
      <header className="header">
        <h1>
          <a href="#/" className="header-link">
            DevMesh
          </a>
        </h1>
        <p className="subtitle">Pipeline Dashboard</p>
      </header>

      <main className="main">
        {route.page === "list" && <PipelineList onSelect={openPipeline} />}
        {route.page === "detail" && (
          <PipelineDetail runId={route.runId} onBack={goBack} />
        )}
      </main>

      <footer className="footer">
        <span className="muted">DevMesh v0.1.0 — Phase 13D</span>
      </footer>
    </div>
  );
}
