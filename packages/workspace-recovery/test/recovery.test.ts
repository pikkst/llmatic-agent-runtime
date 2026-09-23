import { describe, expect, it } from "vitest";
import {
  recommendWorkspaceAction,
  selectRecoveryPullRequest,
  type RepositoryMapSummary,
} from "../src/index.js";
import type { GitStatus, PublishedBranchStatus } from "@llmatic/git-adapter";
import type { OpenPullRequestSummary, PullRequestStatus } from "@llmatic/github-adapter";
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

function openPr(
  number: number,
  headRefName: string,
  isDraft = false,
): OpenPullRequestSummary {
  return {
    number,
    url: "https://github.com/example/repo/pull/" + String(number),
    state: "OPEN",
    isDraft,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefName,
    headRefOid: String(number).padStart(40, "0"),
    baseRefName: "main",
    title: "PR " + String(number),
    authorLogin: "contributor",
  };
}

function pushedBranch(
  branch = "feature/KT-115-duplicate-move-proposal-variant",
): PublishedBranchStatus {
  return {
    branch,
    upstream: "origin/" + branch,
    commitSha: "b".repeat(40),
    committedAt: "2026-09-23T18:00:00+00:00",
    aheadOfDefault: 2,
    behindDefault: 0,
    aheadOfUpstream: 0,
    behindUpstream: 0,
    fullyPushed: true,
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

describe("repository pull-request recovery selection", () => {
  it("prefers the open pull request whose head matches the current local branch", () => {
    const selected = selectRecoveryPullRequest(
      [
        openPr(41, "feature/KT-41"),
        openPr(42, "feature/KT-42", true),
      ],
      "feature/KT-42",
    );

    expect(selected?.number).toBe(42);
    expect(selected?.isDraft).toBe(true);
  });

  it("recovers the only repository open pull request even while local branch is main", () => {
    const selected = selectRecoveryPullRequest([openPr(42, "feature/KT-42", true)], "main");

    expect(selected?.number).toBe(42);
  });

  it("does not guess when several repository pull requests are open and none matches the branch", () => {
    const selected = selectRecoveryPullRequest(
      [openPr(41, "feature/KT-41"), openPr(42, "feature/KT-42")],
      "main",
    );

    expect(selected).toBeUndefined();
  });
});

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

  it("recommends creating a pull request for one fully pushed unmerged branch", () => {
    const result = recommendWorkspaceAction({
      repository,
      git: cleanGit,
      pendingPullRequestBranches: [pushedBranch()],
    });

    expect(result.action).toBe("create_pr");
    expect(result.title).toBe("Create a pull request for the pushed branch");
    expect(result.detail).toContain("feature/KT-115-duplicate-move-proposal-variant");
    expect(result.detail).toContain("no open pull request exists");
  });

  it("does not guess when multiple pushed branches have no pull request", () => {
    const result = recommendWorkspaceAction({
      repository,
      git: cleanGit,
      pendingPullRequestBranches: [
        pushedBranch("feature/KT-114"),
        pushedBranch("feature/KT-115"),
      ],
    });

    expect(result.action).toBe("ask_goal");
    expect(result.title).toBe("Choose a pushed branch to open as a pull request");
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

  it("surfaces ambiguous repository PR state instead of claiming there is no open PR", () => {
    const result = recommendWorkspaceAction({
      repository,
      git: cleanGit,
      openPullRequests: [openPr(41, "feature/KT-41"), openPr(42, "feature/KT-42", true)],
    });

    expect(result.action).toBe("ask_goal");
    expect(result.title).toBe("Choose an open pull request");
    expect(result.detail).toContain("2 open pull request(s)");
    expect(result.detail).toContain("1 draft");
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
