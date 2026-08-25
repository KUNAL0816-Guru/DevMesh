import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Mirror the tsconfig.base paths so tests resolve sibling packages from
// TypeScript sources — no build required before running tests.
const pkgRoot = (name: string) => resolve(__dirname, "packages", name, "src", "index.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@devmesh/contracts": pkgRoot("contracts"),
      "@devmesh/agents": pkgRoot("agents"),
      "@devmesh/storage": pkgRoot("storage"),
      "@devmesh/workspace": pkgRoot("workspace"),
      "@devmesh/runtime": pkgRoot("runtime"),
      "@devmesh/opencode-adapter": pkgRoot("opencode-adapter"),
      "@devmesh/server": pkgRoot("server"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    reporters: ["default"],
    // proot/aarch64 cold starts (first Fastify/pino init, git spawns) can
    // approach several seconds — keep a generous per-test budget.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
