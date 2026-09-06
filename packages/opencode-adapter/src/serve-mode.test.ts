import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentExecutionRequest,
  ToolPermissionDecision,
} from "@devmesh/runtime";
import { OpencodeServeRuntime } from "./serve-mode.js";
import { OpenCodeHybridRuntime } from "./composite.js";
import { permissionResourceForTool, toolTargetFor } from "./permission-catalog.js";

let dir: string;
let stubPath: string;
const runtimes: OpencodeServeRuntime[] = [];

/**
 * Stub `opencode serve` binary implementing the verified v1.18.29 protocol:
 * "opencode server listening on http://127.0.0.1:<port>" on stdout, Basic auth,
 * /global/health, POST /session, GET /event (SSE), prompt_async, permissions
 * reply, abort, message, session/list. Behavior is env-driven (OC_STUB_*):
 *   OC_STUB_EVENTS            JSON acts: {ask:{permission,patterns?,pid?}},
 *                             {idle:true}, {garbage:true}, {waitMs:n}
 *   OC_STUB_CLOSE_AFTER_EVENTS=1  end the SSE stream after the acts
 *   OC_STUB_FAIL_SESSION=1 price  a 400 on session create
 *   OC_STUB_FAIL_PROMPT=1   fail prompt submission
 *   OC_STUB_TTL_MS=<n>      crash the server after n ms
 *   OC_STUB_LOG=<path>      append one JSON line per correlation
 *
 * Cross-session acts (Phase 14D corrective): emit events whose sessionID does
 * NOT belong to the current act timeline, to prove the broker never lets a
 * foreign session end or author our run.
 *   {foreignIdle:{sessionID}} ANSI emits an idle for another session.
 *   {foreignAsk:{permission,pid,sessionID}} emits another session's ask
 *   {askNoSession:{permission,pid}} emits an ask WITHOUT a sessionID (the
 *   broker must still treat it as ours and answer it exactly once).
 */
function makeStub(extra = ""): void {
  const body = `#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  console.log("stub-opencode 99.2.0");
  process.exit(0);
}

const logPath = process.env.OC_STUB_LOG || "";
const log = (obj) => appendFileSync(logPath, JSON.stringify({ t: Date.now(), ...obj }) + "\\n");
const failSession = process.env.OC_STUB_FAIL_SESSION === "1";
const failPrompt = process.env.OC_STUB_FAIL_PROMPT === "1";
const closeAfterEvents = process.env.OC_STUB_CLOSE_AFTER_EVENTS === "1";
const ttlMs = Number(process.env.OC_STUB_TTL_MS || 0);
let acts = [];
try { acts = JSON.parse(process.env.OC_STUB_EVENTS || "[]"); } catch { acts = []; }
// Split the full event program into per-session timelines: a {separate:true}
// act marks the boundary between the session that currently receives acts and
// the next session (used by the concurrent-session test).
const timelines = [];
let current = [];
for (const act of acts) {
  if (act && act.separate) { timelines.push(current); current = []; }
  else current.push(act);
}
if (current.length > 0) timelines.push(current);
let actIndex = 0;
const sessionActs = () => {
  const picked = timelines[Math.min(actIndex, timelines.length - 1)] || [];
  actIndex += 1;
  return picked;
};

const sessions = new Map();
const clients = new Set();
const asked = new Set();
let seq = 1;
const respond = (res, status, body) => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const emit = (obj) => {
  for (const c of clients) c.write("data: " + JSON.stringify(obj) + "\\n\\n");
};
const broadcastIdle = (sessionID) => {
  emit({ id: 0, type: "session.status", properties: { sessionID, status: { type: "idle" } } });
};
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const writeFrame = (c, obj) => c.write("data: " + JSON.stringify(obj) + "\\n\\n");
function emitMany(objects) {
  for (const c of clients) c.write(objects.map((o) => "data: " + JSON.stringify(o) + "\\n\\n").join(""));
}
async function runActs(sessionId, timeline) {
  const until = (deadline, pred) =>
    new Promise((res) => {
      const iv = setInterval(() => {
        if (pred()) { clearInterval(iv); res(); }
      }, 20);
      setTimeout(() => { clearInterval(iv); res(); }, deadline).unref();
    });
  let i = 0;
  while (i < timeline.length) {
    const act = timeline[i];
    if (act.waitMs) { await sleep(act.waitMs); i += 1; continue; }
    if (act.garbage) {
      for (const c of clients) {
        c.write("data: not-json\\n\\ndata: {unclosed\\n\\n");
        c.write(": comment\\n\\nevent: stale\\n\\n");
      }
      i += 1;
      continue;
    }
    if (act.ask && typeof act.ask === "object") {
      // Emit a run of consecutive asks in one write so the adapter handles
      // them in a single synchronous dispatch pass (real chunks arrive this
      // way; the duplicate-ask dedupe depends on it).
      let j = i;
      const batch = [];
      while (j < timeline.length && timeline[j] && timeline[j].ask && typeof timeline[j].ask === "object") {
        const a = timeline[j].ask;
        batch.push({ pid: a.pid || "per_" + seq++, permission: String(a.permission || "read"), patterns: Array.isArray(a.patterns) ? a.patterns : [] });
        j += 1;
      }
      for (const b of batch) {
        asked.add(b.pid);
        log({ route: "permission.asked", session: sessionId, pid: b.pid, permission: b.permission });
      }
      emitMany(batch.map((b) => ({
        type: "permission.asked",
        properties: {
          id: b.pid,
          sessionID: sessionId,
          permission: b.permission,
          patterns: b.patterns,
          metadata: {},
          always: ["*"],
          tool: { messageID: "", callID: "" },
        },
      })));
      await until(Date.now() + 5000, () => batch.every((b) => !asked.has(b.pid)));
      i = j;
      continue;
    }
    if (act.idle) { i += 1; continue; }
    if (act.foreignIdle && typeof act.foreignIdle === "object") {
      broadcastIdle(String(act.foreignIdle.sessionID || "ses_foreign"));
      i += 1; continue;
    }
    if (act.foreignAsk && typeof act.foreignAsk === "object") {
      const f = act.foreignAsk;
      emitMany([{
        type: "permission.asked",
        properties: {
          id: String(f.pid),
          sessionID: String(f.sessionID || "ses_foreign"),
          permission: String(f.permission || "read"),
          patterns: [],
          metadata: {},
          always: ["*"],
          tool: { messageID: "", callID: "" },
        },
      }]);
      i += 1; continue;
    }
    if (act.askNoSession && typeof act.askNoSession === "object") {
      const a = act.askNoSession;
      const id = String(a.pid || "per_" + seq);
      asked.add(id);
      log({ route: "permission.asked", session: sessionId, pid: id, permission: String(a.permission || "read"), noSession: true });
      emitMany([{
        type: "permission.asked",
        properties: {
          id,
          permission: String(a.permission || "read"),
          patterns: Array.isArray(a.patterns) ? a.patterns : [],
          metadata: {},
          always: ["*"],
          tool: { messageID: "", callID: "" },
        },
      }]);
      await until(Date.now() + 5000, () => !asked.has(id));
      i += 1; continue;
    }
    i += 1;
  }
  const idleDeadline = Date.now() + 5000;
  while (asked.size > 0 && Date.now() < idleDeadline) await sleep(20);
  if (closeAfterEvents) {
    for (const c of clients) c.end();
    clients.clear();
  } else {
    broadcastIdle(sessionId);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  const path = url.pathname;
  if (req.method === "GET" && path === "/global/health") {
    log({ route: "health" });
    respond(res, 200, { healthy: true, version: "99.2.0" });
    return;
  }
  if (req.method === "POST" && path === "/session") {
    let body = {};
    try { body = JSON.parse(await readJson(req)); } catch {}
    log({ route: "session.create", body });
    if (failSession) { respond(res, 400, { error: "boom" }); return; }
    const title = String(body.title || "");
    const id = "ses_" + title.replace(/^devmesh-/, "").slice(0, 18);
    sessions.set(id, { tokens: { input: 41, output: 17 }, timeline: sessionActs() });
    respond(res, 200, { id, tokens: sessions.get(id).tokens });
    return;
  }
  if (req.method === "GET" && path === "/event") {
    log({ route: "event" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  const m = path.match(/^\\/session\\/([^/]+)\\/(prompt_async|abort|message)$/);
  const pm = path.match(/^\\/session\\/([^/]+)\\/permissions\\/([^/]+)$/);
  if (req.method === "POST" && m && m[2] === "prompt_async") {
    let body = {};
    try { body = JSON.parse(await readJson(req)); } catch {}
    log({ route: "prompt", session: m[1], body });
    if (failPrompt) { respond(res, 503, { error: "prompt boom" }); return; }
    respond(res, 204);
    const ses = sessions.get(m[1]);
    setTimeout(() => runActs(m[1], ses ? ses.timeline : []).catch(() => undefined), 60);
    return;
  }
  if (req.method === "POST" && m && m[2] === "abort") {
    log({ route: "abort", session: m[1] });
    broadcastIdle(m[1]);
    respond(res, 204);
    return;
  }
  if (req.method === "GET" && m && m[2] === "message") {
    log({ route: "message", session: m[1] });
    respond(res, 200, [{ info: { role: "assistant" }, parts: [{ type: "text", text: "stub final text" }] }]);
    return;
  }
  if (req.method === "GET" && path === "/session/list") {
    log({ route: "session.list" });
    respond(res, 200, [...sessions.entries()].map(([id, s]) => ({ id, tokens: s.tokens })));
    return;
  }
  if (req.method === "POST" && pm) {
    let body = {};
    try { body = JSON.parse(await readJson(req)); } catch {}
    log({ route: "permissions.reply", session: pm[1], pid: pm[2], body });
    if (!asked.has(pm[2])) {
      respond(res, 404, { _tag: "PermissionNotFoundError", requestID: pm[2], message: "Permission request not found: " + pm[2] });
      return;
    }
    asked.delete(pm[2]);
    respond(res, 200, true);
    return;
  }
  respond(res, 404, { error: "no such route " + path });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log("opencode server listening on http://127.0.0.1:" + port);
  log({ route: "listening", pid: process.pid, port });
});
if (ttlMs > 0) setTimeout(() => process.exit(7), ttlMs).unref();
process.on("SIGTERM", () => process.exit(0));
${extra}
`;
  writeFileSync(stubPath, body);
  chmodSync(stubPath, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devmesh-serve-"));
  stubPath = join(dir, "stub-serve.mjs");
  makeStub();
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.dispose().catch(() => undefined);
  }
  rmSync(dir, { recursive: true, force: true });
});

const request = (overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest => ({
  executionId: "22222222-2222-4222-8222-222222222222",
  projectId: "11111111-1111-4111-8111-111111111111",
  workspaceRoot: "",
  instruction: "do the thing",
  timeoutMs: 10_000,
  ...overrides,
});

/** Read the stub's correlation log as JSON lines. */
function readLog(): Array<Record<string, unknown>> {
  let raw = "";
  try {
    raw = readFileSync(join(dir, "stub.log"), "utf8");
  } catch {
    return []; // the stub may not have written anything yet
  }
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function makeRuntime(env: Record<string, string> = {}): OpencodeServeRuntime {
  const runtime = new OpencodeServeRuntime({
    binaryPath: stubPath,
    killGraceMs: 100,
    readyTimeoutMs: 10_000,
    env: { OC_STUB_LOG: join(dir, "stub.log"), ...env },
  });
  runtimes.push(runtime);
  return runtime;
}

let askSeq = 0;

describe("permission catalog (Phase 14D mapping)", () => {
  it("classifies known tools and fails closed on unknown ones", () => {
    expect(permissionResourceForTool("read")).toBe("read");
    expect(permissionResourceForTool("edit")).toBe("edit");
    expect(permissionResourceForTool("write")).toBe("edit");
    expect(permissionResourceForTool("apply_patch")).toBe("edit");
    expect(permissionResourceForTool("bash")).toBe("bash");
    expect(permissionResourceForTool("webfetch")).toBe("webfetch");
    expect(permissionResourceForTool("websearch")).toBe("net");
    expect(permissionResourceForTool("grep")).toBe("read");
    expect(permissionResourceForTool("mystery_tool")).toBeUndefined();
  });

  it("pulls the decision target from the tool's argument fields", () => {
    expect(toolTargetFor("read", { filePath: "src/a.ts" })).toBe("src/a.ts");
    expect(toolTargetFor("bash", { command: "git status" })).toBe("git status");
    expect(toolTargetFor("webfetch", { url: "https://example.com" })).toBe(
      "https://example.com",
    );
    expect(toolTargetFor("edit", { filePath: "  ", content: "x" })).toBeUndefined();
    expect(toolTargetFor("unknown", { filePath: "a" })).toBeUndefined();
  });
});

describe("OpencodeServeRuntime (stub serve protocol)", () => {
  it("reports health from --version before any server is spawned", async () => {
    const runtime = makeRuntime();
    const health = await runtime.health();
    expect(health).toEqual({ healthy: true, version: "stub-opencode 99.2.0" });
  });

  it("spawns one shared server, authenticates, and runs an allow-ed tool to completion", async () => {
    const askPid = `per_allow_${askSeq++}`;
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "read", patterns: ["src/a.ts"], pid: askPid } },
        { idle: true },
      ]),
    });
    const running = runtime.start(
      request({
        model: "opencode/big-pickle",
        onToolPermission: async (r) => {
          // Phase 14D corrective: the broker threads the OpenCode request id
          // through, so DevMesh mints one approval per DISTINCT ask.
          expect(r.requestId).toBe(askPid);
          return { decision: "allow", reason: "fine" };
        },
      }),
    );
    const result = await running.result;

    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe(`ses_${request().executionId.slice(0, 18)}`);
    expect(result.finalText).toBe("stub final text");
    expect(result.usage).toEqual({ inputTokens: 41, outputTokens: 17 });

    const log = readLog();
    expect(log.filter((l) => l.route === "listening")).toHaveLength(1);
    const create = log.find((l) => l.route === "session.create");
    expect((create?.body as Record<string, unknown>)?.model).toEqual({
      providerID: "opencode",
      modelID: "big-pickle",
    });
    expect((create?.body as Record<string, unknown>)?.permission).toEqual([
      { permission: "*", pattern: "*", action: "ask" },
    ]);
    const asked = log.find((l) => l.route === "permission.asked");
    expect(asked).toMatchObject({ pid: askPid, permission: "read" });
    const reply = log.find((l) => l.route === "permissions.reply");
    expect(reply).toMatchObject({ pid: askPid, body: { response: "once" } });
    // exactly one reply for the pid
    expect(log.filter((l) => l.route === "permissions.reply")).toHaveLength(1);
  });

  it("rejects a denied tool and still completes the run", async () => {
    const askPid = `per_deny_${askSeq++}`;
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "edit", patterns: ["src/a.ts"], pid: askPid } },
        { idle: true },
      ]),
    });
    const result = await runtime
      .start(
        request({
          onToolPermission: async (r) => {
            expect(r.resource).toBe("edit");
            expect(r.target).toBe("src/a.ts");
            expect(r.patterns).toEqual(["src/a.ts"]);
            return { decision: "deny", reason: "denied by policy" };
          },
        }),
      )
      .result;
    expect(result.status).toBe("completed");
    const reply = readLog().find((l) => l.route === "permissions.reply");
    expect(reply).toMatchObject({ pid: askPid, body: { response: "reject" } });
  });

  it("auto-rejects (fail closed) when no permission handler is attached", async () => {
    const askPid = `per_nohandler_${askSeq++}`;
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "bash", patterns: ["rm -rf /"], pid: askPid } },
        { idle: true },
      ]),
    });
    const result = await runtime.start(request()).result;
    expect(result.status).toBe("completed");
    const reply = readLog().find((l) => l.route === "permissions.reply");
    expect(reply).toMatchObject({ pid: askPid, body: { response: "reject" } });
  });

  it("auto-rejects unknown tools before they reach the handler", async () => {
    const askPid = `per_unknown_${askSeq++}`;
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "mystery_tool", patterns: ["x"], pid: askPid } },
        { idle: true },
      ]),
    });
    let handlerCalled = false;
    const result = await runtime
      .start(
        request({
          onToolPermission: async () => {
            handlerCalled = true;
            return { decision: "allow", reason: "should never be consulted" };
          },
        }),
      )
      .result;
    expect(result.status).toBe("completed");
    expect(handlerCalled).toBe(false);
    const reply = readLog().find((l) => l.route === "permissions.reply");
    expect(reply).toMatchObject({ pid: askPid, body: { response: "reject" } });
  });

  it("ignores duplicate asks for the same permission id (one reply only)", async () => {
    const askPid = `per_dup_${askSeq++}`;
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "read", pid: askPid } },
        { ask: { permission: "read", pid: askPid } },
        { idle: true },
      ]),
    });
    const result = await runtime
      .start(request({ onToolPermission: async () => ({ decision: "allow", reason: "ok" }) }))
      .result;
    expect(result.status).toBe("completed");
    const replies = readLog().filter((l) => l.route === "permissions.reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ pid: askPid, body: { response: "once" } });
  });

  it("passes the allow-all ruleset when the request is auto-approved", async () => {
    const runtime = makeRuntime({ OC_STUB_EVENTS: "[]" });
    const result = await runtime
      .start(
        request({
          autoApprove: true,
          onToolPermission: async () => ({ decision: "allow", reason: "n/a" }),
        }),
      )
      .result;
    expect(result.status).toBe("completed");
    const create = readLog().find((l) => l.route === "session.create");
    expect((create?.body as Record<string, unknown>)?.permission).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });

  it("survives malformed SSE frames and still completes on idle", async () => {
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([{ garbage: true }, { idle: true }]),
    });
    const result = await runtime
      .start(request({ onToolPermission: async () => ({ decision: "allow", reason: "ok" }) }))
      .result;
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("stub final text");
  });

  it("fails closed when the SSE stream closes before the session finishes", async () => {
    const runtime = makeRuntime({
      OC_STUB_CLOSE_AFTER_EVENTS: "1",
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "read", pid: `per_close_${askSeq++}` } },
      ]),
    });
    const result = await runtime
      .start(request({ onToolPermission: async () => ({ decision: "allow", reason: "ok" }) }))
      .result;
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBeTruthy();
  });

  it("fails the run closed when the server process exits mid-run", async () => {
    const runtime = makeRuntime({
      OC_STUB_TTL_MS: "400",
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "read", pid: `per_crash_${askSeq++}` } },
        { waitMs: 5000 },
      ]),
    });
    const result = await runtime
      .start(request({ onToolPermission: async () => ({ decision: "allow", reason: "ok" }) }))
      .result;
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBeTruthy();
  });

  it("aborts the session and cancels pending asks on cancel", async () => {
    const askPid = `per_cancel_${askSeq++}`;
    let releaseHandler: (d: ToolPermissionDecision) => void = () => undefined;
    const blocker = new Promise<ToolPermissionDecision>((res) => {
      releaseHandler = res;
    });
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "read", pid: askPid } },
        { waitMs: 30_000 },
      ]),
    });
    const running = runtime.start(
      request({ onToolPermission: () => blocker }),
    );
    // Wait until the ask definitely reached the broker before cancelling,
    // regardless of how slow the environment is.
    const askDeadline = Date.now() + 10_000;
    let askSeen = false;
    while (Date.now() < askDeadline) {
      if (readLog().some((l) => l.route === "permission.asked" && l.pid === askPid)) {
        askSeen = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(askSeen).toBe(true);

    await running.cancel("operator cancelled");
    const result = await running.result;

    expect(result.status).toBe("cancelled");
    expect(result.failureReason).toBe("operator cancelled");
    const log = readLog();
    expect(log.some((l) => l.route === "abort")).toBe(true);
    // The still-pending ask was answered with a reject (fail closed) rather
    // than hanging the run.
    const reply = log.find((l) => l.route === "permissions.reply" && l.pid === askPid);
    expect(reply).toMatchObject({ body: { response: "reject" } });
    // Multimedia release must not double-answer the ask.
    releaseHandler({ decision: "allow", reason: "late" });
  });

  it("aborts the session and reports timeout status", async () => {
    const askPid = `per_tmo_${askSeq++}`;
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "read", pid: askPid } },
        { waitMs: 30_000 },
      ]),
    });
    const result = await runtime
      .start(
        request({
          timeoutMs: 300,
          onToolPermission: async () => ({ decision: "allow", reason: "ok" }),
        }),
      )
      .result;
    expect(result.status).toBe("timeout");
    expect(result.failureReason).toContain("300ms");
    expect(readLog().some((l) => l.route === "abort")).toBe(true);
  });

  it("rejects the result when the session cannot be created", async () => {
    const runtime = makeRuntime({ OC_STUB_FAIL_SESSION: "1" });
    await expect(
      runtime.start(request({ onToolPermission: async () => ({ decision: "allow", reason: "x" }) })).result,
    ).rejects.toMatchObject({ code: "runtime/unavailable" });
  });

  it("rejects the result when prompt submission fails", async () => {
    const runtime = makeRuntime({ OC_STUB_FAIL_PROMPT: "1" });
    await expect(
      runtime.start(request({ onToolPermission: async () => ({ decision: "allow", reason: "x" }) })).result,
    ).rejects.toMatchObject({ code: "runtime/unavailable" });
  });

  it("rejects the result when the binary cannot spawn", async () => {
    const runtime = new OpencodeServeRuntime({
      binaryPath: join(dir, "does-not-exist"),
      readyTimeoutMs: 5000,
    });
    await expect(runtime.start(request()).result).rejects.toMatchObject({
      code: "runtime/unavailable",
    });
  });

  it("serves concurrent executions from the same shared server", async () => {
    const askA = `per_conc_a_${askSeq++}`;
    const askB = `per_conc_b_${askSeq++}`;
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "read", pid: askA } },
        { separate: true },
        { ask: { permission: "bash", pid: askB } },
        { separate: true },
        { idle: true },
      ]),
    });
    const a = request({ executionId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const b = request({ executionId: "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    const ra = runtime.start(a);
    const rb = runtime.start(b);
    const [resultA, resultB] = await Promise.all([ra.result, rb.result]);

    expect(resultA.status).toBe("completed");
    expect(resultB.status).toBe("completed");
    expect(resultA.sessionId).not.toBe(resultB.sessionId);

    const log = readLog();
    // Exactly one serve process for both executions.
    expect(log.filter((l) => l.route === "listening")).toHaveLength(1);
    // Both asks were answered exactly once each.
    const replies = log.filter((l) => l.route === "permissions.reply");
    expect(replies).toHaveLength(2);
    expect(replies.some((l) => l.pid === askA)).toBe(true);
    expect(replies.some((l) => l.pid === askB)).toBe(true);
  });
});

describe("serving correlation safety (Phase 14D corrective, cross-session)", () => {
  it("A: a foreign session's idle never ends our run or releases its ask", async () => {
    // Order matters: the foreign idle arrives FIRST, while our ask is still
    // pending (the handler is held). If the broker trusted any session.status
    // frame, the run would terminate and the ask would be rejected instead of
    // answered.
    const askPid = `per_cross_idle_${askSeq++}`;
    let releaseHandler: (d: ToolPermissionDecision) => void = () => undefined;
    const blocker = new Promise<ToolPermissionDecision>((res) => {
      releaseHandler = res;
    });
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { foreignIdle: { sessionID: "ses_not_ours" } },
        { ask: { permission: "edit", patterns: ["src/a.ts"], pid: askPid } },
        { idle: true },
      ]),
    });
    const running = runtime.start(
      request({ onToolPermission: () => blocker }),
    );

    // Wait until our ask reached the broker (the handler is holding it), then
    // release. The foreign idle was already broadcast before the ask.
    const askDeadline = Date.now() + 10_000;
    let askSeen = false;
    while (Date.now() < askDeadline) {
      if (readLog().some((l) => l.route === "permission.asked" && l.pid === askPid)) {
        askSeen = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(askSeen).toBe(true);

    releaseHandler({ decision: "allow", reason: "approved" });
    const result = await running.result;

    expect(result.status).toBe("completed");
    // The ask was answered ONCE with once (allow), not rejected by a premature
    // foreign-idle termination.
    const replies = readLog().filter((l) => l.route === "permissions.reply" && l.pid === askPid);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ body: { response: "once" } });
  });

  it("B: another session's permission.asked is never handled or answered", async () => {
    const foreignPid = `per_foreign_${askSeq++}`;
    const ownPid = `per_own_${askSeq++}`;
    const handlerCalls: Array<{ requestId?: string; tool: string }> = [];
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { foreignAsk: { permission: "edit", pid: foreignPid, sessionID: "ses_not_ours" } },
        { ask: { permission: "bash", patterns: ["git status"], pid: ownPid } },
        { idle: true },
      ]),
    });
    const result = await runtime
      .start(
        request({
          onToolPermission: async (r) => {
            handlerCalls.push({ requestId: r.requestId, tool: r.tool });
            return { decision: "allow", reason: "ok" };
          },
        }),
      )
      .result;
    expect(result.status).toBe("completed");
    // The foreign ask never reached the policy handler; only our own was seen.
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0]).toMatchObject({ requestId: ownPid, tool: "bash" });
    const replies = readLog().filter((l) => l.route === "permissions.reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ pid: ownPid });
    // Exactly one session create for the run (no phantom session for the ask).
    expect(readLog().filter((l) => l.route === "session.create")).toHaveLength(1);
  });

  it("C: an ask WITHOUT a sessionID is treated as ours and answered once", async () => {
    const askPid = `per_nosession_${askSeq++}`;
    const handlerCalls: string[] = [];
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { askNoSession: { permission: "read", pid: askPid } },
        { idle: true },
      ]),
    });
    const result = await runtime
      .start(
        request({
          onToolPermission: async (r) => {
            handlerCalls.push(r.tool);
            return { decision: "allow", reason: "ok" };
          },
        }),
      )
      .result;
    expect(result.status).toBe("completed");
    expect(handlerCalls).toEqual(["read"]);
    const replies = readLog().filter((l) => l.route === "permissions.reply" && l.pid === askPid);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ body: { response: "once" } });
  });

  it("D: a late handler resolution after the run ended never double-answers", async () => {
    // The run ends (idle) while a SECOND ask is still awaiting its handler;
    // the broker fails that ask closed. A late allow for it must not publish a
    // second reply (the stub would 404 it — the broker tolerates that path).
    const askPid = `per_late_${askSeq++}`;
    let releaseHandler: (d: ToolPermissionDecision) => void = () => undefined;
    const blocker = new Promise<ToolPermissionDecision>((res) => {
      releaseHandler = res;
    });
    const runtime = makeRuntime({
      OC_STUB_EVENTS: JSON.stringify([
        { ask: { permission: "edit", pid: askPid } },
        { idle: true },
      ]),
    });
    const running = runtime.start(
      request({
        onToolPermission: () => blocker, // never resolves before idle
      }),
    );
    const askDeadline = Date.now() + 10_000;
    let askSeen = false;
    while (Date.now() < askDeadline) {
      if (readLog().some((l) => l.route === "permission.asked" && l.pid === askPid)) {
        askSeen = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(askSeen).toBe(true);

    const result = await running.result;
    expect(result.status).toBe("completed");

    // The still-pending ask was rejected once when the run finished.
    const before = readLog().filter((l) => l.route === "permissions.reply" && l.pid === askPid);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ body: { response: "reject" } });

    // Late resolution must NOT produce a second reply (takePending is empty).
    releaseHandler({ decision: "allow", reason: "too late" });
    await new Promise((r) => setTimeout(r, 200));
    const after = readLog().filter((l) => l.route === "permissions.reply" && l.pid === askPid);
    expect(after).toHaveLength(1);
  });
});

describe("OpenCodeHybridRuntime (Phase 14D routing)", () => {
  // A minimal fake serve-mode runtime to observe routing without a real
  // process tree; mirrors the composition-root contract.
  function hybrid(runSeen: string[], serveSeen: string[]): OpenCodeHybridRuntime {
    const run = {
      name: "opencode",
      start: (r: AgentExecutionRequest) => {
        runSeen.push(r.executionId);
        return { executionId: r.executionId, onEvent: () => undefined, cancel: async () => undefined, result: Promise.resolve({ status: "completed" as const, exitCode: 0, finalText: "", stderrTail: "", durationMs: 0 }) };
      },
      dispose: async () => undefined,
    };
    const serve = {
      name: "opencode",
      start: (r: AgentExecutionRequest) => {
        serveSeen.push(r.executionId);
        return { executionId: r.executionId, onEvent: () => undefined, cancel: async () => undefined, result: Promise.resolve({ status: "completed" as const, exitCode: 0, finalText: "", stderrTail: "", durationMs: 0 }) };
      },
      dispose: async () => undefined,
    };
    return new OpenCodeHybridRuntime(run as never, serve as never);
  }

  it("routes structured-output executions to run mode and others to serve mode", async () => {
    const runSeen: string[] = [];
    const serveSeen: string[] = [];
    const runtime = hybrid(runSeen, serveSeen);
    const structured = request({
      executionId: "ccccccc3-cccc-4ccc-8ccc-cccccccccccc",
      outputFormat: { name: "test-report", schema: {} },
    });
    const plain = request({ executionId: "ddddddd4-dddd-4ddd-8ddd-dddddddddddd" });

    await runtime.start(structured).result;
    await runtime.start(plain).result;

    expect(runSeen).toEqual([structured.executionId]);
    expect(serveSeen).toEqual([plain.executionId]);
  });

  it("dispose reaches both underlying runtimes", async () => {
    let runDisposed = 0;
    let serveDisposed = 0;
    const run = {
      name: "opencode",
      start: (r: AgentExecutionRequest) => ({ executionId: r.executionId, onEvent: () => undefined, cancel: async () => undefined, result: Promise.resolve({ status: "completed" as const, exitCode: 0, finalText: "", stderrTail: "", durationMs: 0 }) }),
      dispose: async () => {
        runDisposed += 1;
      },
    };
    const serve = {
      name: "opencode",
      start: (r: AgentExecutionRequest) => ({ executionId: r.executionId, onEvent: () => undefined, cancel: async () => undefined, result: Promise.resolve({ status: "completed" as const, exitCode: 0, finalText: "", stderrTail: "", durationMs: 0 }) }),
      dispose: async () => {
        serveDisposed += 1;
      },
    };
    const runtime = new OpenCodeHybridRuntime(run as never, serve as never);
    await runtime.dispose();
    await runtime.dispose();
    expect(runDisposed).toBe(1);
    expect(serveDisposed).toBe(1);
  });
});