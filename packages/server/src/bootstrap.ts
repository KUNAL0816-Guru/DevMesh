import { mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { parseProviderModelRef } from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import type { AgentRuntime, ProviderGateway } from "@devmesh/runtime";
import {
  CompositeProviderGateway,
  OpenAiCompatibleProvider,
} from "@devmesh/runtime";
import { databasePath, loadConfig, workspacesRoot, type Config } from "./config.js";
import { buildApp } from "./app.js";
import { reconcileInterrupted } from "./executions/service.js";

/**
 * Composition root for the agent runtime. This is the ONLY place in the
 * server package that names a concrete runtime; the app itself stays
 * vendor-neutral behind the AgentRuntime port.
 */
async function buildRuntime(config: Config): Promise<AgentRuntime | null> {
  if (config.runtime === "opencode") {
    const { OpencodeAdapter } = await import("@devmesh/opencode-adapter");
    return new OpencodeAdapter({
      binaryPath: config.opencodeBin,
      autoApprove: config.opencodeAutoApprove,
      model: config.opencodeModel,
    });
  }
  if (config.runtime === "opencode-local") {
    const { OpenAiCompatibleRuntime } = await import("@devmesh/opencode-adapter");
    return new OpenAiCompatibleRuntime({
      baseUrl: config.localBaseUrl ?? "",
      model: config.localModel ?? "",
      apiKey: config.localApiKey,
      timeoutMs: config.localTimeoutMs,
    });
  }
  return null;
}

function buildProviderGateway(config: Config): ProviderGateway {
  const composite = new CompositeProviderGateway();
  if (config.gateway === "openai-compatible") {
    composite.register(
      new OpenAiCompatibleProvider({
        providerId: config.gatewayModel ? parseProviderModelRef(config.gatewayModel).provider : undefined,
        baseUrl: config.gatewayBaseUrl,
        apiKey: config.gatewayApiKey,
        timeoutMs: config.gatewayTimeoutMs,
      }),
    );
  }
  return composite;
}

export interface RunningServer {
  app: FastifyInstance;
  config: Config;
  storage: Storage;
  address: string;
  /** ProviderGateway wired for DevMesh's own LLM calls (never null). */
  gateway: ProviderGateway;
  /** Stop listening and release resources (idempotent). */
  shutdown(): Promise<void>;
}

export interface StartServerOptions {
  config?: Config;
  /** ProviderGateway override for the composition root (tests and tools). */
  gateway?: ProviderGateway;
  /** Install SIGINT/SIGTERM handlers (default true; disable in tests). */
  installSignals?: boolean;
}

/**
 * Compose the full stack — storage, workspace service, optional agent
 * runtime, HTTP app — bind it, and wire graceful shutdown. State persists
 * in `dataRoot`:
 *   devmesh.db          SQLite (WAL)
 *   workspaces/<slug>-<id8>/   managed project roots
 * Executions left running by a previous process are reconciled to
 * `interrupted` on boot.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const config = opts.config ?? loadConfig();
  mkdirSync(config.dataRoot, { recursive: true });

  const storage = createStorage({ path: databasePath(config) });
  reconcileInterrupted(storage);
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: workspacesRoot(config),
  });
  const runtime = await buildRuntime(config);
  const gateway = opts.gateway ?? buildProviderGateway(config);
  if (runtime && "health" in runtime && runtime.health) {
    const health = await runtime.health();
    storage.events.append({
      ts: new Date().toISOString(),
      actor: "system",
      type: "runtime.health.changed",
      runtimeId: runtime.name,
      healthy: health.healthy,
      version: health.version,
    });
  }
  const app = buildApp({ config, storage, workspaces, runtime });

  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const bound =
    address && typeof address === "object"
      ? `${address.address}:${address.port}`
      : String(address ?? `${config.host}:${config.port}`);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close(); // onClose hook closes storage
  };

  if (opts.installSignals !== false) {
    const onSignal = (sig: string): void => {
      app.log.info({ signal: sig }, "shutting down");
      void shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  }

  app.log.info({ address: bound }, "devmesh server listening");
  return { app, config, storage, address: bound, gateway, shutdown };
}
