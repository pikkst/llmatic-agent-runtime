import { describe, expect, it } from "vitest";
import { recommendWorkspaceAction, type RepositoryMapSummary } from "../src/index.js";
import type { GitStatus } from "@llmatic/git-adapter";
import type { PullRequestStatus } from "@llmatic/github-adapter";
import type { TaskRecord } from "@llmatic/task-provider";
import type { WorkflowRun } from "@llmatic/core";

const repository: RepositoryMapSummary = {
  generatedAt: "2026-09-22T00:00:00.000Z",
  fileCount: 120,
  sourceFileCount: 80,
  symbolCount: 400,
  importCount: 210,
};

const cleanGit: GitStatus = {
  branch: "main",
  detached: false,
  clean: true,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
};

function task(key: string, lifecycle: TaskRecord["status"]["lifecycle"]): TaskRecord {
  return {
    provider: "markdown",
    id: key,
    key,
    summary: "Task " + key,
    status: {
      id: lifecycle,
      name: lifecycle,
      lifecycle,
    },
    labels: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    dependencies: [],
    source: { type: "markdown" },
  };
}

function pr(ciState: PullRequestStatus["ciState"]): PullRequestStatus {
  return {
    pullRequest: {
      number: 42,
      url: "https://example.test/pr/42",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefName: "feature/KT-42",
      headRefOid: "a".repeat(40),
      baseRefName: "main",
    },
    checks: [],
    ciState,
  };
}

const workflow: WorkflowRun = {
  version: 1,
  runId: "00000000-0000-4000-8000-000000000001",
  taskRef: "KT-42",
  state: "REMOTE_CI",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
  checkpoints: [],
};

describe("workspace recovery recommendation", () => {
  it("prioritizes failing PR recovery for an active workflow", () => {
    const result = recommendWorkspaceAction({
      repository,
      git: cleanGit,
      workflow,
      pullRequest: pr("failing"),
      task: task("KT-42", "in_progress"),
    });

    expect(result.action).toBe("fix_pr");
    expect(result.detail).toContain("PR #42");
  });

  it("continues dirty working-tree work before selecting a new task", () => {
    const result = recommendWorkspaceAction({
      repository,
      git: {
        ...cleanGit,
        branch: "feature/KT-43",
        clean: false,
        unstagedCount: 2,
      },
      nextTask: task("KT-44", "todo"),
    });

    expect(result.action).toBe("continue_changes");
  });

  it("continues an active task before proposing the next task", () => {
    const result = recommendWorkspaceAction({
      repository,
      git: cleanGit,
      task: task("KT-45", "in_progress"),
      nextTask: task("KT-46", "todo"),
    });

    expect(result.action).toBe("continue_task");
  });

  it("proposes the next task when no work is active", () => {
    const result = recommendWorkspaceAction({
      repository,
      git: cleanGit,
      nextTask: task("KT-46", "todo"),
    });

    expect(result.action).toBe("start_task");
  });

  it("sends an empty repository to discovery", () => {
    const result = recommendWorkspaceAction({
      repository: {
        ...repository,
        fileCount: 0,
        sourceFileCount: 0,
        symbolCount: 0,
        importCount: 0,
      },
      git: cleanGit,
    });

    expect(result.action).toBe("start_discovery");
  });
});
