import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowStateStore,
  createDefaultConfig,
  type RepositoryDetection,
} from "@llmatic/core";
import {
  selectWorkflowTask,
  syncWorkflowTask,
  validateWorkflowTask,
  type TaskProvider,
  type TaskRecord,
  type TaskTransition,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function config(root: string) {
  const detection: RepositoryDetection = {
    root,
    git: true,
    packageJson: false,
    packageManager: "unknown",
    technologies: [],
    capabilities: [],
  };

  return createDefaultConfig(detection);
}

class FakeProvider implements TaskProvider {
  public readonly id = "fake";
  public comments: string[] = [];
  public transitions: string[] = [];

  public async getTask(reference: string): Promise<TaskRecord> {
    return {
      provider: this.id,
      id: reference,
      key: reference,
      summary: "Provider-neutral task",
      status: {
        id: "todo",
        name: "Todo",
        lifecycle: "todo",
      },
      labels: [],
      acceptanceCriteria: ["workflow starts"],
      definitionOfDone: ["workflow validates"],
      dependencies: [],
      source: {
        type: this.id,
      },
    };
  }

  public async listTransitions(): Promise<TaskTransition[]> {
    return [{ id: "complete", name: "Complete", toStatus: "Done" }];
  }

  public async addComment(_reference: string, text: string): Promise<void> {
    this.comments.push(text);
  }

  public async transitionTask(
    _reference: string,
    transition: string,
  ): Promise<TaskTransition> {
    this.transitions.push(transition);
    return {
      id: transition,
      name: transition === "complete" ? "Complete" : transition,
      toStatus: transition === "complete" ? "Done" : undefined,
    };
  }
}

describe("provider-neutral workflow helpers", () => {
  it("selects, validates and syncs through one generic provider contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-task-workflow-"));
    roots.push(root);

    const runtime = config(root);
    runtime.permissions.taskWrite = "auto";
    const store = new WorkflowStateStore(root, runtime);
    const provider = new FakeProvider();

    const selected = await selectWorkflowTask(store, provider, "TASK-42");
    expect(selected.workflow.state).toBe("TASK_SELECTED");
    expect(
      selected.workflow.checkpoints.some(
        (checkpoint) =>
          checkpoint.kind === "ACTION" &&
          checkpoint.provider === "fake" &&
          checkpoint.action === "task.select",
      ),
    ).toBe(true);

    const validated = await validateWorkflowTask(store, provider);
    expect(validated.workflow.state).toBe("TASK_VALIDATED");

    const synced = await syncWorkflowTask(store, provider, {
      comment: "PR #42 passed",
      transition: "complete",
    });

    expect(synced.commentAdded).toBe(true);
    expect(synced.transition?.name).toBe("Complete");
    expect(provider.comments).toEqual(["PR #42 passed"]);
    expect(provider.transitions).toEqual(["complete"]);
  });
});
