import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowStateStore,
  createDefaultConfig,
  startWorkflow,
  type RepositoryDetection,
} from "@llmatic/core";
import {
  inspectRuntimeTools,
  parseRuntimeToolOperation,
  runRuntimeToolOperation,
} from "../src/runtime.js";
import type { RuntimeToolProcessRunner } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function configFor(root: string) {
  const detection: RepositoryDetection = {
    root,
    git: true,
    packageJson: true,
    packageManager: "pnpm",
    technologies: [],
    capabilities: [],
  };
  return createDefaultConfig(detection);
}

describe("runtime tool packs", () => {
  it("detects Docker, Supabase, uv/Python, and Ollama through structured probes", async () => {
    const runner: RuntimeToolProcessRunner = (executable, args) => {
      if (executable === "docker") return { exitCode: 0, stdout: "Docker 29\n", stderr: "" };
      if (executable === "supabase") return { exitCode: 0, stdout: "2.50.0\n", stderr: "" };
      if (executable === "uv") return { exitCode: 0, stdout: "uv 0.9.0\n", stderr: "" };
      if (executable === "ollama") return { exitCode: 0, stdout: "ollama 0.12\n", stderr: "" };
      return { exitCode: 127, stdout: "", stderr: args.join(" ") };
    };

    const result = await inspectRuntimeTools("/repo", runner);

    expect(result).toEqual([
      expect.objectContaining({ pack: "docker", available: true, executable: "docker" }),
      expect.objectContaining({ pack: "supabase", available: true, executable: "supabase" }),
      expect.objectContaining({ pack: "python", available: true, executable: "uv" }),
      expect.objectContaining({ pack: "ollama", available: true, executable: "ollama" }),
    ]);
  });

  it("keeps Docker status read-only but approval-gates Docker mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-runtime-"));
    temporaryDirectories.push(root);
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    const calls: string[][] = [];

    const runner: RuntimeToolProcessRunner = (_executable, args) => {
      calls.push(args);
      if (args[0] === "--version") return { exitCode: 0, stdout: "Docker 29\n", stderr: "" };
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    };

    const status = await runRuntimeToolOperation(
      root,
      config,
      store,
      { pack: "docker", operation: "status" },
      { runner },
    );
    expect(status.success).toBe(true);
    expect(calls.at(-1)).toEqual(["compose", "ps", "--all"]);

    await expect(
      runRuntimeToolOperation(
        root,
        config,
        store,
        { pack: "docker", operation: "up" },
        { runner },
      ),
    ).rejects.toThrow("requires approval");
  });

  it("forces Supabase db reset to local and redacts status secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-runtime-"));
    temporaryDirectories.push(root);
    const config = configFor(root);
    config.permissions.databaseMigration = "auto";
    const store = new WorkflowStateStore(root, config);
    const calls: string[][] = [];

    const runner: RuntimeToolProcessRunner = (_executable, args) => {
      calls.push(args);
      if (args[0] === "--version") return { exitCode: 0, stdout: "2.50.0\n", stderr: "" };
      if (args[0] === "status") {
        return {
          exitCode: 0,
          stdout:
            "API URL: http://127.0.0.1:54321\nDB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres\nservice_role key: secret-value\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "reset\n", stderr: "" };
    };

    const status = await runRuntimeToolOperation(
      root,
      config,
      store,
      { pack: "supabase", operation: "status" },
      { runner },
    );
    expect(status.stdout).toContain("postgres:[REDACTED]@127.0.0.1");
    expect(status.stdout).toContain("service_role key: [REDACTED]");

    await runRuntimeToolOperation(
      root,
      config,
      store,
      { pack: "supabase", operation: "db-reset-local" },
      { runner },
    );
    expect(calls.at(-1)).toEqual(["db", "reset", "--local"]);
  });

  it("runs only repository-contained Python scripts and prefers uv when available", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-runtime-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts", "check.py"), "print('ok')\n");

    const config = configFor(root);
    config.permissions.localProcess = "auto";
    const store = new WorkflowStateStore(root, config);
    const calls: Array<{ executable: string; args: string[] }> = [];

    const runner: RuntimeToolProcessRunner = (executable, args) => {
      calls.push({ executable, args });
      if (executable === "uv" && args[0] === "--version") {
        return { exitCode: 0, stdout: "uv 0.9.0\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    };

    const result = await runRuntimeToolOperation(
      root,
      config,
      store,
      {
        pack: "python",
        operation: "run-script",
        script: "scripts/check.py",
        args: ["--fast"],
      },
      { runner },
    );

    expect(result.success).toBe(true);
    expect(calls.at(-1)).toEqual({
      executable: "uv",
      args: ["run", "--", "scripts/check.py", "--fast"],
    });

    await expect(
      runRuntimeToolOperation(
        root,
        config,
        store,
        {
          pack: "python",
          operation: "run-script",
          script: "../escape.py",
          args: [],
        },
        { runner },
      ),
    ).rejects.toThrow("inside the repository");
  });

  it("keeps Ollama list read-only and approval-gates model execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-runtime-"));
    temporaryDirectories.push(root);
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);

    const runner: RuntimeToolProcessRunner = (_executable, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "ollama 0.12\n", stderr: "" };
      return { exitCode: 0, stdout: "model output\n", stderr: "" };
    };

    const listed = await runRuntimeToolOperation(
      root,
      config,
      store,
      { pack: "ollama", operation: "list" },
      { runner },
    );
    expect(listed.success).toBe(true);

    await expect(
      runRuntimeToolOperation(
        root,
        config,
        store,
        { pack: "ollama", operation: "run", model: "qwen3:8b", prompt: "hello" },
        { runner },
      ),
    ).rejects.toThrow("requires approval");
  });

  it("records runtime operations as workflow ACTION checkpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-runtime-"));
    temporaryDirectories.push(root);
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-600");

    const runner: RuntimeToolProcessRunner = (_executable, args) =>
      args[0] === "--version"
        ? { exitCode: 0, stdout: "Docker 29\n", stderr: "" }
        : { exitCode: 0, stdout: "running\n", stderr: "" };

    await runRuntimeToolOperation(
      root,
      config,
      store,
      { pack: "docker", operation: "status" },
      { runner },
    );

    expect(
      (await store.loadCurrent())?.checkpoints.find(
        (checkpoint) =>
          checkpoint.kind === "ACTION" &&
          checkpoint.provider === "runtime-tools" &&
          checkpoint.action === "docker.status",
      ),
    ).toMatchObject({ success: true });
  });

  it("parses only whitelisted operations", () => {
    expect(parseRuntimeToolOperation("supabase", "db-reset-local")).toEqual({
      pack: "supabase",
      operation: "db-reset-local",
    });
    expect(() => parseRuntimeToolOperation("supabase", "db-push")).toThrow(
      "must be status, start, stop, or db-reset-local",
    );
  });
});
