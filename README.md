# DevMesh

Multi-agent AI software engineering platform. Describe a software project;
specialized agents collaborate to build it inside a git workspace.

- Control plane + orchestration: DevMesh Core (this monorepo)
- Initial agent runtime: [OpenCode](https://opencode.ai) behind a swappable port
- Source of truth: the git workspace
- Agent communication: typed structured artifacts (zod-validated)

See [docs/adr/0001-approved-architecture.md](docs/adr/0001-approved-architecture.md)
for the approved architecture and its amendments.

## Status — Phase 0 (scaffolding + core contracts)

| Done | Item |
|------|------|
| x | Monorepo scaffold (npm workspaces, TS strict, eslint flat config, vitest) |
| x | `@devmesh/contracts`: schemas for ids, roles, permissions, manifests, task state machine, artifacts, domain events, context entries, prompts |
|   | Phase 1: server skeleton, storage, workspace/git service |
|   | Phase 2: runtime-opencode adapter |
|   | Phase 3: orchestrator MVP |

## Layout

```
packages/
  contracts/    shared zod schemas + types (wire-format law)
agents/         runtime-neutral agent manifests        (later phases)
integrations/   opencode plugin shipped into projects (later phases)
mcp/            devmesh MCP server                    (later phases)
scripts/doctor.mjs  environment probe
```

## Requirements

Node >= 22, npm, git. Optional from Phase 2: `opencode` CLI.

## Commands

```
npm ci            # install
npm run doctor    # probe environment (node/git/opencode/memory/disk)
npm run check     # typecheck + lint + tests
npm run build     # compile workspaces
npm test          # vitest
```
