import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStateStore, createDefaultConfig, type RepositoryDetection } from "@llmatic/core";
import type { TaskProvider, TaskRecord, TaskTransition } from "@llmatic/task-provider";
import {
  detectTaskSources,
  resolveTaskProvider,
  resolveTaskReferenceFromProviders,
  startTaskWorkflow,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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


class FakeTaskProvider implements TaskProvider {
  public constructor(
    public readonly id: string,
    private readonly task?: TaskRecord,
    private readonly error?: Error,
  ) {}

  public async getTask(): Promise<TaskRecord> {
    if (this.error) throw this.error;
    if (!this.task) throw new Error("Task was not found.");
    return this.task;
  }

  public async listTransitions(): Promise<TaskTransition[]> {
    return [];
  }

  public async addComment(): Promise<void> {}

  public async transitionTask(): Promise<TaskTransition> {
    throw new Error("Not implemented.");
  }
}

function fakeTask(provider: string, key: string, summary: string): TaskRecord {
  return {
    provider,
    id: key,
    key,
    summary,
    status: {
      id: "todo",
      name: "Todo",
      lifecycle: "todo",
    },
    labels: [],
    acceptanceCriteria: ["Acceptance for " + key],
    definitionOfDone: ["DoD for " + key],
    dependencies: [],
    source: {
      type: provider,
    },
  };
}

describe("task router", () => {
  it("resolves one explicit task match across available providers", async () => {
    const result = await resolveTaskReferenceFromProviders("KT-123", [
      new FakeTaskProvider("markdown", undefined, new Error("Task KT-123 was not found.")),
      new FakeTaskProvider("jira", fakeTask("jira", "KT-123", "Jira task")),
    ]);

    expect(result).toMatchObject({
      status: "resolved",
      reference: "KT-123",
      attemptedProviders: ["markdown", "jira"],
      match: {
        provider: "jira",
        task: {
          key: "KT-123",
          summary: "Jira task",
        },
      },
    });
  });

  it("fails closed when the same explicit task reference resolves in multiple providers", async () => {
    const result = await resolveTaskReferenceFromProviders("KT-123", [
      new FakeTaskProvider("markdown", fakeTask("markdown", "KT-123", "Local task")),
      new FakeTaskProvider("jira", fakeTask("jira", "KT-123", "Remote task")),
    ]);

    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("Expected ambiguous result.");
    expect(result.matches.map((match) => match.provider)).toEqual(["markdown", "jira"]);
  });

  it("fails closed when an available provider cannot be checked", async () => {
    const result = await resolveTaskReferenceFromProviders("KT-123", [
      new FakeTaskProvider("markdown", fakeTask("markdown", "KT-123", "Local task")),
      new FakeTaskProvider("jira", undefined, new Error("Jira request failed with 503")),
    ]);

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("Expected unavailable result.");
    expect(result.matches).toHaveLength(1);
    expect(result.failures).toEqual([
      {
        provider: "jira",
        reason: "Jira request failed with 503",
      },
    ]);
  });

  it("returns not_found only when every provider was checked successfully", async () => {
    const result = await resolveTaskReferenceFromProviders("KT-404", [
      new FakeTaskProvider("markdown", undefined, new Error("Task KT-404 was not found.")),
      new FakeTaskProvider("jira", undefined, new Error("Jira request failed with 404")),
    ]);

    expect(result).toEqual({
      status: "not_found",
      reference: "KT-404",
      attemptedProviders: ["markdown", "jira"],
    });
  });


  it("prefers local Markdown tasks over configured Jira", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-router-"));
    roots.push(root);
    await writeFile(join(root, "TASKS.md"), "## TASK-001 — Local\n\nStatus: Todo\n", "utf8");

    const detection = await detectTaskSources(root, {
      LLMATIC_JIRA_BASE_URL: "https://example.atlassian.net",
      LLMATIC_JIRA_EMAIL: "dev@example.test",
      LLMATIC_JIRA_API_TOKEN: "token",
    });

    expect(detection.selected).toBe("markdown");
  });

  it("honors an explicit Jira task-source preference even when TASKS.md exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-router-"));
    roots.push(root);
    await writeFile(join(root, "TASKS.md"), "## TASK-001 — Local\n\nStatus: Todo\n", "utf8");

    const detection = await detectTaskSources(root, {
      LLMATIC_TASK_PROVIDER: "jira",
      LLMATIC_JIRA_BASE_URL: "https://example.atlassian.net",
      LLMATIC_JIRA_EMAIL: "dev@example.test",
      LLMATIC_JIRA_API_TOKEN: "token",
    });

    expect(detection.selected).toBe("jira");
  });

  it("uses Jira when no Markdown source exists and Jira is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-router-"));
    roots.push(root);

    const detection = await detectTaskSources(root, {
      LLMATIC_JIRA_BASE_URL: "https://example.atlassian.net",
      LLMATIC_JIRA_BEARER_TOKEN: "token",
    });

    expect(detection.selected).toBe("jira");
  });

  it("starts and validates the provider-ranked next task as a local workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-router-"));
    roots.push(root);
    await writeFile(
      join(root, "TASKS.md"),
      [
        "## TASK-001 — First",
        "",
        "Status: Done",
        "",
        "## TASK-002 — Second",
        "",
        "Status: Todo",
        "",
        "### Dependencies",
        "- TASK-001",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtimeConfig = config(root);
    const store = new WorkflowStateStore(root, runtimeConfig);
    const result = await startTaskWorkflow(root, runtimeConfig, store, {
      provider: "markdown",
      environment: {},
    });

    expect(result.task.key).toBe("TASK-002");
    expect(result.workflow.state).toBe("TASK_VALIDATED");
    expect(
      result.workflow.checkpoints.find(
        (checkpoint) => checkpoint.kind === "ACTION" && checkpoint.action === "task.select",
      ),
    ).toMatchObject({
      provider: "markdown",
      success: true,
    });
  });

  it("falls back to manual when no source is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-router-"));
    roots.push(root);

    const detection = await detectTaskSources(root, {});
    expect(detection.selected).toBe("manual");

    const provider = await resolveTaskProvider(root, config(root), "auto", {});
    expect(provider.id).toBe("manual");
    expect((await provider.getTask("LOCAL-1")).key).toBe("LOCAL-1");
  });
});
