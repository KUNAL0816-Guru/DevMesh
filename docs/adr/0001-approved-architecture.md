# ADR-0001: Approved Architecture and Phase 0 Scope

- Status: accepted
- Date: 2026-08-24
- Deciders: project owner (approver), ox-alpha (author)

## Context

DevMesh is a multi-agent AI software engineering platform. The user describes a
software project; specialized agents collaborate to build it inside a git
workspace. OpenCode 1.18.x is the initial coding/agent runtime. The development
environment is Android Termux running Ubuntu via proot-distro (aarch64,
~5.5 GiB RAM, no Docker).

An architecture proposal was reviewed and approved with amendments.

## Decision

Approved architecture, summarized:

1. **Hexagonal modular monolith.** One Node process initially; module
   boundaries (`packages/*`) are enforced so services can split later.
2. **OpenCode strictly behind one adapter/port.** All OpenCode knowledge is
   confined to `packages/runtime-opencode` (+ shipped plugin + MCP server).
   Core depends only on the `AgentRuntime` port defined against contracts.
3. **Git and the workspace are the source of truth.** The context store holds
   derived facts; the filesystem holds reality. Checkpoints are git commits.
4. **Hub-and-spoke orchestration.** Agents never call each other directly;
   the orchestrator routes typed artifacts between them over the domain event
   bus. Task DAG persisted in SQLite; runs resumable.
5. **Typed structured artifacts** for all agent-to-agent communication:
   `spec.v1`, `plan.v1`, `change_set.v1`, `test_report.v1`, `review.v1`,
   `verification.v1` — schema-validated (zod), versioned envelopes.

## Approved amendments

1. OpenCode strictly behind a single adapter/port.
2. Git and workspace are the source of truth.
3. Initial agent set is exactly four roles: architect, developer, tester,
   reviewer. Remaining roles (planner, debugger, documenter, devops) join in
   later phases; `PLANNED_AGENT_ROLES` in contracts documents intent without
   enabling them on the wire.
4. Agent-to-agent communication must use typed structured artifacts only.
5. Every claimed filesystem change or test result must be independently
   verified by DevMesh before acceptance:
   - file claims carry sha-256 + size; DevMesh re-hashes the workspace;
   - test reports reference an exact invocation; DevMesh replays it;
   - results recorded as system-produced `verification.v1` artifacts;
   - unverifiable claims fail the task, not silently pass.
6. Core stays provider-independent: model preferences travel as neutral
   `provider/model-id` strings; execution providers belong to the runtime;
   DevMesh's own LLM calls go through the ProviderGateway port.
7. No frontend implementation yet (Phase 0-2 are API-first).
8. Phase 0 is limited to repository scaffolding and core contracts.
9. Ollama/local-model support is deferred; the OpenAI-compatible adapter shape
   keeps the door open without shipping it now.

## Consequences

- Contracts package is wire-format law: zod schemas, branded ids, task state
  machine, event catalog. Breaking changes bump artifact/event versions.
- Runtime swap feasibility is proven by contract tests, not by hope.
- Resource ceilings of the device (RAM, thermals) shape orchestration defaults
  (bounded concurrency, budget enforcement, resumable runs).
