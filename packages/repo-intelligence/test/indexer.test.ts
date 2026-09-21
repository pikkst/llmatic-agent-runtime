import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowStateStore,
  createDefaultConfig,
  startWorkflow,
  transitionWorkflow,
  type RepositoryDetection,
} from "@llmatic/core";
import {
  analyzeWorkflowRepository,
  buildRepositoryIndex,
  searchRepositoryIndex,
} from "../src/indexer.js";

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
    technologies: ["TypeScript"],
    capabilities: [],
  };

  return createDefaultConfig(detection);
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llmatic-index-"));
  temporaryDirectories.push(root);

  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });

  await writeFile(
    join(root, "src", "service.ts"),
    [
      'import type { AgentConfig } from "@llmatic/core";',
      'export interface ServiceOptions { enabled: boolean }',
      'export class ExampleService {',
      '  public run(): string { return "ok"; }',
      '}',
      'export function createService(config: AgentConfig): ExampleService {',
      '  void config;',
      '  return new ExampleService();',
      '}',
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "README.md"), "# Fixture\n");
  await writeFile(join(root, "node_modules", "ignored", "index.ts"), "export const ignored = true;\n");

  return root;
}

describe("repository intelligence", () => {
  it("indexes files, AST symbols, imports, and ignores generated/dependency directories", async () => {
    const root = await createRepository();
    const config = configFor(root);

    const index = await buildRepositoryIndex(root, config);

    expect(index.files.map((file) => file.path)).toEqual(["README.md", "src/service.ts"]);
    expect(index.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "ServiceOptions", kind: "interface" }),
        expect.objectContaining({ name: "ExampleService", kind: "class" }),
        expect.objectContaining({
          name: "run",
          kind: "method",
          container: "ExampleService",
        }),
        expect.objectContaining({ name: "createService", kind: "function" }),
      ]),
    );
    expect(index.imports).toContainEqual({
      path: "src/service.ts",
      specifier: "@llmatic/core",
      names: ["AgentConfig"],
      typeOnly: true,
    });
  });

  it("searches symbols before lower-scoring file and import matches", async () => {
    const root = await createRepository();
    const config = configFor(root);
    const index = await buildRepositoryIndex(root, config);

    const hits = searchRepositoryIndex(index, "ExampleService");

    expect(hits[0]).toMatchObject({
      kind: "symbol",
      label: "class ExampleService",
      path: "src/service.ts",
    });
  });

  it("advances TASK_VALIDATED to REPO_ANALYZED only after a successful index build", async () => {
    const root = await createRepository();
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);

    await startWorkflow(store, "TASK-300");
    await transitionWorkflow(store, "TASK_VALIDATED");

    const result = await analyzeWorkflowRepository(root, config, store);

    expect(result.workflow.state).toBe("REPO_ANALYZED");
    expect(
      result.workflow.checkpoints.find(
        (checkpoint) =>
          checkpoint.kind === "ACTION" &&
          checkpoint.provider === "repo-intelligence" &&
          checkpoint.action === "index.build",
      ),
    ).toMatchObject({ success: true });
  });

  it("enforces repositoryRead ask permission", async () => {
    const root = await createRepository();
    const config = configFor(root);
    config.permissions.repositoryRead = "ask";

    await expect(buildRepositoryIndex(root, config)).rejects.toThrow("requires approval");
  });
});
