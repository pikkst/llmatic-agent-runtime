import type { AgentConfig, WorkflowRun, WorkflowStateStore } from "@llmatic/core";
import {
  getGitStatus,
  listPublishedBranches,
  type GitStatus,
  type PublishedBranchStatus,
} from "@llmatic/git-adapter";
import {
  getPullRequestStatus,
  listOpenPullRequests,
  type OpenPullRequestSummary,
  type PullRequestStatus,
} from "@llmatic/github-adapter";
import {
  buildRepositoryIndex,
  loadRepositoryIndex,
  type RepositoryIndex,
} from "@llmatic/repo-intelligence";
import {
  buildRepositoryConstitution,
  repositoryConstitutionContext,
  type RepositoryConstitution,
} from "@llmatic/repository-constitution";
import type { TaskProvider, TaskRecord } from "@llmatic/task-provider";
import {
  detectTaskSources,
  resolveTaskProvider,
  resolveWorkflowTaskProvider,
  type TaskSourceDetection,
} from "@llmatic/task-router";

export type WorkspaceRecoveryAction =
  | "continue_workflow"
  | "fix_pr"
  | "wait_for_ci"
  | "review_pr"
  | "create_pr"
  | "continue_task"
  | "start_task"
  | "continue_changes"
  | "start_discovery"
  | "ask_goal";

export interface WorkspaceRecoveryRecommendation {
  action: WorkspaceRecoveryAction;
  title: string;
  detail: string;
}

export interface RepositoryMapSummary {
  generatedAt: string;
  fileCount: number;
  sourceFileCount: number;
  symbolCount: number;
  importCount: number;
}

export interface WorkspaceRecovery {
  root: string;
  repository: RepositoryMapSummary;
  git: GitStatus;
  workflow?: WorkflowRun;
  taskSource: TaskSourceDetection;
  task?: TaskRecord;
  nextTask?: TaskRecord;
  taskCandidates: TaskRecord[];
  constitution: RepositoryConstitution;
  pullRequest?: PullRequestStatus;
  openPullRequests?: OpenPullRequestSummary[];
  pendingPullRequestBranches?: PublishedBranchStatus[];
  warnings: string[];
  recommendation: WorkspaceRecoveryRecommendation;
}

export interface RecoverWorkspaceOptions {
  rebuildIndex?: boolean;
  environment?: NodeJS.ProcessEnv;
}

function indexSummary(index: RepositoryIndex): RepositoryMapSummary {
  return {
    generatedAt: index.generatedAt,
    fileCount: index.fileCount,
    sourceFileCount: index.sourceFileCount,
    symbolCount: index.symbols.length,
    importCount: index.imports.length,
  };
}

function activeWorkflow(run: WorkflowRun | undefined): WorkflowRun | undefined {
  if (!run) return undefined;
  return run.state === "COMPLETED" || run.state === "FAILED" ? undefined : run;
}

function branchTaskReference(branch: string | undefined): string | undefined {
  if (!branch) return undefined;

  const jira = /(?:^|[/_-])([A-Z][A-Z0-9]+-\d+)(?:$|[/_-])/i.exec(branch);
  if (jira?.[1]) return jira[1].toUpperCase();

  const github = /(?:^|[/_-])(?:issue|gh|pr)[-_/]?(\d+)(?:$|[/_-])/i.exec(branch);
  return github?.[1] ? "#" + github[1] : undefined;
}

async function loadOrBuildRepositoryIndex(
  root: string,
  config: AgentConfig,
  rebuild: boolean,
): Promise<RepositoryIndex> {
  if (!rebuild) {
    try {
      return await loadRepositoryIndex(root, config);
    } catch {
      // First recovery for a repository is expected to build the private index.
    }
  }

  return buildRepositoryIndex(root, config);
}

async function providerTask(
  provider: TaskProvider,
  reference: string,
): Promise<TaskRecord | undefined> {
  try {
    return await provider.getTask(reference);
  } catch {
    return undefined;
  }
}

async function recoverWorkflowTask(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  workflow: WorkflowRun,
  environment: NodeJS.ProcessEnv,
): Promise<TaskRecord | undefined> {
  try {
    const provider = await resolveWorkflowTaskProvider(root, config, store, "auto", environment);
    return await providerTask(provider, workflow.taskRef);
  } catch {
    return undefined;
  }
}

async function recoverBranchTask(
  root: string,
  config: AgentConfig,
  detection: TaskSourceDetection,
  branch: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<TaskRecord | undefined> {
  const reference = branchTaskReference(branch);
  if (!reference) return undefined;

  const available = detection.candidates
    .filter((candidate) => candidate.available && candidate.id !== "manual")
    .sort((left, right) => {
      if (reference.startsWith("#")) {
        if (left.id === "github") return -1;
        if (right.id === "github") return 1;
      } else {
        if (left.id === "jira") return -1;
        if (right.id === "jira") return 1;
      }
      return right.priority - left.priority;
    });

  for (const candidate of available) {
    try {
      const provider = await resolveTaskProvider(root, config, candidate.id, environment);
      const task = await providerTask(provider, reference);
      if (task) return task;
    } catch {
      // Continue across available providers; branch recovery is best effort.
    }
  }

  return undefined;
}

async function recoverProviderTasks(
  root: string,
  config: AgentConfig,
  detection: TaskSourceDetection,
  environment: NodeJS.ProcessEnv,
): Promise<{ task?: TaskRecord; nextTask?: TaskRecord; candidates: TaskRecord[] }> {
  if (detection.selected === "manual") return { candidates: [] };

  try {
    const provider = await resolveTaskProvider(root, config, detection.selected, environment);

    if (provider.listTasks) {
      const tasks = await provider.listTasks();
      const active = tasks.find((task) => task.status.lifecycle === "in_progress");
      if (active) {
        return {
          task: active,
          candidates: tasks.filter((task) => task.status.lifecycle !== "done").slice(0, 10),
        };
      }

      if (provider.getNextTask) {
        return {
          nextTask: await provider.getNextTask(),
          candidates: tasks.filter((task) => task.status.lifecycle !== "done").slice(0, 10),
        };
      }

      return {
        candidates: tasks.filter((task) => task.status.lifecycle !== "done").slice(0, 10),
      };
    }

    if (provider.getNextTask) {
      const nextTask = await provider.getNextTask();
      return {
        nextTask,
        candidates: nextTask ? [nextTask] : [],
      };
    }
  } catch {
    // Recovery should still succeed when an optional external provider is unavailable.
  }

  return { candidates: [] };
}

export function selectRecoveryPullRequest(
  pullRequests: OpenPullRequestSummary[],
  branch: string | undefined,
): OpenPullRequestSummary | undefined {
  const normalizedBranch = branch?.trim();
  const branchMatch = normalizedBranch
    ? pullRequests.find((pullRequest) => pullRequest.headRefName === normalizedBranch)
    : undefined;

  if (branchMatch) return branchMatch;
  return pullRequests.length === 1 ? pullRequests[0] : undefined;
}

async function recoverPullRequest(
  root: string,
  branch: string | undefined,
): Promise<{
  pullRequest?: PullRequestStatus;
  openPullRequests: OpenPullRequestSummary[];
}> {
  try {
    const openPullRequests = listOpenPullRequests(root);
    const selected = selectRecoveryPullRequest(openPullRequests, branch);
    if (!selected) return { openPullRequests };

    try {
      const status = await getPullRequestStatus(root, selected.number);
      return status.pullRequest.state === "OPEN"
        ? { pullRequest: status, openPullRequests }
        : { openPullRequests };
    } catch {
      return { openPullRequests };
    }
  } catch {
    // Preserve the legacy current-branch recovery path when repository-wide listing is unavailable.
    try {
      const status = await getPullRequestStatus(root);
      return {
        pullRequest: status.pullRequest.state === "OPEN" ? status : undefined,
        openPullRequests: [],
      };
    } catch {
      return { openPullRequests: [] };
    }
  }
}

export function recommendWorkspaceAction(input: {
  repository: RepositoryMapSummary;
  git: GitStatus;
  workflow?: WorkflowRun;
  task?: TaskRecord;
  nextTask?: TaskRecord;
  pullRequest?: PullRequestStatus;
  openPullRequests?: OpenPullRequestSummary[];
  pendingPullRequestBranches?: PublishedBranchStatus[];
}): WorkspaceRecoveryRecommendation {
  const { repository, git, workflow, task, nextTask, pullRequest } = input;
  const openPullRequests = input.openPullRequests ?? [];
  const pendingPullRequestBranches = input.pendingPullRequestBranches ?? [];

  if (workflow) {
    if (pullRequest?.ciState === "failing" || pullRequest?.ciState === "cancelled") {
      return {
        action: "fix_pr",
        title: "Continue fixing the open pull request",
        detail:
          "Workflow " +
          workflow.taskRef +
          " is active and PR #" +
          pullRequest.pullRequest.number +
          " has failing CI.",
      };
    }

    if (pullRequest?.ciState === "pending") {
      return {
        action: "wait_for_ci",
        title: "Continue from the open pull request",
        detail:
          "PR #" +
          pullRequest.pullRequest.number +
          " is still running CI for workflow " +
          workflow.taskRef +
          ".",
      };
    }

    if (pullRequest?.ciState === "passing") {
      return {
        action: "review_pr",
        title: "Review the green pull request",
        detail:
          "PR #" +
          pullRequest.pullRequest.number +
          " is green; continue the workflow from " +
          workflow.state +
          ".",
      };
    }

    return {
      action: "continue_workflow",
      title: "Continue the active engineering workflow",
      detail: workflow.taskRef + " is currently in state " + workflow.state + ".",
    };
  }

  if (pullRequest) {
    if (pullRequest.ciState === "failing" || pullRequest.ciState === "cancelled") {
      return {
        action: "fix_pr",
        title: "Fix the current branch pull request",
        detail: "PR #" + pullRequest.pullRequest.number + " has failing CI.",
      };
    }

    if (pullRequest.ciState === "pending") {
      return {
        action: "wait_for_ci",
        title: "Continue from the current pull request",
        detail: "PR #" + pullRequest.pullRequest.number + " has CI in progress.",
      };
    }

    return {
      action: "review_pr",
      title: "Continue from the current pull request",
      detail:
        "PR #" +
        pullRequest.pullRequest.number +
        " is open with CI state " +
        pullRequest.ciState +
        ".",
    };
  }

  if (pendingPullRequestBranches.length === 1) {
    const branch = pendingPullRequestBranches[0]!;
    return {
      action: "create_pr",
      title: "Create a pull request for the pushed branch",
      detail:
        branch.branch +
        " is pushed to " +
        branch.upstream +
        " and is " +
        String(branch.aheadOfDefault) +
        " commit(s) ahead of " +
        (branch.behindDefault > 0
          ? "the default branch while " + String(branch.behindDefault) + " commit(s) behind"
          : "the default branch") +
        ", but no open pull request exists.",
    };
  }

  if (pendingPullRequestBranches.length > 1) {
    return {
      action: "ask_goal",
      title: "Choose a pushed branch to open as a pull request",
      detail:
        String(pendingPullRequestBranches.length) +
        " pushed unmerged branches have no open pull request: " +
        pendingPullRequestBranches.map((branch) => branch.branch).join(", ") +
        ".",
    };
  }

  if (!git.clean) {
    return {
      action: "continue_changes",
      title: "Continue the current working-tree changes",
      detail:
        String(git.stagedCount + git.unstagedCount + git.untrackedCount) +
        " changed path(s) are present on branch " +
        (git.branch ?? "detached HEAD") +
        ".",
    };
  }

  if (task?.status.lifecycle === "in_progress") {
    return {
      action: "continue_task",
      title: "Continue the active task",
      detail: task.key + " — " + task.summary,
    };
  }

  if (nextTask) {
    return {
      action: "start_task",
      title: "Start the next unblocked task",
      detail: nextTask.key + " — " + nextTask.summary,
    };
  }

  if (openPullRequests.length > 0) {
    const draftCount = openPullRequests.filter((pullRequest) => pullRequest.isDraft).length;
    return {
      action: "ask_goal",
      title: "Choose an open pull request",
      detail:
        String(openPullRequests.length) +
        " open pull request(s) were found" +
        (draftCount > 0 ? " (" + String(draftCount) + " draft)" : "") +
        ", but none uniquely matches the current branch " +
        (git.branch ?? "detached HEAD") +
        ".",
    };
  }

  if (repository.fileCount === 0) {
    return {
      action: "start_discovery",
      title: "Start project discovery",
      detail: "The workspace has no project files yet.",
    };
  }

  return {
    action: "ask_goal",
    title: "Ask what to work on next",
    detail:
      "The repository is mapped, but no active workflow, open PR, changed worktree, or recoverable task was found.",
  };
}

export async function recoverWorkspace(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  options: RecoverWorkspaceOptions = {},
): Promise<WorkspaceRecovery> {
  const environment = options.environment ?? process.env;
  const warnings: string[] = [];

  const index = await loadOrBuildRepositoryIndex(root, config, options.rebuildIndex ?? false);
  const repository = indexSummary(index);
  const constitution = await buildRepositoryConstitution(root, config, {
    rebuildIndex: false,
  });
  const git = await getGitStatus(root);
  const workflow = activeWorkflow(await store.loadCurrent());
  const taskSource = await detectTaskSources(root, environment);
  const recoveredPullRequests = await recoverPullRequest(root, git.branch);
  const pullRequest = recoveredPullRequests.pullRequest;
  const openPullRequests = recoveredPullRequests.openPullRequests;
  const publishedBranches = await listPublishedBranches(root).catch(() => ({
    defaultBranch: undefined,
    branches: [],
  }));
  const openPullRequestHeads = new Set(openPullRequests.map((item) => item.headRefName));
  const pendingPullRequestBranches = publishedBranches.branches.filter(
    (branch) => branch.fullyPushed && !openPullRequestHeads.has(branch.branch),
  );

  if (openPullRequests.length > 1 && !pullRequest) {
    warnings.push(
      String(openPullRequests.length) +
        " open pull requests were found, but none uniquely matches the current branch.",
    );
  }

  let task: TaskRecord | undefined;
  let nextTask: TaskRecord | undefined;
  let taskCandidates: TaskRecord[] = [];

  if (workflow) {
    task = await recoverWorkflowTask(root, config, store, workflow, environment);
    if (!task) {
      warnings.push("Active workflow task metadata could not be refreshed from its provider.");
    }
  } else {
    task = await recoverBranchTask(root, config, taskSource, git.branch, environment);

    if (!task) {
      const providerTasks = await recoverProviderTasks(root, config, taskSource, environment);
      task = providerTasks.task;
      nextTask = providerTasks.nextTask;
      taskCandidates = providerTasks.candidates;
    }
  }

  const recommendation = recommendWorkspaceAction({
    repository,
    git,
    workflow,
    task,
    nextTask,
    pullRequest,
    openPullRequests,
    pendingPullRequestBranches,
  });

  return {
    root,
    repository,
    git,
    workflow,
    taskSource,
    task,
    nextTask,
    taskCandidates,
    constitution,
    pullRequest,
    openPullRequests,
    pendingPullRequestBranches,
    warnings,
    recommendation,
  };
}

export function workspaceRecoveryContext(recovery: WorkspaceRecovery): string {
  const lines = [
    "Recovered workspace context:",
    "- Repository map: " +
      recovery.repository.fileCount +
      " files, " +
      recovery.repository.symbolCount +
      " symbols, " +
      recovery.repository.importCount +
      " imports",
    "- Branch: " + (recovery.git.branch ?? "detached HEAD"),
    "- Working tree: " +
      (recovery.git.clean
        ? "clean"
        : recovery.git.stagedCount +
          " staged, " +
          recovery.git.unstagedCount +
          " unstaged, " +
          recovery.git.untrackedCount +
          " untracked"),
    "- Task source: " + recovery.taskSource.selected,
    recovery.workflow
      ? "- Workflow: " + recovery.workflow.taskRef + " / " + recovery.workflow.state
      : "- Workflow: none",
    recovery.task
      ? "- Active/recovered task: " +
        recovery.task.key +
        " — " +
        recovery.task.summary +
        " [" +
        recovery.task.status.name +
        "]"
      : "- Active/recovered task: none",
    recovery.nextTask
      ? "- Next task: " + recovery.nextTask.key + " — " + recovery.nextTask.summary
      : undefined,
    "- Constitution: " +
      recovery.constitution.counts.explicitRule +
      " explicit rules, " +
      recovery.constitution.counts.approvedRule +
      " approved rules, " +
      recovery.constitution.counts.inferredConvention +
      " inferred conventions, " +
      recovery.constitution.counts.proposedRule +
      " proposed rules",
    recovery.taskCandidates.length > 0
      ? "- Task candidates: " +
        recovery.taskCandidates
          .map(
            (task) =>
              task.key +
              " [" +
              task.status.name +
              "] " +
              task.summary +
              (task.dependencies.length > 0
                ? " (depends on " + task.dependencies.join(", ") + ")"
                : ""),
          )
          .join(" | ")
      : "- Task candidates: none",
    recovery.pullRequest
      ? "- Selected open PR: #" +
        recovery.pullRequest.pullRequest.number +
        " / " +
        (recovery.pullRequest.pullRequest.isDraft ? "draft" : "ready") +
        " / branch " +
        recovery.pullRequest.pullRequest.headRefName +
        " / CI " +
        recovery.pullRequest.ciState
      : "- Selected open PR: none",
    "- Repository open PRs: " +
      (recovery.openPullRequests?.length
        ? recovery.openPullRequests
            .map(
              (pullRequest) =>
                "#" +
                String(pullRequest.number) +
                " [" +
                (pullRequest.isDraft ? "draft" : "open") +
                "] " +
                pullRequest.headRefName +
                " — " +
                pullRequest.title,
            )
            .join(" | ")
        : "none"),,
    "- Pushed branches without open PR: " +
      (recovery.pendingPullRequestBranches?.length
        ? recovery.pendingPullRequestBranches
            .map(
              (branch) =>
                branch.branch +
                " [" +
                String(branch.aheadOfDefault) +
                " ahead / " +
                String(branch.behindDefault) +
                " behind default, upstream " +
                branch.upstream +
                "]",
            )
            .join(" | ")
        : "none")
    "- Recommended next action: " +
      recovery.recommendation.title +
      " — " +
      recovery.recommendation.detail,
  ].filter((line): line is string => Boolean(line));

  return (
    lines.join("\n") +
    "\n\n" +
    repositoryConstitutionContext(recovery.constitution, {
      includeInferred: true,
      includeProposed: false,
      maxRules: 60,
    })
  );
}
