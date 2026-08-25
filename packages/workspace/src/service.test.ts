import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectId } from "@devmesh/contracts";
import {
  WorkspaceService,
  slugifyName,
  type ProjectRecord,
  type ProjectStore,
} from "./service.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-ws-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

class FakeStore implements ProjectStore {
  readonly byId = new Map<ProjectId, ProjectRecord>();
  insert(p: ProjectRecord): void {
    this.byId.set(p.id, p);
  }
  get(id: ProjectId): ProjectRecord | null {
    return this.byId.get(id) ?? null;
  }
  findByName(name: string): ProjectRecord | null {
    for (const p of this.byId.values()) if (p.name === name) return p;
    return null;
  }
  list(): ProjectRecord[] {
    return [...this.byId.values()];
  }
}

const makeService = (lockTimeoutMs?: number) =>
  new WorkspaceService({
    store: new FakeStore(),
    workspacesRoot: join(dataRoot, "workspaces"),
    lockTimeoutMs,
  });

describe("slugifyName", () => {
  it("normalizes and bounds names", () => {
    expect(slugifyName("My Cool App!!")).toBe("my-cool-app");
    expect(slugifyName("  A_B-c ")).toBe("a_b-c");
    expect(() => slugifyName("ab")).toThrow(/at least 3/);
    expect(() => slugifyName("!!!")).toThrow();
  });
});

describe("WorkspaceService registry", () => {
  it("creates a workspace directory and persists the record", () => {
    const ws = makeService().create("Demo App");
    expect(ws.name).toBe("demo-app");
    expect(existsSync(ws.root)).toBe(true);
  });

  it("rejects duplicate names", () => {
    const svc = makeService();
    svc.create("alpha");
    expect(() => svc.create("Alpha")).toThrow(/already registered/);
  });

  it("resolves by id and name; unknown ids raise not-found", () => {
    const svc = makeService();
    const created = svc.create("beta");
    expect(svc.get(created.projectId).root).toBe(created.root);
    expect(svc.getByName("Beta").name).toBe("beta");
    expect(() => svc.getByName("nope")).toThrow(/no project named/);
  });
});

describe("WorkspaceService file IO", () => {
  let svc: WorkspaceService;
  let handle: ReturnType<WorkspaceService["create"]>;

  beforeEach(() => {
    svc = makeService();
    handle = svc.create("io-project");
  });

  it("writes and reads back text and binary", async () => {
    await svc.writeFile(handle, "src/main.ts", "console.log('hi');\n");
    expect(svc.readTextFile(handle, "src/main.ts")).toContain("console.log");

    const bytes = new Uint8Array([0, 1, 2, 255]);
    await svc.writeFile(handle, "data/blob.bin", Buffer.from(bytes));
    expect([...svc.readFile(handle, "data/blob.bin")]).toEqual([...bytes]);
  });

  it("enforces size limits on read and write", async () => {
    await expect(
      svc.writeFile(handle, "big.txt", "x".repeat(64), { maxBytes: 8 }),
    ).rejects.toMatchObject({ code: "workspace/io" });

    writeFileSync(join(handle.root, "fat.txt"), "y".repeat(64));
    expect(() => svc.readFile(handle, "fat.txt", { maxBytes: 8 })).toThrow(
      /read limit/,
    );
  });

  it("refuses path traversal in every entry point", async () => {
    expect(() => svc.resolvePath(handle, "../outside.txt")).toThrow(
      /unsafe relative path/,
    );
    await expect(svc.writeFile(handle, "../../evil.txt", "x")).rejects.toMatchObject({
      code: "workspace/path-unsafe",
    });
    expect(() => svc.readFile(handle, "/etc/passwd")).toThrow();
    expect(() => svc.listFiles(handle, "..")).toThrow();
  });

  it("refuses symlinked files and symlinked directories", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "devmesh-esc-"));
    const secret = join(outsideDir, "secret.txt");
    writeFileSync(secret, "top secret");

    symlinkSync(secret, join(handle.root, "leak.txt"));
    expect(() => svc.readTextFile(handle, "leak.txt")).toThrow(
      /symlink/,
    );
    await expect(svc.writeFile(handle, "leak.txt", "overwrite")).rejects.toMatchObject({
      code: "workspace/symlink-refused",
    });

    mkdirSync(join(outsideDir, "proj"));
    writeFileSync(join(outsideDir, "proj", "f.txt"), "z");
    symlinkSync(join(outsideDir, "proj"), join(handle.root, "linked-dir"));
    expect(() => svc.readTextFile(handle, "linked-dir/f.txt")).toThrow(/symlink/);

    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("lists files recursively, skipping VCS/build dirs", async () => {
    await svc.writeFile(handle, "src/a.ts", "a");
    await svc.writeFile(handle, "docs/b.md", "b");
    await svc.writeFile(handle, ".git/internal-object", "g");
    await svc.writeFile(handle, "node_modules/pkg/index.js", "n");

    const files = svc.listFiles(handle);
    expect(files).toEqual(["docs/b.md", "src/a.ts"]);
  });

  it("removes files", async () => {
    await svc.writeFile(handle, "tmp.txt", "t");
    await svc.removeFile(handle, "tmp.txt");
    expect(() => svc.readFile(handle, "tmp.txt")).toThrow(/no such file/);
  });
});

describe("workspace mutation locking", () => {
  it("serializes concurrent writers through the implicit lock", async () => {
    const svc = makeService(2000);
    const h = svc.create("locked");
    const order: string[] = [];
    const w = (tag: string) =>
      svc.writeFile(h, "state.txt", tag).then(() => void order.push(tag));

    await Promise.all([w("one"), w("two"), w("three")]);
    // all three completed, one after another — final content is the last writer
    expect(order).toHaveLength(3);
    expect(svc.readTextFile(h, "state.txt")).toBe(order[2]);
  });

  it("withMutationLock composes multi-step operations atomically", async () => {
    const svc = makeService(2000);
    const h = svc.create("atomic");
    const seen: number[] = [];
    await Promise.all([
      svc.withMutationLock(h, async () => {
        await svc.writeFile(h, "n.txt", "1");
        seen.push(1);
        await new Promise((r) => setTimeout(r, 15));
        await svc.writeFile(h, "n2.txt", "2");
        seen.push(2);
      }),
      svc.withMutationLock(h, async () => {
        seen.push(3);
      }),
    ]);
    // second block can only run after the first released
    expect(seen[seen.length - 1]).toBe(3);
    expect(seen.indexOf(2)).toBeLessThan(seen.indexOf(3));
  });

  it("times out when another writer holds the lock", async () => {
    const svc = makeService(30);
    const h = svc.create("slow");

    // hold via service so its internal mutex is busy
    const hold = svc.withMutationLock(h, () => new Promise((r) => setTimeout(r, 250)));
    await expect(svc.writeFile(h, "x.txt", "x")).rejects.toMatchObject({
      code: "workspace/locked",
    });
    await hold;
    await svc.writeFile(h, "x.txt", "after");
    expect(svc.readTextFile(h, "x.txt")).toBe("after");
  });
});
