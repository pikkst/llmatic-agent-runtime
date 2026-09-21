import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../src/config.js";
import { detectRepository } from "../src/detect.js";
import { runLocalValidation } from "../src/orchestrator.js";
import {
  WorkflowStateStore,
  startWorkflow,
  transitionWorkflow,
} from "../src/workflow.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llmatic-orchestrator-"));
  temporaryDirectories.push(root);

  await mkdir(join(root, ".git"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.17.1",
      scripts: {
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
    }),
  );

  return root;
}

async function moveToImplementing(store: WorkflowStateStore): Promise<void> {
  await transitionWorkflow(store, "TASK_VALIDATED");
  await transitionWorkflow(store, "REPO_ANALYZED");
  await transitionWorkflow(store, "BRANCH_CREATED");
  await transitionWorkflow(store, "IMPLEMENTING");
}

describe("runLocalValidation", () => {
  it("advances a successful validation run to CODE_REVIEW", async () => {
    const root = await createRepository();
    const detection = await detectRepository(root);
    const config = createDefaultConfig(detection);
    const store = new WorkflowStateStore(root, config);

    await startWorkflow(store, "TASK-100");
    await moveToImplementing(store);

    const runner = vi.fn(() => ({ exitCode: 0 }));
    const report = await runLocalValidation(root, config, store, { runner });

    expect(report.success).toBe(true);
    expect(report.finishedState).toBe("CODE_REVIEW");
    expect(report.results.map((result) => result.capability)).toEqual([
      "typecheck",
      "test",
    ]);

    const current = await store.loadCurrent();
    expect(current?.state).toBe("CODE_REVIEW");
    expect(
      current?.checkpoints.filter((checkpoint) => checkpoint.kind === "CAPABILITY_RUN"),
    ).toHaveLength(2);
  });

  it("moves to FIXING after the first failing required gate", async () => {
    const root = await createRepository();
    const detection = await detectRepository(root);
    const config = createDefaultConfig(detection);
    const store = new WorkflowStateStore(root, config);

    await startWorkflow(store, "TASK-101");
    await moveToImplementing(store);

    const runner = vi.fn((_executable: string, args: string[]) => ({
      exitCode: args.at(-1) === "test" ? 1 : 0,
    }));

    const report = await runLocalValidation(root, config, store, { runner });

    expect(report.success).toBe(false);
    expect(report.finishedState).toBe("FIXING");
    expect(report.results).toHaveLength(2);
    expect(report.results.at(-1)?.capability).toBe("test");

    const current = await store.loadCurrent();
    expect(current?.state).toBe("FIXING");
  });

  it("rejects validation from a state that cannot enter local validation", async () => {
    const root = await createRepository();
    const detection = await detectRepository(root);
    const config = createDefaultConfig(detection);
    const store = new WorkflowStateStore(root, config);

    await startWorkflow(store, "TASK-102");

    await expect(runLocalValidation(root, config, store)).rejects.toThrow(
      "Local validation requires workflow state",
    );
  });
});
