import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  approvalIdSchema,
  artifactKindSchema,
  contextEntrySchema,
  contextNamespaceSchema,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
} from "@devmesh/contracts";
import { ApprovalGate } from "./approvals.js";
import type { Storage } from "@devmesh/storage";
import { summarizeRunUsage } from "@devmesh/storage";
import type { WorkspaceService, ProjectRecord } from "@devmesh/workspace";
import type { AgentRuntime } from "@devmesh/runtime";
import type { AgentRegistry } from "@devmesh/agents";
import { createDefaultAgentRegistry } from "@devmesh/agents";
import { z } from "zod";
import type { Config } from "./config.js";
import { authConfigFromConfig, budgetConfigFromConfig, pricingRulesFromConfig } from "./config.js";
import { normalizeError } from "./errors-map.js";
import { registerAuth } from "./auth.js";
import {
  currentPrincipal,
  authorizeProject,
  authorizeRun,
  authorizeExecution,
  authorizeApproval,
} from "./authorize.js";
import { GitService } from "@devmesh/workspace";
import { ExecutionService } from "./executions/service.js";
import { createPriceTable } from "./executions/pricing.js";
import { VERIFICATION_COMMAND_PATTERN } from "./executions/commands.js";
import { Orchestrator } from "./orchestrator.js";
import type { DomainEvent } from "@devmesh/contracts";
import { PipelineEventStream } from "./pipeline-sse.js";

export const APP_VERSION = "0.1.0";

const createProjectBody = z.strictObject({
  name: z.string().min(1).max(120),
});

const startExecutionBody = z.strictObject({
  instruction: z.string().min(1).max(8000),
  taskId: taskIdSchema.optional(),
  agentId: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,62}$/)
    .optional(),
  model: z.string().min(3).max(200).optional(),
  verificationCommand: z
    .string()
    .max(300)
    .regex(VERIFICATION_COMMAND_PATTERN, "command contains forbidden characters")
    .optional(),
});

const createContextEntryBody = z.strictObject({
  namespace: contextNamespaceSchema,
  key: z.string().min(1).max(200),
  value: z.unknown(),
  createdBy: z.string().min(1).max(50),
});

const approvalRiskSchema = z.enum(["low", "medium", "high", "critical"]);

const createApprovalBody = z.strictObject({
  projectId: projectIdSchema,
  runId: runIdSchema,
  taskId: taskIdSchema.nullable().optional(),
  kind: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  detail: z.string().max(4000).default(""),
  risk: approvalRiskSchema,
});

const resolveApprovalBody = z.strictObject({
  decision: z.enum(["allow", "deny"]),
});

export interface BuildAppOptions {
  config: Config;
  storage: Storage;
  workspaces: WorkspaceService;
  /**
   * Runtime-neutral port. The composition root (bootstrap/main) decides
   * which concrete runtime to wire; the app itself never imports vendor
   * code. Omitted/null => execution endpoints answer 503.
   */
  runtime?: AgentRuntime | null;
  /** Agent definitions; defaults are provided when omitted (tests). */
  agents?: AgentRegistry;
  /** Override for the client dist directory (tests). Resolved to
   *  packages/client/dist when omitted. */
  staticRoot?: string;
}

/** Construct the DevMesh control-plane HTTP application (not yet listening). */
export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: opts.config.logLevel,
      base: { component: "devmesh-server" },
    },
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
  });

  const startedAt = Date.now();
  const git = new GitService();
  const budgetConfig = budgetConfigFromConfig(opts.config);
  const priceRules = pricingRulesFromConfig(opts.config);
  const executions = new ExecutionService({
    storage: opts.storage,
    workspaces: opts.workspaces,
    git,
    runtime: opts.runtime ?? null,
    agents: opts.agents ?? createDefaultAgentRegistry(),
    defaultTimeoutMs: opts.config.execTimeoutMs,
    defaultModel: opts.config.opencodeModel,
    ...(budgetConfig ? { budget: budgetConfig } : {}),
    ...(priceRules.length > 0 ? { pricing: createPriceTable(priceRules) } : {}),
  });

  // In-memory registry of active pipeline runs (runId → Orchestrator).
  // Cleared on every terminal path; no memory leak on normal operation.
  const runningPipelines = new Map<string, Orchestrator>();

  // Approval workflow owner: persistence + event emission for create/resolve.
  const approvals = new ApprovalGate(opts.storage);

  const publicExecution = (rec: Awaited<ReturnType<ExecutionService["start"]>>) => ({
    id: rec.id,
    runId: rec.runId,
    projectId: rec.projectId,
    taskId: rec.taskId,
    agentId: rec.agentId,
    role: rec.role,
    runtime: rec.runtime,
    status: rec.status,
    failureKind: rec.failureKind,
    instruction: rec.instruction,
    sessionRef: rec.sessionRef,
    exitCode: rec.exitCode,
    stoppedReason: rec.stoppedReason,
    errorMessage: rec.errorMessage,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    durationMs: rec.durationMs,
    resultArtifactId: rec.resultArtifactId,
    verificationArtifactId: rec.verificationArtifactId,
  });

  // -- structured errors ----------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    // Fastify's own schema/body errors keep their message (safe, no internals)
    const isFstErr = typeof (err as { code?: unknown }).code === "string" &&
      String((err as { code?: unknown }).code).startsWith("FST_ERR_");
    let problem = normalizeError(err);
    if (isFstErr) {
      const e = err as { statusCode?: number; message: string };
      problem = { status: e.statusCode ?? 400, code: "request/invalid", message: e.message };
    }
    const level = problem.status >= 500 ? "error" : "warn";
    req.log[level](
      {
        code: problem.code,
        status: problem.status,
        err: problem.status >= 500 ? err : undefined,
      },
      "request failed",
    );
    void reply.status(problem.status).send({
      error: { code: problem.code, message: problem.message },
    });
  });

  // -- Phase 14A: Bearer authentication ------------------------------------
  registerAuth(app, authConfigFromConfig(opts.config));

  // -- static frontend (SPA fallback) ---------------------------------------
  const serverDir = dirname(fileURLToPath(import.meta.url));
  const defaultStaticRoot = opts.staticRoot ?? join(serverDir, "..", "..", "client", "dist");

  if (existsSync(defaultStaticRoot)) {
    app.register(fastifyStatic, {
      root: defaultStaticRoot,
      prefix: "/",
      wildcard: true,
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const p = req.url.split("?")[0] ?? "";
    const isApi =
      p.startsWith("/health") ||
      p.startsWith("/projects") ||
      p.startsWith("/pipelines") ||
      p.startsWith("/executions") ||
      p.startsWith("/approvals") ||
      p.startsWith("/auth") ||
      p.startsWith("/api");
    if (!isApi && existsSync(defaultStaticRoot)) {
      void reply.sendFile("index.html");
      return;
    }
    void reply.status(404).send({
      error: { code: "request/not-found", message: "no such route" },
    });
  });

  // -- health ---------------------------------------------------------------
  app.get("/health", async () => {
    let storageOk = false;
    try {
      opts.storage.db.prepare("SELECT 1 AS ok").get();
      storageOk = true;
    } catch {
      storageOk = false;
    }
    const body = {
      ok: storageOk,
      version: APP_VERSION,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      checks: { storage: storageOk ? "ok" : "fail" },
    };
    return body;
  });

  // -- auth/me (Phase 14A) --------------------------------------------------
  app.get("/auth/me", async (request) => {
    if (request.auth) return request.auth;
    // Auth disabled: return a synthetic principal for backward compatibility.
    return { id: "devmesh:default", method: "bearer" };
  });

  // -- projects / workspaces ------------------------------------------------
  app.post("/projects", async (req, reply) => {
    const parsed = createProjectBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "body must be {name: string}" },
      });
    }
    const principal = currentPrincipal(req);
    const handle = opts.workspaces.create(parsed.data.name, {
      ownerPrincipalId: principal?.id ?? null,
    });
    const record = opts.storage.projects.get(handle.projectId);
    if (!record) {
      return reply.status(500).send({
        error: { code: "internal/error", message: "project vanished after create" },
      });
    }
    return reply.status(201).send(toApiProject(record));
  });

  app.get("/projects", async (req) => {
    const principal = currentPrincipal(req);
    const projects = principal
      ? opts.storage.projects.listByOwner(principal.id)
      : opts.storage.projects.list();
    return { projects: projects.map(toApiProject) };
  });

  app.get("/projects/:projectId", async (req, reply) => {
    const params = z.strictObject({ projectId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid project id" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    const rec = opts.storage.projects.get(parsedId.data);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    return toApiProject(rec);
  });

  // -- executions (runtime-neutral; no shell passthrough) --------------------
  app.post("/projects/:projectId/executions", async (req, reply) => {
    const params = z.strictObject({ projectId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid project id" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    if (!executions.configured) {
      return reply.status(503).send({
        error: { code: "runtime/not-configured", message: "no agent runtime wired" },
      });
    }
    const parsedBody = startExecutionBody.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "body must be {instruction: string}" },
      });
    }
    try {
      const rec = await executions.start({
        projectId: parsedId.data,
        instruction: parsedBody.data.instruction,
        taskId: parsedBody.data.taskId,
        agentId: parsedBody.data.agentId,
        model: parsedBody.data.model,
        verificationCommand: parsedBody.data.verificationCommand,
      });
      return reply.status(202).send({ execution: publicExecution(rec) });
    } catch (err) {
      const problem = normalizeError(err);
      const status =
        problem.status < 500
          ? problem.status
          : (err as { code?: string }).code === "runtime/unavailable"
            ? 503
            : problem.status;
      return reply.status(status).send({
        error: {
          code: (err as { code?: string }).code ?? problem.code,
          message: problem.message,
        },
      });
    }
  });

  app.get("/projects/:projectId/executions", async (req, reply) => {
    const params = z.strictObject({ projectId: z.string() }).safeParse(req.params);
    const parsedId = params.success ? projectIdSchema.safeParse(params.data.projectId) : null;
    if (!parsedId?.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    try {
      opts.workspaces.get(parsedId.data); // existence + workspace liveness check
    } catch {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    return {
      executions: executions.listByProject(parsedId.data).map(publicExecution),
    };
  });

  app.get("/executions/:executionId", async (req, reply) => {
    const params = z.strictObject({ executionId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such execution" },
      });
    }
    const rec = authorizeExecution(opts.storage, currentPrincipal(req), params.data.executionId);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such execution" },
      });
    }
    return { execution: publicExecution(rec) };
  });

  app.post("/executions/:executionId/cancel", async (req, reply) => {
    const params = z.strictObject({ executionId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such execution" },
      });
    }
    const rec = authorizeExecution(opts.storage, currentPrincipal(req), params.data.executionId);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such execution" },
      });
    }
    try {
      const cancelled = await executions.cancel(params.data.executionId);
      return reply.status(202).send({ execution: publicExecution(cancelled) });
    } catch (err) {
      const problem = normalizeError(err);
      return reply.status(problem.status).send({
        error: { code: (err as { code?: string }).code ?? problem.code, message: problem.message },
      });
    }
  });

  // -- pipeline (multi-agent orchestrator) -----------------------------------
  const startPipelineBody = z.strictObject({
    instruction: z.string().min(1).max(8000),
  });

  app.post("/projects/:projectId/pipeline", async (req, reply) => {
    const params = z.strictObject({ projectId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid project id" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    if (!executions.configured) {
      return reply.status(503).send({
        error: { code: "runtime/not-configured", message: "no agent runtime wired" },
      });
    }
    const parsedBody = startPipelineBody.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "body must be {instruction: string}" },
      });
    }
    const orchestrator = new Orchestrator({
      storage: opts.storage,
      workspaces: opts.workspaces,
      executionService: executions,
    });
    try {
      // Run the pipeline asynchronously; the client can poll task status
      const result = orchestrator.run(parsedId.data, parsedBody.data.instruction);
      // Don't await — let it run in background; return 202 immediately
      let runningPipelineRunId: string | null = null;
      void result
        .then(() => { /* terminal — registry cleaned up */ })
        .catch(() => { /* terminal — registry cleaned up */ })
        .finally(() => {
          const rid = orchestrator.currentRunId ?? runningPipelineRunId;
          if (rid) runningPipelines.delete(rid);
        });
      // Read the pipeline run created by the orchestrator
      const runId = orchestrator.currentRunId;
      runningPipelineRunId = runId;
      if (runId) {
        runningPipelines.set(runId, orchestrator);
        const pipelineRun = opts.storage.pipelineRuns.get(runId);
        return reply.status(202).send({
          pipeline: {
            runId,
            projectId: parsedId.data,
            status: pipelineRun?.status ?? "running",
            goal: parsedBody.data.instruction.slice(0, 8000),
            createdAt: pipelineRun?.createdAt ?? new Date().toISOString(),
          },
        });
      }
      return reply.status(202).send({
        pipeline: {
          runId: null,
          projectId: parsedId.data,
          status: "running",
          goal: parsedBody.data.instruction.slice(0, 8000),
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      const problem = normalizeError(err);
      return reply.status(problem.status).send({
        error: {
          code: (err as { code?: string }).code ?? problem.code,
          message: problem.message,
        },
      });
    }
  });

  // -- pipeline cancellation -------------------------------------------------
  app.post("/pipelines/:runId/cancel", async (req, reply) => {
    const params = z.strictObject({ runId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid run id" },
      });
    }
    const parsedId = runIdSchema.safeParse(params.data.runId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const resolved = authorizeRun(opts.storage, currentPrincipal(req), parsedId.data);
    if (!resolved) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const rec = resolved.run;
    // Already terminal — idempotent response, no corruption.
    const terminal = rec.status !== "running";
    const orchestrator = runningPipelines.get(parsedId.data);
    if (orchestrator) {
      orchestrator.cancel();
    }
    // Re-read to return the most recent state.
    const updated = opts.storage.pipelineRuns.get(parsedId.data) ?? rec;
    if (terminal) {
      return reply.status(200).send({ pipeline: updated });
    }
    return reply.status(202).send({ pipeline: updated });
  });

  // -- pipeline resume ------------------------------------------------------
  app.post("/pipelines/:runId/resume", async (req, reply) => {
    const params = z.strictObject({ runId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid run id" },
      });
    }
    const parsedId = runIdSchema.safeParse(params.data.runId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const resolved = authorizeRun(opts.storage, currentPrincipal(req), parsedId.data);
    if (!resolved) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const rec = resolved.run;
    // Already running or completed — 409 Conflict.
    if (rec.status === "running" || rec.status === "completed") {
      return reply.status(409).send({
        error: { code: "pipeline/not-resumable", message: `pipeline is ${rec.status}` },
      });
    }
    // Resumable (failed/cancelled/timeout) — a runtime is required to perform
    // the actual resume.
    if (!executions.configured) {
      return reply.status(503).send({
        error: { code: "runtime/not-configured", message: "no agent runtime wired" },
      });
    }
    const orchestrator = new Orchestrator({
      storage: opts.storage,
      workspaces: opts.workspaces,
      executionService: executions,
    });
    try {
      const result = orchestrator.resume(parsedId.data);
      const runningPipelineRunId: string | null = parsedId.data;
      void result
        .then(() => { /* terminal */ })
        .catch(() => { /* terminal */ })
        .finally(() => {
          if (runningPipelineRunId) runningPipelines.delete(runningPipelineRunId);
        });
      runningPipelines.set(parsedId.data, orchestrator);
      const pipelineRun = opts.storage.pipelineRuns.get(parsedId.data);
      return reply.status(202).send({
        pipeline: {
          runId: parsedId.data,
          projectId: rec.projectId,
          status: pipelineRun?.status ?? "running",
          goal: rec.goal,
          createdAt: rec.createdAt,
        },
      });
    } catch (err) {
      // TerminalStateError for "not-found" → 404, for "running/completed" → 409
      if (err instanceof Error && err.name === "TerminalStateError") {
        const tsErr = err as unknown as { currentStatus: string };
        if (tsErr.currentStatus === "not-found") {
          return reply.status(404).send({
            error: { code: "pipeline/not-found", message: "no such pipeline run" },
          });
        }
        return reply.status(409).send({
          error: { code: "pipeline/not-resumable", message: `pipeline is ${tsErr.currentStatus}` },
        });
      }
      const problem = normalizeError(err);
      return reply.status(problem.status).send({
        error: {
          code: (err as { code?: string }).code ?? problem.code,
          message: problem.message,
        },
      });
    }
  });

  // -- pipeline query routes (read-only) ------------------------------------

  // GET /projects/:projectId/pipelines
  app.get("/projects/:projectId/pipelines", async (req, reply) => {
    const params = z.strictObject({ projectId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid project id" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    const rec = opts.storage.projects.get(parsedId.data);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    return { pipelines: opts.storage.pipelineRuns.listByProject(parsedId.data) };
  });

  // GET /pipelines/:runId
  app.get("/pipelines/:runId", async (req, reply) => {
    const params = z.strictObject({ runId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid run id" },
      });
    }
    const parsedId = runIdSchema.safeParse(params.data.runId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const resolved = authorizeRun(opts.storage, currentPrincipal(req), parsedId.data);
    if (!resolved) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    return { pipeline: resolved.run };
  });

  // GET /pipelines/:runId/tasks
  app.get("/pipelines/:runId/tasks", async (req, reply) => {
    const params = z.strictObject({ runId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid run id" },
      });
    }
    const parsedId = runIdSchema.safeParse(params.data.runId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const resolved = authorizeRun(opts.storage, currentPrincipal(req), parsedId.data);
    if (!resolved) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    return { tasks: opts.storage.tasks.listByRun(parsedId.data) };
  });

  // GET /pipelines/:runId/events
  app.get("/pipelines/:runId/events", async (req, reply) => {
    const params = z.strictObject({ runId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid run id" },
      });
    }
    const parsedId = runIdSchema.safeParse(params.data.runId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const resolved = authorizeRun(opts.storage, currentPrincipal(req), parsedId.data);
    if (!resolved) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const raw = (req.query ?? {}) as Record<string, unknown>;
    const afterSeq = Number(raw.afterSeq);
    const limitRaw = Number(raw.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 100;
    const safeAfter = Number.isFinite(afterSeq) && afterSeq >= 0 ? Math.floor(afterSeq) : 0;
    const events = opts.storage.events.listByRunAfter(parsedId.data, safeAfter, limit + 1);
    const hasMore = events.length > limit;
    if (hasMore) events.pop();
    return { events, hasMore };
  });

  // GET /pipelines/:runId/events/stream (SSE)
  app.get("/pipelines/:runId/events/stream", async (req, reply) => {
    const params = z.strictObject({ runId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid run id" },
      });
    }
    const parsedId = runIdSchema.safeParse(params.data.runId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const resolved = authorizeRun(opts.storage, currentPrincipal(req), parsedId.data);
    if (!resolved) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }

    // Parse Last-Event-ID for reconnection (defaults to 0 = start from beginning).
    const lastEventIdRaw = req.headers["last-event-id"];
    const lastEventId = Number(lastEventIdRaw);
    const afterSeq = Number.isFinite(lastEventId) && lastEventId >= 0 ? Math.floor(lastEventId) : 0;

    // Hijack the response to write SSE frames directly to the raw socket.
    reply.hijack();
    const raw = reply.raw;
    raw.setHeader("Content-Type", "text/event-stream");
    raw.setHeader("Cache-Control", "no-cache");
    raw.setHeader("Connection", "keep-alive");
    raw.setHeader("X-Accel-Buffering", "no");
    raw.flushHeaders();

    const sendSSE = (event: DomainEvent): void => {
      try {
        const id = String(event.seq);
        const data = JSON.stringify(event);
        raw.write(`id: ${id}\nevent: ${event.type}\ndata: ${data}\n\n`);
      } catch {
        // Write failed — client likely disconnected; stream will be cleaned up.
      }
    };

    const stream = new PipelineEventStream({
      storage: opts.storage,
      runId: parsedId.data,
      afterSeq,
      callbacks: {
        onEvent: (event) => {
          // Heartbeats are sent as SSE comments, not as DomainEvents.
          if ((event as { type?: string }).type === "__heartbeat") {
            try { raw.write(": keepalive\n\n"); } catch { /* client gone */ }
            return;
          }
          sendSSE(event);
        },
        onClose: () => {
          try { raw.end(); } catch { /* already closed */ }
        },
      },
    });

    // Clean up on client disconnect.
    req.raw.once("close", () => stream.stop());
    req.raw.once("aborted", () => stream.stop());

    // Start replay + live streaming (does not block the route handler
    // because reply.hijack() already took ownership of the response).
    void stream.start(afterSeq);
  });

  // GET /pipelines/:runId/artifacts
  app.get("/pipelines/:runId/artifacts", async (req, reply) => {
    const params = z.strictObject({ runId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid run id" },
      });
    }
    const parsedId = runIdSchema.safeParse(params.data.runId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const resolved = authorizeRun(opts.storage, currentPrincipal(req), parsedId.data);
    if (!resolved) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const raw = (req.query ?? {}) as Record<string, unknown>;
    const kindRaw = typeof raw.kind === "string" ? raw.kind : undefined;
    let kind: string | undefined;
    if (kindRaw !== undefined) {
      const kindParsed = artifactKindSchema.safeParse(kindRaw);
      if (!kindParsed.success) {
        return reply.status(400).send({
          error: { code: "request/invalid", message: `invalid artifact kind; valid: ${artifactKindSchema.options.join(",")}` },
        });
      }
      kind = kindParsed.data;
    }
    return { artifacts: opts.storage.artifacts.listByRun(parsedId.data, kind as never) };
  });

  // GET /pipelines/:runId/executions
  app.get("/pipelines/:runId/executions", async (req, reply) => {
    const params = z.strictObject({ runId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid run id" },
      });
    }
    const parsedId = runIdSchema.safeParse(params.data.runId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const resolved = authorizeRun(opts.storage, currentPrincipal(req), parsedId.data);
    if (!resolved) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const allExecs = opts.storage.executions.listByProject(resolved.projectId);
    return { executions: allExecs.filter((e) => e.runId === parsedId.data) };
  });

  // GET /pipelines/:runId/usage
  app.get("/pipelines/:runId/usage", async (req, reply) => {
    const params = z.strictObject({ runId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid run id" },
      });
    }
    const parsedId = runIdSchema.safeParse(params.data.runId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const resolved = authorizeRun(opts.storage, currentPrincipal(req), parsedId.data);
    if (!resolved) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const summary = summarizeRunUsage(opts.storage.db, parsedId.data);
    if (!summary) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    return { usage: summary };
  });

  // GET /projects/:projectId/tasks
  app.get("/projects/:projectId/tasks", async (req, reply) => {
    const params = z.strictObject({ projectId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid project id" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    const rec = opts.storage.projects.get(parsedId.data);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    return { tasks: opts.storage.tasks.listByProject(parsedId.data) };
  });

  // GET /projects/:projectId/artifacts
  app.get("/projects/:projectId/artifacts", async (req, reply) => {
    const params = z.strictObject({ projectId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid project id" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    const rec = opts.storage.projects.get(parsedId.data);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    const raw = (req.query ?? {}) as Record<string, unknown>;
    const kindRaw = typeof raw.kind === "string" ? raw.kind : undefined;
    let kind: string | undefined;
    if (kindRaw !== undefined) {
      const kindParsed = artifactKindSchema.safeParse(kindRaw);
      if (!kindParsed.success) {
        return reply.status(400).send({
          error: { code: "request/invalid", message: `invalid artifact kind; valid: ${artifactKindSchema.options.join(",")}` },
        });
      }
      kind = kindParsed.data;
    }
    return { artifacts: opts.storage.artifacts.listByProject(parsedId.data, kind as never) };
  });

  // -- context (namespaced blackboard) ----------------------------------------

  // GET /projects/:projectId/context — latest entries across all namespaces
  app.get("/projects/:projectId/context", async (req, reply) => {
    const params = z.strictObject({ projectId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid project id" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    const rec = opts.storage.projects.get(parsedId.data);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    const all = opts.storage.context.latestAllProject(parsedId.data);
    const grouped: Record<string, unknown[]> = {};
    for (const entry of all.values()) {
      const ns = entry.namespace;
      if (!grouped[ns]) grouped[ns] = [];
      grouped[ns]!.push(entry);
    }
    return { context: grouped };
  });

  // GET /projects/:projectId/context/:namespace
  app.get("/projects/:projectId/context/:namespace", async (req, reply) => {
    const params = z
      .strictObject({ projectId: z.string(), namespace: z.string() })
      .safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid params" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    const rec = opts.storage.projects.get(parsedId.data);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    const nsParsed = contextNamespaceSchema.safeParse(params.data.namespace);
    if (!nsParsed.success) {
      return reply.status(400).send({
        error: {
          code: "request/invalid",
          message: `invalid namespace; valid: ${contextNamespaceSchema.options.join(",")}`,
        },
      });
    }
    const map = opts.storage.context.latestByKeyProject(nsParsed.data, parsedId.data);
    return { context: Array.from(map.values()) };
  });

  // GET /projects/:projectId/context/:namespace/history/:key
  app.get("/projects/:projectId/context/:namespace/history/:key", async (req, reply) => {
    const params = z
      .strictObject({ projectId: z.string(), namespace: z.string(), key: z.string() })
      .safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid params" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    const rec = opts.storage.projects.get(parsedId.data);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    const nsParsed = contextNamespaceSchema.safeParse(params.data.namespace);
    if (!nsParsed.success) {
      return reply.status(400).send({
        error: {
          code: "request/invalid",
          message: `invalid namespace; valid: ${contextNamespaceSchema.options.join(",")}`,
        },
      });
    }
    if (!params.data.key) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "key is required" },
      });
    }
    const entries = opts.storage.context.historyProject(params.data.key, nsParsed.data, parsedId.data);
    return { history: entries };
  });

  // POST /projects/:projectId/context — create a context entry
  app.post("/projects/:projectId/context", async (req, reply) => {
    const params = z.strictObject({ projectId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid project id" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    const rec = opts.storage.projects.get(parsedId.data);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    const parsedBody = createContextEntryBody.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "body must include namespace, key, value, createdBy" },
      });
    }
    const entry = contextEntrySchema.parse({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...parsedBody.data,
    });
    opts.storage.context.put(entry, parsedId.data);
    return reply.status(201).send({ context: entry });
  });

  // -- approvals -------------------------------------------------------------

  // POST /approvals — create an approval request (emits approval.requested).
  app.post("/approvals", async (req, reply) => {
    const parsed = createApprovalBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "request/invalid",
          message: "body must be {projectId, runId, kind, title, detail, risk}",
        },
      });
    }
    const body = parsed.data;
    if (!opts.storage.projects.get(body.projectId)) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    // The pipeline run is the authoritative resource: its persisted project is
    // the source of truth for authorization. A client-supplied projectId is only
    // accepted when it matches the run's project (no cross-project references).
    const run = opts.storage.pipelineRuns.get(body.runId);
    if (!run) {
      return reply.status(404).send({
        error: { code: "pipeline/not-found", message: "no such pipeline run" },
      });
    }
    const task = body.taskId ? opts.storage.tasks.get(body.taskId) : null;
    if (body.taskId && !task) {
      return reply.status(404).send({
        error: { code: "task/not-found", message: "no such task" },
      });
    }
    const runProjectId = projectIdSchema.parse(run.projectId);
    authorizeProject(opts.storage, currentPrincipal(req), runProjectId);
    if (body.projectId !== run.projectId) {
      return reply.status(400).send({
        error: {
          code: "request/invalid",
          message: "projectId does not match the run's project",
        },
      });
    }
    if (task && (task.projectId !== run.projectId || task.runId !== body.runId)) {
      return reply.status(400).send({
        error: {
          code: "request/invalid",
          message: "taskId does not belong to the pipeline run",
        },
      });
    }
    const record = approvals.request({
      projectId: runProjectId,
      runId: body.runId,
      taskId: body.taskId ?? null,
      spec: {
        kind: body.kind,
        title: body.title,
        detail: body.detail,
        risk: body.risk,
      },
    });
    return reply.status(201).send({ approval: record });
  });

  // GET /approvals/:id — fetch approval status.
  app.get("/approvals/:approvalId", async (req, reply) => {
    const params = z
      .strictObject({ approvalId: z.string() })
      .safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid approval id" },
      });
    }
    const parsedId = approvalIdSchema.safeParse(params.data.approvalId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "approval/not-found", message: "no such approval" },
      });
    }
    const rec = authorizeApproval(opts.storage, currentPrincipal(req), parsedId.data);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "approval/not-found", message: "no such approval" },
      });
    }
    return { approval: rec };
  });

  // POST /approvals/:id/resolve — approve/deny (emits approval.resolved).
  app.post("/approvals/:approvalId/resolve", async (req, reply) => {
    const params = z
      .strictObject({ approvalId: z.string() })
      .safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid approval id" },
      });
    }
    const parsedId = approvalIdSchema.safeParse(params.data.approvalId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "approval/not-found", message: "no such approval" },
      });
    }
    const existing = authorizeApproval(opts.storage, currentPrincipal(req), parsedId.data);
    if (!existing) {
      return reply.status(404).send({
        error: { code: "approval/not-found", message: "no such approval" },
      });
    }
    const parsedBody = resolveApprovalBody.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.status(400).send({
        error: {
          code: "request/invalid",
          message: "body must be {decision: \"allow\"|\"deny\"}",
        },
      });
    }
    try {
      const record = approvals.resolve(parsedId.data, parsedBody.data.decision);
      return reply.status(200).send({ approval: record });
    } catch (err) {
      const problem = normalizeError(err);
      return reply.status(problem.status).send({
        error: {
          code: (err as { code?: string }).code ?? problem.code,
          message: problem.message,
        },
      });
    }
  });

  // GET /projects/:projectId/approvals — list pending approvals.
  app.get("/projects/:projectId/approvals", async (req, reply) => {
    const params = z.strictObject({ projectId: z.string() }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "invalid project id" },
      });
    }
    const parsedId = projectIdSchema.safeParse(params.data.projectId);
    if (!parsedId.success) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    authorizeProject(opts.storage, currentPrincipal(req), parsedId.data);
    const rec = opts.storage.projects.get(parsedId.data);
    if (!rec) {
      return reply.status(404).send({
        error: { code: "workspace/not-found", message: "no such project" },
      });
    }
    return { approvals: opts.storage.approvals.listPending(parsedId.data) };
  });

  // -- lifecycle ------------------------------------------------------------
  app.addHook("onClose", async () => {
    opts.storage.close();
  });

  return app;
}

function toApiProject(rec: ProjectRecord): {
  id: string;
  name: string;
  createdAt: string;
} {
  // rootPath deliberately omitted from public payloads
  return { id: rec.id, name: rec.name, createdAt: rec.createdAt };
}
