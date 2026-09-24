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
  listPublishedBranches,
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

  it("discovers pushed unmerged branches relative to the remote default branch", async () => {
    const runner: GitProcessRunner = (_executable, args) => {
      if (args[0] === "symbolic-ref") {
        return { exitCode: 0, stdout: "origin/main\n", stderr: "" };
      }

      if (args[0] === "for-each-ref") {
        return {
          exitCode: 0,
          stdout: [
            "main|origin/main|aaaaaaaa|2026-09-23T10:00:00+00:00",
            "feature/KT-115|origin/feature/KT-115|bbbbbbbb|2026-09-23T18:00:00+00:00",
            "feature/merged|origin/feature/merged|cccccccc|2026-09-22T18:00:00+00:00",
            "local-only||dddddddd|2026-09-23T17:00:00+00:00",
          ].join("\n"),
          stderr: "",
        };
      }

      if (args[0] === "merge-base") {
        const branch = args[2];
        return branch === "feature/merged"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
      }

      if (args[0] === "rev-list") {
        const range = args.at(-1);
        if (range === "main...feature/KT-115") {
          return { exitCode: 0, stdout: "0\t3\n", stderr: "" };
        }
        if (range === "feature/KT-115...origin/feature/KT-115") {
          return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
        }
      }

      return { exitCode: 1, stdout: "", stderr: "unexpected git command" };
    };

    const snapshot = await listPublishedBranches("/repo", runner);

    expect(snapshot.defaultBranch).toBe("main");
    expect(snapshot.branches).toEqual([
      expect.objectContaining({
        branch: "feature/KT-115",
        upstream: "origin/feature/KT-115",
        aheadOfDefault: 3,
        behindDefault: 0,
        aheadOfUpstream: 0,
        behindUpstream: 0,
        fullyPushed: true,
      }),
    ]);
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

    await expect(pushCurrentBranch("/repo", runtimeConfig, { runner })).rejects.toThrow(
      "requires approval",
    );
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

    const result = await createWorkflowBranch(root, runtimeConfig, store, "feature/task-200", {
      runner,
    });

    expect(result.workflow.state).toBe("BRANCH_CREATED");
    expect(
      result.workflow.checkpoints.find(
        (checkpoint) => checkpoint.kind === "ACTION" && checkpoint.action === "branch.create",
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
