import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config.js";
import type { RepositoryDetection } from "../src/types.js";
import {
  WorkflowStateStore,
  recordCapabilityCheckpoint,
  startWorkflow,
  transitionWorkflow,
} from "../src/workflow.js";

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

describe("WorkflowStateStore", () => {
  it("persists a workflow and valid state transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-workflow-"));
    temporaryDirectories.push(root);

    const store = new WorkflowStateStore(root, configFor(root));
    const started = await startWorkflow(store, "KT-100");

    expect(started.state).toBe("TASK_SELECTED");

    const validated = await transitionWorkflow(store, "TASK_VALIDATED");
    expect(validated.state).toBe("TASK_VALIDATED");

    const loaded = await store.loadCurrent();
    expect(loaded?.runId).toBe(started.runId);
    expect(loaded?.checkpoints).toHaveLength(2);
  });

  it("rejects invalid state transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-workflow-"));
    temporaryDirectories.push(root);

    const store = new WorkflowStateStore(root, configFor(root));
    await startWorkflow(store, "TASK-1");

    await expect(transitionWorkflow(store, "READY_TO_MERGE")).rejects.toThrow(
      "Invalid workflow transition",
    );
  });

  it("records capability results as checkpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-workflow-"));
    temporaryDirectories.push(root);

    const store = new WorkflowStateStore(root, configFor(root));
    await startWorkflow(store, "TASK-2");

    await recordCapabilityCheckpoint(store, {
      capability: "test",
      command: "pnpm run test",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 12,
      exitCode: 0,
      success: true,
    });

    const loaded = await store.loadCurrent();
    expect(loaded?.checkpoints.at(-1)).toMatchObject({
      kind: "CAPABILITY_RUN",
      capability: "test",
      success: true,
    });
  });
});
