import { useState, useEffect, useCallback } from "react";

type Route =
  | { page: "list" }
  | { page: "detail"; runId: string };

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);

  if (parts[0] === "pipelines" && parts[1]) {
    return { page: "detail", runId: parts[1]! };
  }
  return { page: "list" };
}

export function useHashRoute(): [Route, (runId: string) => void, () => void] {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const openPipeline = useCallback((runId: string) => {
    window.location.hash = `#/pipelines/${runId}`;
  }, []);

  const goBack = useCallback(() => {
    window.location.hash = "#/";
  }, []);

  return [route, openPipeline, goBack];
}
