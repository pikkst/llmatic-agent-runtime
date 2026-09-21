import { mkdtemp, rm } from "node:fs/promises";
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
  commitStagedChanges,
  createBranch,
  createWorkflowBranch,
  getGitStatus,
  pushCurrentBranch,
  pushWorkflowBranch,
} from "../src/git.js";
import type { GitProcessRunner } from "../src/types.js";

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

describe("git adapter", () => {
  it("parses structured repository status", async () => {
    const runner: GitProcessRunner = (_executable, args) => {
      if (args[0] === "branch") {
        return { exitCode: 0, stdout: "feature/test\n", stderr: "" };
      }

      return {
        exitCode: 0,
        stdout: "M  staged.ts\n M unstaged.ts\n?? new.ts\n",
        stderr: "",
      };
    };

    const status = await getGitStatus("/repo", runner);

    expect(status).toEqual({
      branch: "feature/test",
      detached: false,
      clean: false,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 1,
    });
  });

  it("creates branches with structured Git arguments", async () => {
    const runtimeConfig = configFor("/repo");
    const calls: string[][] = [];
    const runner: GitProcessRunner = (_executable, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await createBranch("/repo", runtimeConfig, "feature/task-1", {
      runner,
    });

    expect(result.branch).toBe("feature/task-1");
    expect(calls).toEqual([
      ["check-ref-format", "--branch", "feature/task-1"],
      ["switch", "-c", "feature/task-1"],
    ]);
  });

  it("commits only already staged changes", async () => {
    const runtimeConfig = configFor("/repo");
    const runner: GitProcessRunner = (_executable, args) => {
      if (args[0] === "diff") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }

      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }

      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await commitStagedChanges("/repo", runtimeConfig, "feat: test", {
      runner,
    });

    expect(result.commitSha).toBe("abc123");
  });

  it("requires explicit approval for the default gitPush permission", async () => {
    const runtimeConfig = configFor("/repo");
    const runner: GitProcessRunner = () => ({
      exitCode: 0,
      stdout: "feature/test\n",
      stderr: "",
    });

    await expect(
      pushCurrentBranch("/repo", runtimeConfig, { runner }),
    ).rejects.toThrow("requires approval");
  });

  it("transitions workflow only after branch creation succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-git-"));
    temporaryDirectories.push(root);

    const runtimeConfig = configFor(root);
    const store = new WorkflowStateStore(root, runtimeConfig);
    await startWorkflow(store, "TASK-200");
    await transitionWorkflow(store, "TASK_VALIDATED");
    await transitionWorkflow(store, "REPO_ANALYZED");

    const runner: GitProcessRunner = () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const result = await createWorkflowBranch(
      root,
      runtimeConfig,
      store,
      "feature/task-200",
      { runner },
    );

    expect(result.workflow.state).toBe("BRANCH_CREATED");
    expect(
      result.workflow.checkpoints.find(
        (checkpoint) =>
          checkpoint.kind === "ACTION" &&
          checkpoint.action === "branch.create",
      ),
    ).toMatchObject({
      provider: "git",
      success: true,
      detail: "feature/task-200",
    });
  });

  it("transitions READY_TO_PUSH to PUSHED only after a successful push", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-git-"));
    temporaryDirectories.push(root);

    const runtimeConfig = configFor(root);
    runtimeConfig.permissions.gitPush = "auto";
    const store = new WorkflowStateStore(root, runtimeConfig);
    await startWorkflow(store, "TASK-201");
    await transitionWorkflow(store, "TASK_VALIDATED");
    await transitionWorkflow(store, "REPO_ANALYZED");
    await transitionWorkflow(store, "BRANCH_CREATED");
    await transitionWorkflow(store, "IMPLEMENTING");
    await transitionWorkflow(store, "LOCAL_VALIDATION");
    await transitionWorkflow(store, "CODE_REVIEW");
    await transitionWorkflow(store, "READY_TO_PUSH");

    const runner: GitProcessRunner = (_executable, args) => {
      if (args[0] === "branch") {
        return { exitCode: 0, stdout: "feature/task-201\n", stderr: "" };
      }

      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await pushWorkflowBranch(root, runtimeConfig, store, {
      runner,
    });

    expect(result.workflow.state).toBe("PUSHED");
    expect(result.push).toEqual({
      branch: "feature/task-201",
      remote: "origin",
    });
  });
});
