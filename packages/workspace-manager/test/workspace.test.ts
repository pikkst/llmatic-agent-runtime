import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentConfig } from "@llmatic/core";
import {
  ensureLlmaticGitExclude,
  initializePrivateWorkspace,
  readGlobalKiloMcpStatus,
  registerGlobalKiloMcp,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function gitRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llmatic-workspace-"));
  temporaryDirectories.push(root);
  const result = spawnSync("git", ["init"], { cwd: root, encoding: "utf8", shell: false });

  if (result.status !== 0) {
    throw new Error("git init failed in workspace-manager test.");
  }

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.17.1",
      scripts: { test: "vitest run", build: "tsc -b" },
      devDependencies: { typescript: "^5.7.2", vitest: "^2.1.8" },
    }),
  );

  return root;
}

describe("private workspace manager", () => {
  it("stores runtime config/state/cache outside the repository and loads it through workspace home", async () => {
    const root = await gitRepository();
    const storage = await mkdtemp(join(tmpdir(), "llmatic-global-storage-"));
    temporaryDirectories.push(storage);

    const workspace = await initializePrivateWorkspace(root, storage);
    const config = await loadAgentConfig(root, { LLMATIC_WORKSPACE_HOME: storage });

    expect(workspace.paths.configPath.startsWith(storage)).toBe(true);
    expect(config.runtime.stateDirectory.startsWith(storage)).toBe(true);
    expect(config.runtime.cacheDirectory.startsWith(storage)).toBe(true);

    await expect(readFile(join(root, "llmatic.agent.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("adds local LLMatic patterns to .git/info/exclude without touching .gitignore", async () => {
    const root = await gitRepository();
    await writeFile(join(root, ".gitignore"), "node_modules/\n");

    const result = await ensureLlmaticGitExclude(root);
    const exclude = await readFile(result.path!, "utf8");
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");

    expect(result.supported).toBe(true);
    expect(exclude).toContain(".llmatic/");
    expect(exclude).toContain("llmatic.agent.local.yaml");
    expect(gitignore).toBe("node_modules/\n");
  });

  it("upserts a global Kilo MCP entry while preserving existing JSONC content", async () => {
    const home = await mkdtemp(join(tmpdir(), "llmatic-kilo-"));
    temporaryDirectories.push(home);
    const configPath = join(home, "kilo.jsonc");
    await mkdir(home, { recursive: true });
    await writeFile(
      configPath,
      '// keep me\n{\n  "mcp": { "other": { "enabled": true } }\n}\n',
    );

    const storage = join(home, "llmatic-storage");
    const server = join(home, "llmatic-mcp.mjs");
    await registerGlobalKiloMcp(server, storage, { configPath, nodeCommand: "node" });

    const raw = await readFile(configPath, "utf8");
    const status = await readGlobalKiloMcpStatus({ configPath });

    expect(raw).toContain("// keep me");
    expect(raw).toContain('"other"');
    expect(status).toMatchObject({
      configured: true,
      enabled: true,
      command: ["node", server],
      workspaceHome: storage,
    });
  });
});
