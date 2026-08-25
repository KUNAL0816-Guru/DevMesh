#!/usr/bin/env node
// DevMesh environment doctor.
// Probes the local machine and prints an OK/WARN/FAIL matrix.
// Exit code 1 only when a hard requirement fails (node, npm, git).

import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import os from "node:os";
import process from "node:process";

const asJson = process.argv.slice(2).includes("--json");

const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
};

function probe(cmd, argv, { timeout = 15000 } = {}) {
  try {
    const out = execFileSync(cmd, argv, {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    return { ok: false, err: err?.message ?? String(err) };
  }
}

const giB = (bytes) => Math.round((bytes / 2 ** 30) * 10) / 10;

// ---- platform ------------------------------------------------------------
record("platform", "ok", `${process.platform}/${process.arch}`);

const kernel = os.release();
const isProot = /proot/i.test(kernel);
record(
  "environment",
  "ok",
  isProot ? `proot detected (kernel ${kernel})` : `native kernel ${kernel}`,
);

// ---- hard requirements ----------------------------------------------------
{
  const major = Number(process.versions.node.split(".")[0]);
  record(
    "node",
    major >= 22 ? "ok" : "fail",
    `v${process.versions.node} (required >=22)`,
  );
}

{
  const r = probe("npm", ["--version"]);
  record("npm", r.ok ? "ok" : "fail", r.ok ? `v${r.out}` : "not found");
}

{
  const r = probe("git", ["--version"]);
  record("git", r.ok ? "ok" : "fail", r.ok ? r.out.replace(/^git version /, "v") : "not found");
}

// ---- runtime (needed from Phase 2 on) --------------------------------------
{
  const r = probe("opencode", ["--version"]);
  if (r.ok) {
    const m = r.out.match(/(\d+\.\d+\.\d+)/);
    record("opencode", "ok", `v${m?.[1] ?? "?"}`);
  } else {
    record("opencode", "warn", "not found (required for agent runtime phases)");
  }
}

// ---- resources -------------------------------------------------------------
{
  const total = giB(os.totalmem());
  const free = giB(os.freemem());
  let status = "ok";
  if (total < 2 || free < 0.5) status = "fail";
  else if (total < 4 || free < 1) status = "warn";
  record("memory", status, `total ${total} GiB, free ${free} GiB`);
}

{
  try {
    const fs = statfsSync(process.cwd());
    const free = giB(fs.bsize * fs.bavail);
    record("disk", free >= 0.5 ? (free < 2 ? "warn" : "ok") : "fail", `${free} GiB free in ${process.cwd()}`);
  } catch (err) {
    record("disk", "warn", `statfs failed: ${err?.message ?? err}`);
  }
}

// ---- optional tooling (informational) ---------------------------------------
for (const [name, cmd, argv] of [
  ["docker", "docker", ["--version"]],
  ["go", "go", ["version"]],
  ["python", "python3", ["--version"]],
]) {
  const r = probe(cmd, argv);
  record(name, "ok", r.ok ? r.out.split("\n")[0].slice(0, 80) : "not found (optional)");
}

// ---- report -----------------------------------------------------------------
if (asJson) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  const color = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
  const paint = { ok: color("32", "OK"), warn: color("33", "WARN"), fail: color("31", "FAIL") };
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${paint[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  console.log(`\n${results.length} checks: ${color(fails ? "31" : "32", `${fails} failed`)}, ${warns} warned`);
}

process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
