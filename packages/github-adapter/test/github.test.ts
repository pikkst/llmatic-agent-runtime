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
  createPullRequest,
  createWorkflowPullRequest,
  getFailedPullRequestDiagnostics,
  getPullRequestReviewContext,
  getPullRequestReviewMetadata,
  getPullRequestStatus,
  mergePullRequest,
  mergeWorkflowPullRequest,
  publishPullRequestReview,
  refreshWorkflowRemoteCi,
} from "../src/github.js";
import type { GitHubProcessRunner } from "../src/types.js";

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

function pullRequestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 7,
    url: "https://github.com/example/repo/pull/7",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefName: "feature/task",
    headRefOid: "abc123",
    baseRefName: "main",
    ...overrides,
  });
}

async function moveToPushed(store: WorkflowStateStore): Promise<void> {
  await transitionWorkflow(store, "TASK_VALIDATED");
  await transitionWorkflow(store, "REPO_ANALYZED");
  await transitionWorkflow(store, "BRANCH_CREATED");
  await transitionWorkflow(store, "IMPLEMENTING");
  await transitionWorkflow(store, "LOCAL_VALIDATION");
  await transitionWorkflow(store, "CODE_REVIEW");
  await transitionWorkflow(store, "READY_TO_PUSH");
  await transitionWorkflow(store, "PUSHED");
}

describe("github adapter", () => {
  it("requires approval for default pull-request creation", async () => {
    const config = configFor("/repo");
    const runner: GitHubProcessRunner = () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    await expect(
      createPullRequest("/repo", config, { title: "Test PR", body: "" }, { runner }),
    ).rejects.toThrow("requires approval");
  });

  it("requires explicit approval before publishing a pull-request review comment", async () => {
    const config = configFor("/repo");
    const runner: GitHubProcessRunner = () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    await expect(
      publishPullRequestReview("/repo", config, "7", { body: "Review body" }, { runner }),
    ).rejects.toThrow("requires approval");
  });

  it("publishes an approved pull-request review as a comment", async () => {
    const config = configFor("/repo");
    const calls: string[][] = [];
    const runner: GitHubProcessRunner = (_executable, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await publishPullRequestReview(
      "/repo",
      config,
      "7",
      { body: "Review body" },
      { approved: true, runner },
    );

    expect(calls).toEqual([["pr", "review", "7", "--comment", "--body", "Review body"]]);
  });

  it("creates a pull request with structured gh arguments", async () => {
    const config = configFor("/repo");
    const calls: string[][] = [];
    const runner: GitHubProcessRunner = (_executable, args) => {
      calls.push(args);

      if (args[1] === "create") {
        return {
          exitCode: 0,
          stdout: "https://github.com/example/repo/pull/7\n",
          stderr: "",
        };
      }

      return { exitCode: 0, stdout: pullRequestJson(), stderr: "" };
    };

    const pullRequest = await createPullRequest(
      "/repo",
      config,
      {
        title: "Test PR",
        body: "Body",
        base: "main",
        head: "feature/task",
      },
      { approved: true, runner },
    );

    expect(pullRequest.number).toBe(7);
    expect(calls[0]).toEqual([
      "pr",
      "create",
      "--title",
      "Test PR",
      "--body",
      "Body",
      "--base",
      "main",
      "--head",
      "feature/task",
    ]);
  });

  it("maps an empty no-check response into remote CI state none", async () => {
    const runner: GitHubProcessRunner = (_executable, args) => {
      if (args[1] === "view") {
        return { exitCode: 0, stdout: pullRequestJson(), stderr: "" };
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: "no checks reported on the branch",
      };
    };

    const status = await getPullRequestStatus("/repo", "7", runner);

    expect(status.ciState).toBe("none");
    expect(status.checks).toEqual([]);
  });

  it("maps pending check exit code 8 into remote CI status", async () => {
    const runner: GitHubProcessRunner = (_executable, args) => {
      if (args[1] === "view") {
        return { exitCode: 0, stdout: pullRequestJson(), stderr: "" };
      }

      return {
        exitCode: 8,
        stdout: JSON.stringify([
          {
            name: "CI",
            state: "IN_PROGRESS",
            bucket: "pending",
            workflow: "CI",
            link: "https://example.test/run",
          },
        ]),
        stderr: "",
      };
    };

    const status = await getPullRequestStatus("/repo", "7", runner);

    expect(status.ciState).toBe("pending");
    expect(status.checks).toHaveLength(1);
  });

  it("reads external pull-request review context without mutations", async () => {
    const calls: string[][] = [];
    const runner: GitHubProcessRunner = (_executable, args) => {
      calls.push(args);

      if (args[1] === "checks") {
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }

      if (args[1] === "diff") {
        return {
          exitCode: 0,
          stdout: "diff --git a/src/value.ts b/src/value.ts\n+export const value = 2;\n",
          stderr: "",
        };
      }

      if (args[0] === "repo" && args[1] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ nameWithOwner: "example/repo" }),
          stderr: "",
        };
      }

      if (args[0] === "api" && args.includes("--paginate")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            [
              {
                filename: "src/value.ts",
                additions: 1,
                deletions: 0,
              },
            ],
          ]),
          stderr: "",
        };
      }

      if (args[0] === "api" && args[1] === "graphql") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        isResolved: false,
                        isOutdated: false,
                        path: "src/value.ts",
                        line: 1,
                        originalLine: 1,
                        comments: {
                          nodes: [
                            {
                              author: { login: "inline-reviewer" },
                              body: "Please cover the null case.",
                              createdAt: "2026-09-22T12:00:00Z",
                              url: "https://github.com/example/repo/pull/7#discussion_r1",
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
        };
      }

      if (args[1] === "view" && String(args.at(-1)).includes("title")) {
        return {
          exitCode: 0,
          stdout: pullRequestJson({
            title: "Improve value handling",
            body: "PR body",
            author: { login: "contributor" },
            reviews: [
              {
                author: { login: "reviewer" },
                state: "COMMENTED",
                body: "Please verify the edge case.",
                submittedAt: "2026-09-22T10:00:00Z",
              },
            ],
            comments: [
              {
                author: { login: "maintainer" },
                body: "CI is green.",
                createdAt: "2026-09-22T11:00:00Z",
                url: "https://github.com/example/repo/pull/7#issuecomment-1",
              },
            ],
          }),
          stderr: "",
        };
      }

      if (args[1] === "view") {
        return { exitCode: 0, stdout: pullRequestJson(), stderr: "" };
      }

      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    const context = await getPullRequestReviewContext("/repo", "7", runner);

    expect(context.status.ciState).toBe("none");
    expect(context.title).toBe("Improve value handling");
    expect(context.authorLogin).toBe("contributor");
    expect(context.changedFiles).toEqual([{ path: "src/value.ts", additions: 1, deletions: 0 }]);
    expect(context.reviews[0]).toMatchObject({
      authorLogin: "reviewer",
      state: "COMMENTED",
    });
    expect(context.comments[0]?.authorLogin).toBe("maintainer");
    expect(context.reviewThreads[0]).toMatchObject({
      path: "src/value.ts",
      line: 1,
      resolved: false,
      outdated: false,
    });
    expect(context.reviewThreads[0]?.comments[0]?.authorLogin).toBe("inline-reviewer");
    expect(context.diff).toContain("+export const value = 2;");
    expect(context.diffTruncated).toBe(false);
    expect(calls).toContainEqual(["pr", "diff", "7", "--color", "never"]);
    expect(calls).toContainEqual([
      "api",
      "--paginate",
      "--slurp",
      "repos/example/repo/pulls/7/files?per_page=100",
    ]);
  });

  it("rejects external PR review when the target belongs to another repository", async () => {
    const runner: GitHubProcessRunner = (_executable, args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          exitCode: 0,
          stdout: pullRequestJson({
            url: "https://github.com/other/repo/pull/7",
          }),
          stderr: "",
        };
      }

      if (args[0] === "pr" && args[1] === "checks") {
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }

      if (args[0] === "repo" && args[1] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ nameWithOwner: "example/repo" }),
          stderr: "",
        };
      }

      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    await expect(getPullRequestReviewMetadata("/repo", "7", runner)).rejects.toThrow(
      "must target the opened repository",
    );
  });

  it("returns bounded failed GitHub Actions logs for PR diagnostics", async () => {
    const calls: string[][] = [];
    const runner: GitHubProcessRunner = (_executable, args) => {
      calls.push(args);

      if (args[1] === "view" && args[0] === "pr") {
        return { exitCode: 0, stdout: pullRequestJson(), stderr: "" };
      }

      if (args[1] === "checks") {
        return {
          exitCode: 1,
          stdout: JSON.stringify([
            {
              name: "CI",
              state: "FAILURE",
              bucket: "fail",
              workflow: "CI",
              link: "https://github.com/example/repo/actions/runs/123456789/job/1",
            },
          ]),
          stderr: "",
        };
      }

      if (args[0] === "run" && args[1] === "view") {
        return {
          exitCode: 0,
          stdout: "FAIL src/example.test.ts\nAssertionError: expected 1 to be 2\n",
          stderr: "",
        };
      }

      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    const diagnostics = await getFailedPullRequestDiagnostics("/repo", "7", runner);

    expect(diagnostics.status.ciState).toBe("failing");
    expect(diagnostics.failed[0]).toMatchObject({
      runId: "123456789",
      log: expect.stringContaining("AssertionError"),
    });
    expect(calls).toContainEqual(["run", "view", "123456789", "--log-failed"]);
  });

  it("creates the workflow PR before moving PUSHED to PR_OPEN", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-github-"));
    temporaryDirectories.push(root);

    const config = configFor(root);
    config.permissions.createPullRequest = "auto";
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-400");
    await moveToPushed(store);

    const runner: GitHubProcessRunner = (_executable, args) => {
      if (args[1] === "create") {
        return {
          exitCode: 0,
          stdout: "https://github.com/example/repo/pull/7\n",
          stderr: "",
        };
      }

      return { exitCode: 0, stdout: pullRequestJson(), stderr: "" };
    };

    const result = await createWorkflowPullRequest(
      root,
      config,
      store,
      { title: "TASK-400", body: "" },
      { runner },
    );

    expect(result.workflow.state).toBe("PR_OPEN");
    expect(
      result.workflow.checkpoints.find(
        (checkpoint) =>
          checkpoint.kind === "ACTION" &&
          checkpoint.provider === "github" &&
          checkpoint.action === "pr.create",
      ),
    ).toMatchObject({
      success: true,
      metadata: {
        prNumber: "7",
        headRefOid: "abc123",
      },
    });
  });

  it("advances passing remote CI from PR_OPEN to FINAL_REVIEW", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-github-"));
    temporaryDirectories.push(root);

    const config = configFor(root);
    config.permissions.createPullRequest = "auto";
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-401");
    await moveToPushed(store);

    const runner: GitHubProcessRunner = (_executable, args) => {
      if (args[1] === "create") {
        return {
          exitCode: 0,
          stdout: "https://github.com/example/repo/pull/7\n",
          stderr: "",
        };
      }

      if (args[1] === "checks") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              name: "CI",
              state: "SUCCESS",
              bucket: "pass",
              workflow: "CI",
              link: "https://example.test/run",
            },
          ]),
          stderr: "",
        };
      }

      return { exitCode: 0, stdout: pullRequestJson(), stderr: "" };
    };

    await createWorkflowPullRequest(
      root,
      config,
      store,
      { title: "TASK-401", body: "" },
      { runner },
    );

    const result = await refreshWorkflowRemoteCi(root, store, undefined, runner);

    expect(result.status.ciState).toBe("passing");
    expect(result.workflow.state).toBe("FINAL_REVIEW");
  });

  it("moves failing remote CI to FIXING", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-github-"));
    temporaryDirectories.push(root);

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-402");
    await moveToPushed(store);
    await transitionWorkflow(store, "PR_OPEN");
    await transitionWorkflow(store, "REMOTE_CI");

    const runner: GitHubProcessRunner = (_executable, args) => {
      if (args[1] === "checks") {
        return {
          exitCode: 1,
          stdout: JSON.stringify([
            {
              name: "CI",
              state: "FAILURE",
              bucket: "fail",
              workflow: "CI",
              link: "https://example.test/run",
            },
          ]),
          stderr: "",
        };
      }

      return { exitCode: 0, stdout: pullRequestJson(), stderr: "" };
    };

    const result = await refreshWorkflowRemoteCi(root, store, "7", runner);

    expect(result.workflow.state).toBe("FIXING");
  });

  it("merges with exact head SHA protection and completes the workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-github-"));
    temporaryDirectories.push(root);

    const config = configFor(root);
    config.permissions.mergePullRequest = "auto";
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-403");
    await moveToPushed(store);
    await transitionWorkflow(store, "PR_OPEN");
    await transitionWorkflow(store, "REMOTE_CI");
    await transitionWorkflow(store, "FINAL_REVIEW");
    await transitionWorkflow(store, "READY_TO_MERGE");

    const calls: string[][] = [];
    const runner: GitHubProcessRunner = (_executable, args) => {
      calls.push(args);

      if (args[1] === "merge") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }

      return { exitCode: 0, stdout: pullRequestJson(), stderr: "" };
    };

    const direct = await mergePullRequest(root, config, "7", {
      runner,
      method: "squash",
    });

    expect(direct.method).toBe("squash");
    expect(calls.at(-1)).toEqual(["pr", "merge", "7", "--squash", "--match-head-commit", "abc123"]);

    const result = await mergeWorkflowPullRequest(root, config, store, "7", {
      runner,
      method: "squash",
    });

    expect(result.workflow.state).toBe("COMPLETED");
  });
});
