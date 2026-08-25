import Fastify, { type FastifyInstance } from "fastify";
import {
  projectIdSchema,
  taskIdSchema,
} from "@devmesh/contracts";
import type { Storage } from "@devmesh/storage";
import type { WorkspaceService, ProjectRecord } from "@devmesh/workspace";
import type { AgentRuntime } from "@devmesh/runtime";
import type { AgentRegistry } from "@devmesh/agents";
import { createDefaultAgentRegistry } from "@devmesh/agents";
import { z } from "zod";
import type { Config } from "./config.js";
import { normalizeError } from "./errors-map.js";
import { GitService } from "@devmesh/workspace";
import { ExecutionService } from "./executions/service.js";
import { VERIFICATION_COMMAND_PATTERN } from "./executions/commands.js";
import { Orchestrator } from "./orchestrator.js";

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
  const executions = new ExecutionService({
    storage: opts.storage,
    workspaces: opts.workspaces,
    git,
    runtime: opts.runtime ?? null,
    agents: opts.agents ?? createDefaultAgentRegistry(),
    defaultTimeoutMs: opts.config.execTimeoutMs,
    defaultModel: opts.config.opencodeModel,
  });

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

  app.setNotFoundHandler((_req, reply) => {
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

  // -- projects / workspaces ------------------------------------------------
  app.post("/projects", async (req, reply) => {
    const parsed = createProjectBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "request/invalid", message: "body must be {name: string}" },
      });
    }
    const handle = opts.workspaces.create(parsed.data.name);
    const record = opts.storage.projects.get(handle.projectId);
    if (!record) {
      return reply.status(500).send({
        error: { code: "internal/error", message: "project vanished after create" },
      });
    }
    return reply.status(201).send(toApiProject(record));
  });

  app.get("/projects", async () => {
    return { projects: opts.storage.projects.list().map(toApiProject) };
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
    return toApiProject(rec);
  });

  // -- executions (runtime-neutral; no shell passthrough) --------------------
  app.post("/projects/:projectId/executions", async (req, reply) => {
    if (!executions.configured) {
      return reply.status(503).send({
        error: { code: "runtime/not-configured", message: "no agent runtime wired" },
      });
    }
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
    const rec = opts.storage.executions.get(params.data.executionId);
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
    try {
      const rec = await executions.cancel(params.data.executionId);
      return reply.status(202).send({ execution: publicExecution(rec) });
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
    if (!executions.configured) {
      return reply.status(503).send({
        error: { code: "runtime/not-configured", message: "no agent runtime wired" },
      });
    }
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
      void result.catch((err) => {
        app.log.error({ err }, "pipeline failed");
      });
      return reply.status(202).send({
        message: "pipeline started",
        projectId: parsedId.data,
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
