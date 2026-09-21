import { spawnSync } from "node:child_process";
import type {
  AgentConfig,
  WorkflowRun,
  WorkflowStateStore,
} from "@llmatic/core";
import {
  recordActionCheckpoint,
  transitionWorkflow,
} from "@llmatic/core";
import type {
  BranchResult,
  CommitResult,
  GitMutationOptions,
  GitProcessResult,
  GitProcessRunner,
  GitStatus,
  PushOptions,
  PushResult,
} from "./types.js";

function defaultRunner(
  executable: string,
  args: string[],
  cwd: string,
): GitProcessResult {
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: result.error.message,
    };
  }

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandText(args: string[]): string {
  return ["git", ...args].join(" ");
}

function run(
  root: string,
  args: string[],
  runner: GitProcessRunner,
): GitProcessResult {
  return runner("git", args, root);
}

function requireSuccess(
  result: GitProcessResult,
  args: string[],
): GitProcessResult {
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      "Git command failed: " +
        commandText(args) +
        " (exit " +
        result.exitCode +
        ")" +
        (detail ? ": " + detail : ""),
    );
  }

  return result;
}

function assertPermission(
  permission: AgentConfig["permissions"]["repositoryWrite"],
  permissionName: string,
  approved: boolean,
): void {
  if (permission === "deny") {
    throw new Error(permissionName + " is denied by llmatic.agent.yaml.");
  }

  if (permission === "ask" && !approved) {
    throw new Error(
      permissionName +
        " requires approval. Re-run with --approve after reviewing the operation.",
    );
  }
}

function repositoryRunner(options?: GitMutationOptions): GitProcessRunner {
  return options?.runner ?? defaultRunner;
}

async function currentBranch(
  root: string,
  runner: GitProcessRunner,
): Promise<string> {
  const args = ["branch", "--show-current"];
  const result = requireSuccess(run(root, args, runner), args);
  const branch = result.stdout.trim();

  if (!branch) {
    throw new Error("Git repository is in detached HEAD state.");
  }

  return branch;
}

export async function getGitStatus(
  root: string,
  runner: GitProcessRunner = defaultRunner,
): Promise<GitStatus> {
  const branchResult = requireSuccess(
    run(root, ["branch", "--show-current"], runner),
    ["branch", "--show-current"],
  );
  const statusArgs = ["status", "--porcelain=v1"];
  const statusResult = requireSuccess(run(root, statusArgs, runner), statusArgs);
  const lines = statusResult.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;

  for (const line of lines) {
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";

    if (x === "?" && y === "?") {
      untrackedCount += 1;
      continue;
    }

    if (x !== " ") {
      stagedCount += 1;
    }

    if (y !== " ") {
      unstagedCount += 1;
    }
  }

  const branch = branchResult.stdout.trim() || undefined;

  return {
    branch,
    detached: !branch,
    clean: stagedCount === 0 && unstagedCount === 0 && untrackedCount === 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
  };
}

export async function createBranch(
  root: string,
  config: AgentConfig,
  name: string,
  options: GitMutationOptions = {},
): Promise<BranchResult> {
  const runner = repositoryRunner(options);
  const validationArgs = ["check-ref-format", "--branch", name];
  requireSuccess(run(root, validationArgs, runner), validationArgs);

  assertPermission(
    config.permissions.repositoryWrite,
    "Repository write",
    options.approved ?? false,
  );

  const args = ["switch", "-c", name];
  requireSuccess(run(root, args, runner), args);

  return { branch: name };
}

export async function stagePaths(
  root: string,
  config: AgentConfig,
  paths: string[],
  options: GitMutationOptions = {},
): Promise<void> {
  if (paths.length === 0) {
    throw new Error("At least one path is required for git stage.");
  }

  assertPermission(
    config.permissions.repositoryWrite,
    "Repository write",
    options.approved ?? false,
  );

  const runner = repositoryRunner(options);
  const args = ["add", "--", ...paths];
  requireSuccess(run(root, args, runner), args);
}

export async function commitStagedChanges(
  root: string,
  config: AgentConfig,
  message: string,
  options: GitMutationOptions = {},
): Promise<CommitResult> {
  if (!message.trim()) {
    throw new Error("Commit message must not be empty.");
  }

  assertPermission(
    config.permissions.repositoryWrite,
    "Repository write",
    options.approved ?? false,
  );

  const runner = repositoryRunner(options);
  const diffArgs = ["diff", "--cached", "--quiet"];
  const diff = run(root, diffArgs, runner);

  if (diff.exitCode === 0) {
    throw new Error("No staged changes are available to commit.");
  }

  if (diff.exitCode !== 1) {
    requireSuccess(diff, diffArgs);
  }

  const commitArgs = ["commit", "-m", message.trim()];
  requireSuccess(run(root, commitArgs, runner), commitArgs);

  const shaArgs = ["rev-parse", "HEAD"];
  const sha = requireSuccess(run(root, shaArgs, runner), shaArgs).stdout.trim();

  if (!sha) {
    throw new Error("Git commit succeeded but HEAD SHA could not be resolved.");
  }

  return { commitSha: sha };
}

export async function pushCurrentBranch(
  root: string,
  config: AgentConfig,
  options: PushOptions = {},
): Promise<PushResult> {
  assertPermission(
    config.permissions.gitPush,
    "Git push",
    options.approved ?? false,
  );

  const runner = repositoryRunner(options);
  const branch = await currentBranch(root, runner);
  const remote = options.remote?.trim() || "origin";
  const args = options.setUpstream
    ? ["push", "--set-upstream", remote, branch]
    : ["push", remote, branch];

  requireSuccess(run(root, args, runner), args);

  return { branch, remote };
}

export async function createWorkflowBranch(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  name: string,
  options: GitMutationOptions = {},
): Promise<{ branch: string; workflow: WorkflowRun }> {
  const current = await store.loadCurrent();

  if (!current || current.state !== "REPO_ANALYZED") {
    throw new Error(
      "Workflow branch creation requires state REPO_ANALYZED.",
    );
  }

  try {
    const branch = await createBranch(root, config, name, options);
    await recordActionCheckpoint(store, {
      provider: "git",
      action: "branch.create",
      command: "git switch -c " + name,
      success: true,
      detail: name,
    });
    const workflow = await transitionWorkflow(store, "BRANCH_CREATED");

    return { branch: branch.branch, workflow };
  } catch (error) {
    await recordActionCheckpoint(store, {
      provider: "git",
      action: "branch.create",
      command: "git switch -c " + name,
      success: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function pushWorkflowBranch(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  options: PushOptions = {},
): Promise<{ push: PushResult; workflow: WorkflowRun }> {
  const current = await store.loadCurrent();

  if (!current || current.state !== "READY_TO_PUSH") {
    throw new Error("Workflow push requires state READY_TO_PUSH.");
  }

  try {
    const push = await pushCurrentBranch(root, config, options);
    await recordActionCheckpoint(store, {
      provider: "git",
      action: "push",
      command: "git push " + push.remote + " " + push.branch,
      success: true,
      detail: push.branch,
    });
    const workflow = await transitionWorkflow(store, "PUSHED");

    return { push, workflow };
  } catch (error) {
    await recordActionCheckpoint(store, {
      provider: "git",
      action: "push",
      success: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
