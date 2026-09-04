import type {
  ApiError,
  Approval,
  ApprovalDecision,
  Artifact,
  ArtifactKind,
  DomainEvent,
  Execution,
  PipelineRun,
  Project,
  RunUsage,
  TaskCard,
} from "./types.js";

function getBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL as string) ?? "";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getBaseUrl();
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    let body: ApiError | undefined;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      // non-JSON error
    }
    throw new Error(
      body?.error?.message ?? `HTTP ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/projects");
  return data.projects;
}

export async function getProject(id: string): Promise<Project> {
  const data = await request<{ project: Project }>(`/projects/${id}`);
  return data.project;
}

export async function createProject(name: string): Promise<Project> {
  const data = await request<{ project: Project }>("/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return data.project;
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export async function listProjectPipelines(
  projectId: string,
): Promise<PipelineRun[]> {
  const data = await request<{ pipelines: PipelineRun[] }>(
    `/projects/${projectId}/pipelines`,
  );
  return data.pipelines;
}

export async function getPipeline(runId: string): Promise<PipelineRun> {
  const data = await request<{ pipeline: PipelineRun }>(`/pipelines/${runId}`);
  return data.pipeline;
}

export async function startPipeline(
  projectId: string,
  instruction: string,
): Promise<{
  runId: string | null;
  projectId: string;
  status: string;
  goal: string;
  createdAt: string;
}> {
  const data = await request<{
    pipeline: {
      runId: string | null;
      projectId: string;
      status: string;
      goal: string;
      createdAt: string;
    };
  }>(`/projects/${projectId}/pipeline`, {
    method: "POST",
    body: JSON.stringify({ instruction }),
  });
  return data.pipeline;
}

export async function cancelPipeline(
  runId: string,
): Promise<PipelineRun> {
  const data = await request<{ pipeline: PipelineRun }>(
    `/pipelines/${runId}/cancel`,
    { method: "POST" },
  );
  return data.pipeline;
}

export async function resumePipeline(
  runId: string,
): Promise<{
  runId: string;
  projectId: string;
  status: string;
  goal: string;
  createdAt: string;
}> {
  const data = await request<{
    pipeline: {
      runId: string;
      projectId: string;
      status: string;
      goal: string;
      createdAt: string;
    };
  }>(`/pipelines/${runId}/resume`, { method: "POST" });
  return data.pipeline;
}

// ---------------------------------------------------------------------------
// Pipeline sub-resources
// ---------------------------------------------------------------------------

export async function getPipelineTasks(runId: string): Promise<TaskCard[]> {
  const data = await request<{ tasks: TaskCard[] }>(`/pipelines/${runId}/tasks`);
  return data.tasks;
}

export async function getPipelineArtifacts(
  runId: string,
  kind?: ArtifactKind,
): Promise<Artifact[]> {
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  const data = await request<{ artifacts: Artifact[] }>(
    `/pipelines/${runId}/artifacts${qs}`,
  );
  return data.artifacts;
}

export async function getPipelineExecutions(
  runId: string,
): Promise<Execution[]> {
  const data = await request<{ executions: Execution[] }>(
    `/pipelines/${runId}/executions`,
  );
  return data.executions;
}

export async function getPipelineUsage(runId: string): Promise<RunUsage> {
  const data = await request<{ usage: RunUsage }>(
    `/pipelines/${runId}/usage`,
  );
  return data.usage;
}

export async function getPipelineEvents(
  runId: string,
  opts?: { afterSeq?: number; limit?: number },
): Promise<{ events: DomainEvent[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (opts?.afterSeq !== undefined) params.set("afterSeq", String(opts.afterSeq));
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request(`/pipelines/${runId}/events${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * List PENDING approval requests for a project (oldest first). The existing
 * REST contract exposes only pending requests at this endpoint; resolved ones
 * are dropped from this list (matches `ApprovalRepository.listPending`).
 */
export async function getProjectApprovals(
  projectId: string,
): Promise<Approval[]> {
  const data = await request<{ approvals: Approval[] }>(
    `/projects/${projectId}/approvals`,
  );
  return data.approvals;
}

/**
 * Resolve an approval. The existing contract accepts `{ decision }` where the
 * decision is `"allow"` (approve) or `"deny"` (reject). There is no rejection
 * reason field in the contract.
 */
export async function resolveApproval(
  approvalId: string,
  decision: ApprovalDecision,
): Promise<Approval> {
  const data = await request<{ approval: Approval }>(
    `/approvals/${approvalId}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({ decision }),
    },
  );
  return data.approval;
}

// ---------------------------------------------------------------------------
// SSE — returns a native EventSource; caller manages lifecycle
// ---------------------------------------------------------------------------

/**
 * Exhaustive list of event types the server emits on the SSE stream.
 * Kept in sync with `@devmesh/contracts` `domainEventSchema` — add new
 * entries here when the backend adds new event types.
 */
const PIPELINE_SSE_EVENTS = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "task.created",
  "task.transitioned",
  "artifact.recorded",
  "verification.failed",
  "checkpoint.created",
  "approval.requested",
  "approval.resolved",
  "permission.requested",
  "permission.resolved",
  "agent.session.opened",
  "agent.reply.completed",
  "runtime.health.changed",
  "error.raised",
] as const;

type PipelineSSEType = (typeof PIPELINE_SSE_EVENTS)[number];

function parseSSEData(msg: MessageEvent): DomainEvent | null {
  try {
    return JSON.parse(msg.data) as DomainEvent;
  } catch {
    return null;
  }
}

export function openPipelineStream(
  runId: string,
  onEvent: (event: DomainEvent) => void,
  opts?: { onError?: (err: Event) => void },
): EventSource {
  const base = getBaseUrl();
  const url = `${base}/pipelines/${runId}/events/stream`;
  const es = new EventSource(url);

  // The server sends `event: <type>` fields (e.g. "run.started"), which
  // makes the browser dispatch a MessageEvent with that type name.
  // `onmessage` only fires for `type === "message"` (no event: field),
  // so we must register a listener for every known event type.
  const handler = (msg: MessageEvent): void => {
    const event = parseSSEData(msg);
    if (event) onEvent(event);
  };
  for (const type of PIPELINE_SSE_EVENTS) {
    es.addEventListener(type as PipelineSSEType, handler as EventListener);
  }

  es.onerror = (err) => {
    opts?.onError?.(err);
  };

  return es;
}
